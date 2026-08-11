import importlib.util
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
import unittest


def load_worker_main():
    module_dir = Path(__file__).resolve().parent
    if str(module_dir) not in sys.path:
        sys.path.insert(0, str(module_dir))

    module_path = module_dir / "main.py"
    spec = importlib.util.spec_from_file_location("worker_main", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class ResolveModelLanguageTest(unittest.TestCase):
    def test_maps_product_language_labels_to_whisper_codes(self):
        worker_main = load_worker_main()

        self.assertEqual(worker_main.resolve_model_language("english"), "en")
        self.assertEqual(worker_main.resolve_model_language("danish"), "da")
        self.assertEqual(worker_main.resolve_model_language("german"), "de")
        self.assertEqual(worker_main.resolve_model_language("spanish"), "es")

    def test_treats_mixed_or_unknown_as_auto_detect(self):
        worker_main = load_worker_main()

        self.assertIsNone(worker_main.resolve_model_language(""))
        self.assertIsNone(worker_main.resolve_model_language("mixed"))
        self.assertIsNone(worker_main.resolve_model_language("unknown"))

    def test_normalizes_locale_suffixes(self):
        worker_main = load_worker_main()

        self.assertEqual(worker_main.resolve_model_language("en-US"), "en")
        self.assertEqual(worker_main.resolve_model_language("pt_BR"), "pt")


class FakeSegment:
    def __init__(self, start: float = 0.0, end: float = 1.0) -> None:
        self.start = start
        self.end = end
        self.text = "hello"


class FakeModel:
    def __init__(self, segments=None, duration: float | None = None) -> None:
        self.calls = []
        self._segments = segments if segments is not None else [FakeSegment()]
        self._info = SimpleNamespace(duration=duration)

    def transcribe(self, media_path: str, language: str | None, vad_filter: bool):
        self.calls.append(
            {
                "media_path": media_path,
                "language": language,
                "vad_filter": vad_filter,
            }
        )
        return iter(self._segments), self._info


class TranscriberLanguageBoundaryTest(unittest.TestCase):
    def test_transcribe_passes_normalized_language_code_to_model(self):
        worker_main = load_worker_main()
        fake_model = FakeModel()
        transcriber = worker_main.Transcriber(SimpleNamespace(device="cpu"))
        transcriber._model = fake_model
        transcriber._model_path = Path("/tmp/tiny")

        with tempfile.NamedTemporaryFile() as media_file:
            _summary, segments, diarization_status = transcriber.transcribe(
                {
                    "mediaPath": media_file.name,
                    "languageHint": "english",
                }
            )

        self.assertEqual(fake_model.calls[0]["language"], "en")
        self.assertEqual(len(segments), 1)
        self.assertEqual(diarization_status, "degraded")


class TranscriberProgressTest(unittest.TestCase):
    def test_emits_engine_progress_samples_per_segment(self):
        worker_main = load_worker_main()
        fake_model = FakeModel(
            segments=[FakeSegment(0.0, 1.5), FakeSegment(1.5, 4.25), FakeSegment(4.25, 9.0)],
            duration=12.0,
        )
        transcriber = worker_main.Transcriber(SimpleNamespace(device="cpu"))
        transcriber._model = fake_model
        transcriber._model_path = Path("/tmp/tiny")

        samples = []
        with tempfile.NamedTemporaryFile() as media_file:
            _summary, segments, _status = transcriber.transcribe(
                {"mediaPath": media_file.name, "languageHint": "english"},
                on_progress=lambda until_ms, duration_ms, count: samples.append(
                    (until_ms, duration_ms, count)
                ),
            )

        self.assertEqual(len(segments), 3)
        self.assertEqual(
            samples,
            [
                (1500, 12000, 1),
                (4250, 12000, 2),
                (9000, 12000, 3),
            ],
        )

    def test_progress_samples_tolerate_missing_media_duration(self):
        worker_main = load_worker_main()
        fake_model = FakeModel(segments=[FakeSegment(0.0, 2.0)], duration=None)
        transcriber = worker_main.Transcriber(SimpleNamespace(device="cpu"))
        transcriber._model = fake_model
        transcriber._model_path = Path("/tmp/tiny")

        samples = []
        with tempfile.NamedTemporaryFile() as media_file:
            transcriber.transcribe(
                {"mediaPath": media_file.name, "languageHint": "english"},
                on_progress=lambda until_ms, duration_ms, count: samples.append(
                    (until_ms, duration_ms, count)
                ),
            )

        self.assertEqual(samples, [(2000, None, 1)])


class HeartbeatLoopSimulationTest(unittest.TestCase):
    """Simulated worker run: engine samples land on the loop, the next
    heartbeat post carries them to the app API verbatim."""

    def test_heartbeat_posts_engine_samples_after_progress_updates(self):
        worker_main = load_worker_main()

        posted = []

        def fake_post_json(config, path, payload):
            posted.append((path, dict(payload)))
            return {}

        original_post = worker_main.post_json
        worker_main.post_json = fake_post_json
        try:
            config = SimpleNamespace(
                worker_id="sim-worker",
                base_url="http://app.test",
                secret=None,
                heartbeat_seconds=0.02,
            )
            loop = worker_main.HeartbeatLoop(config, "job-1")
            loop.update(
                transcribed_until_ms=4250,
                audio_duration_ms=12000,
                segments_seen=2,
            )
            loop.start()
            try:
                deadline = time.time() + 2.0
                while not posted and time.time() < deadline:
                    time.sleep(0.01)
            finally:
                loop.stop()
        finally:
            worker_main.post_json = original_post

        self.assertTrue(posted, "expected at least one simulated heartbeat post")
        path, payload = posted[-1]
        self.assertEqual(path, "/api/internal/transcript-jobs/job-1/heartbeat")
        self.assertEqual(payload["workerId"], "sim-worker")
        self.assertEqual(payload["state"], "running")
        self.assertEqual(payload["transcribedUntilMs"], 4250)
        self.assertEqual(payload["audioDurationMs"], 12000)
        self.assertEqual(payload["segmentsSeen"], 2)

    def test_fresh_loop_posts_no_progress_yet(self):
        worker_main = load_worker_main()

        posted = []

        def fake_post_json(config, path, payload):
            posted.append(dict(payload))
            return {}

        original_post = worker_main.post_json
        worker_main.post_json = fake_post_json
        try:
            config = SimpleNamespace(
                worker_id="sim-worker",
                base_url="http://app.test",
                secret=None,
                heartbeat_seconds=0.02,
            )
            loop = worker_main.HeartbeatLoop(config, "job-2")
            loop.start()
            try:
                deadline = time.time() + 2.0
                while not posted and time.time() < deadline:
                    time.sleep(0.01)
            finally:
                loop.stop()
        finally:
            worker_main.post_json = original_post

        self.assertTrue(posted)
        self.assertIsNone(posted[-1]["progressPercent"])
        self.assertIsNone(posted[-1]["transcribedUntilMs"])
        self.assertIsNone(posted[-1]["segmentsSeen"])

    def test_progress_updates_send_immediately_then_coalesce_until_final_flush(self):
        worker_main = load_worker_main()
        posted = []

        def fake_post_json(config, path, payload):
            posted.append((time.monotonic(), dict(payload)))
            return {}

        original_post = worker_main.post_json
        worker_main.post_json = fake_post_json
        try:
            config = SimpleNamespace(
                worker_id="sim-worker",
                base_url="http://app.test",
                secret=None,
                heartbeat_seconds=60.0,
            )
            loop = worker_main.HeartbeatLoop(config, "job-throttled")
            loop.start()
            try:
                first_update_at = time.monotonic()
                loop.update(
                    transcribed_until_ms=1_000,
                    audio_duration_ms=10_000,
                    segments_seen=1,
                )
                deadline = time.time() + 2.0
                while not posted and time.time() < deadline:
                    time.sleep(0.01)

                self.assertEqual(len(posted), 1)
                self.assertLess(posted[0][0] - first_update_at, 0.5)

                loop.update(
                    transcribed_until_ms=2_000,
                    audio_duration_ms=10_000,
                    segments_seen=2,
                )
                loop.update(
                    transcribed_until_ms=3_000,
                    audio_duration_ms=10_000,
                    segments_seen=3,
                )
                time.sleep(1.0)
                self.assertEqual(len(posted), 1)

                flush_started_at = time.monotonic()
                loop.flush()
                self.assertEqual(len(posted), 2)
                self.assertLess(posted[1][0] - flush_started_at, 0.5)
                self.assertEqual(posted[1][1]["transcribedUntilMs"], 3_000)
                self.assertEqual(posted[1][1]["segmentsSeen"], 3)
            finally:
                loop.stop()
        finally:
            worker_main.post_json = original_post


class ProcessJobProgressTest(unittest.TestCase):
    def test_short_job_posts_engine_sample_before_completion(self):
        worker_main = load_worker_main()
        posted = []

        class ShortTranscriber:
            def transcribe(self, job, on_progress=None):
                self.assert_progress_callback(on_progress)
                on_progress(4_250, 12_000, 2)
                return "Ready", [{"id": "seg-1"}], "degraded"

            @staticmethod
            def assert_progress_callback(on_progress):
                if on_progress is None:
                    raise AssertionError("expected process_job to provide a progress callback")

        def fake_post_json(config, path, payload):
            posted.append((path, dict(payload)))
            return {}

        original_post = worker_main.post_json
        worker_main.post_json = fake_post_json
        try:
            config = SimpleNamespace(
                worker_id="sim-worker",
                base_url="http://app.test",
                secret=None,
                heartbeat_seconds=60.0,
                allow_stub_fallback=False,
                device="cpu",
            )
            worker_main.process_job(
                config,
                ShortTranscriber(),
                {"jobId": "job-short", "title": "Short recording"},
            )
        finally:
            worker_main.post_json = original_post

        heartbeat_posts = [
            (index, payload)
            for index, (path, payload) in enumerate(posted)
            if path == "/api/internal/transcript-jobs/job-short/heartbeat"
        ]
        self.assertEqual(len(heartbeat_posts), 1)
        heartbeat_index, heartbeat_payload = heartbeat_posts[0]
        complete_index = next(
            index
            for index, (path, _payload) in enumerate(posted)
            if path == "/api/internal/transcript-jobs/job-short/complete"
        )
        self.assertLess(heartbeat_index, complete_index)
        self.assertEqual(heartbeat_payload["transcribedUntilMs"], 4_250)
        self.assertEqual(heartbeat_payload["audioDurationMs"], 12_000)
        self.assertEqual(heartbeat_payload["segmentsSeen"], 2)


if __name__ == "__main__":
    unittest.main()
