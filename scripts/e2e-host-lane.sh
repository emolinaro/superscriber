#!/usr/bin/env bash
# Host-local e2e lane for the model provisioning work: builds the standalone
# server, serves it on a dedicated port with an isolated .tmp runtime, starts
# the Python worker beside it, and runs Playwright against the lane.
# Usage: bash scripts/e2e-host-lane.sh [playwright args...]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

PORT="${SUPERSCRIBER_E2E_HOST_PORT:-3199}"
RUN_ID="${SUPERSCRIBER_E2E_HOST_RUN_ID:-hostlane}"
DATA_DIR="${REPO_ROOT}/.tmp/e2e-data.${RUN_ID}"
MODEL_DIR="${REPO_ROOT}/.tmp/e2e-models.${RUN_ID}"
FIXTURE_DIR="${REPO_ROOT}/.tmp/e2e-model-fixture.${RUN_ID}"
mkdir -p "${DATA_DIR}" "${MODEL_DIR}" "${FIXTURE_DIR}"

cleanup() {
  if [[ -n "${APP_PID:-}" ]]; then kill "${APP_PID}" 2>/dev/null || true; fi
  if [[ -n "${WORKER_PID:-}" ]]; then kill "${WORKER_PID}" 2>/dev/null || true; fi
}
trap cleanup EXIT

if python3 "${REPO_ROOT}/scripts/http_probe.py" "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
  if [[ "${SUPERSCRIBER_E2E_HOST_REUSE:-0}" == "1" ]]; then
    echo "Reusing the server already answering on port ${PORT}."
  else
    echo "Refusing to start: port ${PORT} already answers /api/health." >&2
    echo "Stop the squatter (lsof -ti :${PORT}) or set SUPERSCRIBER_E2E_HOST_PORT." >&2
    exit 1
  fi
fi

DO_BUILD=1
if [[ "${1:-}" == "--no-build" ]]; then
  DO_BUILD=0
  shift
fi

if [[ "${DO_BUILD}" -eq 1 ]]; then
  npm run build >/dev/null
  cp -r .next/static .next/standalone/.next/static
  cp -r public .next/standalone/public >/dev/null 2>&1 || true
fi

export PORT="${PORT}"
export AUTH_URL="http://localhost:${PORT}" NEXTAUTH_URL="http://localhost:${PORT}"
export SUPERSCRIBER_DB_PATH="${DATA_DIR}/superscriber.db"
export SUPERSCRIBER_UPLOAD_TMP_DIR="${DATA_DIR}/uploads"
export SUPERSCRIBER_TRANSCRIBE_MODEL_DIR="${MODEL_DIR}"
export SUPERSCRIBER_MODEL_DOWNLOAD_FIXTURE_DIR="${FIXTURE_DIR}"
export SUPERSCRIBER_TRANSCRIBE_MODEL="missing-e2e-model"
export SUPERSCRIBER_TRANSCRIBE_OFFLINE=1
# Mirror the container worker contract: runtime downloads off (host default
# would be on), stub fallback on, so a missing configured model degrades to
# the stub summary instead of failing the job.
export SUPERSCRIBER_TRANSCRIBE_ALLOW_RUNTIME_DOWNLOAD=0
export SUPERSCRIBER_TRANSCRIBE_ALLOW_STUB_FALLBACK=1
export SUPERSCRIBER_ENGINE_SHARED_SECRET="e2e-shared-secret"
export SUPERSCRIBER_WORKER_POLL_SECONDS=1
export SUPERSCRIBER_WORKER_HEARTBEAT_SECONDS=2
export SUPERSCRIBER_APP_BASE_URL="http://localhost:${PORT}"

(cd .next/standalone && exec node server.js) > /tmp/e2e-host-lane-app.log 2>&1 &
APP_PID=$!
(exec bash scripts/run-worker-python.sh worker/main.py) > /tmp/e2e-host-lane-worker.log 2>&1 &
WORKER_PID=$!

for _ in $(seq 1 30); do
  if curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

export PLAYWRIGHT_BASE_URL="http://localhost:${PORT}"
export SUPERSCRIBER_E2E_MODEL_DIR="${MODEL_DIR}"
npx playwright test "$@"
