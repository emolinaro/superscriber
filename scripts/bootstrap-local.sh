#!/usr/bin/env bash
# local-deploy-bootstrap: one-shot LOCAL DEPLOY bootstrap from a clean clone to
# a running app and transcription worker with durable instance state.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

INSTANCE_ROOT="${SUPERSCRIBER_INSTANCE_ROOT:-${HOME}/.local/share/superscriber}"
PORT="3000"
MODEL_TIER=""
RESOLVED_MODEL_TIER=""
SKIP_MODEL_DOWNLOAD=0
SKIP_WORKER_DEPS=0
CHECK_DEPS_ONLY=0
INSTANCE_WAS_RUNNING=0

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap-local.sh [options]

  --instance-root DIR     Instance state root (default: ~/.local/share/superscriber)
  --port N                Port for the app (default: 3000)
  --model-tier TIER       faster-whisper tier to provision (default: interactive
                          picker; non-interactive default: the catalog default 'small')
  --skip-model-download   Do not download; require the selected or previously
                          configured tier to exist in the model cache
  --skip-worker-deps      Do not create the Python venv / install worker requirements
  --check-deps-only       Run only the dependency preflight
  -h, --help              Show this help
EOF
}

log() { printf '[bootstrap] %s\n' "$*"; }
fail() { printf '[bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }

require_option_value() {
  [[ $# -ge 2 && -n "${2:-}" ]] || fail "${1} requires a value"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance-root) require_option_value "$@"; INSTANCE_ROOT="$2"; shift 2 ;;
    --port) require_option_value "$@"; PORT="$2"; shift 2 ;;
    --model-tier) require_option_value "$@"; MODEL_TIER="$2"; shift 2 ;;
    --skip-model-download) SKIP_MODEL_DOWNLOAD=1; shift ;;
    --skip-worker-deps) SKIP_WORKER_DEPS=1; shift ;;
    --check-deps-only) CHECK_DEPS_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

required_node_version() {
  sed -n 's/^ARG NODE_BASE_IMAGE=node:\([0-9.]*\).*/\1/p' "${REPO_ROOT}/Dockerfile" | head -1
}

node_pin_reference() {
  local line
  line="$(sed -n '/^ARG NODE_BASE_IMAGE=node:/=' "${REPO_ROOT}/Dockerfile" | head -1)"
  printf 'Dockerfile:%s' "${line:-unknown}"
}

version_ge() {
  local have="$1" want="$2"
  [[ "$(printf '%s\n%s\n' "${want}" "${have}" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" == "${want}" ]]
}

check_python_venv() {
  local probe_root
  probe_root="$(mktemp -d "${TMPDIR:-/tmp}/superscriber-venv-check.XXXXXX")" || \
    fail "could not create a temporary Python venv preflight directory"
  if ! python3 -m venv "${probe_root}/venv" >/dev/null 2>&1 || \
     [[ ! -x "${probe_root}/venv/bin/python3" ]] || \
     ! "${probe_root}/venv/bin/python3" -c 'import ensurepip' >/dev/null 2>&1; then
    rm -rf -- "${probe_root}"
    fail "python3 cannot create a venv with ensurepip. Install python3-venv on Debian/Ubuntu, or reinstall Python with venv and ensurepip support, then re-run."
  fi
  rm -rf -- "${probe_root}"
}

check_dependencies() {
  command -v node >/dev/null 2>&1 || fail \
    "Node.js is not installed. Install Node $(required_node_version) exactly, pinned at $(node_pin_reference), then re-run."

  local want have
  want="$(required_node_version)"
  [[ -n "${want}" ]] || fail "could not determine the required Node version from the Dockerfile NODE_BASE_IMAGE pin"
  have="$(node --version | sed 's/^v//')"
  [[ "${have}" == "${want}" ]] || fail \
    "Node ${have} is installed, but this repo requires exactly Node ${want} from $(node_pin_reference) (ARG NODE_BASE_IMAGE). Install Node ${want}, then re-run."

  command -v npm >/dev/null 2>&1 || fail \
    "npm is not on PATH even though node is. Reinstall Node ${want} with npm bundled, then re-run."

  command -v python3 >/dev/null 2>&1 || fail \
    "python3 is not installed. The transcription worker needs Python >= 3.10; install it with venv support, then re-run."
  version_ge "$(python3 -c 'import sys;print(".".join(map(str,sys.version_info[:2])))')" "3.10" || fail \
    "python3 is too old; the transcription worker needs Python >= 3.10. Install a newer Python, then re-run."
}

log_dependencies() {
  log "dependencies ok: node $(node --version | sed 's/^v//'), npm $(npm --version), $(python3 --version)"
}

canonicalize_without_create() {
  local resolved ancestor suffix="" base physical
  resolved="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$1")"
  ancestor="${resolved}"
  while [[ ! -d "${ancestor}" ]]; do
    [[ "${ancestor}" != "/" ]] || return 1
    base="${ancestor##*/}"
    suffix="${base}${suffix:+/${suffix}}"
    ancestor="${ancestor%/*}"
    [[ -n "${ancestor}" ]] || ancestor="/"
  done
  physical="$(cd "${ancestor}" && pwd -P)"
  if [[ "${physical}" == "/" ]]; then
    printf '/%s\n' "${suffix}"
  else
    printf '%s%s\n' "${physical%/}" "${suffix:+/${suffix}}"
  fi
}

reject_temporary_instance_root() {
  local candidate canonical_temp
  for candidate in "/tmp" "/private/tmp" "${TMPDIR:-/tmp}"; do
    canonical_temp="$(canonicalize_without_create "${candidate}")" || continue
    case "${INSTANCE_ROOT}" in
      "${canonical_temp}"|"${canonical_temp}"/*)
        fail "instance root must be durable storage, never the system temp dir: ${INSTANCE_ROOT}" ;;
    esac
  done
}

port_is_free() {
  node -e '
    const net = require("node:net");
    const server = net.createServer();
    server.once("error", (error) => process.exit(error.code === "EADDRINUSE" ? 1 : 2));
    server.listen(Number(process.argv[1]), "127.0.0.1", () => server.close(() => process.exit(0)));
  ' "$1"
}

resolve_instance_root() {
  local configured_port
  INSTANCE_ROOT="$(canonicalize_without_create "${INSTANCE_ROOT}")" || fail "could not resolve instance root"
  [[ "${INSTANCE_ROOT}" != "/" ]] || fail "instance root must be a dedicated directory, not the filesystem root"
  reject_temporary_instance_root
  case "${PORT}" in
    ''|*[!0-9]*) fail "port must be a number, got '${PORT}'" ;;
  esac
  [[ "${PORT}" -ge 1024 && "${PORT}" -le 65535 ]] || fail "port ${PORT} is outside 1024-65535"

  if [[ -d "${INSTANCE_ROOT}" ]] && bash "${SCRIPT_DIR}/instance-run.sh" "${INSTANCE_ROOT}" --status >/dev/null 2>&1; then
    INSTANCE_WAS_RUNNING=1
    configured_port="$(sed -n 's/^PORT=\([0-9][0-9]*\)$/\1/p' "${INSTANCE_ROOT}/app.env" 2>/dev/null | tail -1 || true)"
    if [[ "${configured_port}" != "${PORT}" ]] && ! port_is_free "${PORT}"; then
      fail "port ${PORT} is occupied by a foreign process. Pick another with --port."
    fi
  elif ! port_is_free "${PORT}"; then
    fail "port ${PORT} is occupied by a foreign process. Pick another with --port."
  fi
}

install_node_deps() {
  log "installing Node dependencies (npm ci)"
  (cd "${REPO_ROOT}" && npm ci --no-audit --no-fund)
}

install_worker_deps() {
  local venv="${INSTANCE_ROOT}/venv"
  if [[ ! -x "${venv}/bin/python3" ]]; then
    log "creating worker Python venv at ${venv}"
    python3 -m venv "${venv}"
  fi
  log "installing worker dependencies from worker/requirements.txt"
  "${venv}/bin/pip" install --quiet --disable-pip-version-check -r "${REPO_ROOT}/worker/requirements.txt"
}

previous_model_tier() {
  [[ -f "${INSTANCE_ROOT}/app.env" ]] || return 1
  sed -n 's/^SUPERSCRIBER_TRANSCRIBE_MODEL=\([a-zA-Z0-9._-]*\)$/\1/p' "${INSTANCE_ROOT}/app.env" | tail -1
}

choose_model_tier() {
  local previous answer
  if [[ -n "${MODEL_TIER}" ]]; then
    RESOLVED_MODEL_TIER="${MODEL_TIER}"
    return
  fi
  previous="$(previous_model_tier || true)"
  if [[ -n "${previous}" ]]; then
    RESOLVED_MODEL_TIER="${previous}"
    log "preserving previously configured model tier '${RESOLVED_MODEL_TIER}'"
    return
  fi
  if [[ "${SKIP_MODEL_DOWNLOAD}" -eq 1 || ! -t 0 ]]; then
    RESOLVED_MODEL_TIER="small"
    [[ "${SKIP_MODEL_DOWNLOAD}" -eq 1 ]] || log "non-interactive run: defaulting to the catalog default model tier 'small'"
    return
  fi
  log "available transcription model tiers:"
  (cd "${REPO_ROOT}" && SUPERSCRIBER_TRANSCRIBE_MODEL_DIR="${INSTANCE_ROOT}/model-cache" \
    npx tsx scripts/provision-model-tier.ts --list)
  printf 'Choose a model tier [small]: ' >&2
  read -r answer
  RESOLVED_MODEL_TIER="${answer:-small}"
}

write_env_assignment() {
  local file="$1" name="$2" value="$3"
  printf '%s=%q\n' "${name}" "${value}" >> "${file}"
}

normalize_runtime_permissions() {
  chmod 700 "${INSTANCE_ROOT}" "${INSTANCE_ROOT}/data" "${INSTANCE_ROOT}/data/media" \
    "${INSTANCE_ROOT}/data/uploads" "${INSTANCE_ROOT}/model-cache" \
    "${INSTANCE_ROOT}/logs" "${INSTANCE_ROOT}/pids" "${INSTANCE_ROOT}/secrets"
  find "${INSTANCE_ROOT}/data" "${INSTANCE_ROOT}/model-cache" "${INSTANCE_ROOT}/logs" \
    "${INSTANCE_ROOT}/pids" "${INSTANCE_ROOT}/secrets" -type d -exec chmod 700 {} +
  find "${INSTANCE_ROOT}/data" "${INSTANCE_ROOT}/model-cache" "${INSTANCE_ROOT}/logs" \
    "${INSTANCE_ROOT}/pids" "${INSTANCE_ROOT}/secrets" -type f -exec chmod 600 {} +
  [[ ! -f "${INSTANCE_ROOT}/instance.log" ]] || chmod 600 "${INSTANCE_ROOT}/instance.log"
  [[ ! -f "${INSTANCE_ROOT}/app.env" ]] || chmod 600 "${INSTANCE_ROOT}/app.env"
}

prepare_instance_root() {
  mkdir -p \
    "${INSTANCE_ROOT}/data/media" \
    "${INSTANCE_ROOT}/data/uploads" \
    "${INSTANCE_ROOT}/model-cache" \
    "${INSTANCE_ROOT}/logs" \
    "${INSTANCE_ROOT}/pids" \
    "${INSTANCE_ROOT}/secrets"
  normalize_runtime_permissions

  if [[ ! -s "${INSTANCE_ROOT}/secrets/auth.secret" ]]; then
    node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("hex"))' \
      > "${INSTANCE_ROOT}/secrets/auth.secret"
  fi
  if [[ ! -s "${INSTANCE_ROOT}/secrets/engine.secret" ]]; then
    node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' \
      > "${INSTANCE_ROOT}/secrets/engine.secret"
  fi
  chmod 600 "${INSTANCE_ROOT}/secrets/auth.secret" "${INSTANCE_ROOT}/secrets/engine.secret"
}

write_app_env() {
  local env_file="${INSTANCE_ROOT}/app.env.tmp.$$"
  : > "${env_file}"
  write_env_assignment "${env_file}" SUPERSCRIBER_AUTH_MODE local
  write_env_assignment "${env_file}" SUPERSCRIBER_DEPLOYMENT_PROFILE no-mail
  write_env_assignment "${env_file}" SUPERSCRIBER_DB_PATH "${INSTANCE_ROOT}/data/superscriber.db"
  write_env_assignment "${env_file}" SUPERSCRIBER_MEDIA_DIR "${INSTANCE_ROOT}/data/media"
  write_env_assignment "${env_file}" SUPERSCRIBER_UPLOAD_TMP_DIR "${INSTANCE_ROOT}/data/uploads"
  write_env_assignment "${env_file}" SUPERSCRIBER_ENGINE_MODE internal
  write_env_assignment "${env_file}" SUPERSCRIBER_APP_BASE_URL "http://127.0.0.1:${PORT}"
  write_env_assignment "${env_file}" NEXTAUTH_URL "http://localhost:${PORT}"
  write_env_assignment "${env_file}" SUPERSCRIBER_TRANSCRIBE_MODEL "${RESOLVED_MODEL_TIER}"
  write_env_assignment "${env_file}" SUPERSCRIBER_TRANSCRIBE_MODEL_DIR "${INSTANCE_ROOT}/model-cache"
  write_env_assignment "${env_file}" SUPERSCRIBER_TRANSCRIBE_OFFLINE 1
  write_env_assignment "${env_file}" SUPERSCRIBER_TRANSCRIBE_ALLOW_RUNTIME_DOWNLOAD 0
  write_env_assignment "${env_file}" SUPERSCRIBER_WORKER_PYTHON "${INSTANCE_ROOT}/venv/bin/python3"
  write_env_assignment "${env_file}" PORT "${PORT}"
  write_env_assignment "${env_file}" HOSTNAME 127.0.0.1
  chmod 600 "${env_file}"
  mv "${env_file}" "${INSTANCE_ROOT}/app.env"
  log "instance root ready at ${INSTANCE_ROOT} (db: data/superscriber.db, models: model-cache/, logs: logs/)"
}

provision_model() {
  if [[ "${SKIP_MODEL_DOWNLOAD}" -eq 1 ]]; then
    log "verifying cached model tier '${RESOLVED_MODEL_TIER}' (--skip-model-download)"
    (cd "${REPO_ROOT}" && SUPERSCRIBER_TRANSCRIBE_MODEL_DIR="${INSTANCE_ROOT}/model-cache" \
      npx tsx scripts/provision-model-tier.ts --verify "${RESOLVED_MODEL_TIER}")
    return
  fi
  log "provisioning model tier '${RESOLVED_MODEL_TIER}' through the app's pinned-artifact flow"
  (cd "${REPO_ROOT}" && SUPERSCRIBER_TRANSCRIBE_MODEL_DIR="${INSTANCE_ROOT}/model-cache" \
    npx tsx scripts/provision-model-tier.ts --tier "${RESOLVED_MODEL_TIER}")
}

quiesce_instance() {
  if [[ "${INSTANCE_WAS_RUNNING}" -eq 1 ]]; then
    log "quiescing the running instance before database and bundle activation"
    bash "${SCRIPT_DIR}/instance-stop.sh" "${INSTANCE_ROOT}"
    INSTANCE_WAS_RUNNING=0
  fi
  port_is_free "${PORT}" || fail "port ${PORT} remains occupied after instance quiescence"
}

init_database() {
  log "initializing database (idempotent migrations)"
  (cd "${REPO_ROOT}" && SUPERSCRIBER_DB_PATH="${INSTANCE_ROOT}/data/superscriber.db" \
    npx tsx scripts/ensure-db.ts)
}

build_app() {
  log "building production bundle (next build, standalone output)"
  (cd "${REPO_ROOT}" && NEXT_TELEMETRY_DISABLED=1 npm run build)
  rm -rf "${REPO_ROOT}/.next/standalone/.next/static"
  cp -R "${REPO_ROOT}/.next/static" "${REPO_ROOT}/.next/standalone/.next/static"
  rm -rf "${REPO_ROOT}/.next/standalone/public"
  cp -R "${REPO_ROOT}/public" "${REPO_ROOT}/.next/standalone/public"
}

launch_failure() {
  bash "${SCRIPT_DIR}/instance-stop.sh" "${INSTANCE_ROOT}" >/dev/null 2>&1 || true
  fail "$1"
}

launch_instance() {
  log "launching supervisor (crash-restart; SIGTERM-stoppable via scripts/instance-stop.sh)"
  bash "${SCRIPT_DIR}/instance-run.sh" "${INSTANCE_ROOT}"

  log "waiting for app and worker readiness on http://127.0.0.1:${PORT}"
  local attempts=0 app_ready=0 worker_ready=0 worker_status
  while [[ "${attempts}" -lt 120 ]]; do
    if ! bash "${SCRIPT_DIR}/instance-run.sh" "${INSTANCE_ROOT}" --status >/dev/null 2>&1; then
      launch_failure "the supervisor exited before the instance became ready; inspect ${INSTANCE_ROOT}/logs/supervisor.log"
    fi
    if python3 "${REPO_ROOT}/scripts/http_probe.py" "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 && \
       bash "${SCRIPT_DIR}/instance-run.sh" "${INSTANCE_ROOT}" --app-running >/dev/null 2>&1; then
      app_ready=1
    fi
    worker_status=1
    if bash "${SCRIPT_DIR}/instance-run.sh" "${INSTANCE_ROOT}" --worker-ready >/dev/null 2>&1; then
      worker_ready=1
      worker_status=0
    else
      worker_status=$?
    fi
    if [[ "${worker_status}" -eq 2 ]]; then
      launch_failure "the worker failed its startup preflight; inspect ${INSTANCE_ROOT}/logs/worker.log"
    fi
    if [[ "${app_ready}" -eq 1 && "${worker_ready}" -eq 1 ]]; then
      return
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
  launch_failure "app and worker did not become ready within 120 seconds; inspect ${INSTANCE_ROOT}/logs/"
}

print_first_run() {
  local root_command
  printf -v root_command '%q' "${INSTANCE_ROOT}"
  cat <<EOF

Superscriber is running.

  URL:                http://localhost:${PORT}
  First admin:        open the URL - with no accounts yet, the sign-up door is the
                      first-run bootstrap: the first account you create becomes the
                      administrator. After that the door closes and admins provision
                      accounts from Administration > Accounts.
  Instance root:      ${INSTANCE_ROOT}
  Database:           ${INSTANCE_ROOT}/data/superscriber.db
  Model cache:        ${INSTANCE_ROOT}/model-cache (${RESOLVED_MODEL_TIER})
  Logs:               ${INSTANCE_ROOT}/logs/{app,worker,supervisor}.log
  Stop:               scripts/instance-stop.sh ${root_command}
  Start:              scripts/instance-run.sh ${root_command}
  Re-run bootstrap:   ${BASH_SOURCE[0]} (idempotent)

EOF
}

main() {
  check_dependencies
  if [[ "${CHECK_DEPS_ONLY}" -eq 1 ]]; then
    check_python_venv
    log_dependencies
    return 0
  fi

  resolve_instance_root
  check_python_venv
  log_dependencies
  install_node_deps
  choose_model_tier
  prepare_instance_root
  provision_model
  write_app_env
  quiesce_instance
  if [[ "${SKIP_WORKER_DEPS}" -eq 0 ]]; then
    install_worker_deps
  fi
  init_database
  build_app
  launch_instance
  print_first_run
}

main "$@"
