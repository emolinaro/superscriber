#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
if [[ -f /app/server.js ]]; then
  APP_WORKDIR="/app"
  SERVER_ENTRYPOINT="/app/server.js"
  WORKER_ENTRYPOINT="/app/worker/main.py"
  HTTP_PROBE="/app/scripts/http_probe.py"
else
  APP_WORKDIR="${REPO_ROOT}"
  SERVER_ENTRYPOINT="${REPO_ROOT}/.next/standalone/server.js"
  WORKER_ENTRYPOINT="${REPO_ROOT}/worker/main.py"
  HTTP_PROBE="${REPO_ROOT}/scripts/http_probe.py"
fi

APP_DATA_DIR="${SUPERSCRIBER_DATA_DIR:-${APP_WORKDIR}/data}"

export NODE_ENV="${NODE_ENV:-production}"
export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"
export PORT="${PORT:-3000}"
export HOSTNAME="${SUPERSCRIBER_BIND_HOST:-0.0.0.0}"
export SUPERSCRIBER_ENGINE_MODE="${SUPERSCRIBER_ENGINE_MODE:-internal}"
export SUPERSCRIBER_DB_PATH="${SUPERSCRIBER_DB_PATH:-${APP_DATA_DIR}/superscriber.db}"
export SUPERSCRIBER_MEDIA_DIR="${SUPERSCRIBER_MEDIA_DIR:-${APP_DATA_DIR}/media}"
export SUPERSCRIBER_UPLOAD_TMP_DIR="${SUPERSCRIBER_UPLOAD_TMP_DIR:-${APP_DATA_DIR}/uploads}"
export SUPERSCRIBER_APP_BASE_URL="${SUPERSCRIBER_APP_BASE_URL:-http://127.0.0.1:${PORT}}"
export SUPERSCRIBER_TRANSCRIBE_MODEL="${SUPERSCRIBER_TRANSCRIBE_MODEL:-small}"
export SUPERSCRIBER_TRANSCRIBE_MODEL_DIR="${SUPERSCRIBER_TRANSCRIBE_MODEL_DIR:-${APP_WORKDIR}/models}"
export SUPERSCRIBER_TRANSCRIBE_OFFLINE="${SUPERSCRIBER_TRANSCRIBE_OFFLINE:-1}"
export SUPERSCRIBER_TRANSCRIBE_ALLOW_RUNTIME_DOWNLOAD="${SUPERSCRIBER_TRANSCRIBE_ALLOW_RUNTIME_DOWNLOAD:-0}"
export SUPERSCRIBER_TRANSCRIBE_ALLOW_STUB_FALLBACK="${SUPERSCRIBER_TRANSCRIBE_ALLOW_STUB_FALLBACK:-0}"
export SUPERSCRIBER_TRANSCRIBE_DEVICE="${SUPERSCRIBER_TRANSCRIBE_DEVICE:-auto}"

APP_PID=""
WORKER_PID=""
RUN_AS_APP_USER=()

prepare_runtime_root() {
  local path="$1"
  if [[ ! -e "${path}" ]]; then
    return
  fi

  chown "${NODE_UID}:${NODE_GID}" "${path}"
  chmod u+rwx "${path}"
}

if [[ "$(id -u)" == "0" ]]; then
  NODE_UID="$(id -u node)"
  NODE_GID="$(id -g node)"

  prepare_runtime_root "${APP_DATA_DIR}"
  prepare_runtime_root "$(dirname "${SUPERSCRIBER_DB_PATH}")"
  prepare_runtime_root "$(dirname "${SUPERSCRIBER_MEDIA_DIR}")"
  prepare_runtime_root "$(dirname "${SUPERSCRIBER_UPLOAD_TMP_DIR}")"
  prepare_runtime_root "${SUPERSCRIBER_TRANSCRIBE_MODEL_DIR}"

  mkdir -p \
    "$(dirname "${SUPERSCRIBER_DB_PATH}")" \
    "${SUPERSCRIBER_MEDIA_DIR}" \
    "${SUPERSCRIBER_UPLOAD_TMP_DIR}" \
    "${SUPERSCRIBER_TRANSCRIBE_MODEL_DIR}"

  # Bind mounts often inherit host ownership. Normalize writable runtime paths
  # before dropping privileges so the container works on stock Linux runners.
  chown -R "${NODE_UID}:${NODE_GID}" \
    "${APP_DATA_DIR}" \
    "${SUPERSCRIBER_TRANSCRIBE_MODEL_DIR}"

  RUN_AS_APP_USER=(
    setpriv
    "--reuid=${NODE_UID}"
    "--regid=${NODE_GID}"
    --clear-groups
  )
else
  mkdir -p \
    "$(dirname "${SUPERSCRIBER_DB_PATH}")" \
    "${SUPERSCRIBER_MEDIA_DIR}" \
    "${SUPERSCRIBER_UPLOAD_TMP_DIR}" \
    "${SUPERSCRIBER_TRANSCRIBE_MODEL_DIR}"
fi

run_as_app_user() {
  if [[ ${#RUN_AS_APP_USER[@]} -gt 0 ]]; then
    "${RUN_AS_APP_USER[@]}" "$@"
    return
  fi

  "$@"
}

terminate() {
  if [[ -n "${WORKER_PID}" ]] && kill -0 "${WORKER_PID}" 2>/dev/null; then
    kill "${WORKER_PID}" 2>/dev/null || true
  fi

  if [[ -n "${APP_PID}" ]] && kill -0 "${APP_PID}" 2>/dev/null; then
    kill "${APP_PID}" 2>/dev/null || true
  fi
}

trap terminate INT TERM

wait_for_app() {
  local attempts=0

  until python3 "${HTTP_PROBE}" "${SUPERSCRIBER_APP_BASE_URL}/api/health"; do
    attempts=$((attempts + 1))
    if [[ ${attempts} -ge 90 ]]; then
      echo "App did not become healthy within 90 seconds." >&2
      return 1
    fi
    sleep 1
  done
}

monitor_children() {
  while true; do
    if ! kill -0 "${APP_PID}" 2>/dev/null; then
      wait "${APP_PID}"
      return $?
    fi

    if [[ -n "${WORKER_PID}" ]] && ! kill -0 "${WORKER_PID}" 2>/dev/null; then
      wait "${WORKER_PID}"
      local worker_status=$?
      terminate
      wait "${APP_PID}" || true
      return "${worker_status}"
    fi

    sleep 2
  done
}

echo "Starting Superscriber app on ${PORT} in ${SUPERSCRIBER_ENGINE_MODE} mode."
cd "${APP_WORKDIR}"
run_as_app_user node "${SERVER_ENTRYPOINT}" &
APP_PID=$!

if ! wait_for_app; then
  terminate
  wait "${APP_PID}" || true
  exit 1
fi

if [[ "${SUPERSCRIBER_ENGINE_MODE}" == "internal" ]]; then
  echo "Using offline transcription model ${SUPERSCRIBER_TRANSCRIBE_MODEL} from ${SUPERSCRIBER_TRANSCRIBE_MODEL_DIR}."
  echo "Starting internal Python worker."
  run_as_app_user python3 -u "${WORKER_ENTRYPOINT}" &
  WORKER_PID=$!
fi

monitor_children
