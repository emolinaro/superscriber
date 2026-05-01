#!/usr/bin/env python3
from runtime_support import WorkerConfig, ensure_local_model


def main() -> int:
    config = WorkerConfig.from_env()
    model_path = ensure_local_model(config, allow_download=True)
    print(f"Prefetched transcription model '{config.model_name}' into {model_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
