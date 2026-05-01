#!/usr/bin/env python3
import os
import socket
import subprocess
from dataclasses import dataclass
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
ENGINE_SECRET_FILE = REPO_ROOT / "data" / "engine.secret"


class SpeechStackUnavailable(RuntimeError):
    pass


class ModelUnavailable(RuntimeError):
    pass


def load_engine_secret() -> str | None:
    from_env = os.environ.get("SUPERSCRIBER_ENGINE_SHARED_SECRET", "").strip()
    if from_env:
        return from_env

    if ENGINE_SECRET_FILE.exists():
        return ENGINE_SECRET_FILE.read_text(encoding="utf8").strip()

    return None


def env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default

    normalized = raw.strip().lower()
    return normalized not in {"0", "false", "no", "off", ""}


def running_in_container() -> bool:
    return Path("/.dockerenv").exists()


def default_offline_mode() -> bool:
    return running_in_container()


def default_allow_runtime_download() -> bool:
    return not running_in_container()


def slugify_model_name(model_name: str) -> str:
    return model_name.replace("/", "--").replace(":", "--")


def detect_cuda_available() -> bool:
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            return True
    except Exception:
        pass

    try:
        result = subprocess.run(
            ["nvidia-smi", "-L"],
            check=False,
            capture_output=True,
            text=True,
        )
        return result.returncode == 0 and bool(result.stdout.strip())
    except Exception:
        return False


def resolve_device(selection: str) -> tuple[str, str]:
    normalized = selection.strip().lower()
    cuda_available = detect_cuda_available()

    if normalized == "cpu":
        return "cpu", "CPU forced by SUPERSCRIBER_TRANSCRIBE_DEVICE."

    if normalized == "cuda":
        if not cuda_available:
            raise RuntimeError(
                "CUDA was explicitly requested, but no compatible GPU runtime is available."
            )
        return "cuda", "CUDA forced by SUPERSCRIBER_TRANSCRIBE_DEVICE."

    if normalized not in {"", "auto"}:
        raise RuntimeError(
            "SUPERSCRIBER_TRANSCRIBE_DEVICE must be one of auto, cpu, or cuda."
        )

    if cuda_available:
        return "cuda", "Auto-selected CUDA because a compatible GPU runtime is available."

    return "cpu", "Auto-selected CPU because no compatible GPU runtime is available."


@dataclass
class WorkerConfig:
    base_url: str
    worker_id: str
    poll_seconds: float
    heartbeat_seconds: float
    model_name: str
    model_root: Path
    offline: bool
    allow_runtime_download: bool
    allow_stub_fallback: bool
    secret: str | None
    device: str
    device_reason: str
    compute_type: str

    @classmethod
    def from_env(cls) -> "WorkerConfig":
        device, device_reason = resolve_device(
            os.environ.get("SUPERSCRIBER_TRANSCRIBE_DEVICE", "auto")
        )
        compute_type = os.environ.get(
            (
                "SUPERSCRIBER_TRANSCRIBE_GPU_COMPUTE_TYPE"
                if device == "cuda"
                else "SUPERSCRIBER_TRANSCRIBE_CPU_COMPUTE_TYPE"
            ),
            "float16" if device == "cuda" else "int8",
        ).strip()

        return cls(
            base_url=os.environ.get(
                "SUPERSCRIBER_APP_BASE_URL", "http://127.0.0.1:3000"
            ).rstrip("/"),
            worker_id=os.environ.get(
                "SUPERSCRIBER_WORKER_ID", f"worker-{socket.gethostname()}"
            ),
            poll_seconds=float(
                os.environ.get("SUPERSCRIBER_WORKER_POLL_SECONDS", "5")
            ),
            heartbeat_seconds=float(
                os.environ.get("SUPERSCRIBER_WORKER_HEARTBEAT_SECONDS", "15")
            ),
            model_name=os.environ.get("SUPERSCRIBER_TRANSCRIBE_MODEL", "small").strip()
            or "small",
            model_root=Path(
                os.environ.get(
                    "SUPERSCRIBER_TRANSCRIBE_MODEL_DIR",
                    str(REPO_ROOT / "models"),
                )
            ),
            offline=env_flag("SUPERSCRIBER_TRANSCRIBE_OFFLINE", default_offline_mode()),
            allow_runtime_download=env_flag(
                "SUPERSCRIBER_TRANSCRIBE_ALLOW_RUNTIME_DOWNLOAD",
                default_allow_runtime_download(),
            ),
            allow_stub_fallback=env_flag(
                "SUPERSCRIBER_TRANSCRIBE_ALLOW_STUB_FALLBACK", False
            ),
            secret=load_engine_secret(),
            device=device,
            device_reason=device_reason,
            compute_type=compute_type,
        )

    @property
    def model_path(self) -> Path:
        return self.model_root / slugify_model_name(self.model_name)


def configure_model_environment(config: WorkerConfig) -> None:
    config.model_root.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_HOME", str(config.model_root / ".hf-home"))
    os.environ.setdefault(
        "HUGGINGFACE_HUB_CACHE",
        str(config.model_root / ".hf-home" / "hub"),
    )

    if config.offline:
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
    else:
        os.environ.pop("HF_HUB_OFFLINE", None)
        os.environ.pop("TRANSFORMERS_OFFLINE", None)


def model_artifacts_present(model_path: Path) -> bool:
    return (
        model_path.exists()
        and model_path.is_dir()
        and (model_path / "config.json").exists()
        and (model_path / "model.bin").exists()
    )


def ensure_local_model(config: WorkerConfig, *, allow_download: bool | None = None) -> Path:
    configure_model_environment(config)

    model_path = config.model_path
    if model_artifacts_present(model_path):
        return model_path

    should_download = (
        config.allow_runtime_download if allow_download is None else allow_download
    )
    if not should_download:
        raise ModelUnavailable(
            "The configured transcription model is not present locally and runtime downloads are disabled. "
            "Rebuild the image with model prefetch enabled or set SUPERSCRIBER_TRANSCRIBE_ALLOW_RUNTIME_DOWNLOAD=1."
        )

    try:
        from faster_whisper.utils import download_model  # type: ignore
    except Exception as exc:
        raise SpeechStackUnavailable("faster-whisper is not installed.") from exc

    model_path.parent.mkdir(parents=True, exist_ok=True)
    download_model(
        config.model_name,
        output_dir=str(model_path),
        local_files_only=False,
    )

    if not model_artifacts_present(model_path):
        raise ModelUnavailable(
            "The transcription model download finished without producing the expected local files."
        )

    return model_path
