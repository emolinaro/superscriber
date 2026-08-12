#!/usr/bin/env bash
# local-deploy-bootstrap: durable crash-restart supervisor for a Superscriber
# local deployment. Shape follows the proven 3275 lane wrapper
# (runtime/superscriber-3275/run.sh): a nohup-detached supervisor loop with
# per-role logs, pid files, SIGTERM-stoppable children, and bounded restart
# backoff (5s, 15s, 45s, then 300s; back to 5s after a 60s healthy run).
#
# All state lives under the instance root (default
# ~/.local/share/superscriber, written by scripts/bootstrap-local.sh):
#   app.env            non-secret environment (paths, port, model tier)
#   secrets/           auth + engine shared secrets (mode 0600, read, never printed)
#   data/              SQLite database, media, uploads
#   model-cache/       provisioned faster-whisper tiers
#   logs/              supervisor.log, app.log, worker.log (+ merged instance.log)
#   pids/              supervisor.pid, app.pid, worker.pid
#
# Usage:
#   scripts/instance-run.sh [INSTANCE_ROOT]    start (idempotent; no-op if running)
#   scripts/instance-stop.sh [INSTANCE_ROOT]   stop (SIGTERM to the supervisor)
set -euo pipefail

INSTANCE_ROOT="${1:-${SUPERSCRIBER_INSTANCE_ROOT:-$HOME/.local/share/superscriber}}"
INSTANCE_ROOT="$(cd "${INSTANCE_ROOT}" 2>/dev/null && pwd -P)" || {
  echo "instance root '${1:-${SUPERSCRIBER_INSTANCE_ROOT:-$HOME/.local/share/superscriber}}' does not exist; run scripts/bootstrap-local.sh first" >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_DIR="${INSTANCE_ROOT}/logs"
PID_DIR="${INSTANCE_ROOT}/pids"
INSTANCE_LOG="${INSTANCE_ROOT}/instance.log"

mkdir -p "${LOG_DIR}" "${PID_DIR}"
touch "${INSTANCE_LOG}" "${LOG_DIR}/supervisor.log" "${LOG_DIR}/app.log" "${LOG_DIR}/worker.log"

timestamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say_supervisor() {
  printf '[%s] [supervisor] %s\n' "$(timestamp)" "$*" >>"${LOG_DIR}/supervisor.log"
  printf '[%s] [supervisor] %s\n' "$(timestamp)" "$*" >>"${INSTANCE_LOG}"
}

load_env() {
  if [[ ! -f "${INSTANCE_ROOT}/app.env" ]]; then
    echo "missing ${INSTANCE_ROOT}/app.env; run scripts/bootstrap-local.sh first" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090,SC1091
  . "${INSTANCE_ROOT}/app.env"
  set +a
  AUTH_SECRET="$(cat "${INSTANCE_ROOT}/secrets/auth.secret")"
  NEXTAUTH_SECRET="${AUTH_SECRET}"
  SUPERSCRIBER_ENGINE_SHARED_SECRET="$(cat "${INSTANCE_ROOT}/secrets/engine.secret")"
  export AUTH_SECRET NEXTAUTH_SECRET SUPERSCRIBER_ENGINE_SHARED_SECRET
  export NODE_ENV=production
}

port_of_instance() {
  # PORT is written by bootstrap-local.sh into app.env.
  (
    set -a
    # shellcheck disable=SC1090,SC1091
    . "${INSTANCE_ROOT}/app.env"
    set +a
    printf '%s\n' "${PORT}"
  )
}

next_backoff() {
  local consecutive="$1"
  if [ "${consecutive}" -le 1 ]; then
    echo 5
  elif [ "${consecutive}" -eq 2 ]; then
    echo 15
  elif [ "${consecutive}" -eq 3 ]; then
    echo 45
  else
    echo 300
  fi
}

run_role() {
  local role="$1"
  shift
  local log
  if [ "${role}" = app ]; then log="${LOG_DIR}/app.log"; else log="${LOG_DIR}/worker.log"; fi

  local consecutive=0
  while true; do
    local started
    started="$(date +%s)"
    say_supervisor "${role} starting: $*"
    set +e
    "$@" >> >({
      while IFS= read -r line; do
        printf '[%s] [%s] %s\n' "$(timestamp)" "${role}" "${line}" | tee -a "${log}" >>"${INSTANCE_LOG}"
      done
    }) 2>&1 &
    local child_pid=$!
    printf '%s\n' "${child_pid}" > "${PID_DIR}/${role}.pid"
    wait "${child_pid}"
    local status=$?
    set -e
    local ended
    ended="$(date +%s)"
    if [ $((ended - started)) -ge 60 ]; then consecutive=0; fi
    consecutive=$((consecutive + 1))
    local wait_s
    wait_s="$(next_backoff "${consecutive}")"
    say_supervisor "${role} exited status=${status} after $((ended - started))s; restart ${consecutive} in ${wait_s}s"
    sleep "${wait_s}"
  done
}

stop_children() {
  say_supervisor "stop requested"
  for name in app worker; do
    if [ -f "${PID_DIR}/${name}.pid" ]; then
      kill "$(cat "${PID_DIR}/${name}.pid")" 2>/dev/null || true
    fi
  done
  kill "${APP_LOOP_PID}" "${WORKER_LOOP_PID}" 2>/dev/null || true
}

if [ "${2:-}" != "--supervise" ]; then
  if [ -f "${PID_DIR}/supervisor.pid" ] && kill -0 "$(cat "${PID_DIR}/supervisor.pid")" 2>/dev/null; then
    echo "supervisor already running: pid $(cat "${PID_DIR}/supervisor.pid")"
    exit 0
  fi
  PORT="$(port_of_instance)"
  if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null; then
    echo "refusing to start with port ${PORT} occupied by a foreign process" >&2
    lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >&2
    exit 1
  fi
  nohup bash "${SCRIPT_DIR}/instance-run.sh" "${INSTANCE_ROOT}" --supervise >>"${INSTANCE_LOG}" 2>&1 &
  echo $! > "${PID_DIR}/supervisor.pid"
  echo "started supervisor $(cat "${PID_DIR}/supervisor.pid")"
  exit 0
fi

load_env
cd "${REPO}"
APP_LOOP_PID=""
WORKER_LOOP_PID=""
trap stop_children INT TERM

(
  while true; do
    run_role app node "${REPO}/.next/standalone/server.js"
  done
) &
APP_LOOP_PID=$!

if [ "${SUPERSCRIBER_ENGINE_MODE:-internal}" = "internal" ]; then
  (
    while true; do
      run_role worker env PYTHONUNBUFFERED=1 SUPERSCRIBER_WORKER_PYTHON="${SUPERSCRIBER_WORKER_PYTHON:-${INSTANCE_ROOT}/venv/bin/python3}" bash "${REPO}/scripts/run-worker-python.sh" "${REPO}/worker/main.py"
    done
  ) &
  WORKER_LOOP_PID=$!
fi

say_supervisor "supervising app=${APP_LOOP_PID} worker=${WORKER_LOOP_PID:-none} at http://127.0.0.1:${PORT}"
wait
