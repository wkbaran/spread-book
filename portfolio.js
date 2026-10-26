#!/usr/bin/env node

const fs       = require('fs');
const path     = require('path');
const https    = require('https');
const { buildPage } = require('./page');
const { readBetas } = require('./betas');
const { annotate } = require('./sim');
const { optionStratLinks } = require('./spread-alerts');

// --paper: a snapshot of paper trades (paper.js), written to reports/paper/ and marked as paper, so it never joins
// the real book's history, latest.json or the stop alerts, which read reports/ only.
const paper = process.argv.includes('--paper');
const csvFile = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!csvFile) { console.error('Usage: node portfolio.js <csv-file> [--paper]'); process.exit(1); }

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
const reportsDir = path.join(__dirname, 'reports', ...(paper ? ['paper'] : []));
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

// ── Underlying prices ─────────────────────────────────────────────────────────
// Fetched before the report is written: the snapshot carries them as `spots` for the
// strike-distance warning (book.js), and daily-pnl.js reads <base>-prices.json to
// attribute P&L without reverse-engineering prices from historical data.

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
  // SPY comes with the same fetch, for beta-weighting; it is only in `prices` if the book holds it.
  let prices = {}, spy = null, spotsAsOf;
  try {
    const fetched = await fetchCurrentPrices([...new Set([...underlyings, 'SPY'])]);
    spy    = fetched.SPY ?? null;
    prices = Object.fromEntries(underlyings.filter(u => u in fetched).map(u => [u, fetched[u]]));
    // When the prices were fetched, not when the positions were: the two jobs run 25 to 45 minutes apart.
    if (Object.keys(fetched).length) spotsAsOf = new Date().toISOString();
  }
  catch (e) { console.warn('WARN: price fetch failed:', e.message); }
  const priceFile = path.join(reportsDir, basename + '-prices.json');
  fs.writeFileSync(priceFile, JSON.stringify({ generatedAt: snapshotTime.toISOString(), prices }, null, 2));
  console.log(`Wrote → ${priceFile} (${Object.keys(prices).length}/${underlyings.length} underlyings)`);

  // Betas from equity-watch's job, left in ./shared between the two jobs. The snapshot keeps them,
  // with when they were computed, and book.js weights each spread's delta by its beta.
  const betaFile = readBetas(path.join(__dirname, 'shared', 'betas.json'));
  const betas = betaFile && Object.fromEntries(underlyings.map(u => [u, betaFile.betas[u] ?? null]));
  console.log(betaFile
    ? `Betas: ${Object.values(betas).filter(b => b !== null).length}/${underlyings.length} underlyings (as of ${betaFile.asOf})`
    : 'Betas: no file from equity-watch');

  // Each spread's saved trade in OptionStrat, from the spreadsheet beside the CSV (none for a paper snapshot).
  // The site is behind basic auth, so the snapshot and the report may carry them; latest.json still doesn't.
  let links = new Map();
  try { links = optionStratLinks(csvFile.replace(/\.csv$/, '.xlsx')); }
  catch (e) { console.warn('WARN: OptionStrat links unreadable:', e.message); }

  const snapshot = {
    generatedAt: snapshotTime.toISOString(),
    source:      path.basename(csvFile),
    paper:       paper || undefined,
    spots:       prices,
    spotsAsOf,
    spy,
    betas:       betas || undefined,
    betasAsOf:   betaFile ? betaFile.asOf : undefined,
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
      optionStratUrl: links.get(s.name.trim()),
    })),
  };

  // The exit plan and the "from here" odds for each spread (sim.js). Stored, so the page and brief.js only read
  // them. A failure here costs those numbers, not the report.
  try {
    const t0 = Date.now();
    annotate(snapshot);
    console.log(`Exit plans: ${snapshot.positions.filter(p => p.plan).length}/${snapshot.positions.length} spreads (${Date.now() - t0} ms)`);
  } catch (e) { console.warn('WARN: exit plans failed:', e.message); }

  const jsonFile = path.join(reportsDir, basename + '-portfolio.json');
  fs.writeFileSync(jsonFile, JSON.stringify(snapshot, null, 2));
  console.log(`Wrote → ${jsonFile}`);

  // ── HTML report ───────────────────────────────────────────────────────────────
  // A shell plus the snapshot; report.js draws everything in the browser (see page.js).

  const outFile = path.join(reportsDir, basename + '-portfolio.html');
  fs.writeFileSync(outFile, buildPage(snapshot, basename));
  console.log(`Wrote → ${outFile}`);

  require('./generate-index')(undefined, reportsDir, paper ? 'Paper book' : undefined);
})().catch(e => { console.error(e); process.exit(1); });
