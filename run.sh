#!/usr/bin/env bash
# Both jobs in turn, for a local run: download, then build the report.
# (In the container they run separately, with equity-watch's beta job between them.)
set -euo pipefail

cd "$(dirname "$0")"

bash fetch.sh
bash report.sh
