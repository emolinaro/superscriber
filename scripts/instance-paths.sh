#!/usr/bin/env bash

INSTANCE_MARKER_NAME=".superscriber-instance"

canonicalize_instance_path() {
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

resolve_durable_instance_root() {
  local raw="$1" resolved candidate canonical_temp
  resolved="$(canonicalize_instance_path "${raw}")" || {
    printf "could not resolve instance root '%s'\n" "${raw}" >&2
    return 1
  }
  if [[ "${resolved}" == "/" ]]; then
    printf 'instance root must be a dedicated directory, not the filesystem root\n' >&2
    return 1
  fi
  if [[ "${SUPERSCRIBER_BOOTSTRAP_ALLOW_TMP_INSTANCE_ROOT:-0}" != "1" ]]; then
    for candidate in "/tmp" "/private/tmp" "${TMPDIR:-/tmp}"; do
      canonical_temp="$(canonicalize_instance_path "${candidate}")" || continue
      case "${resolved}" in
        "${canonical_temp}"|"${canonical_temp}"/*)
          printf 'instance root must be durable storage, never the system temp dir: %s\n' "${resolved}" >&2
          return 1
          ;;
      esac
    done
  fi
  printf '%s\n' "${resolved}"
}

instance_marker_is_valid() {
  local marker="$1/${INSTANCE_MARKER_NAME}" signature
  [[ -f "${marker}" && ! -L "${marker}" ]] || return 1
  IFS= read -r signature < "${marker}" || return 1
  [[ "${signature}" == "superscriber-local-instance-v1" ]]
}

require_instance_marker() {
  instance_marker_is_valid "$1" && return 0
  printf "instance root '%s' is not owned by the local bootstrap; run scripts/bootstrap-local.sh first\n" "$1" >&2
  return 1
}

reject_managed_instance_symlinks() {
  local root="$1" relative path
  for relative in data data/media data/uploads model-cache logs pids secrets venv; do
    path="${root}/${relative}"
    if [[ -L "${path}" ]]; then
      printf "managed instance path must not be a symlink: %s\n" "${path}" >&2
      return 1
    fi
  done
}

process_start_fingerprint() {
  local pid="$1" started
  kill -0 "${pid}" 2>/dev/null || return 1
  started="$(ps -ww -p "${pid}" -o lstart= 2>/dev/null)"
  [[ -n "${started//[[:space:]]/}" ]] || return 1
  printf '%s' "${started}" | cksum | awk '{ printf "%s-%s\n", $1, $2 }'
}

process_matches_start_fingerprint() {
  local pid="$1" expected="$2" current
  current="$(process_start_fingerprint "${pid}")" || return 1
  [[ "${current}" == "${expected}" ]]
}

process_command_fingerprint() {
  local pid="$1" command
  kill -0 "${pid}" 2>/dev/null || return 1
  command="$(ps -ww -p "${pid}" -o args= 2>/dev/null)"
  [[ -n "${command}" ]] || return 1
  printf '%s' "${command}" | cksum | awk '{ printf "%s-%s\n", $1, $2 }'
}

process_matches_role_identity() {
  local pid="$1" started="$2" command="$3" current_command
  process_matches_start_fingerprint "${pid}" "${started}" || return 1
  current_command="$(process_command_fingerprint "${pid}")" || return 1
  [[ "${current_command}" == "${command}" ]]
}

maintenance_lock_dir() {
  printf '%s/pids/maintenance.lock\n' "$1"
}

read_maintenance_identity() {
  local root="$1" identity pid token started
  identity="$(maintenance_lock_dir "${root}")/identity"
  [[ -f "${identity}" ]] || return 1
  read -r pid token started < "${identity}" || return 1
  [[ "${pid}" =~ ^[0-9]+$ && "${token}" =~ ^[0-9a-f]{48}$ && "${started}" =~ ^[0-9]+-[0-9]+$ ]] || return 1
  printf '%s %s %s\n' "${pid}" "${token}" "${started}"
}

maintenance_lock_is_active() {
  local root="$1" identity pid token started args
  identity="$(read_maintenance_identity "${root}")" || return 1
  read -r pid token started <<< "${identity}"
  process_matches_start_fingerprint "${pid}" "${started}" || return 1
  args="$(ps -ww -p "${pid}" -o args= 2>/dev/null || true)"
  [[ "${args}" == *"bootstrap-local.sh"* ]]
}
