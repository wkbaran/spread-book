#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Downloading..."
csv=$(node --env-file-if-exists=.env download.js | tail -n1)

if [[ -z "$csv" ]]; then
  echo "ERROR: download.js produced no output path" >&2
  exit 1
fi

echo "==> CSV: $csv"
echo "==> Generating portfolio..."
node portfolio.js "$csv"

echo "==> Generating daily P&L attribution..."
node daily-pnl.js || echo "WARN: daily-pnl.js skipped (need at least 2 portfolio snapshots)"

echo "==> Writing the agent brief (latest.json)..."
node brief.js

echo "==> Done."
