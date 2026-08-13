#!/usr/bin/env bash
# local-deploy-bootstrap: one-shot LOCAL DEPLOY bootstrap from a clean clone to
# a running app and transcription worker with durable instance state.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/instance-paths.sh
. "${SCRIPT_DIR}/instance-paths.sh"

INSTANCE_ROOT="${SUPERSCRIBER_INSTANCE_ROOT:-${HOME}/.local/share/superscriber}"
PORT="3000"
MODEL_TIER=""
RESOLVED_MODEL_TIER=""
SKIP_MODEL_DOWNLOAD=0
SKIP_WORKER_DEPS=0
CHECK_DEPS_ONLY=0
BUNDLE_ID=""
BUNDLE_DIR=""
BUILD_OUTPUT_DIR=""
REPOSITORY_LOCK_DIR="${REPO_ROOT}/.superscriber-bootstrap-repository.lock"
REPOSITORY_LOCK_IDENTITY=""

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap-local.sh [options]

  --instance-root DIR     Instance state root (default: ~/.local/share/superscriber)
  --port N                Port for the app (default: 3000)
  --model-tier TIER       faster-whisper tier to provision (default: interactive
                          picker; non-interactive default: the catalog default 'small')
  --skip-model-download   Do not download; require the selected or previously
                          configured tier to exist in the model cache
  --skip-worker-deps      Reuse an existing valid worker venv without installing
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
  INSTANCE_ROOT="$(resolve_durable_instance_root "${INSTANCE_ROOT}")" || exit 1
  case "${PORT}" in
    ''|*[!0-9]*) fail "port must be a number, got '${PORT}'" ;;
  esac
  [[ "${PORT}" -ge 1024 && "${PORT}" -le 65535 ]] || fail "port ${PORT} is outside 1024-65535"

  if [[ -e "${INSTANCE_ROOT}" && ! -d "${INSTANCE_ROOT}" ]]; then
    fail "instance root exists but is not a directory: ${INSTANCE_ROOT}"
  fi
  if [[ -d "${INSTANCE_ROOT}" ]] && ! instance_marker_is_valid "${INSTANCE_ROOT}" && \
     [[ -n "$(find "${INSTANCE_ROOT}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    fail "existing instance root is non-empty but has no valid ${INSTANCE_MARKER_NAME} ownership marker. Pick an empty, dedicated instance root."
  fi
  reject_managed_instance_symlinks "${INSTANCE_ROOT}" || exit 1

  if [[ -d "${INSTANCE_ROOT}" ]] && bash "${SCRIPT_DIR}/instance-run.sh" "${INSTANCE_ROOT}" --status >/dev/null 2>&1; then
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
  reject_managed_instance_symlinks "${INSTANCE_ROOT}" || exit 1
  if [[ ! -x "${venv}/bin/python3" ]]; then
    log "creating worker Python venv at ${venv}"
    python3 -m venv "${venv}"
  fi
  validate_worker_python_version
  log "installing worker dependencies from worker/requirements.txt"
  "${venv}/bin/pip" install --quiet --disable-pip-version-check -r "${REPO_ROOT}/worker/requirements.txt"
}

validate_worker_python_version() {
  local python="${INSTANCE_ROOT}/venv/bin/python3"
  [[ -x "${python}" ]] || fail "worker venv is missing at ${INSTANCE_ROOT}/venv. Re-run without --skip-worker-deps to create it."
  "${python}" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1 || \
    fail "worker venv Python must be >= 3.10. Remove ${INSTANCE_ROOT}/venv and re-run without --skip-worker-deps."
}

validate_worker_venv() {
  local python="${INSTANCE_ROOT}/venv/bin/python3"
  reject_managed_instance_symlinks "${INSTANCE_ROOT}" || exit 1
  validate_worker_python_version
  "${python}" -c 'import faster_whisper' >/dev/null 2>&1 || \
    fail "worker venv is missing faster-whisper. Re-run without --skip-worker-deps to install worker/requirements.txt."
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
  reject_managed_instance_symlinks "${INSTANCE_ROOT}" || exit 1
  chmod 700 "${INSTANCE_ROOT}" "${INSTANCE_ROOT}/data" "${INSTANCE_ROOT}/data/media" \
    "${INSTANCE_ROOT}/data/uploads" "${INSTANCE_ROOT}/model-cache" \
    "${INSTANCE_ROOT}/logs" "${INSTANCE_ROOT}/pids" "${INSTANCE_ROOT}/secrets" \
    "${INSTANCE_ROOT}/build"
  find "${INSTANCE_ROOT}/data" "${INSTANCE_ROOT}/model-cache" "${INSTANCE_ROOT}/logs" \
    "${INSTANCE_ROOT}/pids" "${INSTANCE_ROOT}/secrets" -type d -exec chmod 700 {} +
  find "${INSTANCE_ROOT}/data" "${INSTANCE_ROOT}/model-cache" "${INSTANCE_ROOT}/logs" \
    "${INSTANCE_ROOT}/pids" "${INSTANCE_ROOT}/secrets" -type f -exec chmod 600 {} +
  [[ ! -f "${INSTANCE_ROOT}/instance.log" ]] || chmod 600 "${INSTANCE_ROOT}/instance.log"
  [[ ! -f "${INSTANCE_ROOT}/app.env" ]] || chmod 600 "${INSTANCE_ROOT}/app.env"
  [[ ! -f "${INSTANCE_ROOT}/active-bundle" ]] || chmod 600 "${INSTANCE_ROOT}/active-bundle"
  chmod 600 "${INSTANCE_ROOT}/${INSTANCE_MARKER_NAME}"
}

prepare_instance_root() {
  reject_managed_instance_symlinks "${INSTANCE_ROOT}" || exit 1
  mkdir -p "${INSTANCE_ROOT}"
  if ! instance_marker_is_valid "${INSTANCE_ROOT}"; then
    local marker_tmp="${INSTANCE_ROOT}/${INSTANCE_MARKER_NAME}.tmp.$$"
    printf 'superscriber-local-instance-v1\ncreated_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${marker_tmp}"
    chmod 600 "${marker_tmp}"
    mv "${marker_tmp}" "${INSTANCE_ROOT}/${INSTANCE_MARKER_NAME}"
  fi
  reject_managed_instance_symlinks "${INSTANCE_ROOT}" || exit 1
  mkdir -p \
    "${INSTANCE_ROOT}/data/media" \
    "${INSTANCE_ROOT}/data/uploads" \
    "${INSTANCE_ROOT}/model-cache" \
    "${INSTANCE_ROOT}/logs" \
    "${INSTANCE_ROOT}/pids" \
    "${INSTANCE_ROOT}/secrets" \
    "${INSTANCE_ROOT}/build"
  acquire_maintenance_lock
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

MAINTENANCE_LOCK_DIR=""
MAINTENANCE_IDENTITY=""

reclaim_stale_maintenance_lock() {
  reclaim_stale_owned_lock \
    "${MAINTENANCE_LOCK_DIR}" "$1" maintenance_lock_is_active "${INSTANCE_ROOT}"
}

release_maintenance_lock() {
  local current stale claim observed
  [[ -n "${MAINTENANCE_LOCK_DIR}" && -d "${MAINTENANCE_LOCK_DIR}" ]] || return 0
  current="$(cat "${MAINTENANCE_LOCK_DIR}/identity" 2>/dev/null || true)"
  [[ "${current}" == "${MAINTENANCE_IDENTITY}" ]] || return 0
  observed="${current}"
  claim="$(acquire_reclaim_slot "${MAINTENANCE_LOCK_DIR}")" || return 0
  [[ "$(cat "${MAINTENANCE_LOCK_DIR}/identity" 2>/dev/null || true)" == "${observed}" ]] || {
    release_reclaim_slot "${MAINTENANCE_LOCK_DIR}" "${claim}"
    return 0
  }
  reclaim_slot_is_owned "${MAINTENANCE_LOCK_DIR}" "${claim}" || return 0
  stale="${MAINTENANCE_LOCK_DIR}.released.$$.$RANDOM"
  if mv "${MAINTENANCE_LOCK_DIR}" "${stale}" 2>/dev/null; then
    rm -rf -- "${stale}"
  fi
  release_reclaim_slot "${MAINTENANCE_LOCK_DIR}" "${claim}"
}

acquire_maintenance_lock() {
  local attempts=0 token started observed age identity_tmp
  MAINTENANCE_LOCK_DIR="$(maintenance_lock_dir "${INSTANCE_ROOT}")"
  while [[ "${attempts}" -lt 50 ]]; do
    if lock_reclaim_is_blocking "${MAINTENANCE_LOCK_DIR}"; then
      attempts=$((attempts + 1))
      sleep 0.1
      continue
    fi
    if mkdir "${MAINTENANCE_LOCK_DIR}" 2>/dev/null; then
      if [[ -d "${MAINTENANCE_LOCK_DIR}.reclaim" || -L "${MAINTENANCE_LOCK_DIR}.reclaim" ]]; then
        rmdir "${MAINTENANCE_LOCK_DIR}" 2>/dev/null || true
        attempts=$((attempts + 1))
        sleep 0.1
        continue
      fi
      token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
      started="$(process_start_fingerprint "$$")" || {
        rmdir "${MAINTENANCE_LOCK_DIR}" 2>/dev/null || true
        fail "could not identify the bootstrap process for maintenance ownership"
      }
      MAINTENANCE_IDENTITY="$$ ${token} ${started}"
      identity_tmp="${MAINTENANCE_LOCK_DIR}/identity.tmp.$$"
      printf '%s\n' "${MAINTENANCE_IDENTITY}" > "${identity_tmp}"
      mv "${identity_tmp}" "${MAINTENANCE_LOCK_DIR}/identity"
      trap cleanup_bootstrap_state EXIT
      return 0
    fi
    if maintenance_lock_is_active "${INSTANCE_ROOT}"; then
      fail "another bootstrap is maintaining ${INSTANCE_ROOT}; wait for it to finish before re-running"
    fi
    observed="$(cat "${MAINTENANCE_LOCK_DIR}/identity" 2>/dev/null || true)"
    age="$(path_age_ms "${MAINTENANCE_LOCK_DIR}" 2>/dev/null || echo 0)"
    if [[ "${age}" =~ ^[0-9]+$ && "${age}" -ge 5000 ]]; then
      reclaim_stale_maintenance_lock "${observed}" || true
    fi
    attempts=$((attempts + 1))
    sleep 0.1
  done
  fail "could not acquire maintenance ownership for ${INSTANCE_ROOT}; another bootstrap may be starting"
}

repository_lock_is_active() {
  process_lock_identity_is_active_file "${REPOSITORY_LOCK_DIR}/identity"
}

release_repository_lock() {
  local current stale claim observed
  [[ -n "${REPOSITORY_LOCK_IDENTITY}" && -d "${REPOSITORY_LOCK_DIR}" ]] || return 0
  current="$(cat "${REPOSITORY_LOCK_DIR}/identity" 2>/dev/null || true)"
  [[ "${current}" == "${REPOSITORY_LOCK_IDENTITY}" ]] || return 0
  observed="${current}"
  claim="$(acquire_reclaim_slot "${REPOSITORY_LOCK_DIR}")" || return 0
  [[ "$(cat "${REPOSITORY_LOCK_DIR}/identity" 2>/dev/null || true)" == "${observed}" ]] || {
    release_reclaim_slot "${REPOSITORY_LOCK_DIR}" "${claim}"
    return 0
  }
  reclaim_slot_is_owned "${REPOSITORY_LOCK_DIR}" "${claim}" || return 0
  stale="${REPOSITORY_LOCK_DIR}.released.$$.$RANDOM"
  if mv "${REPOSITORY_LOCK_DIR}" "${stale}" 2>/dev/null; then
    rm -rf -- "${stale}"
  fi
  release_reclaim_slot "${REPOSITORY_LOCK_DIR}" "${claim}"
  REPOSITORY_LOCK_IDENTITY=""
}

acquire_repository_lock() {
  local attempts=0 token started identity_tmp observed age
  while [[ "${attempts}" -lt 50 ]]; do
    if lock_reclaim_is_blocking "${REPOSITORY_LOCK_DIR}"; then
      attempts=$((attempts + 1))
      sleep 0.1
      continue
    fi
    if mkdir "${REPOSITORY_LOCK_DIR}" 2>/dev/null; then
      if [[ -d "${REPOSITORY_LOCK_DIR}.reclaim" || -L "${REPOSITORY_LOCK_DIR}.reclaim" ]]; then
        rmdir "${REPOSITORY_LOCK_DIR}" 2>/dev/null || true
        attempts=$((attempts + 1))
        sleep 0.1
        continue
      fi
      token="$(instance_random_token)"
      started="$(process_start_fingerprint "$$")" || {
        rmdir "${REPOSITORY_LOCK_DIR}" 2>/dev/null || true
        fail "could not identify the bootstrap process for repository ownership"
      }
      REPOSITORY_LOCK_IDENTITY="$$ ${token} ${started}"
      identity_tmp="${REPOSITORY_LOCK_DIR}/identity.tmp.$$"
      printf '%s\n' "${REPOSITORY_LOCK_IDENTITY}" > "${identity_tmp}"
      mv "${identity_tmp}" "${REPOSITORY_LOCK_DIR}/identity"
      trap cleanup_bootstrap_state EXIT
      return 0
    fi
    if [[ -L "${REPOSITORY_LOCK_DIR}" ]]; then
      fail "repository operation lock must not be a symlink: ${REPOSITORY_LOCK_DIR}"
    fi
    if repository_lock_is_active; then
      fail "another local bootstrap is using this repository's dependencies; wait for it to finish before re-running"
    fi
    observed="$(cat "${REPOSITORY_LOCK_DIR}/identity" 2>/dev/null || true)"
    age="$(path_age_ms "${REPOSITORY_LOCK_DIR}" 2>/dev/null || echo 0)"
    if [[ "${age}" =~ ^[0-9]+$ && "${age}" -ge 5000 ]]; then
      reclaim_stale_owned_lock \
        "${REPOSITORY_LOCK_DIR}" "${observed}" repository_lock_is_active || true
    fi
    attempts=$((attempts + 1))
    sleep 0.1
  done
  fail "could not acquire repository dependency ownership; another bootstrap may be starting"
}

cleanup_build_output() {
  if [[ -n "${BUILD_OUTPUT_DIR}" && -d "${BUILD_OUTPUT_DIR}" ]]; then
    case "${BUILD_OUTPUT_DIR}" in
      "${REPO_ROOT}/.superscriber-build-output/"*) rm -rf -- "${BUILD_OUTPUT_DIR}" ;;
    esac
  fi
  rmdir "${REPO_ROOT}/.superscriber-build-output" 2>/dev/null || true
  BUILD_OUTPUT_DIR=""
}

cleanup_bundle_staging() {
  local path
  [[ -n "${BUNDLE_ID}" ]] || return 0
  path="${INSTANCE_ROOT}/build/.staging-${BUNDLE_ID}"
  if [[ -d "${path}" && ! -L "${path}" ]]; then
    rm -rf -- "${path}"
  fi
}

cleanup_bootstrap_state() {
  cleanup_build_output
  cleanup_bundle_staging
  release_repository_lock
  release_maintenance_lock
}

write_app_env() {
  local env_file="${INSTANCE_ROOT}/app.env.tmp.$$" active_file
  reject_managed_instance_symlinks "${INSTANCE_ROOT}" || exit 1
  [[ -n "${BUNDLE_ID}" && -n "${BUNDLE_DIR}" ]] || fail "production bundle was not published"
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
  write_env_assignment "${env_file}" SUPERSCRIBER_APP_BUNDLE "${BUNDLE_DIR}"
  write_env_assignment "${env_file}" PORT "${PORT}"
  write_env_assignment "${env_file}" HOSTNAME 127.0.0.1
  chmod 600 "${env_file}"
  mv "${env_file}" "${INSTANCE_ROOT}/app.env"
  active_file="${INSTANCE_ROOT}/active-bundle.tmp.$$"
  printf '%s\n' "${BUNDLE_ID}" > "${active_file}"
  chmod 600 "${active_file}"
  mv "${active_file}" "${INSTANCE_ROOT}/active-bundle"
  log "instance root ready at ${INSTANCE_ROOT} (db: data/superscriber.db, models: model-cache/, logs: logs/)"
}

provision_model() {
  reject_managed_instance_symlinks "${INSTANCE_ROOT}" || exit 1
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
  if bash "${SCRIPT_DIR}/instance-run.sh" "${INSTANCE_ROOT}" --status >/dev/null 2>&1; then
    log "quiescing the running instance before database and bundle activation"
    bash "${SCRIPT_DIR}/instance-stop.sh" "${INSTANCE_ROOT}"
  fi
  port_is_free "${PORT}" || fail "port ${PORT} remains occupied after instance quiescence"
}

init_database() {
  reject_managed_instance_symlinks "${INSTANCE_ROOT}" || exit 1
  log "initializing database (idempotent migrations)"
  (cd "${REPO_ROOT}" && SUPERSCRIBER_DB_PATH="${INSTANCE_ROOT}/data/superscriber.db" \
    npx tsx scripts/ensure-db.ts)
}

build_app() {
  local revision token dist_relative staging bundle_hash_file relative checksum
  revision="$(git -C "${REPO_ROOT}" rev-parse --verify HEAD)"
  [[ "${revision}" =~ ^[0-9a-f]{40}$ ]] || fail "could not determine an immutable source revision for the production bundle"
  token="$(instance_random_token)"
  BUNDLE_ID="${revision}-${token}"
  BUNDLE_DIR="${INSTANCE_ROOT}/build/${BUNDLE_ID}"
  staging="${INSTANCE_ROOT}/build/.staging-${BUNDLE_ID}"
  dist_relative=".superscriber-build-output/${BUNDLE_ID}"
  BUILD_OUTPUT_DIR="${REPO_ROOT}/${dist_relative}"
  reject_managed_instance_symlinks "${INSTANCE_ROOT}" || exit 1
  [[ ! -e "${BUNDLE_DIR}" && ! -L "${BUNDLE_DIR}" && ! -e "${staging}" && ! -L "${staging}" ]] || \
    fail "refusing to overwrite an existing production bundle target"
  log "building production bundle (next build, standalone output)"
  (cd "${REPO_ROOT}" && \
    NEXT_TELEMETRY_DISABLED=1 SUPERSCRIBER_NEXT_DIST_DIR="${dist_relative}" npm run build)
  [[ -f "${BUILD_OUTPUT_DIR}/standalone/server.js" ]] || fail "Next standalone build did not produce server.js"
  mkdir -p "${staging}/.next/static" "${staging}/public" "${staging}/scripts"
  cp -RL "${BUILD_OUTPUT_DIR}/standalone/." "${staging}/"
  cp -RL "${BUILD_OUTPUT_DIR}/static/." "${staging}/.next/static/"
  cp -RL "${REPO_ROOT}/public/." "${staging}/public/"
  cp -RL "${REPO_ROOT}/worker" "${staging}/worker"
  cp "${REPO_ROOT}/scripts/instance-run.sh" \
    "${REPO_ROOT}/scripts/instance-paths.sh" \
    "${REPO_ROOT}/scripts/instance-stop.sh" \
    "${REPO_ROOT}/scripts/run-worker-python.sh" \
    "${staging}/scripts/"
  bundle_hash_file="${staging}/bundle.sha256"
  : > "${bundle_hash_file}"
  for relative in server.js scripts/instance-run.sh scripts/instance-paths.sh \
    scripts/run-worker-python.sh worker/main.py; do
    checksum="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "${staging}/${relative}")"
    printf '%s %s\n' "${checksum}" "${relative}" >> "${bundle_hash_file}"
  done
  chmod 700 "${staging}/scripts/instance-run.sh" \
    "${staging}/scripts/instance-stop.sh" \
    "${staging}/scripts/run-worker-python.sh"
  chmod -R go-rwx "${staging}"
  mv "${staging}" "${BUNDLE_DIR}"
  reject_managed_instance_symlinks "${INSTANCE_ROOT}" || exit 1
  cleanup_build_output
}

launch_failure() {
  bash "${SCRIPT_DIR}/instance-stop.sh" "${INSTANCE_ROOT}" >/dev/null 2>&1 || true
  fail "$1"
}

launch_instance() {
  log "launching supervisor (crash-restart; SIGTERM-stoppable via scripts/instance-stop.sh)"
  SUPERSCRIBER_MAINTENANCE_IDENTITY="${MAINTENANCE_IDENTITY}" \
    bash "${SCRIPT_DIR}/instance-run.sh" "${INSTANCE_ROOT}"

  log "waiting for app and worker readiness on http://127.0.0.1:${PORT}"
  local attempts=0 app_ready worker_ready worker_status
  while [[ "${attempts}" -lt 120 ]]; do
    app_ready=0
    worker_ready=0
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
  local root_command bootstrap_command
  printf -v root_command '%q' "${INSTANCE_ROOT}"
  printf -v bootstrap_command '%q --instance-root %q --port %q' "${BASH_SOURCE[0]}" "${INSTANCE_ROOT}" "${PORT}"
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
  Re-run bootstrap:   ${bootstrap_command} (idempotent)

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
  prepare_instance_root
  quiesce_instance
  if [[ "${SKIP_WORKER_DEPS}" -eq 0 ]]; then
    install_worker_deps
  fi
  validate_worker_venv
  choose_model_tier
  acquire_repository_lock
  install_node_deps
  build_app
  release_repository_lock
  provision_model
  init_database
  write_app_env
  launch_instance
  release_maintenance_lock
  trap - EXIT
  print_first_run
}

main "$@"
