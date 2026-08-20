#!/usr/bin/env bash
# install-worker-torch-wheels.sh - platform- and residence-aware picker for
# the pinned torch pair that the diarization worker needs.
#
# Captain context (corr=5b5415f96245d0fe) + directive corr=0688a345e73914a8:
# the installer SELF-CLASSIFIES host hardware - OS + arch AND CUDA residence
# (NVIDIA) - and picks the right torch wheel variant automatically: CPU when
# nothing else is supported, the NVIDIA CUDA wheel on CUDA-capable runtimes,
# macOS keeps its CPU/MPS build, and anything unknown falls back to CPU with
# a printed notice. There is NO manual --device/--backend-style toggle: the
# operator never picks a variant. A plan line is printed before any
# download. Wheels come from the pinned PyTorch index
# (https://download.pytorch.org/whl/<variant>); the cuXXX indexes
# self-mirror the nvidia-* runtime dependencies. See worker/requirements.txt
# for why torch/torchaudio stay pinned at 2.8.0 (pyannote.audio 3.3.2 calls
# a torchaudio API removed in 2.9).
#
# Callpath: scripts/bootstrap-local.sh -> this script. The Dockerfile pins
# the CPU variant directly (the appliance image intentionally stays
# CUDA-free); this script governs host installs.
#
# Usage:  scripts/install-worker-torch-wheels.sh <worker-venv-dir>
#
# Variants the classifier may pick:
#   - pypi  default PyPI index (macOS and Linux aarch64; the only published
#           macOS torch 2.8.0 wheels are arm64 CPU/MPS builds, and PyPI
#           linux aarch64 wheels are CPU builds)
#   - cpu   https://download.pytorch.org/whl/cpu
#   - cuXXX https://download.pytorch.org/whl/cuXXX (NVIDIA CUDA residence;
#           chosen to not exceed the driver's reported CUDA capability)

set -euo pipefail

TORCH_VERSION="2.8.0"
TORCHAUDIO_VERSION="2.8.0"
PYTORCH_WHEEL_BASE="https://download.pytorch.org/whl"
CUDA_VARIANTS="cu129 cu128 cu126" # newest supported first; cu126 is the floor

log() { printf '[worker-torch] %s\n' "$*" >&2; }
fail() { log "ERROR: $*"; return 1; }

driver_cuda_version() {
  # Prints the host driver's maximum CUDA runtime (e.g. "12.8"), or nothing.
  command -v nvidia-smi >/dev/null 2>&1 || return 1
  nvidia-smi 2>/dev/null \
    | grep -oE 'CUDA Version: [0-9]+\.[0-9]+' \
    | head -1 \
    | awk '{print $3}'
}

cuda_variant_for_driver() {
  # Picks the newest supported cuXXX tag the driver's CUDA version can run,
  # else empty (driver too old for every 2.8 wheel build).
  local driver="$1" variant num driver_num
  # cuXXX tags encode CUDA 12.X (cu126 == 12.6); normalize both sides to
  # major*100 + minor so comparisons line up.
  driver_num=$(( ${driver%%.*} * 100 + ${driver##*.} ))
  for variant in ${CUDA_VARIANTS}; do
    num=$(( 1080 + ${variant#cu} ))
    if (( driver_num >= num )); then
      printf '%s' "${variant}"
      return 0
    fi
  done
  return 0
}

# Self-classify the host (no operator toggle): returns one of
# pypi | cpu | cu126 | cu128 | cu129. Anything unrecognised falls back to
# the CPU wheels (or PyPI's CPU builds) with a printed notice - safe default
# per captain directive corr=0688a345e73914a8.
pick_variant() {
  local os arch variant cuda
  os="$(uname -s)"
  arch="$(uname -m)"
  case "${os}" in
    Darwin)
      # torch 2.8.0 publishes macOS arm64 wheels only; they are CPU/MPS
      # builds, and PyPI is their home. (Intel Macs: no 2.8 wheel exists.)
      printf 'pypi'
      ;;
    Linux)
      case "${arch}" in
        x86_64)
          cuda="$(driver_cuda_version || true)"
          if [[ -n "${cuda}" ]]; then
            variant="$(cuda_variant_for_driver "${cuda}")"
            if [[ -n "${variant}" ]]; then
              printf '%s\n' "${variant}"
            else
              log "notice: NVIDIA driver reports CUDA ${cuda}, below the torch ${TORCH_VERSION} wheel floor (cu126); falling back to CPU wheels (upgrade the driver to get the CUDA wheel automatically)"
              printf 'cpu\n'
            fi
          else
            printf 'cpu'
          fi
          ;;
        aarch64)
          # PyPI linux aarch64 torch wheels are CPU builds. NVIDIA Jetson
          # CUDA wheels come from JetPack, not download.pytorch.org; out of
          # scope for the appliance.
          if [[ -n "$(driver_cuda_version || true)" ]]; then
            log "notice: NVIDIA-on-aarch64 host detected; installing the CPU aarch64 wheels (JetPack CUDA wheels are out of scope)"
          fi
          printf 'pypi\n'
          ;;
        *)
          log "notice: unrecognised Linux arch '${arch}'; falling back to CPU wheels from the pinned PyTorch index"
          printf 'cpu\n'
          ;;
      esac
      ;;
    *)
      log "notice: unrecognised OS '${os}'; falling back to CPU wheels from the pinned PyTorch index"
      printf 'cpu\n'
      ;;
  esac
}

index_url_for() {
  # The download source for a variant; empty means default PyPI.
  local variant="$1"
  case "${variant}" in
    pypi) printf '' ;;
    *)    printf '%s/%s' "${PYTORCH_WHEEL_BASE}" "${variant}" ;;
  esac
}

print_plan_line() {
  # Printed BEFORE any download so the operator sees exactly what the
  # self-classification chose and why.
  local variant="$1" index
  index="$(index_url_for "${variant}")"
  [[ -n "${index}" ]] || index="PyPI (default index)"
  printf '[worker-torch] plan: torch==%s + torchaudio==%s from %s (variant=%s; os=%s arch=%s cuda=%s)\n' \
    "${TORCH_VERSION}" "${TORCHAUDIO_VERSION}" "${index}" "${variant}" \
    "$(uname -s)" "$(uname -m)" "$(driver_cuda_version 2>/dev/null || printf none)"
}

install_wheels() {
  local variant="$1"
  local -a args=(install --quiet --disable-pip-version-check)
  case "${variant}" in
    pypi) ;;
    *)    args+=(--index-url "${PYTORCH_WHEEL_BASE}/${variant}") ;;
  esac
  args+=("torch==${TORCH_VERSION}" "torchaudio==${TORCHAUDIO_VERSION}")
  log "installing torch==${TORCH_VERSION} torchaudio==${TORCHAUDIO_VERSION} (variant=${variant})"
  "${PIP}" "${args[@]}"
}

verify_wheels() {
  local variant="$1" installed expected_suffix
  installed="$("${VENV_DIR}/bin/python3" -c 'import torch; print(torch.__version__)')" \
    || fail "installed torch failed to import"
  [[ "${installed}" == "${TORCH_VERSION}"* ]] \
    || fail "installed torch ${installed}, expected ${TORCH_VERSION}"
  case "${variant}" in
    pypi) expected_suffix="" ;;
    *)    expected_suffix="+${variant}" ;;
  esac
  if [[ -n "${expected_suffix}" && "${installed}" != *"${expected_suffix}" ]]; then
    fail "installed torch ${installed} does not carry the ${expected_suffix} local tag"
  fi
  log "verified torch ${installed}"
}

main() {
  local venv_dir="${1:-}"
  [[ -n "${venv_dir}" ]] || { log "usage: $0 <worker-venv-dir>"; return 2; }
  PIP="${venv_dir}/bin/pip"
  VENV_DIR="${venv_dir}"
  [[ -x "${PIP}" ]] || { log "ERROR: no pip at ${PIP} - create the venv first"; return 1; }

  local variant
  variant="$(pick_variant)" || return 1
  print_plan_line "${variant}"
  install_wheels "${variant}"
  verify_wheels "${variant}"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
