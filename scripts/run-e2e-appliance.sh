#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-test}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TMP_ROOT="${REPO_ROOT}/.tmp"

IMAGE="${SUPERSCRIBER_E2E_IMAGE:-superscriber:e2e}"
CONTAINER_NAME="${SUPERSCRIBER_E2E_CONTAINER_NAME:-superscriber-e2e}"
PORT="${SUPERSCRIBER_E2E_PORT:-3105}"
APP_URL="${PLAYWRIGHT_BASE_URL:-http://localhost:${PORT}}"
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

# The OIDC fake provider runs as a sidecar sharing the app container's network
# namespace, so the app, the browser, and the suite all see one identical
# issuer: http://127.0.0.1:${OIDC_PORT}/ (loopback inside the shared netns, published
# to the host for Playwright).
OIDC_PORT="${SUPERSCRIBER_E2E_OIDC_PORT:-4105}"
OIDC_SIDECAR="${CONTAINER_NAME}-oidc"
OIDC_DIR="${TMP_ROOT}/e2e-oidc-config"
export SUPERSCRIBER_E2E_OIDC_PORT="${OIDC_PORT}"

# Reset-mail seam: SUPERSCRIBER_E2E_RESET_MAIL=smtp starts a fake SMTP
# sidecar (same netns pattern as OIDC) and configures the app for the
# password-reset mail spec. Default (unset) keeps the seam off, matching the
# product default.
RESET_MAIL_MODE="${SUPERSCRIBER_E2E_RESET_MAIL:-}"
SMTP_PORT="${SUPERSCRIBER_E2E_SMTP_PORT:-4205}"
SMTP_CONTROL_PORT="${SUPERSCRIBER_E2E_SMTP_CONTROL_PORT:-4206}"
SMTP_SIDECAR="${CONTAINER_NAME}-smtp"
export SUPERSCRIBER_E2E_RESET_MAIL="${RESET_MAIL_MODE}"
export SUPERSCRIBER_E2E_SMTP_CONTROL_PORT="${SMTP_CONTROL_PORT}"

cleanup_container() {
  docker rm -f "${CONTAINER_NAME}" "${OIDC_SIDECAR}" "${SMTP_SIDECAR}" >/dev/null 2>&1 || true
}

cleanup_oidc_config() {
  rm -rf "${OIDC_DIR}" >/dev/null 2>&1 || true
}

cleanup_run() {
  cleanup_container
  cleanup_oidc_config
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
  if python3 "${REPO_ROOT}/scripts/http_probe.py" "http://127.0.0.1:${OIDC_PORT}/jwks" >/dev/null 2>&1; then
    echo "Refusing to start: a server already answers on OIDC port ${OIDC_PORT}." >&2
    echo "Stop it, or set SUPERSCRIBER_E2E_OIDC_PORT to a free port." >&2
    return 1
  fi
  if [[ "${RESET_MAIL_MODE}" == "smtp" ]]; then
    if python3 "${REPO_ROOT}/scripts/http_probe.py" "http://127.0.0.1:${SMTP_CONTROL_PORT}/messages" >/dev/null 2>&1; then
      echo "Refusing to start: a server already answers on SMTP control port ${SMTP_CONTROL_PORT}." >&2
      echo "Stop it, or set SUPERSCRIBER_E2E_SMTP_CONTROL_PORT to a free port." >&2
      return 1
    fi
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
  cleanup_oidc_config
  preflight_port_free
  mkdir -p "${DATA_DIR}"

  # Mounted OIDC material for the container's dual-auth configuration.
  mkdir -p "${OIDC_DIR}"
  printf 'fake-oidc-client-secret\n' > "${OIDC_DIR}/client-secret"
  printf 'fake-smtp-password\n' > "${OIDC_DIR}/reset-mail-password"
  cat > "${OIDC_DIR}/management-networks.json" <<JSON
{
  "managementNetworks": ["10.10.0.0/16"],
  "trustedProxies": ["10.10.0.2"]
}
JSON
  cat > "${OIDC_DIR}/role-map.json" <<JSON
{
  "version": 1,
  "issuer": "http://127.0.0.1:${OIDC_PORT}/",
  "claim": "superscriber_role_group_ids",
  "groups": {
    "uploader": "11111111-1111-4111-8111-111111111111",
    "reviewer": "22222222-2222-4222-8222-222222222222",
    "approver": "33333333-3333-4333-8333-333333333333",
    "admin": "44444444-4444-4444-8444-444444444444"
  }
}
JSON
  SMTP_PUBLISH_ARGS=()
  SMTP_ENV_ARGS=()
  if [[ "${RESET_MAIL_MODE}" == "smtp" ]]; then
    SMTP_PUBLISH_ARGS=(
      --publish "${SMTP_PORT}:4205"
      --publish "${SMTP_CONTROL_PORT}:4206"
    )
    SMTP_ENV_ARGS=(
      --env "SUPERSCRIBER_RESET_MAIL_MODE=smtp"
      --env "SUPERSCRIBER_RESET_MAIL_SMTP_HOST=127.0.0.1"
      --env "SUPERSCRIBER_RESET_MAIL_SMTP_PORT=4205"
      --env "SUPERSCRIBER_RESET_MAIL_FROM_ADDRESS=reset@superscriber.test"
      --env "SUPERSCRIBER_RESET_MAIL_PASSWORD_FILE=/run/oidc/reset-mail-password"
      --env "SUPERSCRIBER_RESET_MAIL_BASE_URL=${APP_URL}"
    )
  fi

  # The container entrypoint chowns the bind-mounted data dir to the in-image
  # user without widening its mode. Keep it traversable so the host Playwright
  # process can stat the sqlite database on stock Linux CI runners.
  chmod 0755 "${DATA_DIR}"

  docker run \
    --detach \
    --name "${CONTAINER_NAME}" \
    --publish "${PORT}:3000" \
    --publish "${OIDC_PORT}:${OIDC_PORT}" \
    ${SMTP_PUBLISH_ARGS[@]+"${SMTP_PUBLISH_ARGS[@]}"} \
    --volume "${DATA_DIR}:/app/data" \
    --volume "${OIDC_DIR}:/run/oidc:ro" \
    --env NEXTAUTH_URL="${APP_URL}" \
    --env AUTH_URL="${APP_URL}" \
    --env SUPERSCRIBER_AUTH_MODE=dual \
    --env SUPERSCRIBER_OIDC_ISSUER="http://127.0.0.1:${OIDC_PORT}/" \
    --env SUPERSCRIBER_OIDC_CLIENT_ID="superscriber" \
    --env SUPERSCRIBER_OIDC_CLIENT_SECRET_FILE="/run/oidc/client-secret" \
    --env SUPERSCRIBER_OIDC_ROLE_MAP_FILE="/run/oidc/role-map.json" \
    --env SUPERSCRIBER_MANAGEMENT_NETWORKS_FILE="/run/oidc/management-networks.json" \
    ${SMTP_ENV_ARGS[@]+"${SMTP_ENV_ARGS[@]}"} \
    --env SUPERSCRIBER_TRANSCRIBE_MODEL="missing-e2e-model" \
    --env SUPERSCRIBER_TRANSCRIBE_OFFLINE=1 \
    --env SUPERSCRIBER_TRANSCRIBE_ALLOW_STUB_FALLBACK=1 \
    --env SUPERSCRIBER_WORKER_POLL_SECONDS=1 \
    --env SUPERSCRIBER_WORKER_HEARTBEAT_SECONDS=2 \
    "${IMAGE}" >/dev/null

  # Sidecar fake OIDC provider in the app container's network namespace. The
  # canonical implementation is TypeScript shared with the suite; esbuild
  # bundles it to a single plain-ESM file the stock node in the app image can
  # run without extra tooling.
  "${REPO_ROOT}/node_modules/.bin/esbuild" \
    "${REPO_ROOT}/scripts/fake-oidc-sidecar-entry.ts" \
    --format=esm --platform=node --target=node20 --bundle \
    --outfile="${OIDC_DIR}/fake-oidc-sidecar.mjs" >/dev/null

  docker run \
    --detach \
    --rm \
    --name "${OIDC_SIDECAR}" \
    --network "container:${CONTAINER_NAME}" \
    --entrypoint node \
    --volume "${OIDC_DIR}/fake-oidc-sidecar.mjs:/fake-oidc-sidecar.mjs:ro" \
    "${IMAGE}" /fake-oidc-sidecar.mjs "${OIDC_PORT}" >/dev/null

  local oidc_attempts=0
  until python3 "${REPO_ROOT}/scripts/http_probe.py" "http://127.0.0.1:${OIDC_PORT}/.well-known/openid-configuration"; do
    oidc_attempts=$((oidc_attempts + 1))
    if [[ ${oidc_attempts} -ge 30 ]]; then
      echo "Timed out waiting for the fake OIDC sidecar" >&2
      docker logs "${OIDC_SIDECAR}" >&2 || true
      return 1
    fi
    sleep 1
  done

  if [[ "${RESET_MAIL_MODE}" == "smtp" ]]; then
    # Sidecar fake SMTP provider in the app container's network namespace,
    # mirroring the OIDC sidecar above.
    "${REPO_ROOT}/node_modules/.bin/esbuild" \
      "${REPO_ROOT}/scripts/fake-smtp-sidecar-entry.ts" \
      --format=esm --platform=node --target=node20 --bundle \
      --outfile="${OIDC_DIR}/fake-smtp-sidecar.mjs" >/dev/null

    docker run \
      --detach \
      --rm \
      --name "${SMTP_SIDECAR}" \
      --network "container:${CONTAINER_NAME}" \
      --entrypoint node \
      --volume "${OIDC_DIR}/fake-smtp-sidecar.mjs:/fake-smtp-sidecar.mjs:ro" \
      "${IMAGE}" /fake-smtp-sidecar.mjs 4205 4206 >/dev/null

    local smtp_attempts=0
    until python3 "${REPO_ROOT}/scripts/http_probe.py" "http://127.0.0.1:${SMTP_CONTROL_PORT}/messages"; do
      smtp_attempts=$((smtp_attempts + 1))
      if [[ ${smtp_attempts} -ge 30 ]]; then
        echo "Timed out waiting for the fake SMTP sidecar" >&2
        docker logs "${SMTP_SIDECAR}" >&2 || true
        return 1
      fi
      sleep 1
    done
  fi

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
