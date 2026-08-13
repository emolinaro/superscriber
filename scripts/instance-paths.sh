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

reject_worker_venv_symlinks() {
  local venv="$1" found relative target
  [[ -d "${venv}" && ! -L "${venv}" ]] || return 0
  while IFS= read -r found; do
    relative="${found#"${venv}"/}"
    if [[ "${relative}" =~ ^bin/python([0-9]+(\.[0-9]+)?)?$ ]]; then
      continue
    fi
    if [[ "${relative}" == "lib64" ]]; then
      target="$(readlink "${found}")"
      [[ "${target}" == "lib" ]] && continue
    fi
    printf "managed instance path must not be a symlink: %s\n" "${found}" >&2
    return 1
  done < <(find "${venv}" -type l -print)
}

reject_managed_instance_symlinks() {
  local root="$1" relative path found child child_name
  for relative in \
    "${INSTANCE_MARKER_NAME}" app.env rollback.env activation.pending \
    activation.previous activation.candidate instance.log \
    data data/media data/uploads model-cache logs pids secrets venv build; do
    path="${root}/${relative}"
    if [[ -L "${path}" ]]; then
      printf "managed instance path must not be a symlink: %s\n" "${path}" >&2
      return 1
    fi
  done

  for relative in data model-cache logs pids secrets; do
    path="${root}/${relative}"
    [[ -d "${path}" ]] || continue
    found="$(find "${path}" -type l -print -quit)"
    if [[ -n "${found}" ]]; then
      printf "managed instance path must not be a symlink: %s\n" "${found}" >&2
      return 1
    fi
  done

  path="${root}/venv"
  reject_worker_venv_symlinks "${path}" || return 1

  for path in \
    "${root}/pids/supervisor.lock.reclaim" \
    "${root}/pids/maintenance.lock.reclaim"; do
    if [[ -L "${path}" ]]; then
      printf "managed instance path must not be a symlink: %s\n" "${path}" >&2
      return 1
    fi
  done

  path="${root}/build"
  if [[ -d "${path}" ]]; then
    for child in "${path}"/* "${path}"/.[!.]* "${path}"/..?*; do
      [[ -e "${child}" || -L "${child}" ]] || continue
      if [[ -L "${child}" ]]; then
        printf "managed instance path must not be a symlink: %s\n" "${child}" >&2
        return 1
      fi
      if [[ -d "${child}" && ( -e "${child}/venv" || -L "${child}/venv" ) ]]; then
        if [[ ! -d "${child}/venv" || -L "${child}/venv" ]]; then
          printf "managed instance venv must be a real directory: %s\n" "${child}/venv" >&2
          return 1
        fi
        child_name="${child##*/}"
        [[ "${child_name}" != .staging-* ]] || continue
        reject_worker_venv_symlinks "${child}/venv" || return 1
      fi
    done
  fi
}

path_age_ms() {
  node -e 'process.stdout.write(String(Date.now() - require("node:fs").statSync(process.argv[1]).mtimeMs))' "$1"
}

instance_random_token() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))'
}

publish_process_lock_directory() {
  local lock_dir="$1" private name value
  shift
  [[ ! -e "${lock_dir}" && ! -L "${lock_dir}" ]] || return 1
  private="${lock_dir}.pending.$$.$(instance_random_token)"
  [[ ! -e "${private}" && ! -L "${private}" ]] || return 1
  mkdir "${private}" || return 1
  chmod 700 "${private}"
  while [[ "$#" -gt 0 ]]; do
    [[ "$#" -ge 2 ]] || {
      rm -rf -- "${private}"
      return 1
    }
    name="$1"
    value="$2"
    shift 2
    [[ "${name}" =~ ^[a-zA-Z0-9._-]+$ ]] || {
      rm -rf -- "${private}"
      return 1
    }
    printf '%s\n' "${value}" > "${private}/${name}"
    chmod 600 "${private}/${name}"
  done
  if [[ ! -e "${lock_dir}" && ! -L "${lock_dir}" ]] && \
    node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' \
    "${private}" "${lock_dir}" 2>/dev/null; then
    return 0
  fi
  rm -rf -- "${private}"
  return 1
}

process_start_fingerprint() {
  local pid="$1" started
  process_is_live "${pid}" || return 1
  started="$(ps -ww -p "${pid}" -o lstart= 2>/dev/null)"
  [[ -n "${started//[[:space:]]/}" ]] || return 1
  printf '%s' "${started}" | cksum | awk '{ printf "%s-%s\n", $1, $2 }'
}

process_is_live() {
  local pid="$1" state
  kill -0 "${pid}" 2>/dev/null || return 1
  state="$(ps -p "${pid}" -o stat= 2>/dev/null || true)"
  [[ -n "${state}" && "${state}" != *Z* ]]
}

process_matches_start_fingerprint() {
  local pid="$1" expected="$2" current
  current="$(process_start_fingerprint "${pid}")" || return 1
  [[ "${current}" == "${expected}" ]]
}

process_command_fingerprint() {
  local pid="$1" command
  process_is_live "${pid}" || return 1
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

read_process_lock_identity_file() {
  local identity_file="$1" pid token started
  [[ -f "${identity_file}" && ! -L "${identity_file}" ]] || return 1
  read -r pid token started < "${identity_file}" || return 1
  [[ "${pid}" =~ ^[0-9]+$ && "${token}" =~ ^[0-9a-f]{48}$ && "${started}" =~ ^[0-9]+-[0-9]+$ ]] || return 1
  printf '%s %s %s\n' "${pid}" "${token}" "${started}"
}

process_lock_identity_is_active_file() {
  local identity pid token started
  identity="$(read_process_lock_identity_file "$1")" || return 1
  read -r pid token started <<< "${identity}"
  process_matches_start_fingerprint "${pid}" "${started}"
}

supervisor_lock_is_active() {
  local lock_dir="$1" identity pid token started args
  identity="$(cat "${lock_dir}/identity" 2>/dev/null || true)"
  read -r pid token <<< "${identity}"
  [[ "${pid}" =~ ^[0-9]+$ && "${token}" =~ ^[0-9a-f]{48}$ ]] || return 1
  started="$(cat "${lock_dir}/started" 2>/dev/null || true)"
  process_matches_start_fingerprint "${pid}" "${started}" || return 1
  args="$(ps -ww -p "${pid}" -o args= 2>/dev/null || true)"
  [[ "${args}" == *"instance-run.sh"* && "${args}" == *"--supervise ${token}"* ]]
}

reclaim_slot_is_owned() {
  local lock_dir="$1" expected="$2" current pid token started identity_file
  identity_file="$(reclaim_identity_file "${lock_dir}.reclaim")"
  current="$(cat "${identity_file}" 2>/dev/null || true)"
  [[ "${current}" == "${expected}" ]] || return 1
  read -r pid token started <<< "${current}"
  [[ "${pid}" =~ ^[0-9]+$ && "${token}" =~ ^[0-9a-f]{48}$ && "${started}" =~ ^[0-9]+-[0-9]+$ ]] || return 1
  process_matches_start_fingerprint "${pid}" "${started}"
}

release_reclaim_slot() {
  local lock_dir="$1" expected="$2" slot stale
  slot="${lock_dir}.reclaim"
  reclaim_slot_is_owned "${lock_dir}" "${expected}" || return 0
  stale="${slot}.released.$$.$RANDOM"
  if mv "${slot}" "${stale}" 2>/dev/null; then
    rm -rf -- "${stale}"
  fi
}

acquire_reclaim_slot() {
  local lock_dir="$1" slot attempts=0 token started identity private identity_file
  local observed age stale moved moved_identity_file
  slot="${lock_dir}.reclaim"
  while [[ "${attempts}" -lt 20 ]]; do
    token="$(instance_random_token)"
    started="$(process_start_fingerprint "$$")" || return 1
    identity="$$ ${token} ${started}"
    private="${slot}.pending.$$.$token"
    [[ ! -e "${private}" && ! -L "${private}" ]] || return 1
    mkdir "${private}"
    printf '%s\n' "${identity}" > "${private}/identity"
    chmod 600 "${private}/identity"
    if ln "${private}/identity" "${slot}" 2>/dev/null; then
      rm -rf -- "${private}"
      printf '%s\n' "${identity}"
      return 0
    fi
    rm -rf -- "${private}"

    if [[ -L "${slot}" ]]; then
      printf 'lock reclaim path must not be a symlink: %s\n' "${slot}" >&2
      return 1
    fi
    identity_file="$(reclaim_identity_file "${slot}")"
    observed="$(cat "${identity_file}" 2>/dev/null || true)"
    if process_lock_identity_is_active_file "${identity_file}"; then
      return 1
    fi
    age="$(path_age_ms "${slot}" 2>/dev/null || echo 0)"
    if [[ ! "${age}" =~ ^[0-9]+$ || "${age}" -lt 5000 ]]; then
      return 1
    fi

    stale="${slot}.stale.$$.$RANDOM"
    if mv "${slot}" "${stale}" 2>/dev/null; then
      moved_identity_file="$(reclaim_identity_file "${stale}")"
      moved="$(cat "${moved_identity_file}" 2>/dev/null || true)"
      if [[ "${moved}" == "${observed}" ]] && \
         ! process_lock_identity_is_active_file "${moved_identity_file}"; then
        rm -rf -- "${stale}"
      elif [[ ! -e "${slot}" && ! -L "${slot}" ]]; then
        mv "${stale}" "${slot}" 2>/dev/null || true
      fi
    fi
    attempts=$((attempts + 1))
    sleep 0.05
  done
  return 1
}

reclaim_identity_file() {
  if [[ -d "$1" && ! -L "$1" ]]; then
    printf '%s/identity\n' "$1"
  else
    printf '%s\n' "$1"
  fi
}

lock_reclaim_is_blocking() {
  local lock_dir="$1" slot claim
  slot="${lock_dir}.reclaim"
  [[ -e "${slot}" || -L "${slot}" ]] || return 1
  claim="$(acquire_reclaim_slot "${lock_dir}")" || return 0
  release_reclaim_slot "${lock_dir}" "${claim}"
  return 1
}

reclaim_stale_owned_lock() {
  local lock_dir="$1" observed="$2" active_check="$3" claim current stale
  shift 3
  claim="$(acquire_reclaim_slot "${lock_dir}")" || return 1

  current="$(cat "${lock_dir}/identity" 2>/dev/null || true)"
  if [[ "${current}" != "${observed}" ]] || "${active_check}" "$@" || \
     ! reclaim_slot_is_owned "${lock_dir}" "${claim}"; then
    release_reclaim_slot "${lock_dir}" "${claim}"
    return 1
  fi

  current="$(cat "${lock_dir}/identity" 2>/dev/null || true)"
  if [[ "${current}" != "${observed}" ]] || "${active_check}" "$@"; then
    release_reclaim_slot "${lock_dir}" "${claim}"
    return 1
  fi
  reclaim_slot_is_owned "${lock_dir}" "${claim}" || return 1

  stale="${lock_dir}.stale.$$.$RANDOM"
  if mv "${lock_dir}" "${stale}" 2>/dev/null; then
    rm -rf -- "${stale}"
    release_reclaim_slot "${lock_dir}" "${claim}"
    return 0
  fi
  release_reclaim_slot "${lock_dir}" "${claim}"
  return 1
}

maintenance_lock_dir() {
  printf '%s/pids/maintenance.lock\n' "$1"
}

read_maintenance_identity() {
  local root="$1" identity pid token started
  identity="$(maintenance_lock_dir "${root}")/identity"
  [[ -f "${identity}" && ! -L "${identity}" ]] || return 1
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

activation_id_from_file() {
  local activation_file="$1" bundle_id
  [[ -f "${activation_file}" && ! -L "${activation_file}" ]] || return 1
  bundle_id="$(sed -n 's/^SUPERSCRIBER_ACTIVATION_ID=\([0-9a-f][0-9a-f]*-[0-9a-f][0-9a-f]*\)$/\1/p' "${activation_file}")"
  [[ "${bundle_id}" =~ ^[0-9a-f]{40}-[0-9a-f]{48}$ ]] || return 1
  printf '%s\n' "${bundle_id}"
}

resolve_activation_bundle() {
  local root="$1" activation_file="$2" bundle_id bundle relative expected actual
  bundle_id="$(activation_id_from_file "${activation_file}")" || return 1
  bundle="${root}/build/${bundle_id}"
  [[ -d "${bundle}" && ! -L "${root}/build" && ! -L "${bundle}" ]] || return 1
  [[ ! -e "${bundle}/.incomplete" && ! -L "${bundle}/.incomplete" ]] || return 1
  [[ -d "${bundle}/venv" && ! -L "${bundle}/venv" && -x "${bundle}/venv/bin/python3" ]] || return 1
  reject_worker_venv_symlinks "${bundle}/venv" || return 1
  [[ -f "${bundle}/bundle.sha256" && ! -L "${bundle}/bundle.sha256" ]] || return 1
  for relative in server.js scripts/instance-run.sh scripts/instance-paths.sh \
    scripts/run-worker-python.sh worker/main.py; do
    [[ -f "${bundle}/${relative}" && ! -L "${bundle}/${relative}" ]] || return 1
    expected="$(awk -v wanted="${relative}" '$2 == wanted { print $1 }' "${bundle}/bundle.sha256")"
    [[ "${expected}" =~ ^[0-9a-f]{64}$ ]] || return 1
    actual="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "${bundle}/${relative}")"
    [[ "${actual}" == "${expected}" ]] || return 1
  done
  printf '%s\n' "${bundle}"
}

resolve_active_bundle() {
  resolve_activation_bundle "$1" "$1/app.env"
}
