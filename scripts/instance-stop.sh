#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTANCE_ROOT="${1:-${SUPERSCRIBER_INSTANCE_ROOT:-$HOME/.local/share/superscriber}}"

exec bash "${SCRIPT_DIR}/instance-run.sh" "${INSTANCE_ROOT}" --stop
