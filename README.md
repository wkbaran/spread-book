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
| Betas | The sibling project equity-watch: its `beta` command asks Schwab and hands the result over through a shared directory | Optional. Weights each spread's delta; the column is blank for a spread without a beta, or when the betas are more than 10 days old |
| Underlying prices | [Yahoo Finance](https://finance.yahoo.com/) chart API, for daily P&L attribution, the distance to each short strike, and SPY's price for beta-weighting | Optional. Free, no key; those features are skipped without it |
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
- **Short strike distance.** Not a decision list. Each spread gets the number of expected moves between the stock and its short strike, `price × IV × √(days ÷ 365)` being one move. Below 0.5 it is highlighted as a heads-up; a negative number means the stock has passed the strike. Hover the column heading, or the label in the spread detail, for what σ means. The threshold is `RULES.strikeSigma` in `book.js`. It needs the underlying's price, which comes from Yahoo and is saved in the snapshot as `spots`, so it is blank for older snapshots and for symbols Yahoo can't price (indexes such as SPX).
- **Book totals.** Theta per day, delta, gamma, and vega per IV point for the whole book. Each total switches the heatmap below it (keys 1–5 do the same). The fifth card is the beta-weighted delta: the number of SPY shares the book behaves like, from each spread's `delta × beta × (stock price ÷ SPY price)`. Only spreads with a beta count, and the card says how many do.
- **Heatmap.** The chosen greek by underlying and expiration, with row and column totals. Each underlying gets one row per spread type, so the two legs of an iron condor stay separate. Delta and beta-weighted delta use a diverging scale: signal colour for bullish, ink for bearish. The beta-weighted view puts every stock in one unit (SPY shares), so its totals can be compared across names, which the raw delta totals cannot. A spread without a beta shows a dash and is left out of that view's totals, and the note under the table says how many are missing.
- **Spread detail.** Click any cell, chart dot, decision or scorecard row to open that spread: progress from the stop to the close target, PoP, credit, max loss, EV, IV, the greeks, and its rank on both quality ratios. Iron condor legs link to each other.
- **What each spread pays for its risk.** Theta per unit gamma against theta per unit vega. Spreads below the median on both fall in the shaded corner; those are the first to close when you want capital back. The dashed lines are the book's medians, not the chart's midpoint. A spread whose export shows zero gamma (or vega) has no ratio, so its dot sits on the axis at 0; it is left out of the medians and the shaded corner.
- **Scorecard.** Every spread with days left, PoP, credit, max loss, EV, progress toward an exit, distance to the short strike, the greeks (with a beta-weighted delta column), IV and both quality ratios, plus book totals. Select a heading to sort. A gain is shown as a share of max profit and a loss as a share of max loss, matching the two exit rules.
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

## The brief for agents

`latest.json`, next to `index.html` on the site, is the newest report as one JSON file for an LLM agent to read, such as a morning check before the market opens. It is rewritten every run and served with `no-cache`.

| Field | What it holds |
|---|---|
| `rules`, `glossary` | The exit thresholds and what each field means, so an agent doesn't have to guess |
| `summary` | Counts for each decision list, plus the spreads closest to the target and to the stop |
| `decisions` | `readyToClose`, `atStop`, `inRollWindow` and `gettingClose`, in the same order as the report |
| `watch` | `nearShortStrike`: spreads inside the strike-distance warning, closest first. Informational, not an exit rule |
| `spotsAsOf` | When the Yahoo prices behind `sigmaToShortStrike` and `underlyingSpot` were fetched, 25 to 45 minutes after the positions. `null` for snapshots from before it was recorded |
| `book` | The whole book by kind: `counts` (`puts`, `calls`, `other`), `maxLossTotal`, `maxLossByKind`, `netDelta`, and `betaWeightedDelta` with its `betaCoverage` (`null` until betas exist) |
| `totals`, `concentration` | Book greeks, plus `betaWeightedDelta` over the positions that have a beta (`betaCoverage` says how many), then greeks and theta share by underlying and by expiration. Each underlying also carries `maxLoss`, `kinds` (spread count by `put`, `call`, `other`), its `expirations` and `underlyingSpot`, so a screener can avoid doubling up |
| `closed` | Spreads that left the book in the last 60 days: name, `openedAt`, `closedAt`, `daysHeld`, `entry`, `lastReturnPct` and an `outcome` (`target`, `stop`, `expired` or `other`). Each record is one `episode` of a spread. Always `approximate`: the return is from the last snapshot that held the spread, not at the close |
| `pnl` | Attribution since the previous run: totals, the biggest movers, and spreads opened or closed |
| `positions` | Every spread with its derived numbers, including `sigmaToShortStrike`, sizing (`width`, `creditToWidthPct`, `profitOfRiskPct`, `popPct`) `entry` and `episode`, `reopened`, `episodeBreak`, nearest expiration first |
| `links` | The HTML report, full snapshot and P&L JSON, relative to `latest.json` |

The decision lists come from `book.js`, the same code the report page runs, so the two always agree. Each run also keeps its own copy as `<base>-brief.json`.

`pop` and `ev` are current values, not the values at entry. `entry` is the only place to find those: it holds what the spread looked like in the first snapshot that contained it, built from every `*-portfolio.json` in `reports/`. A spread already open in the oldest snapshot gets `entry: { "known": false }` rather than a guess, and so does its `closed` record.

The same name, expiration and strikes is one spread until an *episode break* starts a new `episode` (`reopened: true`, with `episodeBreak` saying why): `"gap"` when it was missing from a snapshot between two sightings, `"resized"` when its credit or max loss changed by a cent. Each episode has its own entry and closed record. A snapshot file that fails to parse is skipped, so it can't cause a gap. One blind spot: a close and reopen at the same credit between two consecutive snapshots (1.6 to 66 hours apart, median 5.7) is invisible. Percentages in the sizing fields run 0 to 100.

## Scripts

| Script | Input | Output |
|---|---|---|
| `run.sh` | — | Both jobs in turn, for a local run: `fetch.sh`, then `report.sh` |
| `fetch.sh` | `.env` | Job 1: `data/*.csv` from OptionStrat, and `shared/underlyings.txt` for equity-watch's beta job when `shared/` exists |
| `report.sh [csv]` | The newest CSV, or the one named | Job 2's analysis: portfolio report, daily P&L and the brief. With no argument it refuses a CSV more than `MAX_AGE_MIN` (default 90) minutes old, because that means `fetch.sh` failed |
| `publish.sh [csv]` | The same | `report.sh`, then upload to S3, regenerate the index and invalidate CloudFront. Job 2 |
| `betas.js` | CSV, `shared/betas.json` | Writes the underlyings list for equity-watch (`write-underlyings <csv> <file>`); `portfolio.js` uses it to read the betas back |
| `download.js` | `.env` | `data/*.csv` (exports Group: Live from OptionStrat, converts xlsx → CSV) |
| `portfolio.js <csv>` | CSV file | `reports/*-portfolio.html`, `*-portfolio.json` (the positions, plus the underlying prices as `spots`) and `*-prices.json` |
| `daily-pnl.js` | Two newest snapshots | `reports/*-daily-pnl.html` and `<base>-pnl.json`, P&L attribution between runs |
| `brief.js` | Newest snapshot and its P&L | `reports/<base>-brief.json` and `latest.json`, the [brief for agents](#the-brief-for-agents) |
| `generate-index.js` | File list | `reports/index.html`, `archive.html`, `snapshots.json` |
| `book.js` | — | Exit rules, strike distance, history and the calculations the page draws, shared by `report.js` and `brief.js` |
| `page.js` | A snapshot | The report's HTML shell, with the styles, snapshot and scripts inlined. `portfolio.js` writes it; the page tests build it |
| `report.js`, `report.css`, `theme.css`, `palette.js` | — | Inlined into every report |
| `index.js`, `whatif.js` | CSV file | The legacy heatmaps report |

```
data/       source CSVs (gitignored)
test/       unit and page tests (jsdom)
reports/    generated reports, JSON snapshots and index.html (gitignored)
docker/     Dockerfile, compose file, crontab and env template for scheduled publishing
shared/     the directory shared with equity-watch (gitignored; a bind mount in the container)
docs/       README screenshots
```

## Tests

`npm test` runs the tests in `test/` with Node's built-in runner. They need `npm ci` first, because the page tests use [jsdom](https://github.com/jsdom/jsdom), a dev-only dependency that the Docker image leaves out (`npm ci --omit=dev`). jsdom wants Node 22.22.2, 24.15 or 26+.

- **`book.test.js`, `history.test.js`**: `book.js`'s exit rules, strike distance, beta-weighted delta and sizing numbers, including the cases where each is blank, and the history behind `entry` and `closed` (the unknown entry, the dedupe, the 60-day window and the episode breaks).
- **`calc.test.js`**: the calculations the report page draws, also in `book.js`: the heatmap grid and its ordering, ranks, the chart's scaling and medians, scorecard sorting and totals, and the trial-trade parser.
- **`page.test.js`**: builds a report from a synthetic book (`fixture.js`) exactly as `portfolio.js` does, runs its scripts in jsdom, and clicks through it. It checks that every spread is drawn, that the page's totals and decision lists match what `brief.js` writes for the same snapshot, and that the greek keys, sorting, trial trades and the snapshot menu work, including a book with no betas and one with no gamma.
- **`betas.test.js`**: the underlyings list and reading the betas file.

The page tests check what the page draws, not how it looks: colours, layout and the font need a browser. `portfolio.js` itself (the CSV parsing and the Yahoo fetch) has no automated tests; check it by running the pipeline on a sample CSV from `data/` and opening the result.

## Scheduled publishing (Docker)

The `docker/` directory publishes to the S3 bucket and CloudFront site described under [AWS](#aws) as two scheduled jobs, with equity-watch's beta job between them:

1. **`fetch.sh`** at 7:45 AM and 1:25 PM: downloads the open spreads from OptionStrat and writes `shared/underlyings.txt`.
2. **equity-watch's beta job**, in its own container at 8:05 AM and 2:05 PM: reads that list and writes `shared/betas.json`.
3. **`publish.sh`** at 8:10 AM and 2:10 PM: builds the report from the CSV job 1 left, reads the betas, and uploads.

Job 2 never downloads, and it refuses a CSV more than 90 minutes old, so a failed download can't republish an old export as new. A missing or old `betas.json` doesn't stop the report. The snapshot records when the betas were computed. Prices (and so the strike distance) are fetched when job 2 runs, 25 to 45 minutes after the positions; the snapshot records when as `spotsAsOf`.

| File | Purpose |
|---|---|
| `docker/Dockerfile` | Node 24 Alpine image with the AWS CLI and supercronic |
| `docker/compose.yaml` | Runs the container; `data/` and `reports/` are bind-mounted from `~/spread-book/` on the Docker host, and `SHARED_DIR` from `docker/.env` is mounted at `/app/shared` for the files exchanged with equity-watch |
| `docker/crontab` | `fetch.sh` at 7:45 AM and 1:25 PM, `publish.sh` at 8:10 AM and 2:10 PM, Mountain, weekdays |
| `docker/.env.example` | Template for `docker/.env` (OptionStrat and AWS credentials, and `SHARED_DIR`) |

The container runs with `TZ=America/Denver`, so the crontab is in local time and DST is handled automatically. The bind-mounted directories persist between runs, so `daily-pnl.js` always has an earlier snapshot to compare against.

```bash
cp docker/.env.example docker/.env      # fill in credentials
docker compose -f docker/compose.yaml up -d --build
docker compose -f docker/compose.yaml exec spread-book /app/fetch.sh     # download now
docker compose -f docker/compose.yaml exec spread-book /app/publish.sh   # then publish it
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
