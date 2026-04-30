import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch


def load_runtime_support():
    module_path = Path(__file__).with_name("runtime_support.py")
    spec = importlib.util.spec_from_file_location("runtime_support", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class WorkerConfigDefaultsTest(unittest.TestCase):
    def test_local_host_defaults_to_cpu_bootstrap_friendly_model_policy(self):
        runtime_support = load_runtime_support()
        with patch.dict(os.environ, {}, clear=True):
            with patch.object(runtime_support, "running_in_container", return_value=False):
                with patch.object(
                    runtime_support,
                    "resolve_device",
                    return_value=("cpu", "Auto-selected CPU because no compatible GPU runtime is available."),
                ):
                    config = runtime_support.WorkerConfig.from_env()

        self.assertFalse(config.offline)
        self.assertTrue(config.allow_runtime_download)
        self.assertEqual(config.device, "cpu")

    def test_container_defaults_stay_offline_and_no_download(self):
        runtime_support = load_runtime_support()
        with patch.dict(os.environ, {}, clear=True):
            with patch.object(runtime_support, "running_in_container", return_value=True):
                with patch.object(
                    runtime_support,
                    "resolve_device",
                    return_value=("cpu", "Auto-selected CPU because no compatible GPU runtime is available."),
                ):
                    config = runtime_support.WorkerConfig.from_env()

        self.assertTrue(config.offline)
        self.assertFalse(config.allow_runtime_download)

    def test_explicit_env_overrides_default_policy(self):
        runtime_support = load_runtime_support()
        with patch.dict(
            os.environ,
            {
                "SUPERSCRIBER_TRANSCRIBE_OFFLINE": "1",
                "SUPERSCRIBER_TRANSCRIBE_ALLOW_RUNTIME_DOWNLOAD": "0",
            },
            clear=True,
        ):
            with patch.object(runtime_support, "running_in_container", return_value=False):
                with patch.object(
                    runtime_support,
                    "resolve_device",
                    return_value=("cpu", "Auto-selected CPU because no compatible GPU runtime is available."),
                ):
                    config = runtime_support.WorkerConfig.from_env()

        self.assertTrue(config.offline)
        self.assertFalse(config.allow_runtime_download)


if __name__ == "__main__":
    unittest.main()
