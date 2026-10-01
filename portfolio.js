#!/usr/bin/env node

const fs       = require('fs');
const path     = require('path');
const https    = require('https');
const asset    = f => fs.readFileSync(path.join(__dirname, f), 'utf8');

const csvFile = process.argv[2];
if (!csvFile) { console.error('Usage: node portfolio.js <csv-file>'); process.exit(1); }

// ── CSV Parsing ──────────────────────────────────────────────────────────────

function parseCSVLine(line) {
  const result = [];
  let current = '', inQuotes = false;
  for (const char of line) {
    if (char === '"') { inQuotes = !inQuotes; }
    else if (char === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
    else { current += char; }
  }
  result.push(current.trim());
  return result;
}

function parsePct(s)    { return parseFloat((s || '').replace('%', '')) || 0; }
function parseDollar(s) {
  if (!s) return 0;
  const neg = s.includes('(');
  const n   = parseFloat(s.replace(/[^0-9.]/g, '')) || 0;
  return neg ? -n : n;
}

// Row layout:
// 0:Name  1:Return%  2:Return$  3:CreatedAt  4:Expiration  5:NetCredit  6:Chance
// 7:MaxLoss  8:MaxProfit  9:High  10:Low  11:Delta  12:Theta  13:Gamma
// 14:Vega  15:Rho  16:IV  17:Link  18:Group
function loadSpreads(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
  const out   = [];
  const now   = new Date();
  for (let i = 2; i < lines.length; i++) {
    const v = parseCSVLine(lines[i]);
    if (!v[0] || v[0].startsWith('.'))               continue;
    if (!v[0].toLowerCase().includes('spread'))      continue;

    const name      = v[0];
    const gamma     = parseFloat(v[13]) || 0;
    const theta     = parseFloat(v[12]) || 0;
    const vega      = parseFloat(v[14]) || 0;
    const chance    = parsePct(v[6]) / 100;
    const maxLoss   = Math.abs(parseDollar(v[7]));
    const maxProfit = Math.abs(parseDollar(v[8]));
    const returnPct = parsePct(v[1]);
    const expDate   = new Date(v[4]);
    const dte       = isNaN(expDate.getTime()) ? null : Math.floor((expDate - now) / 86400000);
    // Loss as % of max risk (meaningful only when negative; null for winning positions)
    const lossOfRisk = (returnPct < 0 && maxLoss > 0)
      ? (returnPct / 100) * maxProfit / maxLoss * 100 : null;

    out.push({
      name,
      underlying:      name.split(' ')[0],
      expiration:      v[4],
      type:            name.includes('Bull Put')  ? 'Bull Put'  :
                       name.includes('Bear Call') ? 'Bear Call' : 'Other',
      returnPct,
      dte,
      lossOfRisk,
      credit:          Math.abs(parseDollar(v[5])),
      chance,
      maxLoss,
      maxProfit,
      ev:              chance * maxProfit - (1 - chance) * maxLoss,
      delta:           parseFloat(v[11]) || 0,
      theta,
      gamma,
      vega,
      iv:              parsePct(v[16]),
      tgRatio:         gamma !== 0 ? theta / Math.abs(gamma) : null,
      tvRatio:         vega  !== 0 ? theta / Math.abs(vega)  : null,
    });
  }
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const spreads = loadSpreads(csvFile);
if (!spreads.length) { console.error('No spreads found in', csvFile); process.exit(1); }
console.log(`Parsed ${spreads.length} spread positions`);

const basename = path.basename(csvFile, '.csv');
const reportsDir = path.join(__dirname, 'reports');
fs.mkdirSync(reportsDir, { recursive: true });

// ── JSON snapshot ─────────────────────────────────────────────────────────────
// Written next to the report. The report page embeds the same object and can
// load other snapshots' JSON files to redraw itself (see report.js).

function fmtExpISO(expStr) {
  // "4/17/26 14:00" or "4/17/2026 14:00" → "2026-04-17"
  const m = (expStr || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return expStr;
  const year = m[3].length === 2 ? '20' + m[3] : m[3];
  return `${year}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
}

// download.js stamps filenames with America/Denver wall-clock time; turn one into an instant.
function fromDenver(date, hh, mm) {
  const guess = new Date(`${date}T${hh}:${mm}:00Z`);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', timeZoneName: 'longOffset' })
    .formatToParts(guess).find(p => p.type === 'timeZoneName').value; // e.g. "GMT-06:00"
  const m = off.match(/([+-])(\d{2}):(\d{2})/);
  const mins = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return new Date(guess.getTime() - mins * 60000);
}

// Parse timestamp from CSV filename (e.g. live-active-...-2026-05-07_13-22.csv → 1:22 PM Mountain)
// Falls back to now if the filename doesn't contain a recognisable date.
function tsFromFilename(filename) {
  const m = path.basename(filename).match(/(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})/);
  return m ? fromDenver(m[1], m[2], m[3]) : new Date();
}
const snapshotTime = tsFromFilename(csvFile);

const snapshot = {
  generatedAt: snapshotTime.toISOString(),
  source:      path.basename(csvFile),
  positions:   spreads.map(s => ({
    name:       s.name,
    underlying: s.underlying,
    expiration: fmtExpISO(s.expiration),
    type:       s.type,
    chance:     s.chance,
    credit:     s.credit,
    maxProfit:  s.maxProfit,
    maxLoss:    s.maxLoss,
    ev:         s.ev,
    returnPct:  s.returnPct,
    theta:      s.theta,
    vega:       s.vega,
    gamma:      s.gamma,
    delta:      s.delta,
    iv:         s.iv,
    tgRatio:    s.tgRatio,
    tvRatio:    s.tvRatio,
  })),
};

const jsonFile = path.join(reportsDir, basename + '-portfolio.json');
fs.writeFileSync(jsonFile, JSON.stringify(snapshot, null, 2));
console.log(`Wrote → ${jsonFile}`);

// ── HTML report ───────────────────────────────────────────────────────────────
// A shell plus the snapshot; report.js draws everything in the browser.

const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
// Keep "</script>" inside the data from closing the tag.
const embedJSON = obj => JSON.stringify(obj).replace(/</g, '\\u003c');

const html = `<!DOCTYPE html>
<html lang="en" data-theme="dark" data-palette="#0e2a31,#ece4d0,#f3a83b">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spread book</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect x='12' y='12' width='34' height='34' rx='6' fill='%23f3a83b'/><rect x='54' y='54' width='34' height='34' rx='6' fill='%23f3a83b'/><rect x='54' y='12' width='34' height='34' rx='6' fill='%23f3a83b' opacity='.45'/><rect x='12' y='54' width='34' height='34' rx='6' fill='%23f3a83b' opacity='.45'/></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&display=swap" rel="stylesheet">
<script>
  try { if (localStorage.getItem("optionspread.theme") === "light") document.documentElement.setAttribute("data-theme", "light"); } catch (e) {}
</script>
<script>${asset('palette.js')}</script>
<style>
${asset('theme.css')}
${asset('report.css')}
</style>
</head>
<body data-base="${escAttr(basename)}">
<header class="top">
  <h1 class="brand"><a href="index.html">Spread book</a></h1>
  <label class="snap">Snapshot <select id="snapshot"></select></label>
  <span class="snap-status" id="snap-status" role="status"></span>
  <span class="spacer"></span>
  <nav><a href="archive.html">Archive</a></nav>
  <button id="theme-btn" type="button">Light mode</button>
  <button id="whatif-btn" type="button" class="btn-signal" aria-expanded="false" aria-controls="whatif">Try a trade</button>
</header>

<main class="wrap">
  <section class="whatif" id="whatif" hidden>
    <h2>Try a trade before you place it</h2>
    <p>Paste a row from the OptionStrat export, or several rows copied from Excel. Each trade is added to every total, the grid and the scorecard with a dashed outline, so you can see what it changes.</p>
    <div class="whatif-row">
      <textarea id="whatif-text" aria-label="Spread rows from the OptionStrat export" spellcheck="false" placeholder="AAPL Jun 18th 180/185 Bull Put Spread,0%,$0,..."></textarea>
      <button id="whatif-add" type="button" class="btn-signal">Add to book</button>
    </div>
    <p class="error" id="whatif-error" role="alert" hidden></p>
    <div class="chips" id="chips"></div>
  </section>

  <div class="decide" id="decide"></div>

  <div class="book" id="book" role="group" aria-label="Book totals. Choose one to show it in the grid."></div>

  <div class="split">
    <section>
      <div class="section-head">
        <h2 class="section-title" id="grid-title">Theta by underlying and expiration</h2>
        <div class="legend" id="legend"></div>
      </div>
      <p class="section-note" id="grid-note"></p>
      <div class="heat-scroll"><table class="heat" id="heat"></table></div>
    </section>
    <aside class="detail" id="detail" aria-live="polite"></aside>
  </div>

  <section class="quality">
    <div>
      <div class="section-head">
        <h2 class="section-title">What each spread pays for its risk</h2>
      </div>
      <div class="plot" id="plot"></div>
    </div>
    <div class="q-notes">
      <p><strong>Right</strong> means more theta for each unit of gamma. These hold up better through a sharp move.</p>
      <p><strong>Up</strong> means more theta for each unit of vega. These hold up better through an IV spike.</p>
      <p>The shaded corner is below the median on both. Those spreads are the first to close when you want capital back.</p>
    </div>
  </section>

  <section class="scorecard">
    <div class="section-head">
      <h2 class="section-title">Scorecard</h2>
      <span class="section-note">Select a heading to sort. Gains count toward the close at 50% of max profit, losses toward the stop at 25% of max loss.</span>
    </div>
    <div class="table-scroll"><table class="sc" id="sc"></table></div>
    <details class="guide">
      <summary>What the columns mean</summary>
      <dl>
        <dt>Days</dt><dd>Days to expiration as of the snapshot. Highlighted at 21 or fewer, the window to close or roll before gamma speeds up.</dd>
        <dt>PoP</dt><dd>OptionStrat's probability that both legs expire worthless and you keep the full credit.</dd>
        <dt>EV</dt><dd><code>PoP × max profit − (1 − PoP) × max loss</code>. It treats the trade as all or nothing, so it's usually negative for credit spreads. Use it to compare positions, not as a signal on its own.</dd>
        <dt>Toward an exit</dt><dd>A gain is shown as a share of max profit and counts toward the close at 50%. A loss is shown as a share of max loss and counts toward the stop at 25%. The bar's left end is the stop and its right end is the close.</dd>
        <dt>Theta</dt><dd>Dollars earned per day from time decay, all else equal.</dd>
        <dt>Delta</dt><dd>Direction. Bull puts are positive, bear calls negative.</dd>
        <dt>Gamma</dt><dd>How fast delta moves against you. Negative for credit spreads, and largest near expiration and near the short strike.</dd>
        <dt>Vega</dt><dd>Dollars lost per one-point rise in implied volatility.</dd>
        <dt>IV</dt><dd>Implied volatility from the export.</dd>
        <dt>Θ per Γ</dt><dd>Theta earned for each unit of gamma. Low values are the most exposed to a sharp move. Blank when gamma is zero.</dd>
        <dt>Θ per V</dt><dd>Theta earned for each unit of vega. Low values are the first to close into a volatility spike.</dd>
      </dl>
    </details>
  </section>
</main>

<script type="application/json" id="book-data">${embedJSON(snapshot)}</script>
<script>${asset('book.js')}</script>
<script>${asset('report.js')}</script>
</body>
</html>`;

const outFile = path.join(reportsDir, basename + '-portfolio.html');
fs.writeFileSync(outFile, html);
console.log(`Wrote → ${outFile}`);

// ── Underlying price snapshot ─────────────────────────────────────────────────
// Fetch current prices so daily-pnl.js can do exact attribution without having
// to reverse-engineer prices from historical data.

function httpsGet(url, opts) {
  return new Promise(resolve => {
    const req = https.get(url, opts || {}, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve(buf));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

async function fetchCurrentPrices(underlyings) {
  const now     = Date.now();
  const period2 = Math.floor(now / 1000) + 86400;
  const period1 = period2 - 10 * 86400;
  const prices  = {};
  await Promise.all(underlyings.map(async sym => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}` +
                `?interval=1d&period1=${period1}&period2=${period2}`;
    const raw = await httpsGet(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    });
    if (!raw) return;
    try {
      const r = JSON.parse(raw).chart?.result?.[0];
      if (!r) return;
      const closes = r.indicators.quote[0].close;
      const price  = [...closes].reverse().find(c => c != null);
      if (price != null) prices[sym] = price;
    } catch (_) {}
  }));
  return prices;
}

(async () => {
  const underlyings = [...new Set(spreads.map(s => s.underlying))];
  const prices = await fetchCurrentPrices(underlyings);
  const priceFile = path.join(reportsDir, basename + '-prices.json');
  fs.writeFileSync(priceFile, JSON.stringify({ generatedAt: snapshotTime.toISOString(), prices }, null, 2));
  const found = Object.keys(prices).length;
  console.log(`Wrote → ${priceFile} (${found}/${underlyings.length} underlyings)`);
})().catch(e => console.warn('WARN: price snapshot failed:', e.message));

require('./generate-index')();
