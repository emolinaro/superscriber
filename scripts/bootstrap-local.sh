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
ACTIVATION_RECORD=""
ACTIVATION_BACKUP=""
ACTIVATION_CANDIDATE=""
ACTIVATION_PENDING=0
INSTANCE_WAS_RUNNING=0
INSTANCE_RESTORED=0

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

fsync_file_path() {
  node -e '
    const fs = require("node:fs");
    const fd = fs.openSync(process.argv[1], "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  ' "$1"
}

fsync_directory_path() {
  node -e '
    const fs = require("node:fs");
    const fd = fs.openSync(process.argv[1], "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  ' "$1"
}

fsync_tree_path() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const sync = (target) => {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(target)) sync(path.join(target, entry));
      }
      const fd = fs.openSync(target, "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    };
    sync(process.argv[1]);
  ' "$1"
}

durable_replace_file() {
  local source="$1" destination="$2" directory="$3"
  fsync_file_path "${source}"
  mv "${source}" "${destination}"
  fsync_directory_path "${directory}"
}

durable_remove_paths() {
  local directory="$1" path changed=0
  shift
  for path in "$@"; do
    if [[ -e "${path}" || -L "${path}" ]]; then
      rm -f -- "${path}"
      changed=1
    fi
  done
  [[ "${changed}" -eq 0 ]] || fsync_directory_path "${directory}"
}

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
  ACTIVATION_RECORD="${INSTANCE_ROOT}/activation.pending"
  ACTIVATION_BACKUP="${INSTANCE_ROOT}/activation.previous"
  ACTIVATION_CANDIDATE="${INSTANCE_ROOT}/activation.candidate"
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
  [[ ! -f "${INSTANCE_ROOT}/rollback.env" ]] || chmod 600 "${INSTANCE_ROOT}/rollback.env"
  [[ ! -f "${ACTIVATION_RECORD}" ]] || chmod 600 "${ACTIVATION_RECORD}"
  [[ ! -f "${ACTIVATION_BACKUP}" ]] || chmod 600 "${ACTIVATION_BACKUP}"
  [[ ! -f "${ACTIVATION_CANDIDATE}" ]] || chmod 600 "${ACTIVATION_CANDIDATE}"
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
  if [[ -e "${ACTIVATION_RECORD}" || -L "${ACTIVATION_RECORD}" ]]; then
    recover_pending_activation || fail "could not recover the interrupted activation at ${ACTIVATION_RECORD}"
  else
    rm -f -- "${ACTIVATION_BACKUP}" "${ACTIVATION_CANDIDATE}"
  fi
  INSTANCE_WAS_RUNNING=0
  INSTANCE_RESTORED=0
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
  local attempts=0 token started observed age
  MAINTENANCE_LOCK_DIR="$(maintenance_lock_dir "${INSTANCE_ROOT}")"
  while [[ "${attempts}" -lt 50 ]]; do
    if lock_reclaim_is_blocking "${MAINTENANCE_LOCK_DIR}"; then
      attempts=$((attempts + 1))
      sleep 0.1
      continue
    fi
    token="$(instance_random_token)"
    started="$(process_start_fingerprint "$$")" || \
      fail "could not identify the bootstrap process for maintenance ownership"
    MAINTENANCE_IDENTITY="$$ ${token} ${started}"
    if publish_process_lock_directory \
      "${MAINTENANCE_LOCK_DIR}" identity "${MAINTENANCE_IDENTITY}"; then
      trap cleanup_bootstrap_state EXIT
      return 0
    fi
    MAINTENANCE_IDENTITY=""
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
  local attempts=0 token started observed age
  while [[ "${attempts}" -lt 50 ]]; do
    if lock_reclaim_is_blocking "${REPOSITORY_LOCK_DIR}"; then
      attempts=$((attempts + 1))
      sleep 0.1
      continue
    fi
    token="$(instance_random_token)"
    started="$(process_start_fingerprint "$$")" || \
      fail "could not identify the bootstrap process for repository ownership"
    REPOSITORY_LOCK_IDENTITY="$$ ${token} ${started}"
    if publish_process_lock_directory \
      "${REPOSITORY_LOCK_DIR}" identity "${REPOSITORY_LOCK_IDENTITY}"; then
      trap cleanup_bootstrap_state EXIT
      return 0
    fi
    REPOSITORY_LOCK_IDENTITY=""
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
    fsync_directory_path "${INSTANCE_ROOT}/build"
  fi
}

remove_bundle_generation() {
  local bundle_id="$1"
  [[ "${bundle_id}" =~ ^[0-9a-f]{40}-[0-9a-f]{48}$ ]] || return 0
  [[ "${bundle_id}" == "${BUNDLE_ID}" && "${INSTANCE_ROOT}/build/${bundle_id}" == "${BUNDLE_DIR}" ]] || return 0
  remove_inactive_bundle_generation "${bundle_id}"
}

remove_inactive_bundle_generation() {
  local bundle_id="$1" path active_id
  [[ "${bundle_id}" =~ ^[0-9a-f]{40}-[0-9a-f]{48}$ ]] || return 0
  path="${INSTANCE_ROOT}/build/${bundle_id}"
  [[ "${path}" == "${INSTANCE_ROOT}/build/"* ]] || return 0
  active_id="$(activation_id_from_file "${INSTANCE_ROOT}/app.env" 2>/dev/null || true)"
  [[ "${active_id}" != "${bundle_id}" ]] || return 0
  if [[ -d "${path}" && ! -L "${path}" ]]; then
    rm -rf -- "${path}"
    fsync_directory_path "${INSTANCE_ROOT}/build"
  fi
}

read_activation_record() {
  local format candidate previous was_running
  [[ -f "${ACTIVATION_RECORD}" && ! -L "${ACTIVATION_RECORD}" ]] || return 1
  format="$(sed -n 's/^FORMAT=//p' "${ACTIVATION_RECORD}")"
  candidate="$(sed -n 's/^CANDIDATE=//p' "${ACTIVATION_RECORD}")"
  previous="$(sed -n 's/^PREVIOUS=//p' "${ACTIVATION_RECORD}")"
  was_running="$(sed -n 's/^PREVIOUS_WAS_RUNNING=//p' "${ACTIVATION_RECORD}")"
  [[ "${format}" == "superscriber-activation-v1" ]] || return 1
  [[ "${candidate}" =~ ^[0-9a-f]{40}-[0-9a-f]{48}$ ]] || return 1
  [[ "${previous}" == "none" || "${previous}" =~ ^[0-9a-f]{40}-[0-9a-f]{48}$ ]] || return 1
  [[ "${previous}" != "${candidate}" ]] || return 1
  [[ "${was_running}" == "0" || "${was_running}" == "1" ]] || return 1
  [[ "${previous}" != "none" || "${was_running}" == "0" ]] || return 1
  printf '%s %s %s\n' "${candidate}" "${previous}" "${was_running}"
}

write_activation_record() {
  local candidate="$1" previous="$2" was_running="$3" tmp
  tmp="${ACTIVATION_RECORD}.tmp.$$"
  [[ ! -e "${tmp}" && ! -L "${tmp}" ]] || fail "refusing to overwrite an activation record staging file"
  {
    printf 'FORMAT=superscriber-activation-v1\n'
    printf 'CANDIDATE=%s\n' "${candidate}"
    printf 'PREVIOUS=%s\n' "${previous}"
    printf 'PREVIOUS_WAS_RUNNING=%s\n' "${was_running}"
  } > "${tmp}"
  chmod 600 "${tmp}"
  durable_replace_file "${tmp}" "${ACTIVATION_RECORD}" "${INSTANCE_ROOT}"
}

recover_pending_activation() {
  local record candidate previous was_running current source="" restored_tmp
  record="$(read_activation_record)" || return 1
  read -r candidate previous was_running <<< "${record}"
  current="$(activation_id_from_file "${INSTANCE_ROOT}/app.env" 2>/dev/null || true)"
  if [[ "${current}" != "${candidate}" && "${current}" != "${previous}" ]]; then
    [[ -z "${current}" && "${previous}" == "none" ]] || return 1
  fi

  if [[ "${previous}" != "none" ]]; then
    if [[ "${current}" == "${previous}" ]] && resolve_active_bundle "${INSTANCE_ROOT}" >/dev/null 2>&1; then
      source="${INSTANCE_ROOT}/app.env"
    elif [[ "$(activation_id_from_file "${ACTIVATION_BACKUP}" 2>/dev/null || true)" == "${previous}" ]] && \
         resolve_activation_bundle "${INSTANCE_ROOT}" "${ACTIVATION_BACKUP}" >/dev/null 2>&1; then
      source="${ACTIVATION_BACKUP}"
    elif [[ "$(activation_id_from_file "${INSTANCE_ROOT}/rollback.env" 2>/dev/null || true)" == "${previous}" ]] && \
         resolve_activation_bundle "${INSTANCE_ROOT}" "${INSTANCE_ROOT}/rollback.env" >/dev/null 2>&1; then
      source="${INSTANCE_ROOT}/rollback.env"
    else
      return 1
    fi
  fi

  if bash "${SCRIPT_DIR}/instance-run.sh" "${INSTANCE_ROOT}" --status >/dev/null 2>&1; then
    bash "${SCRIPT_DIR}/instance-stop.sh" "${INSTANCE_ROOT}" >/dev/null 2>&1 || return 1
  fi

  if [[ "${previous}" == "none" ]]; then
    durable_remove_paths "${INSTANCE_ROOT}" "${INSTANCE_ROOT}/app.env"
  elif [[ "${source}" != "${INSTANCE_ROOT}/app.env" ]]; then
    restored_tmp="${INSTANCE_ROOT}/app.env.recovered.$$"
    cp "${source}" "${restored_tmp}"
    chmod 600 "${restored_tmp}"
    durable_replace_file "${restored_tmp}" "${INSTANCE_ROOT}/app.env" "${INSTANCE_ROOT}"
  fi
  if [[ "${previous}" != "none" ]]; then
    resolve_active_bundle "${INSTANCE_ROOT}" >/dev/null 2>&1 || return 1
  fi

  remove_inactive_bundle_generation "${candidate}"
  durable_remove_paths "${INSTANCE_ROOT}" "${ACTIVATION_CANDIDATE}"
  if [[ "${was_running}" == "1" ]]; then
    SUPERSCRIBER_MAINTENANCE_IDENTITY="${MAINTENANCE_IDENTITY}" \
      bash "${SCRIPT_DIR}/instance-run.sh" "${INSTANCE_ROOT}" >/dev/null 2>&1 || return 1
    bash "${SCRIPT_DIR}/instance-run.sh" "${INSTANCE_ROOT}" --status >/dev/null 2>&1 || return 1
  fi
  durable_remove_paths "${INSTANCE_ROOT}" "${ACTIVATION_RECORD}" "${ACTIVATION_BACKUP}"
  ACTIVATION_PENDING=0
  INSTANCE_RESTORED=1
  log "recovered the previous activation after an interrupted bootstrap"
}

restart_quiesced_instance() {
  [[ "${INSTANCE_WAS_RUNNING}" -eq 1 && "${INSTANCE_RESTORED}" -eq 0 ]] || return 0
  if ! bash "${SCRIPT_DIR}/instance-run.sh" "${INSTANCE_ROOT}" --status >/dev/null 2>&1; then
    if SUPERSCRIBER_MAINTENANCE_IDENTITY="${MAINTENANCE_IDENTITY}" \
      bash "${SCRIPT_DIR}/instance-run.sh" "${INSTANCE_ROOT}" >/dev/null 2>&1; then
      log "restored the previously running instance"
    else
      printf '[bootstrap] ERROR: could not restart the previous instance; inspect %s/logs/supervisor.log\n' "${INSTANCE_ROOT}" >&2
    fi
  fi
  INSTANCE_RESTORED=1
}

restore_previous_activation() {
  [[ "${ACTIVATION_PENDING}" -eq 1 || -e "${ACTIVATION_RECORD}" || -L "${ACTIVATION_RECORD}" ]] || return 0
  recover_pending_activation
}

cleanup_bootstrap_state() {
  cleanup_build_output
  cleanup_bundle_staging
  release_repository_lock
  if [[ "${ACTIVATION_PENDING}" -eq 1 || -e "${ACTIVATION_RECORD}" || -L "${ACTIVATION_RECORD}" ]]; then
    if ! restore_previous_activation; then
      printf '[bootstrap] ERROR: could not restore the previous activation; inspect %s\n' "${ACTIVATION_RECORD}" >&2
    fi
  else
    restart_quiesced_instance
  fi
  remove_bundle_generation "${BUNDLE_ID}"
  if [[ ! -e "${ACTIVATION_RECORD}" && ! -L "${ACTIVATION_RECORD}" ]]; then
    durable_remove_paths "${INSTANCE_ROOT}" "${ACTIVATION_BACKUP}" "${ACTIVATION_CANDIDATE}"
  fi
  release_maintenance_lock
}

write_app_env() {
  local env_file="${ACTIVATION_CANDIDATE}" previous_id="none" backup_tmp
  reject_managed_instance_symlinks "${INSTANCE_ROOT}" || exit 1
  [[ -n "${BUNDLE_ID}" && -n "${BUNDLE_DIR}" ]] || fail "production bundle was not published"
  [[ ! -e "${ACTIVATION_RECORD}" && ! -L "${ACTIVATION_RECORD}" ]] || fail "an earlier activation still requires recovery"
  [[ ! -e "${env_file}" && ! -L "${env_file}" ]] || fail "refusing to overwrite an activation candidate"
  if resolve_active_bundle "${INSTANCE_ROOT}" >/dev/null 2>&1; then
    previous_id="$(activation_id_from_file "${INSTANCE_ROOT}/app.env")"
    backup_tmp="${ACTIVATION_BACKUP}.tmp.$$"
    [[ ! -e "${backup_tmp}" && ! -L "${backup_tmp}" ]] || fail "refusing to overwrite an activation backup staging file"
    cp "${INSTANCE_ROOT}/app.env" "${backup_tmp}"
    chmod 600 "${backup_tmp}"
    durable_replace_file "${backup_tmp}" "${ACTIVATION_BACKUP}" "${INSTANCE_ROOT}"
    activation_id_from_file "${ACTIVATION_BACKUP}" >/dev/null
  else
    durable_remove_paths "${INSTANCE_ROOT}" "${ACTIVATION_BACKUP}"
  fi
  : > "${env_file}"
  write_env_assignment "${env_file}" SUPERSCRIBER_ACTIVATION_ID "${BUNDLE_ID}"
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
  write_env_assignment "${env_file}" SUPERSCRIBER_APP_BUNDLE "${BUNDLE_DIR}"
  write_env_assignment "${env_file}" PORT "${PORT}"
  write_env_assignment "${env_file}" HOSTNAME 127.0.0.1
  chmod 600 "${env_file}"
  fsync_file_path "${env_file}"
  write_activation_record "${BUNDLE_ID}" "${previous_id}" "${INSTANCE_WAS_RUNNING}"
  ACTIVATION_PENDING=1
  durable_replace_file "${env_file}" "${INSTANCE_ROOT}/app.env" "${INSTANCE_ROOT}"
  durable_remove_paths "${INSTANCE_ROOT}" "${INSTANCE_ROOT}/active-bundle"
  log "instance root ready at ${INSTANCE_ROOT} (db: data/superscriber.db, models: model-cache/, logs: logs/)"
}

prune_inactive_bundles() {
  local active_id rollback_id="" path name changed=0
  active_id="$(activation_id_from_file "${INSTANCE_ROOT}/app.env")" || return 1
  if [[ -f "${INSTANCE_ROOT}/rollback.env" && ! -L "${INSTANCE_ROOT}/rollback.env" ]]; then
    rollback_id="$(activation_id_from_file "${INSTANCE_ROOT}/rollback.env" 2>/dev/null || true)"
  fi
  for path in "${INSTANCE_ROOT}/build"/*; do
    [[ -e "${path}" || -L "${path}" ]] || continue
    name="${path##*/}"
    [[ "${name}" =~ ^[0-9a-f]{40}-[0-9a-f]{48}$ ]] || continue
    [[ "${name}" == "${active_id}" || "${name}" == "${rollback_id}" ]] && continue
    [[ -d "${path}" && ! -L "${path}" ]] || continue
    rm -rf -- "${path}"
    changed=1
  done
  [[ "${changed}" -eq 0 ]] || fsync_directory_path "${INSTANCE_ROOT}/build"
}

commit_activation() {
  local record candidate previous was_running
  record="$(read_activation_record)" || fail "active candidate has no valid pending activation record"
  read -r candidate previous was_running <<< "${record}"
  [[ "${candidate}" == "${BUNDLE_ID}" ]] || fail "pending activation does not match the running candidate"
  [[ "$(activation_id_from_file "${INSTANCE_ROOT}/app.env" 2>/dev/null || true)" == "${candidate}" ]] || \
    fail "active activation does not match the running candidate"
  if [[ "${previous}" != "none" ]]; then
    [[ "$(activation_id_from_file "${ACTIVATION_BACKUP}" 2>/dev/null || true)" == "${previous}" ]] || \
      fail "pending activation lost its previous generation"
    durable_replace_file "${ACTIVATION_BACKUP}" "${INSTANCE_ROOT}/rollback.env" "${INSTANCE_ROOT}"
  else
    durable_remove_paths "${INSTANCE_ROOT}" "${INSTANCE_ROOT}/rollback.env" "${ACTIVATION_BACKUP}"
  fi
  durable_remove_paths "${INSTANCE_ROOT}" "${ACTIVATION_RECORD}" "${ACTIVATION_CANDIDATE}"
  ACTIVATION_PENDING=0
  INSTANCE_RESTORED=1
  prune_inactive_bundles
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
    INSTANCE_WAS_RUNNING=1
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
  fsync_tree_path "${staging}"
  mv "${staging}" "${BUNDLE_DIR}"
  fsync_directory_path "${INSTANCE_ROOT}/build"
  reject_managed_instance_symlinks "${INSTANCE_ROOT}" || exit 1
  cleanup_build_output
}

launch_failure() {
  restore_previous_activation || fail "$1; restoring the previous activation also failed"
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
  acquire_repository_lock
  install_node_deps
  choose_model_tier
  provision_model
  init_database
  build_app
  release_repository_lock
  write_app_env
  launch_instance
  commit_activation
  release_maintenance_lock
  trap - EXIT
  print_first_run
}

main "$@"
