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
#
# The timer's Persistent=true means a missed run (e.g. tower-dev was off) fires as soon as
# the timer unit starts again, which can be before the network is up on boot. User units
# have no network-online.target to depend on, so instead we poll DNS resolution of
# $CHECK_HOST for up to 120s before running the real check. This is a DNS-only check, not a
# full connectivity test, because DNS is what "the network isn't up yet" fails on here and
# it's cheap/fast; if DNS never resolves in the window we skip the run and exit 0 so this
# doesn't trigger a false OnFailure= ntfy alert.
set -uo pipefail
cd "$(dirname "$0")/.."

emit() {
  local line
  while IFS= read -r line; do printf '%s\n' "${line:0:240}"; done
}

CHECK_HOST="${CHECK_HOST:-backtolincolnshire.co.uk}"

dns_up=0
for attempt in $(seq 1 13); do
  if getent hosts "$CHECK_HOST" >/dev/null 2>&1; then
    dns_up=1
    break
  fi
  [ "$attempt" -lt 13 ] && sleep 10
done

if [ "$dns_up" -eq 0 ]; then
  printf 'DNS for %s did not come up within 120s; skipping this run.\n' "$CHECK_HOST"
  exit 0
fi

output=$(npm run check-live 2>&1)
status=$?

emit <<<"$output"
if [ "$status" -ne 0 ]; then
  printf '\n--- failures ---\n'
  emit < <(grep -E '^(FAIL|WARN):' <<<"$output")
fi
exit "$status"
