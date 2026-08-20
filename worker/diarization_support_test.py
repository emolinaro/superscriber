"""diarization-bundle unit tests (worker side).

Runs under a plain python3 interpreter without the pyannote/torch stack:
  python3 worker/diarization_support_test.py
"""

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


def load_module(name: str, filename: str):
    module_dir = Path(__file__).resolve().parent
    if str(module_dir) not in sys.path:
        sys.path.insert(0, str(module_dir))
    spec = importlib.util.spec_from_file_location(name, module_dir / filename)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


diarization = load_module("diarization_support_under_test", "diarization_support.py")


def write_bundle(root: Path, pins: dict) -> Path:
    bundle_dir = root / "diarization"
    for part in pins["parts"].values():
        for entry in part["files"]:
            path = bundle_dir / entry["path"]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"\0" * entry["sizeBytes"])
    return bundle_dir


def pins_dict() -> dict:
    return {
        "bundleId": "pyannote-diarization-3.1",
        "parts": {
            "pipeline": {
                "repository": "pyannote/speaker-diarization-3.1",
                "revision": "a" * 40,
                "files": [{"path": "config.yaml", "sizeBytes": 4}],
            },
            "segmentation": {
                "repository": "pyannote/segmentation-3.0",
                "revision": "b" * 40,
                "files": [{"path": "segmentation/pytorch_model.bin", "sizeBytes": 8}],
            },
            "embedding": {
                "repository": "pyannote/wespeaker-voxceleb-resnet34-LM",
                "revision": "c" * 40,
                "files": [{"path": "embedding/pytorch_model.bin", "sizeBytes": 12}],
            },
        },
        "sizeBytes": 24,
    }


def segment(start_ms: int, end_ms: int, speaker: str = "Speaker 1") -> dict:
    return {
        "id": f"seg-{start_ms}",
        "speakerLabel": speaker,
        "startMs": start_ms,
        "endMs": end_ms,
        "text": "hello",
        "confidence": 0.9,
    }


class AssignSpeakerLabelsTest(unittest.TestCase):
    """(a) Happy path: a synthetic two-speaker track set assigns distinct,
    ordering-stable labels onto the faster-whisper segment grid."""

    def test_two_speaker_tracks_land_distinct_labels(self):
        segments = [
            segment(0, 4000),
            segment(4000, 9000),
            segment(9000, 12000),
        ]
        tracks = [
            (0.0, 5.0, "SPEAKER_00"),
            (5.0, 12.0, "SPEAKER_01"),
        ]

        labeled, count = diarization.assign_speaker_labels(segments, tracks)

        self.assertEqual(
            [item["speakerLabel"] for item in labeled],
            ["Speaker 1", "Speaker 2", "Speaker 2"],
        )
        self.assertEqual(count, 2)
        # First appearance wins the numbering: flipping the track order must
        # not change which segment is Speaker 1.
        flipped, _ = diarization.assign_speaker_labels(segments, list(reversed(tracks)))
        self.assertEqual(
            [item["speakerLabel"] for item in flipped],
            ["Speaker 1", "Speaker 2", "Speaker 2"],
        )

    def test_segment_without_overlapping_track_keeps_previous_speaker(self):
        segments = [segment(0, 1000), segment(1000, 2000), segment(2000, 3000)]
        tracks = [(0.0, 0.9, "SPEAKER_00")]  # gap from 0.9s on

        labeled, count = diarization.assign_speaker_labels(segments, tracks)

        self.assertEqual(
            [item["speakerLabel"] for item in labeled],
            ["Speaker 1", "Speaker 1", "Speaker 1"],
        )
        self.assertEqual(count, 1)

    def test_max_overlap_wins_split_segments(self):
        # Segment 1 straddles the turn boundary; the larger overlap decides
        # which speaker owns it. Segment 3 sits purely inside SPEAKER_00's
        # span, so equality with segment 1's label proves which way the vote
        # went even though numbering is appearance-ordered.
        segments = [segment(0, 3000), segment(3000, 6000), segment(6000, 9000)]

        tracks = [
            (0.0, 2.0, "SPEAKER_00"),
            (2.0, 6.0, "SPEAKER_01"),
            (6.0, 9.0, "SPEAKER_00"),
        ]
        labeled, count = diarization.assign_speaker_labels(segments, tracks)
        self.assertEqual(
            [item["speakerLabel"] for item in labeled],
            ["Speaker 1", "Speaker 2", "Speaker 1"],
        )
        self.assertEqual(count, 2)

        # Moving the boundary past the segment midpoint flips segment 1 onto
        # the other speaker while segment 3 stays anchored to SPEAKER_00.
        tracks = [
            (0.0, 1.0, "SPEAKER_00"),
            (1.0, 3.0, "SPEAKER_01"),
            (3.0, 9.0, "SPEAKER_00"),
        ]
        labeled, count = diarization.assign_speaker_labels(segments, tracks)
        self.assertEqual(
            [item["speakerLabel"] for item in labeled],
            ["Speaker 1", "Speaker 2", "Speaker 2"],
        )
        self.assertEqual(count, 2)


class BundlePresenceTest(unittest.TestCase):
    def test_ready_when_all_pinned_files_match_byte_sizes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pinned = pins_dict()
            write_bundle(root, pinned)
            with patch.object(diarization, "load_pins", return_value=pinned):
                self.assertTrue(diarization.diarization_bundle_ready(root))

    def test_missing_or_mismatched_bytes_is_not_ready(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pinned = pins_dict()
            with patch.object(diarization, "load_pins", return_value=pinned):
                self.assertFalse(diarization.diarization_bundle_ready(root))
            bundle_dir = write_bundle(root, pinned)
            with patch.object(diarization, "load_pins", return_value=pinned):
                self.assertTrue(diarization.diarization_bundle_ready(root))
            target = bundle_dir / "embedding/pytorch_model.bin"
            target.write_bytes(b"\0" * 5)
            with patch.object(diarization, "load_pins", return_value=pinned):
                self.assertEqual(
                    diarization.missing_bundle_files(root),
                    ["embedding/pytorch_model.bin"],
                )


class ApplyDiarizationFallbackTest(unittest.TestCase):
    """(b) Fallback degradation: any engine or bundle problem keeps the exact
    historical degraded path (single Speaker 1, status degraded, job alive)."""

    def config(self, tmp: str, **overrides):
        base = {
            "model_root": Path(tmp),
            "device": "cpu",
            "diarization_enabled": True,
        }
        base.update(overrides)
        return SimpleNamespace(**base)

    def test_missing_bundle_degrades_without_touching_segments(self):
        with tempfile.TemporaryDirectory() as tmp:
            segments = [segment(0, 1000), segment(1000, 2000)]
            labeled, status, note = diarization.apply_diarization(
                self.config(tmp), "/media/x.wav", segments
            )

        self.assertEqual(status, "degraded")
        self.assertEqual([item["speakerLabel"] for item in labeled], ["Speaker 1", "Speaker 1"])
        self.assertIn("Speaker separation unavailable", note)

    def test_engine_error_degrades_without_failing_the_job(self):
        with tempfile.TemporaryDirectory() as tmp:
            pinned = pins_dict()
            write_bundle(Path(tmp), pinned)
            config = self.config(tmp)
            with (
                patch.object(diarization, "load_pins", return_value=pinned),
                patch.object(diarization, "cached_pipeline", return_value=object()),
                patch.object(
                    diarization,
                    "diarize_media",
                    side_effect=RuntimeError("engine exploded"),
                ),
            ):
                segments = [segment(0, 1000)]
                labeled, status, note = diarization.apply_diarization(
                    config, "/media/x.wav", segments
                )

        self.assertEqual(status, "degraded")
        self.assertEqual(labeled[0]["speakerLabel"], "Speaker 1")
        self.assertIn("Speaker separation failed", note)

    def test_no_speech_turns_degrades(self):
        with tempfile.TemporaryDirectory() as tmp:
            pinned = pins_dict()
            write_bundle(Path(tmp), pinned)
            config = self.config(tmp)
            with (
                patch.object(diarization, "load_pins", return_value=pinned),
                patch.object(diarization, "cached_pipeline", return_value=object()),
                patch.object(diarization, "diarize_media", return_value=[]),
            ):
                labeled, status, note = diarization.apply_diarization(
                    config, "/media/x.wav", [segment(0, 1000)]
                )

        self.assertEqual(status, "degraded")
        self.assertEqual(labeled[0]["speakerLabel"], "Speaker 1")
        self.assertIn("no speech turns", note)

    def test_disabled_flag_skips_attribution_quietly(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = self.config(tmp, diarization_enabled=False)
            segments = [segment(0, 1000)]
            labeled, status, note = diarization.apply_diarization(
                config, "/media/x.wav", segments
            )

        self.assertEqual((status, note), ("degraded", None))
        self.assertIs(labeled, segments)

    def test_attribution_success_marks_available(self):
        with tempfile.TemporaryDirectory() as tmp:
            pinned = pins_dict()
            write_bundle(Path(tmp), pinned)
            config = self.config(tmp)
            tracks = [(0.0, 1.0, "SPEAKER_00"), (1.0, 2.0, "SPEAKER_01")]
            with (
                patch.object(diarization, "load_pins", return_value=pinned),
                patch.object(diarization, "cached_pipeline", return_value=object()),
                patch.object(diarization, "diarize_media", return_value=tracks),
            ):
                labeled, status, note = diarization.apply_diarization(
                    config, "/media/x.wav", [segment(0, 1000), segment(1000, 2000)]
                )

        self.assertEqual(status, "available")
        self.assertEqual(
            [item["speakerLabel"] for item in labeled], ["Speaker 1", "Speaker 2"]
        )
        self.assertIn("2 speakers", note)


class OfflineBundleLoadTest(unittest.TestCase):
    """(c) Offline operation: with HF_HUB_OFFLINE=1 the pinned local
    checkpoints instantiate the pipeline without touching the hub. A fake
    pyannote pipeline class records the substituted local checkpoint paths
    and asserts the offline flag is active during the load."""

    def test_load_pipeline_uses_local_checkpoints_under_hf_hub_offline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_text = (
                "version: 3.1.0\n"
                "pipeline:\n"
                "  name: pyannote.audio.pipelines.SpeakerDiarization\n"
                "  params:\n"
                "    segmentation: pyannote/segmentation-3.0\n"
                "    embedding: pyannote/wespeaker-voxceleb-resnet34-LM\n"
                "    segmentation_batch_size: 32\n"
                "params:\n"
                "  segmentation:\n"
                "    threshold: 0.444\n"
            )
            pinned = pins_dict()
            pinned["parts"]["pipeline"]["files"][0]["sizeBytes"] = len(
                config_text.encode("utf8")
            )
            bundle_dir = write_bundle(root, pinned)
            (bundle_dir / "config.yaml").write_text(config_text, encoding="utf8")

            captured = {}

            class FakePipeline:
                def __init__(self, **kwargs):
                    captured["kwargs"] = kwargs
                    assert os.environ.get("HF_HUB_OFFLINE") == "1"

                def instantiate(self, params):
                    captured["instantiated"] = params

                def to(self, device):
                    captured["device"] = device

            class FakeDeviceFactory:
                def __call__(self, name):
                    return f"device:{name}"

            fake_torch = SimpleNamespace(device=FakeDeviceFactory())
            parsed_config = {
                "pipeline": {
                    "params": {
                        "segmentation": "pyannote/segmentation-3.0",
                        "embedding": "pyannote/wespeaker-voxceleb-resnet34-LM",
                        "segmentation_batch_size": 32,
                    }
                },
                "params": {"segmentation": {"threshold": 0.444}},
            }
            fake_yaml = SimpleNamespace(safe_load=lambda text: dict(parsed_config))

            fake_pipelines = SimpleNamespace(SpeakerDiarization=FakePipeline)
            with (
                patch.object(diarization, "load_pins", return_value=pinned),
                patch.dict(
                    sys.modules,
                    {
                        "torch": fake_torch,
                        "pyannote": SimpleNamespace(),
                        "pyannote.audio": SimpleNamespace(),
                        "pyannote.audio.pipelines": fake_pipelines,
                        "yaml": fake_yaml,
                    },
                ),
                patch.dict(os.environ, {"HF_HUB_OFFLINE": "1"}),
            ):
                pipeline = diarization.load_pipeline(root, "cpu")

            self.assertIsInstance(pipeline, FakePipeline)
            segmentation = captured["kwargs"]["segmentation"]
            embedding = captured["kwargs"]["embedding"]
            self.assertEqual(
                segmentation["checkpoint"],
                str(bundle_dir / "segmentation/pytorch_model.bin"),
            )
            self.assertEqual(
                embedding["checkpoint"],
                str(bundle_dir / "embedding/pytorch_model.bin"),
            )
            self.assertEqual(captured["kwargs"]["segmentation_batch_size"], 32)
            self.assertEqual(
                captured["instantiated"], {"segmentation": {"threshold": 0.444}}
            )
            self.assertEqual(captured["device"], "device:cpu")


if __name__ == "__main__":
    unittest.main()
