#!/usr/bin/env bash
# Job 1: pull the open spreads from OptionStrat into data/, then list their underlyings for
# equity-watch's beta job. Runs under cron in the Docker container (docker/crontab).
# report.sh and publish.sh build the report from the CSV this leaves behind.
set -euo pipefail

cd "$(dirname "$0")"

echo "==> $(date '+%Y-%m-%d %H:%M:%S %Z') fetching"
echo "==> Downloading..."
csv=$(node --env-file-if-exists=.env download.js | tail -n1)

if [[ -z "$csv" ]]; then
  echo "ERROR: download.js produced no output path" >&2
  exit 1
fi
echo "==> CSV: $csv"

# Fixed ./shared, never $SHARED_DIR: compose's env_file passes that in as the HOST path,
# which doesn't exist inside the container. Without the mount (a local run) there is no job to feed.
if [[ -d shared ]]; then
  echo "==> Listing underlyings for the beta job..."
  node betas.js write-underlyings "$csv" shared/underlyings.txt
else
  echo "==> No shared/ directory, so no ticker list for equity-watch"
fi
echo "==> Done."
