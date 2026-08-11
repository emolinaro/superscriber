#!/usr/bin/env python3
import json
import sys
import threading
import time
from pathlib import Path
from typing import Any
from urllib import error, request

from runtime_support import (
    ModelUnavailable,
    SpeechStackUnavailable,
    WorkerConfig,
    configure_model_environment,
    ensure_local_model,
)


LANGUAGE_HINT_ALIASES = {
    "english": "en",
    "danish": "da",
    "german": "de",
    "spanish": "es",
}


def resolve_model_language(language_hint: Any) -> str | None:
    normalized = str(language_hint or "").strip().lower()
    if normalized in {"", "mixed", "unknown"}:
        return None

    normalized = LANGUAGE_HINT_ALIASES.get(normalized, normalized)
    for separator in ("-", "_"):
        if separator in normalized:
            return normalized.split(separator, 1)[0]

    return normalized


def post_json(
    config: WorkerConfig,
    path: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    headers = {"content-type": "application/json"}
    if config.secret:
        headers["authorization"] = f"Bearer {config.secret}"

    req = request.Request(
        f"{config.base_url}{path}",
        data=json.dumps(payload).encode("utf8"),
        headers=headers,
        method="POST",
    )

    try:
        with request.urlopen(req, timeout=30) as response:
            raw = response.read().decode("utf8")
            return json.loads(raw) if raw else {}
    except error.HTTPError as exc:
        body = exc.read().decode("utf8", errors="replace")
        raise RuntimeError(f"{exc.code} {exc.reason}: {body}") from exc


def build_mock_transcript(job: dict[str, Any]) -> tuple[str, list[dict[str, Any]], str]:
    title = str(job.get("title") or "Untitled recording")
    summary = (
        f"Degraded fallback transcript prepared locally for '{title}'. "
        "The configured appliance speech model was unavailable."
    )

    segments = [
        {
            "id": "seg-1",
            "speakerLabel": "Speaker 1",
            "startMs": 0,
            "endMs": 8000,
            "text": f"Fallback transcript generated for {title}.",
            "confidence": 0.72,
        },
        {
            "id": "seg-2",
            "speakerLabel": "Speaker 1",
            "startMs": 8000,
            "endMs": 16000,
            "text": "The configured offline transcription model could not be used for this job.",
            "confidence": 0.72,
        },
    ]

    return summary, segments, "degraded"


class Transcriber:
    def __init__(self, config: WorkerConfig) -> None:
        self.config = config
        self._model: Any | None = None
        self._model_path: Path | None = None
        self._model_name: str | None = None

    def preflight(self) -> None:
        self._load_model()

    def _load_model(self, override_name: str | None = None) -> tuple[Any, Path, bool]:
        """demo-advanced-model-picker: jobs may name a per-recording model.

        An override this host cannot provision or load falls back to the
        configured default instead of wedging the job (returns fallback=True;
        the summary then names the bundle that actually ran). The configured
        default itself stays load-or-raise.
        """
        from dataclasses import replace

        name = (override_name or "").strip() or self.config.model_name
        if (
            self._model is not None
            and self._model_path is not None
            and self._model_name == name
        ):
            return self._model, self._model_path, False

        config = replace(self.config, model_name=name)
        configure_model_environment(config)
        try:
            model_path = ensure_local_model(config)
        except (ModelUnavailable, SpeechStackUnavailable):
            if name == self.config.model_name:
                raise
            model, model_path, _ = self._load_model(None)
            return model, model_path, True

        try:
            from faster_whisper import WhisperModel  # type: ignore
        except Exception as exc:
            raise SpeechStackUnavailable("faster-whisper is not installed.") from exc

        self._model = None
        self._model_path = None
        self._model_name = None
        try:
            model = WhisperModel(
                str(model_path),
                device=config.device,
                compute_type=config.compute_type,
                download_root=str(config.model_root),
                local_files_only=True,
            )
        except Exception:
            if name == self.config.model_name:
                raise
            model, model_path, _ = self._load_model(None)
            return model, model_path, True

        self._model = model
        self._model_path = model_path
        self._model_name = name
        return model, model_path, False

    def transcribe(
        self,
        job: dict[str, Any],
        on_progress: Any | None = None,
    ) -> tuple[str, list[dict[str, Any]], str]:
        media_path = str(job.get("mediaPath") or "")
        if not media_path:
            raise FileNotFoundError("No media path was provided for the claimed job.")
        if not Path(media_path).exists():
            raise FileNotFoundError(f"Media file does not exist: {media_path}")

        # demo-advanced-model-picker: the recording's stored tier pick; absent
        # means the configured default. Unrunnable overrides fall back to the
        # default and the summary says so.
        requested_model = str(job.get("transcriptModel") or "").strip() or None
        model, model_path, used_default_instead = self._load_model(requested_model)
        language = resolve_model_language(job.get("languageHint"))
        segments_iter, _info = model.transcribe(
            media_path,
            language=language,
            vad_filter=True,
        )

        duration_ms = None
        try:
            if getattr(_info, "duration", None):
                duration_ms = int(float(_info.duration) * 1000)
        except Exception:
            duration_ms = None

        segments: list[dict[str, Any]] = []
        for index, segment in enumerate(segments_iter):
            if on_progress is not None:
                on_progress(int(segment.end * 1000), duration_ms, index + 1)
            segments.append(
                {
                    "id": f"seg-{index + 1}",
                    "speakerLabel": "Speaker 1",
                    "startMs": int(segment.start * 1000),
                    "endMs": int(segment.end * 1000),
                    "text": str(segment.text).strip(),
                    "confidence": 0.9,
                }
            )

        if not segments:
            raise RuntimeError("Transcription finished without producing transcript segments.")

        summary = (
            f"Transcript prepared by faster-whisper on {self.config.device} "
            f"using local model bundle {model_path.name}. Speaker separation remains degraded until diarization is added."
        )
        if used_default_instead:
            summary += (
                f" Requested model '{requested_model}' is not provisioned on this host;"
                f" ran the default '{self.config.model_name}' instead."
            )
        return summary, segments, "degraded"


class HeartbeatLoop:
    PROGRESS_HEARTBEAT_SECONDS = 2.0

    def __init__(self, config: WorkerConfig, job_id: str) -> None:
        self.config = config
        self.job_id = job_id
        self.state = "running"
        # No staged base percent: engine samples drive the bar; before the
        # first sample the app keeps the claim-time progress value.
        self.progress: int | None = None
        self.eta_seconds = 90
        self.transcribed_until_ms: int | None = None
        self.audio_duration_ms: int | None = None
        self.segments_seen: int | None = None
        self.diarization_status = "pending"
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._state_lock = threading.Lock()
        self._send_lock = threading.Lock()
        self._update_version = 0
        self._sent_version = 0
        self._last_progress_post_at: float | None = None
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        self._thread.join(timeout=2)

    def update(
        self,
        *,
        state: str | None = None,
        progress: int | None = None,
        eta_seconds: int | None = None,
        diarization_status: str | None = None,
        transcribed_until_ms: int | None = None,
        audio_duration_ms: int | None = None,
        segments_seen: int | None = None,
    ) -> None:
        changed = False
        with self._state_lock:
            if state is not None:
                self.state = state
                changed = True
            if progress is not None:
                self.progress = progress
                changed = True
            if eta_seconds is not None:
                self.eta_seconds = eta_seconds
                changed = True
            if diarization_status is not None:
                self.diarization_status = diarization_status
                changed = True
            if transcribed_until_ms is not None:
                self.transcribed_until_ms = transcribed_until_ms
                changed = True
            if audio_duration_ms is not None:
                self.audio_duration_ms = audio_duration_ms
                changed = True
            if segments_seen is not None:
                self.segments_seen = segments_seen
                changed = True
            if changed:
                self._update_version += 1
        if changed:
            self._wake.set()

    def flush(self) -> None:
        try:
            self._post_heartbeat(pending_only=True)
        except Exception as exc:
            print(f"[worker] heartbeat failed for {self.job_id}: {exc}", file=sys.stderr)

    def _progress_send_delay(self) -> float:
        with self._send_lock:
            if self._last_progress_post_at is None:
                return 0
            elapsed = time.monotonic() - self._last_progress_post_at
            return max(0, self.PROGRESS_HEARTBEAT_SECONDS - elapsed)

    def _post_heartbeat(self, *, pending_only: bool = False) -> None:
        with self._send_lock:
            with self._state_lock:
                version = self._update_version
                has_pending_update = self._sent_version < version
                if pending_only and not has_pending_update:
                    return
                payload = {
                    "workerId": self.config.worker_id,
                    "state": self.state,
                    "progressPercent": self.progress,
                    "etaSeconds": self.eta_seconds,
                    "diarizationStatus": self.diarization_status,
                    "transcribedUntilMs": self.transcribed_until_ms,
                    "audioDurationMs": self.audio_duration_ms,
                    "segmentsSeen": self.segments_seen,
                }

            post_json(
                self.config,
                f"/api/internal/transcript-jobs/{self.job_id}/heartbeat",
                payload,
            )
            if has_pending_update:
                self._last_progress_post_at = time.monotonic()
            with self._state_lock:
                self._sent_version = max(self._sent_version, version)

    def _run(self) -> None:
        while not self._stop.is_set():
            woke_for_update = self._wake.wait(self.config.heartbeat_seconds)
            self._wake.clear()
            if self._stop.is_set():
                return
            try:
                if woke_for_update:
                    delay = self._progress_send_delay()
                    if delay > 0 and self._stop.wait(delay):
                        return
                    self._post_heartbeat(pending_only=True)
                else:
                    self._post_heartbeat()
            except Exception as exc:
                print(f"[worker] heartbeat failed for {self.job_id}: {exc}", file=sys.stderr)


def complete_job(
    config: WorkerConfig,
    job_id: str,
    summary: str,
    segments: list[dict[str, Any]],
    diarization_status: str,
) -> None:
    post_json(
        config,
        f"/api/internal/transcript-jobs/{job_id}/complete",
        {
            "workerId": config.worker_id,
            "summary": summary,
            "segments": segments,
            "diarizationStatus": diarization_status,
        },
    )


def fail_job(
    config: WorkerConfig,
    job_id: str,
    detail: str,
    *,
    retryable: bool,
) -> None:
    post_json(
        config,
        f"/api/internal/transcript-jobs/{job_id}/fail",
        {
            "workerId": config.worker_id,
            "detail": detail,
            "retryable": retryable,
        },
    )


def process_job(config: WorkerConfig, transcriber: Transcriber, job: dict[str, Any]) -> None:
    job_id = str(job["jobId"])
    heartbeat = HeartbeatLoop(config, job_id)
    heartbeat.start()

    try:
        def on_engine_progress(until_ms: int, duration_ms: int | None, count: int) -> None:
            heartbeat.update(
                transcribed_until_ms=until_ms,
                audio_duration_ms=duration_ms,
                segments_seen=count,
            )

        try:
            summary, segments, diarization_status = transcriber.transcribe(
                job, on_progress=on_engine_progress
            )
        except (ModelUnavailable, SpeechStackUnavailable) as exc:
            if not config.allow_stub_fallback:
                raise

            print(f"[worker] degraded fallback for {job_id}: {exc}", file=sys.stderr)
            summary, segments, diarization_status = build_mock_transcript(job)
            # The persisted per-recording pick must stay visible even when the
            # run degrades to the stub engine - it proved the choice reached
            # the worker.
            requested_model = str(job.get("transcriptModel") or "").strip()
            if requested_model:
                summary += (
                    f" Requested model '{requested_model}' could not run on this host;"
                    " the degraded fallback engine produced this transcript instead."
                )

        heartbeat.flush()
        complete_job(config, job_id, summary, segments, diarization_status)
        print(
            f"[worker] completed {job_id} with {len(segments)} segment(s) on {config.device}"
        )
    except Exception as exc:
        retryable = not isinstance(exc, FileNotFoundError)
        detail = f"Internal worker failed: {exc}"
        try:
            fail_job(config, job_id, detail, retryable=retryable)
        except Exception as fail_exc:
            print(
                f"[worker] failed to report job failure for {job_id}: {fail_exc}",
                file=sys.stderr,
            )
        print(f"[worker] failed {job_id}: {detail}", file=sys.stderr)
    finally:
        heartbeat.stop()


def claim_job(config: WorkerConfig) -> dict[str, Any] | None:
    response = post_json(
        config,
        "/api/internal/transcript-jobs/claim",
        {
            "workerId": config.worker_id,
            "staleAfterMs": int(max(config.heartbeat_seconds * 4, 30) * 1000),
        },
    )
    return response.get("job")


def main() -> int:
    config = WorkerConfig.from_env()
    transcriber = Transcriber(config)

    print(
        f"[worker] starting id={config.worker_id} base_url={config.base_url} "
        f"device={config.device} compute_type={config.compute_type}"
    )
    print(f"[worker] device policy: {config.device_reason}")

    try:
        transcriber.preflight()
        print(
            f"[worker] ready with offline model '{config.model_name}' in {config.model_path}"
        )
    except Exception as exc:
        if config.allow_stub_fallback:
            print(
                f"[worker] startup degraded fallback enabled because model preflight failed: {exc}",
                file=sys.stderr,
            )
        else:
            print(f"[worker] startup failed: {exc}", file=sys.stderr)
            return 1

    while True:
        try:
            job = claim_job(config)
            if not job:
                time.sleep(config.poll_seconds)
                continue

            process_job(config, transcriber, job)
        except KeyboardInterrupt:
            print("[worker] stopping")
            return 0
        except Exception as exc:
            print(f"[worker] polling error: {exc}", file=sys.stderr)
            time.sleep(config.poll_seconds)


if __name__ == "__main__":
    raise SystemExit(main())
