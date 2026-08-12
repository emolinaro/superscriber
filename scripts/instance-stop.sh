#!/usr/bin/env bash
# local-deploy-bootstrap: stop a running local deployment supervisor with
# SIGTERM. The supervisor's trap stops the app and worker children.
# Usage: scripts/instance-stop.sh [INSTANCE_ROOT]
set -euo pipefail

INSTANCE_ROOT="${1:-${SUPERSCRIBER_INSTANCE_ROOT:-$HOME/.local/share/superscriber}}"
PID_FILE="${INSTANCE_ROOT}/pids/supervisor.pid"

if [[ ! -f "${PID_FILE}" ]]; then
  echo "no supervisor pid file at ${PID_FILE}; instance is not running"
  exit 0
fi

PID="$(cat "${PID_FILE}")"
if ! kill -0 "${PID}" 2>/dev/null; then
  echo "supervisor pid ${PID} is not running; removing stale pid file"
  rm -f "${PID_FILE}"
  exit 0
fi

kill "${PID}"
for _ in $(seq 1 50); do
  if ! kill -0 "${PID}" 2>/dev/null; then
    rm -f "${PID_FILE}"
    echo "stopped supervisor ${PID}"
    exit 0
  fi
  sleep 0.2
done

echo "supervisor ${PID} did not exit within 10s of SIGTERM" >&2
exit 1
