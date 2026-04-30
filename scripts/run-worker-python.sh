#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${SUPERSCRIBER_WORKER_PYTHON:-}" ]]; then
  PYTHON_BIN="${SUPERSCRIBER_WORKER_PYTHON}"
elif [[ -x ".venv/bin/python3" ]]; then
  PYTHON_BIN=".venv/bin/python3"
else
  PYTHON_BIN="python3"
fi

exec "${PYTHON_BIN}" "$@"
