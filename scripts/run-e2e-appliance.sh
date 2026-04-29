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
DATA_DIR="${SUPERSCRIBER_E2E_DATA_DIR:-$(mktemp -d "${TMP_ROOT}/e2e-data.XXXXXX")}"
BUILD_MODEL="${SUPERSCRIBER_E2E_BUILD_MODEL:-tiny}"
PRELOAD_MODEL="${SUPERSCRIBER_E2E_PRELOAD_MODEL:-0}"

cleanup_container() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
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
  mkdir -p "${DATA_DIR}"

  docker run \
    --rm \
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
    build_image
    trap cleanup_container EXIT
    start_container
    run_playwright "$@"
    ;;
  *)
    echo "Usage: ${0} [build|start|stop|test]" >&2
    exit 1
    ;;
esac
