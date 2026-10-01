#!/usr/bin/env bash
# Generate a fresh report and publish it to S3/CloudFront.
# Runs under cron in the Docker container (docker/crontab).
set -euo pipefail

cd "$(dirname "$0")"

BUCKET="${S3_BUCKET:-optionspread-heatmaps-billbaran}"
DISTRIBUTION_ID="${CLOUDFRONT_DISTRIBUTION_ID:-E3AR100VQDUFIT}"

echo "==> $(date '+%Y-%m-%d %H:%M:%S %Z') starting publish"

bash run.sh

echo "==> Uploading data and reports to s3://$BUCKET/"
aws s3 sync data/ "s3://$BUCKET/data/" --only-show-errors
# index, archive and snapshot list are rebuilt from the full S3 listing below; the local copies only know this volume
aws s3 sync reports/ "s3://$BUCKET/" --exclude 'index.html' --exclude 'archive.html' --exclude 'snapshots.json' --exclude 'latest.json' --only-show-errors
# The brief for agents; it changes every run under the same name, like index.html
aws s3 cp reports/latest.json "s3://$BUCKET/latest.json" --cache-control no-cache --content-type application/json --only-show-errors

echo "==> Regenerating index from S3 contents"
aws s3 ls "s3://$BUCKET/" | awk '{print $4}' | node generate-index.js --stdin
# These three change every run under the same name, so browsers must revalidate them each visit
for f in index.html archive.html snapshots.json; do
  aws s3 cp "reports/$f" "s3://$BUCKET/$f" --cache-control no-cache --only-show-errors
done

echo "==> Invalidating CloudFront cache"
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/*" \
  --query 'Invalidation.Id' --output text

echo "==> $(date '+%Y-%m-%d %H:%M:%S %Z') publish complete"
