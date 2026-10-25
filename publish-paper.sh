#!/usr/bin/env bash
# Upload the paper book (reports/paper/, built by paper.js snapshot) to paper/ in the site's bucket.
# publish.sh runs it with NO_INVALIDATE=1 and invalidates everything itself; the ticket watcher runs it
# alone after opening a paper trade, so the new trade shows in a minute rather than at the next publish.
set -euo pipefail

cd "$(dirname "$0")"

BUCKET="${S3_BUCKET:-optionspread-heatmaps-billbaran}"
DISTRIBUTION_ID="${CLOUDFRONT_DISTRIBUTION_ID:-E3AR100VQDUFIT}"

[[ -d reports/paper ]] || { echo "==> No paper book to publish"; exit 0; }

echo "==> Uploading the paper book to s3://$BUCKET/paper/"
aws s3 sync reports/paper/ "s3://$BUCKET/paper/" --exclude 'index.html' --exclude 'archive.html' --exclude 'snapshots.json' --only-show-errors
# These change every run under the same name, so browsers must revalidate them each visit
for f in index.html archive.html snapshots.json; do
  if [[ -f "reports/paper/$f" ]]; then aws s3 cp "reports/paper/$f" "s3://$BUCKET/paper/$f" --cache-control no-cache --only-show-errors; fi
done

if [[ -z "${NO_INVALIDATE:-}" ]]; then
  aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/paper/*" --query 'Invalidation.Id' --output text
fi
