import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


def load_http_probe():
    probe_path = Path(__file__).with_name("http_probe.py")
    spec = importlib.util.spec_from_file_location("http_probe", probe_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class HttpProbeTest(unittest.TestCase):
    def test_connection_reset_returns_retry_exit_code(self):
        http_probe = load_http_probe()

        with patch.object(http_probe.sys, "argv", ["http_probe.py", "http://127.0.0.1:3105/api/health"]):
            with patch.object(http_probe.request, "urlopen", side_effect=ConnectionResetError(104, "Connection reset by peer")):
                self.assertEqual(http_probe.main(), 1)


if __name__ == "__main__":
    unittest.main()
