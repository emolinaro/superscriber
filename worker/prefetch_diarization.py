#!/usr/bin/env python3
"""diarization-bundle: image-build prefetch for the pinned
speaker-diarization-3.1 bundle. Mirror of the TS installer
(src/server/models/diarization.ts via scripts/provision-model-tier.ts
--diarization), kept standalone so the Docker image build - which has no tsx
- can vendor the same pinned byte set into SUPERSCRIBER_TRANSCRIBE_MODEL_DIR.
Both installers read the single pins source worker/diarization-bundle.json.

The gated Hugging Face repos require a personal token for this one fetch; it
comes from SUPERSCRIBER_HUGGINGFACE_TOKEN or HF_TOKEN for the duration of
this process only and is never persisted (captain contract: one click-gate
acceptance per home, afterwards the runtime sees cached files only).
"""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

WORKER_DIR = Path(__file__).resolve().parent
PINS_PATH = WORKER_DIR / "diarization-bundle.json"
DOWNLOAD_BASE = "https://huggingface.co"
CHUNK_BYTES = 1024 * 1024


class DiarizationPrefetchError(RuntimeError):
    pass


def load_pins() -> dict:
    return json.loads(PINS_PATH.read_text(encoding="utf8"))


def bundle_root(model_root: Path) -> Path:
    return model_root / "diarization"


def downloads(pins: dict) -> list[dict]:
    plan = []
    for part in pins["parts"].values():
        for entry in part["files"]:
            remote_name = entry["path"].split("/")[-1]
            plan.append(
                {
                    "url": f"{DOWNLOAD_BASE}/{part['repository']}/resolve/{part['revision']}/{remote_name}",
                    "path": entry["path"],
                    "sizeBytes": entry["sizeBytes"],
                }
            )
    return plan


def is_provisioned(model_root: Path) -> bool:
    root = bundle_root(model_root)
    return all(
        (root / entry["path"]).is_file()
        and (root / entry["path"]).stat().st_size == entry["sizeBytes"]
        for entry in downloads(load_pins())
    )


def fetch(url: str, destination: Path, token: str) -> None:
    request = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {token}"}
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            destination.parent.mkdir(parents=True, exist_ok=True)
            with open(destination, "wb") as handle:
                while True:
                    chunk = response.read(CHUNK_BYTES)
                    if not chunk:
                        break
                    handle.write(chunk)
    except urllib.error.HTTPError as exc:
        raise DiarizationPrefetchError(
            f"HTTP {exc.code} from Hugging Face for {url}. A 401 means the "
            "token's account has not accepted the pyannote click-gate yet; "
            "see docs/operators/diarization.md."
        ) from exc
    except urllib.error.URLError as exc:
        raise DiarizationPrefetchError(f"Download failed for {url}: {exc}") from exc


def provision(model_root: Path, token: str | None) -> tuple[bool, str | None]:
    if is_provisioned(model_root):
        return True, None
    if not token:
        return False, (
            "Diarization bundle not provisioned and no Hugging Face token was "
            "supplied (SUPERSCRIBER_HUGGINGFACE_TOKEN or HF_TOKEN); skipping "
            "the one-time gated download. Speaker separation will run degraded "
            "until the bundle is provisioned. See docs/operators/diarization.md."
        )

    model_root.mkdir(parents=True, exist_ok=True)
    staging = model_root / ".diarization-provisioning"
    pins = load_pins()
    try:
        import shutil

        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(parents=True)
        for entry in downloads(pins):
            destination = staging / entry["path"]
            fetch(entry["url"], destination, token)
            size = destination.stat().st_size
            if size != entry["sizeBytes"]:
                raise DiarizationPrefetchError(
                    f"Downloaded {entry['path']} has {size} bytes, expected the pinned {entry['sizeBytes']}: {entry['url']}"
                )
        target = bundle_root(model_root)
        if target.exists():
            shutil.rmtree(target)
        staging.rename(target)
    except Exception:
        import shutil

        shutil.rmtree(staging, ignore_errors=True)
        raise
    return True, None


def main() -> int:
    model_root = Path(
        os.environ.get(
            "SUPERSCRIBER_TRANSCRIBE_MODEL_DIR", str(WORKER_DIR.parent / "models")
        )
    )
    token = (
        os.environ.get("SUPERSCRIBER_HUGGINGFACE_TOKEN", "").strip()
        or os.environ.get("HF_TOKEN", "").strip()
        or None
    )
    try:
        ok, warning = provision(model_root, token)
    except DiarizationPrefetchError as exc:
        print(f"Diarization bundle prefetch failed: {exc}", file=sys.stderr)
        return 1
    if warning:
        print(warning)
    if ok:
        print(
            f"Prefetched diarization bundle '{load_pins()['bundleId']}' into {bundle_root(model_root)}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
