#!/usr/bin/env bash
# Job 2's analysis: build the report from a CSV that fetch.sh already downloaded.
# Usage: report.sh [csv]
# With no argument it takes the newest CSV in data/, and refuses one older than MAX_AGE_MIN
# (default 90): that means fetch.sh failed, and rebuilding an old export with today's prices
# would publish it as if it were new. An explicit path skips the check, to redo an old snapshot.
set -euo pipefail

cd "$(dirname "$0")"

csv="${1:-}"
if [[ -z "$csv" ]]; then
  shopt -s nullglob
  files=(data/live-active-by-symbol-*.csv)   # the names sort by date and time
  if [[ ${#files[@]} -eq 0 ]]; then
    echo "ERROR: no CSV in data/. Run fetch.sh first." >&2
    exit 1
  fi
  csv="${files[${#files[@]}-1]}"
  max_age="${MAX_AGE_MIN:-90}"
  # Node, not find -mmin or stat -c: the Alpine image's busybox versions of those aren't checked.
  if ! node -e 'process.exit(Date.now() - require("fs").statSync(process.argv[1]).mtimeMs < process.argv[2] * 60000 ? 0 : 1)' "$csv" "$max_age"; then
    echo "ERROR: $csv is more than $max_age minutes old, so fetch.sh probably failed. Not publishing it as new." >&2
    echo "       To rebuild it anyway, pass its path: report.sh $csv" >&2
    exit 1
  fi
fi

echo "==> CSV: $csv"
echo "==> Generating portfolio..."
node portfolio.js "$csv"

echo "==> Generating daily P&L attribution..."
node daily-pnl.js || echo "WARN: daily-pnl.js skipped (need at least 2 portfolio snapshots)"

echo "==> Writing the agent brief (latest.json)..."
node brief.js

echo "==> Done."
