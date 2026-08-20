#!/usr/bin/env python3
"""diarization-bundle (captain engine ruling 2026-08-20, option A):
vendored pyannote speaker-diarization-3.1 wired into the worker.

Layout under the shared model cache (provisioned once per home, see
scripts/provision-model-tier.ts --diarization):

    <model root>/diarization/config.yaml                 (pipeline config)
    <model root>/diarization/segmentation/pytorch_model.bin
    <model root>/diarization/embedding/pytorch_model.bin

The pipeline config is read from disk, its two model references are rewritten
to the local checkpoints, and the tuned `params` block (thresholds from the
pinned pipeline revision) is passed to instantiate. The worker's own offline
mode (HF_HUB_OFFLINE=1, runtime downloads off) already guarantees zero
runtime network; the local checkpoint paths make that a load-time fact too.
"""

import json
from pathlib import Path
from typing import Any

BUNDLE_DIR_NAME = "diarization"
PINS_PATH = Path(__file__).resolve().parent / "diarization-bundle.json"
PIPELINE_CONFIG_NAME = "config.yaml"
SEGMENTATION_CHECKPOINT = "segmentation/pytorch_model.bin"
EMBEDDING_CHECKPOINT = "embedding/pytorch_model.bin"

_pipeline_cache: dict[tuple[str, str], Any] = {}


class DiarizationUnavailable(RuntimeError):
    """Diarization cannot run on this host; callers degrade to single-speaker."""


class DiarizationBundleMissing(DiarizationUnavailable):
    """The vendored bundle is absent or byte-incomplete."""


def load_pins() -> dict[str, Any]:
    return json.loads(PINS_PATH.read_text(encoding="utf8"))


def bundle_root(model_root: Path) -> Path:
    return Path(model_root) / BUNDLE_DIR_NAME


def missing_bundle_files(model_root: Path) -> list[str]:
    root = bundle_root(model_root)
    missing: list[str] = []
    for part in load_pins()["parts"].values():
        for entry in part["files"]:
            artifact = root / entry["path"]
            if (
                not artifact.is_file()
                or artifact.stat().st_size != entry["sizeBytes"]
            ):
                missing.append(entry["path"])
    return missing


def diarization_bundle_ready(model_root: Path) -> bool:
    return not missing_bundle_files(model_root)


def _read_pipeline_config(root: Path) -> dict[str, Any]:
    try:
        import yaml  # comes with the pyannote stack (hyperpyyaml depends on it)
    except Exception as exc:  # pragma: no cover - defensive
        raise DiarizationUnavailable("pyannote.audio is not installed.") from exc

    config_path = root / PIPELINE_CONFIG_NAME
    if not config_path.is_file():
        raise DiarizationBundleMissing(
            f"Diarization bundle config.yaml is missing under {root}."
        )
    return yaml.safe_load(config_path.read_text(encoding="utf8"))


def load_pipeline(model_root: Path, device: str) -> Any:
    """Instantiate the pinned SpeakerDiarization pipeline entirely offline.

    Both model references are replaced by {"checkpoint": <local file>} so the
    loader cannot route through the Hugging Face hub regardless of the local
    path's substrings, and the tuned params from the pinned config are applied.
    """

    missing = missing_bundle_files(model_root)
    if missing:
        raise DiarizationBundleMissing(
            "Diarization bundle is incomplete under "
            f"{bundle_root(model_root)} (missing/mismatched: {', '.join(missing)}). "
            "Provision it once with `npx tsx scripts/provision-model-tier.ts --diarization`."
        )

    try:
        import torch
        from pyannote.audio.pipelines import SpeakerDiarization
    except Exception as exc:
        raise DiarizationUnavailable("pyannote.audio is not installed.") from exc

    # torch >= 2.6 defaults its loader to weights_only=True, and the pinned
    # pyannote checkpoints carry a torch.torch_version.TorchVersion global.
    # The in-process allowlist keeps the weights_only safety model while
    # accepting that class from our vendored, byte-pinned checkpoints; without
    # it every pipeline load dies with "Weights only load failed ...
    # add_safe_globals" and the job silently degrades to a single speaker.
    torch.serialization.add_safe_globals([torch.torch_version.TorchVersion])

    root = bundle_root(model_root)
    config = _read_pipeline_config(root)
    pipeline_params = (
        config.get("pipeline", {}).get("params", {}) if isinstance(config, dict) else {}
    )
    if not isinstance(pipeline_params, dict):
        pipeline_params = {}

    segmentation_checkpoint = root / SEGMENTATION_CHECKPOINT
    embedding_checkpoint = root / EMBEDDING_CHECKPOINT

    kwargs: dict[str, Any] = dict(pipeline_params)
    kwargs["segmentation"] = {"checkpoint": str(segmentation_checkpoint)}
    kwargs["embedding"] = {"checkpoint": str(embedding_checkpoint)}

    pipeline = SpeakerDiarization(**kwargs)

    tuned_params = config.get("params") if isinstance(config, dict) else None
    if isinstance(tuned_params, dict) and tuned_params:
        pipeline.instantiate(tuned_params)

    pipeline.to(torch.device(device))
    return pipeline


def cached_pipeline(model_root: Path, device: str) -> Any:
    key = (str(Path(model_root).resolve()), device)
    pipeline = _pipeline_cache.get(key)
    if pipeline is None:
        pipeline = load_pipeline(model_root, device)
        _pipeline_cache[key] = pipeline
    return pipeline


def diarize_media(pipeline: Any, media_path: str) -> list[tuple[float, float, str]]:
    """Run the pipeline and return [(start_s, end_s, speaker_id)] tracks.

    The waveform is decoded through faster-whisper's own audio loader so every
    media container the appliance already accepts decodes identically for
    diarization, with no extra codec dependency.
    """

    import numpy as np
    import torch
    from faster_whisper.audio import decode_audio  # type: ignore

    waveform = decode_audio(media_path, sampling_rate=16000)
    if waveform.size == 0:
        raise DiarizationUnavailable("Media decoded to an empty waveform.")

    tensor = torch.from_numpy(np.ascontiguousarray(waveform, dtype=np.float32))
    diarization = pipeline({"waveform": tensor.unsqueeze(0), "sample_rate": 16000})

    tracks: list[tuple[float, float, str]] = []
    for turn, _track, speaker in diarization.itertracks(yield_label=True):
        if turn.end > turn.start:
            tracks.append((float(turn.start), float(turn.end), str(speaker)))
    tracks.sort(key=lambda item: (item[0], item[1]))
    return tracks


def assign_speaker_labels(
    segments: list[dict[str, Any]],
    tracks: list[tuple[float, float, str]],
) -> tuple[list[dict[str, Any]], int]:
    """Vote each transcript segment onto a speaker by max time overlap.

    Speaker ids are normalized to "Speaker N" in first-chronological-appearance
    order so adjacent revisions read identically regardless of the engine's
    internal names. A segment with no overlapping track keeps the previous
    segment's speaker (or Speaker 1), so silence gaps never fork labels.
    """

    order: list[str] = []
    names: dict[str, str] = {}

    def label_for(speaker: str) -> str:
        if speaker not in names:
            order.append(speaker)
            names[speaker] = f"Speaker {len(order)}"
        return names[speaker]

    track_ms = [(int(start * 1000), int(end * 1000), speaker) for start, end, speaker in tracks]

    labeled: list[dict[str, Any]] = []
    previous_label: str | None = None
    for segment in segments:
        start_ms = int(segment.get("startMs") or 0)
        end_ms = int(segment.get("endMs") or 0)
        overlap_by_speaker: dict[str, float] = {}
        for track_start, track_end, speaker in track_ms:
            overlap = min(end_ms, track_end) - max(start_ms, track_start)
            if overlap > 0:
                overlap_by_speaker[speaker] = overlap_by_speaker.get(speaker, 0.0) + overlap

        if overlap_by_speaker:
            chosen = max(overlap_by_speaker.items(), key=lambda item: item[1])[0]
            label = label_for(chosen)
        else:
            label = previous_label or "Speaker 1"

        updated = dict(segment)
        updated["speakerLabel"] = label
        labeled.append(updated)
        previous_label = label

    return labeled, max(len(order), 1 if labeled else 0)


def apply_diarization(
    config: Any,
    media_path: str,
    segments: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], str, str | None]:
    """Atttribute speakers when the vendored bundle is usable.

    Returns (segments, diarization_status, note). Any engine or bundle problem
    degrades to the historical single-speaker result with an explanatory note
    instead of failing the job (captain contract: never break a job).
    """

    if not getattr(config, "diarization_enabled", True):
        return segments, "degraded", None

    model_root = getattr(config, "model_root", None)
    if model_root is None:
        return (
            segments,
            "degraded",
            "Speaker separation unavailable (no model cache configured); all segments stay under Speaker 1.",
        )

    try:
        pipeline = cached_pipeline(model_root, getattr(config, "device", "cpu"))
    except Exception as exc:  # never break a job on bundle/load problems
        return (
            segments,
            "degraded",
            f"Speaker separation unavailable ({exc}); all segments stay under Speaker 1.",
        )

    try:
        tracks = diarize_media(pipeline, media_path)
    except Exception as exc:
        return (
            segments,
            "degraded",
            f"Speaker separation failed ({exc}); all segments stay under Speaker 1.",
        )

    if not tracks:
        return (
            segments,
            "degraded",
            "Speaker separation found no speech turns; all segments stay under Speaker 1.",
        )

    labeled, speaker_count = assign_speaker_labels(segments, tracks)
    return labeled, "available", note_for_speakers(speaker_count)


def note_for_speakers(speaker_count: int) -> str:
    if speaker_count <= 1:
        return (
            "Speaker separation ran locally (pyannote speaker-diarization-3.1) and "
            "found a single speaker."
        )
    return (
        f"Speaker separation ran locally (pyannote speaker-diarization-3.1) and "
        f"attributed {speaker_count} speakers."
    )
