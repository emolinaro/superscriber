#!/usr/bin/env bash
# local-deploy-bootstrap: durable crash-restart supervisor for a Superscriber
# local deployment. Runs app and worker with per-role logs, bounded restart
# backoff, atomic instance ownership, and SIGTERM shutdown.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/instance-paths.sh
. "${SCRIPT_DIR}/instance-paths.sh"

RAW_INSTANCE_ROOT="${1:-${SUPERSCRIBER_INSTANCE_ROOT:-$HOME/.local/share/superscriber}}"
INSTANCE_ROOT="$(resolve_durable_instance_root "${RAW_INSTANCE_ROOT}")" || exit 1
[[ -d "${INSTANCE_ROOT}" ]] || {
  echo "instance root '${RAW_INSTANCE_ROOT}' does not exist; run scripts/bootstrap-local.sh first" >&2
  exit 1
}
require_instance_marker "${INSTANCE_ROOT}" || exit 1
reject_managed_instance_symlinks "${INSTANCE_ROOT}" || exit 1
MODE="${2:---start}"
SUPERVISOR_TOKEN="${3:-}"

REPO="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_DIR="${INSTANCE_ROOT}/logs"
PID_DIR="${INSTANCE_ROOT}/pids"
LOCK_DIR="${PID_DIR}/supervisor.lock"
IDENTITY_FILE="${LOCK_DIR}/identity"
TOKEN_FILE="${LOCK_DIR}/token"
SUPERVISOR_PID_FILE="${PID_DIR}/supervisor.pid"
INSTANCE_LOG="${INSTANCE_ROOT}/instance.log"
PORT=""

timestamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

random_token() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))'
}

read_identity() {
  local pid token
  [[ -f "${IDENTITY_FILE}" ]] || return 1
  read -r pid token < "${IDENTITY_FILE}" || return 1
  [[ "${pid}" =~ ^[0-9]+$ && "${token}" =~ ^[0-9a-f]{48}$ ]] || return 1
  printf '%s %s\n' "${pid}" "${token}"
}

process_matches_identity() {
  local pid="$1" token="$2" args
  kill -0 "${pid}" 2>/dev/null || return 1
  args="$(ps -ww -p "${pid}" -o args= 2>/dev/null || true)"
  [[ "${args}" == *"instance-run.sh"* && "${args}" == *"--supervise ${token}"* ]]
}

valid_identity() {
  local identity pid token
  identity="$(read_identity)" || return 1
  read -r pid token <<< "${identity}"
  process_matches_identity "${pid}" "${token}"
}

wait_for_valid_identity() {
  local attempts=0
  while [[ "${attempts}" -lt 50 ]]; do
    valid_identity && return 0
    attempts=$((attempts + 1))
    sleep 0.1
  done
  return 1
}

reclaim_stale_lock() {
  local observed current stale reclaim_dir reclaim_age
  [[ -d "${LOCK_DIR}" ]] || return 0
  valid_identity && return 1
  observed="$(lock_generation_snapshot)"
  reclaim_dir="${LOCK_DIR}/.reclaim"
  if ! mkdir "${reclaim_dir}" 2>/dev/null; then
    reclaim_age="$(node -e 'process.stdout.write(String(Date.now() - require("node:fs").statSync(process.argv[1]).mtimeMs))' "${reclaim_dir}" 2>/dev/null || echo 0)"
    if [[ "${reclaim_age}" =~ ^[0-9]+$ && "${reclaim_age}" -ge 5000 ]]; then
      rm -rf -- "${reclaim_dir}"
    fi
    return 1
  fi
  current="$(lock_generation_snapshot)"
  if [[ "${current}" != "${observed}" ]] || valid_identity; then
    rmdir "${reclaim_dir}" 2>/dev/null || true
    return 1
  fi
  stale="${LOCK_DIR}.stale.$$.$RANDOM"
  if mv "${LOCK_DIR}" "${stale}" 2>/dev/null; then
    rm -rf -- "${stale}"
    return 0
  fi
  rmdir "${reclaim_dir}" 2>/dev/null || true
  return 1
}

lock_generation_snapshot() {
  printf 'token=%s\nidentity=%s\n' \
    "$(cat "${TOKEN_FILE}" 2>/dev/null || true)" \
    "$(cat "${IDENTITY_FILE}" 2>/dev/null || true)"
}

remove_owned_supervisor_lock() {
  local token="$1" identity identity_token stale
  [[ -d "${LOCK_DIR}" && -f "${TOKEN_FILE}" ]] || return 0
  [[ "$(cat "${TOKEN_FILE}" 2>/dev/null || true)" == "${token}" ]] || return 0
  identity="$(read_identity 2>/dev/null || true)"
  if [[ -n "${identity}" ]]; then
    read -r _ identity_token <<< "${identity}"
    [[ "${identity_token}" == "${token}" ]] || return 0
  fi
  stale="${LOCK_DIR}.stale.$$.$RANDOM"
  if mv "${LOCK_DIR}" "${stale}" 2>/dev/null; then
    rm -rf -- "${stale}"
  fi
}

port_of_instance() {
  local port
  [[ -f "${INSTANCE_ROOT}/app.env" ]] || {
    echo "missing ${INSTANCE_ROOT}/app.env; run scripts/bootstrap-local.sh first" >&2
    return 1
  }
  port="$(sed -n 's/^PORT=\([0-9][0-9]*\)$/\1/p' "${INSTANCE_ROOT}/app.env" | tail -1)"
  [[ -n "${port}" ]] || {
    echo "missing valid PORT in ${INSTANCE_ROOT}/app.env" >&2
    return 1
  }
  printf '%s\n' "${port}"
}

port_is_free() {
  node -e '
    const net = require("node:net");
    const port = Number(process.argv[1]);
    const server = net.createServer();
    server.once("error", (error) => process.exit(error.code === "EADDRINUSE" ? 1 : 2));
    server.listen(port, "127.0.0.1", () => server.close(() => process.exit(0)));
  ' "$1"
}

status_instance() {
  local identity pid token
  if ! identity="$(read_identity)"; then
    return 1
  fi
  read -r pid token <<< "${identity}"
  process_matches_identity "${pid}" "${token}" || return 1
  printf 'supervisor running: pid %s\n' "${pid}"
}

stop_instance() {
  local identity pid token attempts=0
  if [[ -d "${LOCK_DIR}" ]] && ! valid_identity; then
    wait_for_valid_identity || true
  fi
  if ! identity="$(read_identity)"; then
    reclaim_stale_lock || true
    echo "instance is not running (no verified supervisor for ${INSTANCE_ROOT})"
    return 0
  fi
  read -r pid token <<< "${identity}"
  if ! process_matches_identity "${pid}" "${token}"; then
    reclaim_stale_lock || true
    echo "instance is not running (no verified supervisor for ${INSTANCE_ROOT})"
    return 0
  fi
  kill "${pid}"
  while [[ "${attempts}" -lt 100 ]]; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      reclaim_stale_lock || true
      echo "stopped supervisor ${pid}"
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 0.1
  done
  echo "supervisor ${pid} did not exit within 10s of SIGTERM" >&2
  return 1
}

worker_ready_status() {
  local identity supervisor_token pid role_token started command ready_token failed_supervisor_token
  identity="$(read_identity)" || return 1
  read -r pid supervisor_token <<< "${identity}"
  process_matches_identity "${pid}" "${supervisor_token}" || return 1
  if [[ -f "${PID_DIR}/worker.failed" ]]; then
    read -r failed_supervisor_token _ < "${PID_DIR}/worker.failed" || true
    [[ "${failed_supervisor_token:-}" != "${supervisor_token}" ]] || return 2
  fi
  [[ -f "${PID_DIR}/worker.identity" && -f "${PID_DIR}/worker.ready" ]] || return 1
  read -r pid role_token started command < "${PID_DIR}/worker.identity" || return 1
  read -r ready_token < "${PID_DIR}/worker.ready" || return 1
  [[ "${pid}" =~ ^[0-9]+$ && "${role_token}" == "${ready_token}" && "${started}" =~ ^[0-9]+-[0-9]+$ && "${command}" =~ ^[0-9]+-[0-9]+$ ]] || return 1
  process_matches_role_identity "${pid}" "${started}" "${command}"
}

role_running_status() {
  local role="$1" supervisor_identity supervisor_pid supervisor_token pid token started command
  supervisor_identity="$(read_identity)" || return 1
  read -r supervisor_pid supervisor_token <<< "${supervisor_identity}"
  process_matches_identity "${supervisor_pid}" "${supervisor_token}" || return 1
  [[ -f "${PID_DIR}/${role}.identity" ]] || return 1
  read -r pid token started command < "${PID_DIR}/${role}.identity" || return 1
  [[ "${pid}" =~ ^[0-9]+$ && "${token}" =~ ^[0-9a-f]{48}$ && "${started}" =~ ^[0-9]+-[0-9]+$ && "${command}" =~ ^[0-9]+-[0-9]+$ ]] || return 1
  process_matches_role_identity "${pid}" "${started}" "${command}"
}

prepare_runtime_files() {
  reject_managed_instance_symlinks "${INSTANCE_ROOT}" || return 1
  mkdir -p "${LOG_DIR}" "${PID_DIR}"
  chmod 700 "${INSTANCE_ROOT}" "${LOG_DIR}" "${PID_DIR}"
  [[ ! -f "${INSTANCE_ROOT}/app.env" ]] || chmod 600 "${INSTANCE_ROOT}/app.env"
  [[ ! -f "${INSTANCE_ROOT}/secrets/auth.secret" ]] || chmod 600 "${INSTANCE_ROOT}/secrets/auth.secret"
  [[ ! -f "${INSTANCE_ROOT}/secrets/engine.secret" ]] || chmod 600 "${INSTANCE_ROOT}/secrets/engine.secret"
  touch "${INSTANCE_LOG}" "${LOG_DIR}/supervisor.log" "${LOG_DIR}/app.log" "${LOG_DIR}/worker.log"
  chmod 600 "${INSTANCE_LOG}" "${LOG_DIR}/supervisor.log" "${LOG_DIR}/app.log" "${LOG_DIR}/worker.log"
}

maintenance_blocks_start() {
  local lock_dir current
  lock_dir="$(maintenance_lock_dir "${INSTANCE_ROOT}")"
  [[ -d "${lock_dir}" ]] || return 1
  current="$(cat "${lock_dir}/identity" 2>/dev/null || true)"
  [[ -n "${SUPERSCRIBER_MAINTENANCE_IDENTITY:-}" && "${current}" == "${SUPERSCRIBER_MAINTENANCE_IDENTITY}" ]] && return 1
  return 0
}

start_instance() {
  local token expected_pid port attempts
  if maintenance_blocks_start; then
    if maintenance_lock_is_active "${INSTANCE_ROOT}"; then
      echo "refusing to start while bootstrap maintenance is in progress for ${INSTANCE_ROOT}" >&2
    else
      echo "refusing to start with a stale maintenance lock; re-run scripts/bootstrap-local.sh for ${INSTANCE_ROOT}" >&2
    fi
    return 1
  fi
  prepare_runtime_files
  while true; do
    if mkdir "${LOCK_DIR}" 2>/dev/null; then
      token="$(random_token)"
      printf '%s\n' "${token}" > "${TOKEN_FILE}"
      if maintenance_blocks_start; then
        remove_owned_supervisor_lock "${token}"
        echo "refusing to start while bootstrap maintenance is in progress for ${INSTANCE_ROOT}" >&2
        return 1
      fi
      port="$(port_of_instance)" || {
        remove_owned_supervisor_lock "${token}"
        return 1
      }
      if ! port_is_free "${port}"; then
        remove_owned_supervisor_lock "${token}"
        echo "refusing to start with port ${port} occupied by a foreign process" >&2
        return 1
      fi
      nohup bash "${SCRIPT_DIR}/instance-run.sh" "${INSTANCE_ROOT}" --supervise "${token}" >>"${INSTANCE_LOG}" 2>&1 &
      expected_pid=$!
      attempts=0
      while [[ "${attempts}" -lt 50 ]]; do
        if valid_identity; then
          echo "started supervisor ${expected_pid}"
          return 0
        fi
        if ! kill -0 "${expected_pid}" 2>/dev/null; then
          break
        fi
        attempts=$((attempts + 1))
        sleep 0.1
      done
      kill "${expected_pid}" 2>/dev/null || true
      remove_owned_supervisor_lock "${token}"
      echo "supervisor failed to acquire instance ownership" >&2
      return 1
    fi

    if wait_for_valid_identity; then
      if status_instance | sed 's/supervisor running/supervisor already running/'; then
        return 0
      fi
    fi
    reclaim_stale_lock || true
  done
}

case "${MODE}" in
  --status) status_instance; exit $? ;;
  --stop) stop_instance; exit $? ;;
  --worker-ready) worker_ready_status; exit $? ;;
  --app-running) role_running_status app; exit $? ;;
  --start) start_instance; exit $? ;;
  --supervise) ;;
  *) echo "unknown instance-run mode: ${MODE}" >&2; exit 64 ;;
esac

[[ "${SUPERVISOR_TOKEN}" =~ ^[0-9a-f]{48}$ ]] || exit 1
[[ -f "${TOKEN_FILE}" && "$(cat "${TOKEN_FILE}")" == "${SUPERVISOR_TOKEN}" ]] || exit 1
prepare_runtime_files
SUPERVISOR_PID="$$"
rm -f "${SUPERVISOR_PID_FILE}" "${PID_DIR}/app.pid" "${PID_DIR}/worker.pid" \
  "${PID_DIR}/app.identity" "${PID_DIR}/worker.identity" \
  "${PID_DIR}/worker.ready" "${PID_DIR}/worker.failed"
identity_tmp="${IDENTITY_FILE}.$$"
printf '%s %s\n' "${SUPERVISOR_PID}" "${SUPERVISOR_TOKEN}" > "${identity_tmp}"
mv "${identity_tmp}" "${IDENTITY_FILE}"
printf '%s\n' "${SUPERVISOR_PID}" > "${SUPERVISOR_PID_FILE}.tmp.$$"
mv "${SUPERVISOR_PID_FILE}.tmp.$$" "${SUPERVISOR_PID_FILE}"

say_supervisor() {
  printf '[%s] [supervisor] %s\n' "$(timestamp)" "$*" >>"${LOG_DIR}/supervisor.log"
  printf '[%s] [supervisor] %s\n' "$(timestamp)" "$*" >>"${INSTANCE_LOG}"
}

load_env() {
  [[ -f "${INSTANCE_ROOT}/app.env" ]] || {
    echo "missing ${INSTANCE_ROOT}/app.env; run scripts/bootstrap-local.sh first" >&2
    exit 1
  }
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

next_backoff() {
  case "$1" in
    1) echo 5 ;;
    2) echo 15 ;;
    3) echo 45 ;;
    *) echo 300 ;;
  esac
}

write_role_identity() {
  local role pid token tmp started command previous attempts=0
  role="$1"
  pid="$2"
  token="$3"
  started="$(process_start_fingerprint "${pid}")" || return 1
  sleep 0.05
  command="$(process_command_fingerprint "${pid}")" || return 1
  while [[ "${attempts}" -lt 10 ]]; do
    sleep 0.02
    previous="${command}"
    command="$(process_command_fingerprint "${pid}")" || return 1
    [[ "${command}" == "${previous}" ]] && break
    attempts=$((attempts + 1))
  done
  [[ "${command}" == "${previous}" ]] || return 1
  tmp="${PID_DIR}/${role}.identity.tmp.$$"
  printf '%s %s %s %s\n' "${pid}" "${token}" "${started}" "${command}" > "${tmp}"
  mv "${tmp}" "${PID_DIR}/${role}.identity"
  printf '%s\n' "${pid}" > "${PID_DIR}/${role}.pid.tmp.$$"
  mv "${PID_DIR}/${role}.pid.tmp.$$" "${PID_DIR}/${role}.pid"
}

clear_role_state() {
  local role="$1" token="$2" identity current_token ready_token
  identity="$(cat "${PID_DIR}/${role}.identity" 2>/dev/null || true)"
  [[ -n "${identity}" ]] || return 0
  read -r _ current_token _ <<< "${identity}"
  [[ "${current_token}" == "${token}" ]] || return 0
  rm -f "${PID_DIR}/${role}.identity" "${PID_DIR}/${role}.pid"
  if [[ "${role}" == "worker" ]]; then
    ready_token="$(cat "${PID_DIR}/worker.ready" 2>/dev/null || true)"
    [[ "${ready_token}" != "${token}" ]] || rm -f "${PID_DIR}/worker.ready"
  fi
}

run_role() {
  trap - EXIT INT TERM
  local role="$1"
  shift
  local log consecutive=0
  if [[ "${role}" == "app" ]]; then log="${LOG_DIR}/app.log"; else log="${LOG_DIR}/worker.log"; fi

  while true; do
    local started child_pid status ended wait_s role_token ready_tmp failed_tmp was_ready
    started="$(date +%s)"
    role_token="$(random_token)"
    say_supervisor "${role} starting: $*"
    set +e
    "$@" > >(
      while IFS= read -r line; do
        printf '[%s] [%s] %s\n' "$(timestamp)" "${role}" "${line}" | tee -a "${log}" >>"${INSTANCE_LOG}"
        if [[ "${role}" == "worker" && "${line}" == *"[worker] ready with offline model"* ]]; then
          if [[ "$(awk '{ print $2 }' "${PID_DIR}/worker.identity" 2>/dev/null || true)" == "${role_token}" ]]; then
            ready_tmp="${PID_DIR}/worker.ready.tmp.$$.$RANDOM"
            printf '%s\n' "${role_token}" > "${ready_tmp}"
            mv "${ready_tmp}" "${PID_DIR}/worker.ready"
            rm -f "${PID_DIR}/worker.failed"
          fi
        fi
      done
    ) 2>&1 &
    child_pid=$!
    write_role_identity "${role}" "${child_pid}" "${role_token}" || true
    wait "${child_pid}"
    status=$?
    set -e
    was_ready=0
    if [[ "${role}" == "worker" && "$(cat "${PID_DIR}/worker.ready" 2>/dev/null || true)" == "${role_token}" ]]; then
      was_ready=1
    fi
    clear_role_state "${role}" "${role_token}"
    if [[ "${role}" == "worker" && "${was_ready}" -eq 0 ]]; then
      failed_tmp="${PID_DIR}/worker.failed.tmp.$$"
      printf '%s %s %s\n' "${SUPERVISOR_TOKEN}" "${role_token}" "${status}" > "${failed_tmp}"
      mv "${failed_tmp}" "${PID_DIR}/worker.failed"
    fi
    ended="$(date +%s)"
    if [[ $((ended - started)) -ge 60 ]]; then consecutive=0; fi
    consecutive=$((consecutive + 1))
    wait_s="$(next_backoff "${consecutive}")"
    say_supervisor "${role} exited status=${status} after $((ended - started))s; restart ${consecutive} in ${wait_s}s"
    sleep "${wait_s}"
  done
}

APP_LOOP_PID=""
WORKER_LOOP_PID=""

terminate_children() {
  local name identity pid token started command
  for name in app worker; do
    identity="$(cat "${PID_DIR}/${name}.identity" 2>/dev/null || true)"
    [[ -n "${identity}" ]] || continue
    read -r pid token started command <<< "${identity}"
    [[ "${pid}" =~ ^[0-9]+$ && "${token}" =~ ^[0-9a-f]{48}$ && "${started}" =~ ^[0-9]+-[0-9]+$ && "${command}" =~ ^[0-9]+-[0-9]+$ ]] || continue
    process_matches_role_identity "${pid}" "${started}" "${command}" || continue
    kill "${pid}" 2>/dev/null || true
  done
  [[ -z "${APP_LOOP_PID}" ]] || kill "${APP_LOOP_PID}" 2>/dev/null || true
  [[ -z "${WORKER_LOOP_PID}" ]] || kill "${WORKER_LOOP_PID}" 2>/dev/null || true
}

cleanup_identity() {
  local identity pid token
  identity="$(read_identity 2>/dev/null)" || return
  read -r pid token <<< "${identity}"
  [[ "${pid}" == "${SUPERVISOR_PID}" && "${token}" == "${SUPERVISOR_TOKEN}" ]] || return
  terminate_children
  rm -f "${IDENTITY_FILE}" "${TOKEN_FILE}" "${SUPERVISOR_PID_FILE}" \
    "${PID_DIR}/app.pid" "${PID_DIR}/worker.pid" \
    "${PID_DIR}/app.identity" "${PID_DIR}/worker.identity" \
    "${PID_DIR}/worker.ready" "${PID_DIR}/worker.failed"
  rmdir "${LOCK_DIR}" 2>/dev/null || true
}

shutdown() {
  local identity pid token
  trap - INT TERM
  identity="$(read_identity 2>/dev/null)" || exit 0
  read -r pid token <<< "${identity}"
  [[ "${pid}" == "${SUPERVISOR_PID}" && "${token}" == "${SUPERVISOR_TOKEN}" ]] || exit 0
  say_supervisor "stop requested"
  terminate_children
  wait "${APP_LOOP_PID}" 2>/dev/null || true
  [[ -z "${WORKER_LOOP_PID}" ]] || wait "${WORKER_LOOP_PID}" 2>/dev/null || true
  exit 0
}

trap cleanup_identity EXIT
trap shutdown INT TERM
unset SUPERSCRIBER_MAINTENANCE_IDENTITY
load_env
cd "${REPO}"

run_role app node "${SUPERSCRIBER_APP_SERVER:-${REPO}/.next/standalone/server.js}" &
APP_LOOP_PID=$!

if [[ "${SUPERSCRIBER_ENGINE_MODE:-internal}" == "internal" ]]; then
  run_role worker env PYTHONUNBUFFERED=1 \
    SUPERSCRIBER_WORKER_PYTHON="${SUPERSCRIBER_WORKER_PYTHON:-${INSTANCE_ROOT}/venv/bin/python3}" \
    bash "${REPO}/scripts/run-worker-python.sh" "${REPO}/worker/main.py" &
  WORKER_LOOP_PID=$!
fi

say_supervisor "supervising app=${APP_LOOP_PID} worker=${WORKER_LOOP_PID:-none} at http://127.0.0.1:${PORT}"
wait
