#!/usr/bin/env bash
# local-deploy-bootstrap: one-shot LOCAL DEPLOY bootstrap. Takes a fresh
# machine (or a new operator) from a clean clone to a running local instance:
#
#   1. dependency preflight: Node (>= the version the repo's Dockerfile pins),
#      npm, python3 (for the transcription worker) - loud, actionable failures
#   2. npm ci + Python venv with worker/requirements.txt
#   3. instance root (default ~/.local/share/superscriber): durable data dir,
#      secrets (mode 0600, never printed), non-secret app.env
#   4. idempotent database initialization through the repo migration chain
#      (scripts/ensure-db.ts)
#   5. model tier provisioning through the SAME pinned-artifact in-app flow
#      the app exposes (src/server/models/provisioning.ts via
#      scripts/provision-model-tier.ts) - an already-provisioned cache is
#      detected and skipped, so re-runs work offline
#   6. production build (next build, standalone output) and launch under the
#      crash-restart supervisor (scripts/instance-run.sh)
#
# Re-runnable end to end. Instance state is durable and NEVER under /tmp.
#
# Usage:
#   scripts/bootstrap-local.sh [--instance-root DIR] [--port N] [--model-tier TIER]
#                              [--skip-model-download] [--skip-worker-deps]
#                              [--check-deps-only] [-h|--help]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

INSTANCE_ROOT="${SUPERSCRIBER_INSTANCE_ROOT:-${HOME}/.local/share/superscriber}"
PORT="3000"
MODEL_TIER=""
SKIP_MODEL_DOWNLOAD=0
SKIP_WORKER_DEPS=0
CHECK_DEPS_ONLY=0

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap-local.sh [options]

  --instance-root DIR     Instance state root (default: ~/.local/share/superscriber)
  --port N                Port for the app (default: 3000)
  --model-tier TIER       faster-whisper tier to provision (default: interactive
                          picker; non-interactive default: the catalog default 'small')
  --skip-model-download   Provision nothing; the worker stays offline-capable only if
                          the model cache is already populated
  --skip-worker-deps      Do not create the Python venv / install worker requirements
  --check-deps-only       Run only the dependency preflight (used by tests)
  -h, --help              Show this help
EOF
}

log() { printf '[bootstrap] %s\n' "$*"; }
fail() { printf '[bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance-root) INSTANCE_ROOT="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --model-tier) MODEL_TIER="$2"; shift 2 ;;
    --skip-model-download) SKIP_MODEL_DOWNLOAD=1; shift ;;
    --skip-worker-deps) SKIP_WORKER_DEPS=1; shift ;;
    --check-deps-only) CHECK_DEPS_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

# --- dependency preflight ---------------------------------------------------

required_node_version() {
  # The repo declares no package.json engines and no .nvmrc; the Dockerfile
  # base image pin is the authoritative Node contract.
  if [[ -f "${REPO_ROOT}/.nvmrc" ]]; then
    tr -d '[:space:]v' < "${REPO_ROOT}/.nvmrc"
    return
  fi
  local engines
  engines="$(node -e 'const e=require(process.argv[1]).engines;process.stdout.write(e&&e.node?e.node:"")' "${REPO_ROOT}/package.json" 2>/dev/null || true)"
  if [[ -n "${engines}" ]]; then
    # Reduce a range like ">=24.18.1" to its lower bound.
    printf '%s\n' "${engines}" | sed 's/[^0-9.]*\([0-9][0-9.]*\).*/\1/'
    return
  fi
  sed -n 's/^ARG NODE_BASE_IMAGE=node:\([0-9.]*\).*/\1/p' "${REPO_ROOT}/Dockerfile" | head -1
}

version_ge() {
  # version_ge HAVE WANT -> 0 when HAVE >= WANT (numeric, dotted).
  local have="$1" want="$2"
  [ "$(printf '%s\n%s\n' "${want}" "${have}" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" = "${want}" ]
}

check_dependencies() {
  command -v node >/dev/null 2>&1 || fail \
    "Node.js is not installed. Install Node >= $(required_node_version) (e.g. 'brew install node@24' or via nvm), then re-run."

  local want have
  want="$(required_node_version)"
  [[ -n "${want}" ]] || fail "could not determine the repo's required Node version from .nvmrc / package.json engines / Dockerfile"
  have="$(node --version | sed 's/^v//')"
  version_ge "${have}" "${want}" || fail \
    "Node ${have} is installed, but this repo requires Node >= ${want} (Dockerfile pin). Install a newer Node, then re-run."

  command -v npm >/dev/null 2>&1 || fail \
    "npm is not on PATH even though node is. Reinstall Node >= ${want} with npm bundled, then re-run."

  command -v python3 >/dev/null 2>&1 || fail \
    "python3 is not installed. The transcription worker needs Python >= 3.10 (e.g. 'brew install python@3.13' or your distro package), then re-run."
  version_ge "$(python3 -c 'import sys;print(".".join(map(str,sys.version_info[:2])))')" "3.10" || fail \
    "python3 is too old; the transcription worker needs Python >= 3.10. Install a newer Python, then re-run."

  log "dependencies ok: node ${have}, npm $(npm --version), $(python3 --version)"
}

# --- phases -----------------------------------------------------------------

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

prepare_instance_root() {
  local tmp_arg tmp_real
  tmp_arg="${TMPDIR:-/tmp}"
  tmp_arg="${tmp_arg%/}"
  tmp_real="$(cd "${tmp_arg}" 2>/dev/null && pwd -P || true)"
  # SUPERSCRIBER_BOOTSTRAP_ALLOW_TMP_INSTANCE_ROOT is a test-only escape
  # hatch (script-level vitest runs use scratch roots under the os tmpdir);
  # operators must never set it - instance state must outlive a reboot.
  if [[ "${SUPERSCRIBER_BOOTSTRAP_ALLOW_TMP_INSTANCE_ROOT:-0}" != "1" ]]; then
    case "${INSTANCE_ROOT}" in
      /tmp/*|/private/tmp/*|"${tmp_arg}"/*|"${tmp_real:-__never__}"/*)
        fail "instance root must be durable storage, never the system temp dir: ${INSTANCE_ROOT}" ;;
    esac
  fi
  case "${PORT}" in
    ''|*[!0-9]*) fail "port must be a number, got '${PORT}'" ;;
  esac
  [[ "${PORT}" -ge 1024 && "${PORT}" -le 65535 ]] || fail "port ${PORT} is outside 1024-65535"
  if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    if [[ -f "${INSTANCE_ROOT}/pids/supervisor.pid" ]] && kill -0 "$(cat "${INSTANCE_ROOT}/pids/supervisor.pid")" 2>/dev/null; then
      : # our own supervisor is already serving this port; re-run continues
    else
      fail "port ${PORT} is occupied by a foreign process. Pick another with --port."
    fi
  fi

  mkdir -p \
    "${INSTANCE_ROOT}/data/media" \
    "${INSTANCE_ROOT}/data/uploads" \
    "${INSTANCE_ROOT}/model-cache" \
    "${INSTANCE_ROOT}/logs" \
    "${INSTANCE_ROOT}/pids" \
    "${INSTANCE_ROOT}/secrets"
  chmod 700 "${INSTANCE_ROOT}/secrets"

  umask 077
  if [[ ! -s "${INSTANCE_ROOT}/secrets/auth.secret" ]]; then
    node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("hex"))' \
      > "${INSTANCE_ROOT}/secrets/auth.secret"
  fi
  if [[ ! -s "${INSTANCE_ROOT}/secrets/engine.secret" ]]; then
    node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' \
      > "${INSTANCE_ROOT}/secrets/engine.secret"
  fi
  umask 022
  chmod 600 "${INSTANCE_ROOT}/secrets/auth.secret" "${INSTANCE_ROOT}/secrets/engine.secret"

  cat > "${INSTANCE_ROOT}/app.env" <<EOF
SUPERSCRIBER_AUTH_MODE=local
SUPERSCRIBER_DEPLOYMENT_PROFILE=no-mail
SUPERSCRIBER_DB_PATH=${INSTANCE_ROOT}/data/superscriber.db
SUPERSCRIBER_MEDIA_DIR=${INSTANCE_ROOT}/data/media
SUPERSCRIBER_UPLOAD_TMP_DIR=${INSTANCE_ROOT}/data/uploads
SUPERSCRIBER_ENGINE_MODE=internal
SUPERSCRIBER_APP_BASE_URL=http://127.0.0.1:${PORT}
NEXTAUTH_URL=http://localhost:${PORT}
SUPERSCRIBER_TRANSCRIBE_MODEL=${RESOLVED_MODEL_TIER}
SUPERSCRIBER_TRANSCRIBE_MODEL_DIR=${INSTANCE_ROOT}/model-cache
SUPERSCRIBER_TRANSCRIBE_OFFLINE=1
SUPERSCRIBER_TRANSCRIBE_ALLOW_RUNTIME_DOWNLOAD=0
SUPERSCRIBER_WORKER_PYTHON=${INSTANCE_ROOT}/venv/bin/python3
PORT=${PORT}
HOSTNAME=127.0.0.1
EOF
  log "instance root ready at ${INSTANCE_ROOT} (db: data/superscriber.db, models: model-cache/, logs: logs/)"
}

init_database() {
  log "initializing database (idempotent migrations)"
  (cd "${REPO_ROOT}" && SUPERSCRIBER_DB_PATH="${INSTANCE_ROOT}/data/superscriber.db" \
    npx tsx scripts/ensure-db.ts)
}

choose_model_tier() {
  if [[ "${SKIP_MODEL_DOWNLOAD}" -eq 1 ]]; then
    RESOLVED_MODEL_TIER="small"
    return
  fi
  if [[ -n "${MODEL_TIER}" ]]; then
    RESOLVED_MODEL_TIER="${MODEL_TIER}"
    return
  fi
  if [[ ! -t 0 ]]; then
    RESOLVED_MODEL_TIER="small"
    log "non-interactive run: defaulting to the catalog default model tier 'small'"
    return
  fi
  log "available transcription model tiers:"
  (cd "${REPO_ROOT}" && SUPERSCRIBER_TRANSCRIBE_MODEL_DIR="${INSTANCE_ROOT}/model-cache" \
    npx tsx scripts/provision-model-tier.ts --list)
  printf 'Choose a model tier [small]: ' >&2
  local answer
  read -r answer
  RESOLVED_MODEL_TIER="${answer:-small}"
}

provision_model() {
  if [[ "${SKIP_MODEL_DOWNLOAD}" -eq 1 ]]; then
    log "skipping model provisioning (--skip-model-download)"
    return
  fi
  log "provisioning model tier '${RESOLVED_MODEL_TIER}' through the app's pinned-artifact flow"
  (cd "${REPO_ROOT}" && SUPERSCRIBER_TRANSCRIBE_MODEL_DIR="${INSTANCE_ROOT}/model-cache" \
    npx tsx scripts/provision-model-tier.ts --tier "${RESOLVED_MODEL_TIER}")
}

build_app() {
  log "building production bundle (next build, standalone output)"
  (cd "${REPO_ROOT}" && NEXT_TELEMETRY_DISABLED=1 npm run build)
  # next standalone omits static assets; mirror what the Dockerfile does.
  rm -rf "${REPO_ROOT}/.next/standalone/.next/static"
  cp -R "${REPO_ROOT}/.next/static" "${REPO_ROOT}/.next/standalone/.next/static"
  rm -rf "${REPO_ROOT}/.next/standalone/public"
  cp -R "${REPO_ROOT}/public" "${REPO_ROOT}/.next/standalone/public"
}

launch_instance() {
  log "launching supervisor (crash-restart; SIGTERM-stoppable via scripts/instance-stop.sh)"
  bash "${SCRIPT_DIR}/instance-run.sh" "${INSTANCE_ROOT}"

  log "waiting for the app to answer on http://127.0.0.1:${PORT}"
  local attempts=0
  until python3 "${REPO_ROOT}/scripts/http_probe.py" "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [[ "${attempts}" -ge 120 ]]; then
      fail "the app did not become healthy within 120 seconds; tail ${INSTANCE_ROOT}/logs/app.log for details"
    fi
    sleep 1
  done
}

print_first_run() {
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
  Stop:               scripts/instance-stop.sh ${INSTANCE_ROOT}
  Start:              scripts/instance-run.sh ${INSTANCE_ROOT}
  Re-run bootstrap:   ${BASH_SOURCE[0]} (idempotent)

EOF
}

main() {
  check_dependencies
  [[ "${CHECK_DEPS_ONLY}" -eq 1 ]] && return 0

  install_node_deps
  choose_model_tier
  prepare_instance_root
  if [[ "${SKIP_WORKER_DEPS}" -eq 0 ]]; then
    install_worker_deps
  fi
  init_database
  provision_model
  build_app
  launch_instance
  print_first_run
}

main "$@"
