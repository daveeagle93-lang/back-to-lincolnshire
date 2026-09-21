#!/usr/bin/env bash
# Runs `npm run check-live` for the daily systemd timer (scripts/systemd/) and echoes its
# output to the journal. A full run prints ~28 lines, but the ntfy alert quotes only the
# last 20 lines of the unit's journal, so on failure the FAIL/WARN lines are printed again
# at the very end. Lines are cut to 240 chars because ntfy caps a message body at 4096
# bytes. Exits with npm's own status: non-zero (any FAIL) fails the unit and sends the alert.
#
# Truncation uses bash builtins in the main shell, not `cut`: on this host, lines written by
# a short-lived child such as `cut` were stored in the journal without the unit, so
# `journalctl -u` (which notify-failure.sh quotes) did not return them.
set -uo pipefail
cd "$(dirname "$0")/.."

emit() {
  local line
  while IFS= read -r line; do printf '%s\n' "${line:0:240}"; done
}

output=$(npm run check-live 2>&1)
status=$?

emit <<<"$output"
if [ "$status" -ne 0 ]; then
  printf '\n--- failures ---\n'
  emit < <(grep -E '^(FAIL|WARN):' <<<"$output")
fi
exit "$status"
