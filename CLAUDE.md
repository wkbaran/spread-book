# Notes for agents

Things in this project that have surprised agents before. Read the README for how it works; this file is about what isn't obvious from it.

## Deployment

- Production is the `spread-book` container on the Docker host `nuc1`, reached as `core@nuc1`. Deploy from this checkout with `docker -H ssh://core@nuc1 compose -f docker/compose.yaml up -d --build`. The image is built on nuc1, but `docker/.env` is read from this machine, so it has to exist locally (it's gitignored; copy `docker/.env.example` and fill it in).
- Check what's actually running on nuc1 before assuming it matches the repo. Until 2026-09-30 nuc1 still ran the old `optionspread-heatmaps` container with named volumes, several commits behind. Starting `spread-book` next to it would have published twice per run.
- Data and reports are bind-mounted from `/var/home/core/spread-book/{data,reports}` on nuc1. The old named volumes `optionspread-heatmaps_data` and `optionspread-heatmaps_reports` are a leftover backup from the migration, not in use.
- The S3 bucket, IAM user and CloudFront distribution still carry the old `optionspread-heatmaps` name. That's deliberate: renaming them would recreate the resources. Don't "fix" it.
- The site's hostname was taken out of the repo on purpose (commit 8d8c5ab). Don't add it back to tracked files. Ask the developer, or read the `SiteUrl` output of the `spread-book` CloudFormation stack.

## Verifying a publish

- The container's IAM user (`optionspread-heatmaps-billbaran-docker-publish`) can only list the bucket, write and delete objects, and create invalidations. It can't read objects or describe CloudFront, so `aws s3api head-object` or `aws cloudfront get-invalidation` fail with 403/AccessDenied inside the container. That's least privilege, not a broken deploy. Verify from outside: fetch the public URL (e.g. `/latest.json`), or use the developer's local AWS credentials.

## Republishing an old snapshot

- To redo a report without a new download, run `node portfolio.js data/<csv>`, `node daily-pnl.js`, `node brief.js` in the container, then `publish.sh` without its `bash run.sh` line. `publish.sh` alone always downloads a fresh export.
- `portfolio.js` refetches underlying prices every time it runs and overwrites `<base>-prices.json`. Regenerating an old snapshot therefore uses current prices, which skews the delta and gamma split in that run's P&L attribution (the total is unaffected).

## Code

- `book.js` runs in two places: `require`d by `brief.js` in Node, and inlined into every report ahead of `report.js`, where it sets `globalThis.SpreadBook`. Keep it free of Node APIs and `require`. Exit rules belong there, not in `report.js`, so the page and `latest.json` agree.
- `data/` is gitignored, but the three March 2026 CSVs in it are tracked as sample data for testing the pipeline locally.
