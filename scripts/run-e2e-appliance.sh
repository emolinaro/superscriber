#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-test}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TMP_ROOT="${REPO_ROOT}/.tmp"

IMAGE="${SUPERSCRIBER_E2E_IMAGE:-superscriber:e2e}"
CONTAINER_NAME="${SUPERSCRIBER_E2E_CONTAINER_NAME:-superscriber-e2e}"
PORT="${SUPERSCRIBER_E2E_PORT:-3105}"
APP_URL="${PLAYWRIGHT_BASE_URL:-http://127.0.0.1:${PORT}}"
mkdir -p "${TMP_ROOT}"
DATA_DIR_CREATED=0
if [[ -n "${SUPERSCRIBER_E2E_DATA_DIR:-}" ]]; then
  DATA_DIR="${SUPERSCRIBER_E2E_DATA_DIR}"
else
  DATA_DIR="$(mktemp -d "${TMP_ROOT}/e2e-data.XXXXXX")"
  DATA_DIR_CREATED=1
fi
BUILD_MODEL="${SUPERSCRIBER_E2E_BUILD_MODEL:-tiny}"
PRELOAD_MODEL="${SUPERSCRIBER_E2E_PRELOAD_MODEL:-0}"

# The container flow pins a deliberately missing model and enables the Python
# stub fallback (see start_container), so transcripts render the stub's fixed
# confidence. The Playwright suite reads this signal to keep its confidence
# assertions engine-aware instead of hard-coding one engine's values.
export SUPERSCRIBER_E2E_ENGINE="stub"

# Point the suite's DB write helpers at the container so they execute inside
# it, on the app's own kernel and user. Host-side writes to the bind-mounted
# database lose the permission battle on Linux CI (container-owned files) and
# are invisible to the app's held WAL connection over macOS VM file sharing.
export SUPERSCRIBER_E2E_CONTAINER_NAME="${CONTAINER_NAME}"
export SUPERSCRIBER_E2E_CONTAINER_DB_PATH="${SUPERSCRIBER_E2E_CONTAINER_DB_PATH:-/app/data/superscriber.db}"

cleanup_container() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}

cleanup_run() {
  cleanup_container
  if [[ "${DATA_DIR_CREATED}" -eq 1 ]]; then
    # The container owns the files it creates in the data dir, so on Linux CI
    # runners the host uid cannot delete them. Remove the dir through a
    # throwaway root container, falling back to a host rm (enough on macOS).
    docker run --rm --entrypoint bash \
      --volume "${TMP_ROOT}:/e2e-tmp" \
      "${IMAGE}" \
      -c "rm -rf /e2e-tmp/$(basename "${DATA_DIR}")" 2>/dev/null || rm -rf "${DATA_DIR}" || true
  fi
}

preflight_port_free() {
  if python3 "${REPO_ROOT}/scripts/http_probe.py" "${APP_URL}/api/health" >/dev/null 2>&1; then
    echo "Refusing to start: ${APP_URL}/api/health already answers." >&2
    echo "Another server owns port ${PORT}; the suite would silently run against it instead of the container." >&2
    echo "Stop that server, or set SUPERSCRIBER_E2E_PORT to a free port." >&2
    return 1
  fi
}

build_image() {
  docker build \
    --build-arg SUPERSCRIBER_TRANSCRIBE_MODEL="${BUILD_MODEL}" \
    --build-arg SUPERSCRIBER_PRELOAD_MODEL="${PRELOAD_MODEL}" \
    -t "${IMAGE}" \
    "${REPO_ROOT}"
}

wait_for_app() {
  local attempts=0

  until python3 "${REPO_ROOT}/scripts/http_probe.py" "${APP_URL}/api/health"; do
    attempts=$((attempts + 1))
    if [[ ${attempts} -ge 90 ]]; then
      echo "Timed out waiting for ${APP_URL}/api/health" >&2
      docker logs "${CONTAINER_NAME}" >&2 || true
      return 1
    fi
    sleep 1
  done
}

start_container() {
  cleanup_container
  preflight_port_free
  mkdir -p "${DATA_DIR}"
  # The container entrypoint chowns the bind-mounted data dir to the in-image
  # user without widening its mode. Keep it traversable so the host Playwright
  # process can stat the sqlite database on stock Linux CI runners.
  chmod 0755 "${DATA_DIR}"

  docker run \
    --detach \
    --name "${CONTAINER_NAME}" \
    --publish "${PORT}:3000" \
    --volume "${DATA_DIR}:/app/data" \
    --env NEXTAUTH_URL="${APP_URL}" \
    --env AUTH_URL="${APP_URL}" \
    --env SUPERSCRIBER_TRANSCRIBE_MODEL="missing-e2e-model" \
    --env SUPERSCRIBER_TRANSCRIBE_OFFLINE=1 \
    --env SUPERSCRIBER_TRANSCRIBE_ALLOW_STUB_FALLBACK=1 \
    --env SUPERSCRIBER_WORKER_POLL_SECONDS=1 \
    --env SUPERSCRIBER_WORKER_HEARTBEAT_SECONDS=2 \
    "${IMAGE}" >/dev/null

  wait_for_app
}

run_playwright() {
  shift
  PLAYWRIGHT_BASE_URL="${APP_URL}" npx playwright test "$@"
}

case "${ACTION}" in
  build)
    build_image
    ;;
  start)
    start_container
    ;;
  stop)
    cleanup_container
    ;;
  test)
    preflight_port_free
    build_image
    trap cleanup_run EXIT
    start_container
    run_playwright "$@"
    ;;
  *)
    echo "Usage: ${0} [build|start|stop|test]" >&2
    exit 1
    ;;
esac
