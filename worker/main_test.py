import importlib.util
import sys
import tempfile
import weakref
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch


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
    def __init__(self) -> None:
        self.start = 0.0
        self.end = 1.0
        self.text = "hello"


class FakeModel:
    def __init__(self) -> None:
        self.calls = []

    def transcribe(self, media_path: str, language: str | None, vad_filter: bool):
        self.calls.append(
            {
                "media_path": media_path,
                "language": language,
                "vad_filter": vad_filter,
            }
        )
        return iter([FakeSegment()]), object()


class TranscriberLanguageBoundaryTest(unittest.TestCase):
    def test_transcribe_passes_normalized_language_code_to_model(self):
        worker_main = load_worker_main()
        fake_model = FakeModel()
        transcriber = worker_main.Transcriber(
            SimpleNamespace(device="cpu", model_name="tiny")
        )
        transcriber._model = fake_model
        transcriber._model_path = Path("/tmp/tiny")
        transcriber._model_name = "tiny"

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


class TranscriberModelLifecycleTest(unittest.TestCase):
    def test_releases_the_loaded_model_before_switching_and_reloads_default_after_failure(self):
        worker_main = load_worker_main()
        config = worker_main.WorkerConfig(
            base_url="http://localhost",
            worker_id="worker-test",
            poll_seconds=1,
            heartbeat_seconds=1,
            model_name="small",
            model_root=Path("/models"),
            offline=True,
            allow_runtime_download=False,
            allow_stub_fallback=False,
            secret=None,
            device="cpu",
            device_reason="test",
            compute_type="int8",
        )
        transcriber = worker_main.Transcriber(config)
        loaded_default = FakeModel()
        loaded_default_ref = weakref.ref(loaded_default)
        transcriber._model = loaded_default
        transcriber._model_path = Path("/models/small")
        transcriber._model_name = "small"
        del loaded_default

        constructed = []
        loaded_default_alive = []

        def build_model(model_path, **_kwargs):
            constructed.append(Path(model_path).name)
            if Path(model_path).name == "tiny":
                loaded_default_alive.append(loaded_default_ref() is not None)
                raise RuntimeError("override failed to load")
            return FakeModel()

        faster_whisper = SimpleNamespace(WhisperModel=build_model)
        with (
            patch.object(
                worker_main,
                "ensure_local_model",
                side_effect=lambda active_config: active_config.model_path,
            ),
            patch.object(worker_main, "configure_model_environment"),
            patch.dict(sys.modules, {"faster_whisper": faster_whisper}),
        ):
            model, model_path, used_default_instead = transcriber._load_model("tiny")

        self.assertIsInstance(model, FakeModel)
        self.assertEqual(model_path, Path("/models/small"))
        self.assertTrue(used_default_instead)
        self.assertEqual(loaded_default_alive, [False])
        self.assertEqual(constructed, ["tiny", "small"])


if __name__ == "__main__":
    unittest.main()
