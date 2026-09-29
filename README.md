<div align="center">

# Spread Book

**Which credit spreads should you close today, and where is the book's risk piling up?**

Downloads your open positions from OptionStrat, maps theta, delta, gamma and vega by underlying and expiration, flags the spreads that have hit an exit rule, and publishes the result as the Spread book, a single-page report refreshed twice a trading day.

![Node 22.9+](https://img.shields.io/badge/node-22.9%2B-339933?logo=nodedotjs&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-plain-F7DF1E?logo=javascript&logoColor=black)
![One dependency](https://img.shields.io/badge/dependencies-1-informational)
![Docker](https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white)
![AWS](https://img.shields.io/badge/hosting-S3%20%2B%20CloudFront-FF9900?logo=amazonaws&logoColor=white)

[What it uses](#what-it-uses) · [Quick start](#quick-start) · [The report](#the-report) · [Scripts](#scripts) · [Scheduled publishing](#scheduled-publishing-docker)

<img src="docs/screenshots/overview.png" alt="The Spread book report: exit decisions, book totals, the theta heatmap and a spread's detail" width="900">

</div>

## What it uses

Only OptionStrat and Node.js are needed. Everything else is optional.

| What | Service | Needed? |
|---|---|---|
| Positions and greeks | [OptionStrat](https://optionstrat.com) Saved Trades, exported as xlsx through its API | Yes. Requires an OptionStrat account |
| xlsx → CSV conversion | [SheetJS](https://sheetjs.com/) (`xlsx`), the only npm dependency | Yes, runs locally |
| Underlying prices | [Yahoo Finance](https://finance.yahoo.com/) chart API, for daily P&L attribution | Optional. Free, no key; attribution is skipped without it |
| Report font | [Archivo](https://fonts.google.com/specimen/Archivo) from Google Fonts | Loaded by the browser |
| Hosting | AWS S3 + CloudFront (`cloudformation.yaml`) | Optional. Reports are self-contained HTML files |
| Scheduling | Docker with [supercronic](https://github.com/aptible/supercronic) | Optional |

There's no browser automation, framework or build step. Downloads call the OptionStrat API directly, and each report is one HTML file with its data, styles and script inlined.

## Quick start

You need Node.js 22.9 or newer (for `--env-file-if-exists`).

```bash
npm ci               # clean install of exactly what package-lock.json pins
cp .env.example .env # add your OptionStrat credentials
./run.sh             # download → convert → analyse → reports/
```

Open `reports/index.html`, which is always a copy of the newest report.

### Credentials

`download.js` reads these from `.env`:

```
OPTIONSTRAT_EMAIL=you@example.com
OPTIONSTRAT_PASSWORD=yourpassword
OPTIONSTRAT_ACCOUNT_ID=your-account-uuid
```

The account ID is the UUID of your "Live" group on OptionStrat. After the first login, the session cookie is saved to `.session.json` (gitignored) and reused until it expires.

### Exporting by hand

Without credentials, export from OptionStrat yourself and pass the CSV to `portfolio.js`:

1. Open your positions on [OptionStrat](https://optionstrat.com).
2. Saved Trades → Group: Live → Export → Export as .xlsx (Excel).
3. Save it as CSV and run `node portfolio.js <file.csv>`.

Individual option legs and non-spread positions are filtered out. Only spreads are included.

## The report

Each report is one self-contained HTML page. It embeds its snapshot as JSON, and `report.js` draws it in the browser. Colours come from a three-colour palette engine (`palette.js`): pick a palette with the swatch in the lower left, and switch light or dark mode in the header. Both choices are remembered per browser.

- **Decisions.** Four lists at the top, before any analysis, following the exit rules the report is built around:
  - *Ready to close*: at or past 50% of max profit.
  - *At the stop*: the loss has reached 25% of max loss.
  - *21 days or less*: inside the close-or-roll window.
  - *Getting close*: more than 60% of the way to either exit.
- **Book totals.** Theta per day, delta, gamma, and vega per IV point for the whole book. Each total switches the heatmap below it (keys 1–4 do the same).
- **Heatmap.** The chosen greek by underlying and expiration, with row and column totals. Each underlying gets one row per spread type, so the two legs of an iron condor stay separate. Delta uses a diverging scale: signal colour for bullish, ink for bearish.
- **Spread detail.** Click any cell, chart dot, decision or scorecard row to open that spread: progress from the stop to the close target, PoP, credit, max loss, EV, IV, the greeks, and its rank on both quality ratios. Iron condor legs link to each other.
- **What each spread pays for its risk.** Theta per unit gamma against theta per unit vega. Spreads below the median on both fall in the shaded corner; those are the first to close when you want capital back. The dashed lines are the book's medians, not the chart's midpoint. Spreads with zero gamma or vega are listed under the chart.
- **Scorecard.** Every spread with days left, PoP, credit, max loss, EV, progress toward an exit, the greeks, IV and both quality ratios, plus book totals. Select a heading to sort. A gain is shown as a share of max profit and a loss as a share of max loss, matching the two exit rules.
- **Try a trade.** Paste one or more rows from the OptionStrat export, comma-separated or copied from Excel. Each trade is added to every total, the heatmap, the chart and the scorecard with a dashed outline, and the totals show how much it changes.
- **Snapshot menu.** The 14 newest snapshots (about a week at two runs per trading day). Choosing one redraws the page in place in the current design, and the choice is kept in the URL (`?snapshot=<base>`) so it can be linked.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/risk-chart.png" alt="Theta per gamma against theta per vega, with the below-median corner shaded"></td>
    <td width="50%"><img src="docs/screenshots/scorecard.png" alt="The scorecard, sorted by days to expiration"></td>
  </tr>
  <tr>
    <td align="center"><sub>What each spread pays for its risk</sub></td>
    <td align="center"><sub>The scorecard, sorted by days to expiration</sub></td>
  </tr>
</table>

## Scripts

| Script | Input | Output |
|---|---|---|
| `run.sh` | — | Full pipeline: download, portfolio report, daily P&L |
| `publish.sh` | — | `run.sh`, then upload to S3, regenerate the index and invalidate CloudFront |
| `download.js` | `.env` | `data/*.csv` (exports Group: Live from OptionStrat, converts xlsx → CSV) |
| `portfolio.js <csv>` | CSV file | `reports/*-portfolio.html`, `*-portfolio.json` and `*-prices.json` |
| `daily-pnl.js` | Two newest snapshots | `reports/*-daily-pnl.html`, P&L attribution between runs |
| `generate-index.js` | File list | `reports/index.html`, `archive.html`, `snapshots.json` |
| `report.js`, `report.css`, `theme.css`, `palette.js` | — | Inlined into every report |
| `index.js`, `whatif.js` | CSV file | The legacy heatmaps report |

```
data/       source CSVs (gitignored)
reports/    generated reports, JSON snapshots and index.html (gitignored)
docker/     Dockerfile, compose file, crontab and env template for scheduled publishing
docs/       README screenshots
```

## Scheduled publishing (Docker)

The `docker/` directory runs `publish.sh` on a schedule, publishing to the S3 bucket and CloudFront site described under [AWS](#aws).

| File | Purpose |
|---|---|
| `docker/Dockerfile` | Node 24 Alpine image with the AWS CLI and supercronic |
| `docker/compose.yaml` | Runs the container; `data/` and `reports/` are bind-mounted from `~/spread-book/` on the Docker host |
| `docker/crontab` | 7:45 AM and 1:25 PM Mountain, weekdays |
| `docker/.env.example` | Template for `docker/.env` (OptionStrat and AWS credentials) |

The container runs with `TZ=America/Denver`, so the crontab is in local time and DST is handled automatically. The bind-mounted directories persist between runs, so `daily-pnl.js` always has an earlier snapshot to compare against.

```bash
cp docker/.env.example docker/.env      # fill in credentials
docker compose -f docker/compose.yaml up -d --build
docker compose -f docker/compose.yaml exec spread-book /app/publish.sh   # publish now
docker compose -f docker/compose.yaml logs -f
```

To deploy to a remote Docker host, point the same commands at it. The image is built on the remote host, and `docker/.env` is read locally:

```bash
docker -H ssh://user@docker-host compose -f docker/compose.yaml up -d --build
```

### AWS

`cloudformation.yaml` creates a private S3 bucket, a CloudFront distribution with HTTPS, and the `optionspread-heatmaps-billbaran-docker-publish` IAM user the container publishes as. Deploy it in `us-east-1`, since CloudFront's ACM certificate must live there. The site's hostname and its Route 53 hosted zone are parameters:

```bash
aws cloudformation deploy --region us-east-1 --stack-name spread-book \
  --template-file cloudformation.yaml --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides BucketName=your-bucket DomainName=reports.example.com HostedZoneId=Z0123456789ABC
```

The user's access key is created outside the stack, so the secret never appears in stack outputs:

```bash
aws iam create-access-key --user-name optionspread-heatmaps-billbaran-docker-publish
```

The container is the only publisher. The GitHub Actions workflow was removed because GitHub-scheduled runs were routinely delayed by 3–4 hours.

## Security

`package-lock.json` pins every dependency to an exact version and integrity hash, so installs are reproducible and a tampered package fails verification. Docker uses `npm ci`, which also refuses to run if the lockfile and `package.json` disagree. Review lockfile diffs whenever a dependency is added or upgraded.

`.env`, `docker/.env` and `.session.json` hold credentials and are gitignored.

## Disclaimer

A personal tool for tracking my own positions. Greeks, PoP and prices come from OptionStrat and Yahoo Finance as-is, and nothing here is investment advice. Check positions with your broker before acting on a number.

## License

[FSL-1.1-MIT](LICENSE.md) (Functional Source License). You can use, modify and self-host this freely, including for your own trading. You can't offer it as a competing commercial product or service. Each version becomes available under MIT two years after its release.
