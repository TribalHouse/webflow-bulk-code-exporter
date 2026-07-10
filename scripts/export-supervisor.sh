#!/usr/bin/env bash
set -u

cd "$(dirname "$0")/.."

LOG="logs/export-supervisor.log"
INTERVAL_SECONDS="${WEBFLOW_SUPERVISOR_INTERVAL_SECONDS:-600}"
STALL_CYCLES="${WEBFLOW_SUPERVISOR_STALL_CYCLES:-3}"
TAB_WORKERS="${WEBFLOW_TAB_WORKERS:-3}"

last_completed=""
same_completed_cycles=0

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

status_value() {
  node -e "const s=require('./logs/export-status.json'); console.log(s.summary['$1'] ?? 0)"
}

exporter_running() {
  pgrep -f "scripts/export-webflow-tabs.mjs" >/dev/null 2>&1
}

start_exporter() {
  if exporter_running; then
    return 0
  fi

  screen -dmS webflow-tabs bash -lc "cd \"$(pwd)\" && WEBFLOW_TAB_WORKERS=${TAB_WORKERS} npm run export:zips:tabs >> logs/export-tabs.log 2>&1"
}

while true; do
  {
    echo "[$(timestamp)] supervisor tick"
    npm run export:status
    npm run export:retry-candidates
    npm run export:snapshots
  } >> "$LOG" 2>&1

  completed="$(status_value completed)"
  remaining="$(status_value remaining)"

  if [[ "$completed" == "$last_completed" ]]; then
    same_completed_cycles=$((same_completed_cycles + 1))
  else
    same_completed_cycles=0
    last_completed="$completed"
  fi

  if [[ "$remaining" != "0" ]] && ! exporter_running; then
    {
      echo "[$(timestamp)] exporter is not running with ${remaining} remaining; attempting restart"
      start_exporter
      screen -ls || true
    } >> "$LOG" 2>&1
  fi

  if [[ "$remaining" != "0" ]] && [[ "$same_completed_cycles" -ge "$STALL_CYCLES" ]]; then
    echo "[$(timestamp)] warning: completed count has not changed for ${same_completed_cycles} supervisor cycles; completed=${completed}, remaining=${remaining}" >> "$LOG"
  fi

  sleep "$INTERVAL_SECONDS"
done
