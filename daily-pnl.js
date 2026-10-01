#!/usr/bin/env node

const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ── Argument handling ────────────────────────────────────────────────────────
// Usage: node daily-pnl.js [today.json] [yesterday.json]
// Without args: auto-discovers two most recent *-portfolio.json files

const reportsDir = path.join(__dirname, 'reports');

function findLatestJsons() {
  const files = fs.readdirSync(reportsDir)
    .filter(f => f.endsWith('-portfolio.json') && !f.includes('daily-pnl'))
    .sort();
  if (files.length < 2) {
    console.error(`Need at least 2 portfolio JSON snapshots in reports/; found ${files.length}`);
    process.exit(1);
  }
  return [
    path.join(reportsDir, files[files.length - 1]),
    path.join(reportsDir, files[files.length - 2]),
  ];
}

const [todayFile, yesterdayFile] = process.argv[2] && process.argv[3]
  ? [process.argv[2], process.argv[3]]
  : findLatestJsons();

const snap1 = JSON.parse(fs.readFileSync(todayFile,     'utf8'));
const snap0 = JSON.parse(fs.readFileSync(yesterdayFile, 'utf8'));

const [snapNow, snapPrev] = new Date(snap1.generatedAt) >= new Date(snap0.generatedAt)
  ? [snap1, snap0] : [snap0, snap1];

const tsNow  = new Date(snapNow.generatedAt);
const tsPrev = new Date(snapPrev.generatedAt);
const daysElapsed = Math.max(0, (tsNow - tsPrev) / 86400000);

// ── Price delta resolution ───────────────────────────────────────────────────
// Preferred: read from saved *-prices.json snapshots written by portfolio.js.
// Fallback: fetch from Yahoo Finance (used for old snapshots without price files).

function priceFileFor(portfolioFile) {
  return portfolioFile.replace(/-portfolio\.json$/, '-prices.json');
}

function loadSavedPriceDeltas(underlyings) {
  const fileNow  = priceFileFor(todayFile);
  const filePrev = priceFileFor(yesterdayFile);
  if (!fs.existsSync(fileNow) || !fs.existsSync(filePrev)) return null;
  try {
    const pricesNow  = JSON.parse(fs.readFileSync(fileNow)).prices;
    const pricesPrev = JSON.parse(fs.readFileSync(filePrev)).prices;
    const deltas = {};
    for (const sym of underlyings) {
      if (pricesNow[sym] != null && pricesPrev[sym] != null) {
        deltas[sym] = pricesNow[sym] - pricesPrev[sym];
        console.log(`  ${sym}: $${pricesPrev[sym].toFixed(2)} → $${pricesNow[sym].toFixed(2)}` +
                    ` (${deltas[sym] >= 0 ? '+' : ''}${deltas[sym].toFixed(2)}) [saved]`);
      }
    }
    return deltas;
  } catch (_) { return null; }
}

function httpsGet(url, opts) {
  return new Promise(resolve => {
    const req = https.get(url, opts, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve(buf));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

async function fetchPriceDeltasYahoo(underlyings) {
  const result  = {};
  const period2 = Math.floor(tsNow.getTime()  / 1000) + 86400;
  const period1 = Math.floor(tsPrev.getTime() / 1000) - 86400 * 10;

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
      const bars = r.timestamp
        .map((t, i) => ({ date: new Date(t * 1000), close: r.indicators.quote[0].close[i] }))
        .filter(b => b.close != null);
      if (bars.length < 2) return;
      const barNow  = [...bars].reverse().find(b => b.date <= tsNow);
      const barPrev = [...bars].reverse().find(b => b.date <= tsPrev);
      if (barNow && barPrev && barNow !== barPrev) {
        result[sym] = barNow.close - barPrev.close;
        console.log(`  ${sym}: $${barPrev.close.toFixed(2)} → $${barNow.close.toFixed(2)}` +
                    ` (${result[sym] >= 0 ? '+' : ''}${result[sym].toFixed(2)}) [Yahoo]`);
      }
    } catch (_) {}
  }));
  return result;
}

// ── Position matching ────────────────────────────────────────────────────────

function pnlDollars(pos) {
  return (pos.returnPct / 100) * pos.maxProfit;
}

// ── Color helpers (same conventions as portfolio.js) ─────────────────────────

function cDiverging(v, min, max) {
  const abs = Math.max(Math.abs(min), Math.abs(max), 1e-9);
  const t   = Math.max(-1, Math.min(1, v / abs));
  if (t < 0) { const i = -t; return `rgb(${R(220+35*i)},${R(220-180*i)},${R(220-180*i)})`; }
  else        { const i =  t; return `rgb(${R(220-180*i)},${R(185+35*i)},${R(220-180*i)})`; }
}
function cGreen(v, max) {
  const t = Math.max(0, Math.min(1, max > 0 ? v / max : 0));
  return `rgb(${R(230-170*t)},${R(230)},${R(230-170*t)})`;
}
function cRed(absV, absMax) {
  const t = Math.max(0, Math.min(1, absMax > 0 ? absV / absMax : 0));
  return `rgb(${R(230+25*t)},${R(230-190*t)},${R(230-190*t)})`;
}
function R(n) { return Math.round(n); }
function fg(bg) {
  const m = bg.match(/\d+/g);
  if (!m) return '#111';
  const [rv, g, b] = m.map(Number);
  return (0.299*rv + 0.587*g + 0.114*b) < 140 ? '#fff' : '#111';
}

function fmtD(v, dp = 2) {
  if (v === null || v === undefined) return '—';
  if (v < 0) return `-$${Math.abs(v).toFixed(dp)}`;
  return `$${v.toFixed(dp)}`;
}
function fmtReturn(v) {
  if (v === null || v === undefined) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}
function fmtGreek(v, dp = 3) {
  if (v === null || v === undefined) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(dp)}`;
}
function fmtDate(isoOrSlash) {
  return new Date(isoOrSlash).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}
function fmtTs(d) {
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}
function fmtSpot(v) {
  if (v === null || v === undefined) return '—';
  return `${v >= 0 ? '+' : ''}$${Math.abs(v).toFixed(2)}`;
}

// ── Main (async to allow Yahoo Finance fetch) ─────────────────────────────────

(async () => {

  const underlyings = [...new Set(snapNow.positions.map(p => p.underlying))];

  // Try saved price snapshots first; fall back to Yahoo Finance for old snapshots
  let spotDeltas = loadSavedPriceDeltas(underlyings);
  let priceSource;
  if (spotDeltas) {
    priceSource = 'saved';
    console.log(`Loaded saved price snapshots (${Object.keys(spotDeltas).length}/${underlyings.length} underlyings)`);
  } else {
    priceSource = 'yahoo';
    console.log(`No saved price files found — fetching from Yahoo Finance for: ${underlyings.join(', ')}`);
    spotDeltas = await fetchPriceDeltasYahoo(underlyings);
  }
  const pricesFetched = Object.keys(spotDeltas).length;
  console.log(`Got price data for ${pricesFetched}/${underlyings.length} underlyings (source: ${priceSource})`);

  // ── Build per-position rows ──────────────────────────────────────────────────

  const prevByName = Object.fromEntries(snapPrev.positions.map(p => [p.name, p]));
  const currByName = Object.fromEntries(snapNow.positions.map(p => [p.name, p]));

  const rows = [];

  for (const pos of snapNow.positions) {
    const prev = prevByName[pos.name];
    const ds   = spotDeltas[pos.underlying] ?? null;

    if (!prev) {
      rows.push({
        name: pos.name, underlying: pos.underlying,
        expiration: pos.expiration, type: pos.type,
        status: 'new',
        prevReturnPct: null, currReturnPct: pos.returnPct,
        totalPnL:  pnlDollars(pos),
        thetaPnL:  null, deltaPnL: null, gammaPnL: null, vegaPnL: null,
        hasPrices: false,
        spotDelta: ds,
        delta: pos.delta, theta: pos.theta, gamma: pos.gamma, vega: pos.vega,
        maxProfit: pos.maxProfit,
      });
      continue;
    }

    const totalPnL = pnlDollars(pos) - pnlDollars(prev);
    const thetaPnL = prev.theta * daysElapsed;

    let deltaPnL = null, gammaPnL = null, vegaPnL = null;
    const hasPrices = ds !== null;
    if (hasPrices) {
      deltaPnL = prev.delta * ds;
      gammaPnL = 0.5 * prev.gamma * ds * ds;
      vegaPnL  = totalPnL - thetaPnL - deltaPnL - gammaPnL;
    }

    rows.push({
      name: pos.name, underlying: pos.underlying,
      expiration: pos.expiration, type: pos.type,
      status: 'held',
      prevReturnPct: prev.returnPct, currReturnPct: pos.returnPct,
      totalPnL, thetaPnL, deltaPnL, gammaPnL, vegaPnL,
      hasPrices,
      spotDelta: ds,
      delta: pos.delta, theta: pos.theta, gamma: pos.gamma, vega: pos.vega,
      maxProfit: pos.maxProfit,
    });
  }

  // Closed positions
  for (const prev of snapPrev.positions) {
    if (!currByName[prev.name]) {
      rows.push({
        name: prev.name, underlying: prev.underlying,
        expiration: prev.expiration, type: prev.type,
        status: 'closed',
        prevReturnPct: prev.returnPct, currReturnPct: null,
        totalPnL: null, thetaPnL: null, deltaPnL: null, gammaPnL: null, vegaPnL: null,
        hasPrices: false,
        spotDelta: spotDeltas[prev.underlying] ?? null,
        delta: prev.delta, theta: prev.theta, gamma: prev.gamma, vega: prev.vega,
        maxProfit: prev.maxProfit,
      });
    }
  }

  // Sort: held first (by totalPnL desc), new, closed
  const order = { held: 0, new: 1, closed: 2 };
  rows.sort((a, b) => {
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    if (a.totalPnL !== null && b.totalPnL !== null) return b.totalPnL - a.totalPnL;
    return 0;
  });

  // ── Aggregates (held only) ───────────────────────────────────────────────────

  const held         = rows.filter(r => r.status === 'held');
  const totalPnL     = held.reduce((s, r) => s + r.totalPnL, 0);
  const totalTheta   = held.reduce((s, r) => s + (r.thetaPnL ?? 0), 0);
  const heldWithPx   = held.filter(r => r.hasPrices);
  const totalDelta   = heldWithPx.reduce((s, r) => s + r.deltaPnL, 0);
  const totalGamma   = heldWithPx.reduce((s, r) => s + r.gammaPnL, 0);
  // Vega+other residual: over positions with full attribution only
  const totalVega    = heldWithPx.reduce((s, r) => s + r.vegaPnL,  0);
  // For positions WITHOUT price data, compute theta-only residual
  const heldNoPx     = held.filter(r => !r.hasPrices);
  const moveNoPx     = heldNoPx.reduce((s, r) => s + (r.totalPnL - r.thetaPnL), 0);
  const noPxCount    = heldNoPx.length;

  // ── Color scale bounds ───────────────────────────────────────────────────────

  const allPnls   = held.flatMap(r =>
    [r.totalPnL, r.thetaPnL, r.deltaPnL, r.gammaPnL, r.vegaPnL].filter(x => x !== null));
  const pnlMin    = Math.min(...allPnls, 0);
  const pnlMax    = Math.max(...allPnls, 0);
  const thetaMax  = Math.max(...held.map(r => r.thetaPnL ?? 0), 1e-9);

  const allDeltas  = rows.map(r => r.delta);
  const allGammas  = rows.map(r => Math.abs(r.gamma));
  const allVegas   = rows.map(r => Math.abs(r.vega));
  const allThetas  = rows.map(r => r.theta);
  const deltaMin   = Math.min(...allDeltas, 0);
  const deltaMax_v = Math.max(...allDeltas, 0);
  const gammaMax   = Math.max(...allGammas, 1e-9);
  const vegaMax    = Math.max(...allVegas,  1e-9);
  const thetaGMax  = Math.max(...allThetas, 1e-9);

  // ── Build HTML rows ──────────────────────────────────────────────────────────

  function pnlCell(v, classes = '') {
    if (v === null) return `<td class="na ${classes}">—</td>`;
    const bg = cDiverging(v, pnlMin, pnlMax);
    return `<td class="val ${classes}" style="background:${bg};color:${fg(bg)}">${fmtD(v)}</td>`;
  }
  function thetaCell(v) {
    if (v === null) return `<td class="na">—</td>`;
    const bg = cGreen(v, thetaMax);
    return `<td class="val" style="background:${bg};color:${fg(bg)}" title="theta × ${daysElapsed.toFixed(3)} days">${fmtD(v)}</td>`;
  }

  function badge(status) {
    if (status === 'new')    return `<span class="badge new">new</span>`;
    if (status === 'closed') return `<span class="badge closed">closed</span>`;
    return '';
  }

  const tableRows = rows.map(row => {
    const typeCls = row.type === 'Bull Put' ? 'bull' : row.type === 'Bear Call' ? 'bear' : '';
    const isHeld  = row.status === 'held';

    const prevRet = row.prevReturnPct !== null
      ? `<td class="val">${fmtReturn(row.prevReturnPct)}</td>`
      : `<td class="na">—</td>`;
    const currBg  = row.currReturnPct !== null ? cDiverging(row.currReturnPct, -100, 100) : null;
    const currRet = row.currReturnPct !== null
      ? `<td class="val" style="background:${currBg};color:${fg(currBg)}">${fmtReturn(row.currReturnPct)}</td>`
      : `<td class="na">—</td>`;

    const spotCell = row.spotDelta !== null
      ? `<td class="val">${fmtSpot(row.spotDelta)}</td>`
      : `<td class="na" title="Price data unavailable">—</td>`;

    // P&L attribution columns
    const totalCell = pnlCell(isHeld ? row.totalPnL : row.status === 'new' ? row.totalPnL : null, 'sep');
    const theCell   = thetaCell(isHeld ? row.thetaPnL : null);
    const delCell   = pnlCell(isHeld && row.hasPrices ? row.deltaPnL : null);
    const gamCell   = pnlCell(isHeld && row.hasPrices ? row.gammaPnL : null);
    const vegCell   = isHeld && row.hasPrices
      ? pnlCell(row.vegaPnL)
      : isHeld
        ? `<td class="na" title="Δspot unavailable; use Mkt Effects column">—</td>`
        : `<td class="na">—</td>`;
    // Fallback "mkt effects" when no price data
    const mktCell = isHeld && !row.hasPrices
      ? pnlCell(row.totalPnL - row.thetaPnL)
      : `<td class="na">—</td>`;

    // Current Greek value columns
    const dBg  = cDiverging(row.delta,          deltaMin, deltaMax_v);
    const gBg  = cRed(Math.abs(row.gamma),       gammaMax);
    const tCBg = cGreen(row.theta,               thetaGMax);
    const vBg  = cRed(Math.abs(row.vega),        vegaMax);

    return `<tr>
  <td class="sym">${row.underlying}${badge(row.status)}</td>
  <td class="expd">${fmtDate(row.expiration)}</td>
  <td class="pos ${typeCls}">${row.name}</td>
  ${prevRet}${currRet}
  ${totalCell}${theCell}${delCell}${gamCell}${vegCell}${mktCell}
  <td class="val sep" style="background:${dBg};color:${fg(dBg)}">${fmtGreek(row.delta, 2)}</td>
  <td class="val" style="background:${gBg};color:${fg(gBg)}">${fmtGreek(row.gamma, 3)}</td>
  <td class="val" style="background:${tCBg};color:${fg(tCBg)}">${fmtGreek(row.theta, 3)}</td>
  <td class="val" style="background:${vBg};color:${fg(vBg)}">${fmtGreek(row.vega, 3)}</td>
  ${spotCell}
</tr>`;
  }).join('\n');

  // ── Footer totals ────────────────────────────────────────────────────────────

  const totBg  = cDiverging(totalPnL, pnlMin, pnlMax);
  const totTBg = cGreen(totalTheta, thetaMax);
  const totDBg = cDiverging(totalDelta, pnlMin, pnlMax);
  const totGBg = cDiverging(totalGamma, pnlMin, pnlMax);
  const totVBg = cDiverging(totalVega,  pnlMin, pnlMax);
  const totMBg = cDiverging(moveNoPx,   pnlMin, pnlMax);

  const sumDelta  = snapNow.positions.reduce((s, p) => s + p.delta, 0);
  const sumGamma  = snapNow.positions.reduce((s, p) => s + p.gamma, 0);
  const sumTheta  = snapNow.positions.reduce((s, p) => s + p.theta, 0);
  const sumVega   = snapNow.positions.reduce((s, p) => s + p.vega,  0);
  const sDeltaBg  = cDiverging(sumDelta,          deltaMin, deltaMax_v);
  const sGammaBg  = cRed(Math.abs(sumGamma),       gammaMax);
  const sThetaBg  = cGreen(sumTheta,               thetaGMax);
  const sVegaBg   = cRed(Math.abs(sumVega),        vegaMax);

  const noPxNote = noPxCount > 0
    ? `<td class="trow na" colspan="2" title="${noPxCount} position(s) lacked price data; Mkt Effects residual used">↑ ${noPxCount} w/o price data</td>`
    : `<td class="trow na" colspan="2">—</td>`;

  const footerRow = `<tr>
  <td class="sym trow" colspan="3">TOTAL (${held.length} held)</td>
  <td class="trow na" title="Return % is per-position only; no meaningful portfolio total">—</td>
  <td class="trow na" title="Return % is per-position only; no meaningful portfolio total">—</td>
  <td class="val trow sep" style="background:${totBg};color:${fg(totBg)}">${fmtD(totalPnL)}</td>
  <td class="val trow" style="background:${totTBg};color:${fg(totTBg)}">${fmtD(totalTheta)}</td>
  <td class="val trow" style="background:${totDBg};color:${fg(totDBg)}">${heldWithPx.length ? fmtD(totalDelta) : '—'}</td>
  <td class="val trow" style="background:${totGBg};color:${fg(totGBg)}">${heldWithPx.length ? fmtD(totalGamma) : '—'}</td>
  <td class="val trow" style="background:${totVBg};color:${fg(totVBg)}">${heldWithPx.length ? fmtD(totalVega) : '—'}</td>
  ${noPxNote}
  <td class="val trow sep" style="background:${sDeltaBg};color:${fg(sDeltaBg)}">${fmtGreek(sumDelta, 2)}</td>
  <td class="val trow" style="background:${sGammaBg};color:${fg(sGammaBg)}">${fmtGreek(sumGamma, 3)}</td>
  <td class="val trow" style="background:${sThetaBg};color:${fg(sThetaBg)}">${fmtGreek(sumTheta, 3)}</td>
  <td class="val trow" style="background:${sVegaBg};color:${fg(sVegaBg)}">${fmtGreek(sumVega, 3)}</td>
  <td class="trow na">—</td>
</tr>`;

  // ── Summary card data ─────────────────────────────────────────────────────────

  function card(label, value, note, valueColor) {
    const clr = valueColor ?? (value >= 0 ? '#4ade80' : '#f87171');
    return `<div class="card">
  <div class="card-label">${label}</div>
  <div class="card-value" style="color:${clr}">${fmtD(value)}</div>
  ${note ? `<div class="card-note">${note}</div>` : ''}
</div>`;
  }

  const daysLabel = daysElapsed < 0.5
    ? `${(daysElapsed * 24).toFixed(1)} hr`
    : `${daysElapsed.toFixed(2)} days`;

  const hasPricesGlobally = pricesFetched > 0;

  // ── HTML ─────────────────────────────────────────────────────────────────────

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Daily P&L — ${tsNow.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      background: #0a0e1a; color: #c9d1d9; padding: 28px 24px; line-height: 1.4;
    }
    h1 { font-size: 1.3rem; font-weight: 600; color: #e6edf3; text-align: center; margin-bottom: 6px; letter-spacing: .03em; }
    .page-sub { text-align: center; color: #6e7681; font-size: 12px; margin-bottom: 6px; letter-spacing: .06em; text-transform: uppercase; }
    .page-nav { text-align: right; margin-bottom: 24px; }
    .page-nav a { color: #8b949e; font-size: 12px; text-decoration: none; }
    .page-nav a:hover { color: #58a6ff; }
    h2 { font-size: .78rem; color: #f0a500; margin-bottom: 6px; text-transform: uppercase; letter-spacing: .1em; font-weight: 700; }
    section { background: #10151f; border: 1px solid #2a3040; border-radius: 8px; padding: 20px 22px; margin-bottom: 32px; overflow-x: auto; }
    p.subtitle { font-size: 11px; color: #6e7681; margin-bottom: 12px; }
    table { border-collapse: collapse; font-size: 12px; min-width: 100%; }
    th { background: #1c2230; color: #8b949e; padding: 7px 12px; text-align: left; border: 1px solid #2a3040; white-space: nowrap; font-weight: 600; letter-spacing: .04em; font-size: 11px; }
    th.right { text-align: right; }
    th.sep  { border-left: 2px solid #f0a500; }
    th.sep2 { border-left: 2px solid #3a4558; }
    td { padding: 5px 12px; border: 1px solid #1c2230; white-space: nowrap; transition: filter .1s; }
    tr:hover td { filter: brightness(1.14); }
    td.sym  { font-weight: 700; font-size: 13px; min-width: 68px; }
    td.expd { font-size: 11px; color: #8b949e; min-width: 78px; }
    td.pos  { max-width: 360px; overflow: hidden; text-overflow: ellipsis; }
    td.pos.bull { color: #6ee7b7; }
    td.pos.bear { color: #fca5a5; }
    td.val { text-align: right; font-family: 'Cascadia Code', 'Fira Mono', monospace; font-weight: 600; min-width: 72px; }
    td.na { color: #444; text-align: center; background: #10151f; }
    td.sep  { border-left: 2px solid #f0a500; }
    td.sep2 { border-left: 2px solid #3a4558; }
    td.trow { position: relative; border-top: 2px solid #f0a500; font-weight: 700; }
    td.trow.na { border-top: 2px solid #f0a500; }
    .cards { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 28px; }
    .card { background: #10151f; border: 1px solid #2a3040; border-radius: 8px; padding: 14px 18px; flex: 1; min-width: 130px; }
    .card-label { font-size: 10px; text-transform: uppercase; letter-spacing: .1em; color: #6e7681; margin-bottom: 5px; }
    .card-value { font-size: 1.4rem; font-weight: 700; font-family: 'Cascadia Code', 'Fira Mono', monospace; }
    .card-note { font-size: 10px; color: #6e7681; margin-top: 3px; }
    .period-strip { background: #10151f; border: 1px solid #2a3040; border-radius: 6px; padding: 8px 16px; font-size: 11px; color: #6e7681; margin-bottom: 20px; display: flex; gap: 20px; flex-wrap: wrap; }
    .period-strip strong { color: #adbac7; }
    .badge { font-size: 9px; font-weight: 700; padding: 1px 6px; border-radius: 8px; letter-spacing: .05em; text-transform: uppercase; vertical-align: middle; margin-left: 4px; }
    .badge.new    { background: rgba(88,166,255,.18); color: #58a6ff; border: 1px solid rgba(88,166,255,.3); }
    .badge.closed { background: rgba(110,118,129,.18); color: #8b949e; border: 1px solid rgba(110,118,129,.3); }
    details.col-guide { margin-top: 16px; border: 1px solid #2a3040; border-radius: 6px; padding: 0; }
    details.col-guide[open] { padding-bottom: 16px; }
    details.col-guide summary { cursor: pointer; padding: 10px 14px; font-size: 11px; font-weight: 700; color: #8b949e; text-transform: uppercase; letter-spacing: .08em; list-style: none; user-select: none; }
    details.col-guide summary::-webkit-details-marker { display: none; }
    details.col-guide summary::before { content: '▸ '; color: #f0a500; }
    details.col-guide[open] summary::before { content: '▾ '; }
    details.col-guide dl { margin: 4px 14px 0; display: grid; grid-template-columns: max-content 1fr; gap: 6px 20px; }
    details.col-guide dt { font-family: 'Cascadia Code', 'Fira Mono', monospace; font-size: 12px; font-weight: 700; color: #f0a500; padding-top: 2px; white-space: nowrap; }
    details.col-guide dd { font-size: 12px; color: #8b949e; line-height: 1.55; }
    details.col-guide dd strong { color: #c9d1d9; }
    details.col-guide dd code { font-family: 'Cascadia Code', 'Fira Mono', monospace; font-size: 11px; color: #e6edf3; background: #1c2230; border-radius: 3px; padding: 1px 5px; }
  </style>
</head>
<body>
<h1>Daily P&amp;L Attribution</h1>
<p class="page-sub">${tsNow.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</p>
<nav class="page-nav"><a href="index.html">← All Reports</a></nav>

<div class="period-strip">
  <span>From <strong>${fmtTs(tsPrev)}</strong></span>
  <span>To <strong>${fmtTs(tsNow)}</strong></span>
  <span>Elapsed <strong>${daysLabel}</strong></span>
  <span>${snapNow.positions.length} active · ${rows.filter(r=>r.status==='new').length} opened · ${rows.filter(r=>r.status==='closed').length} closed</span>
  ${hasPricesGlobally
    ? `<span>Prices: <strong>${pricesFetched}/${underlyings.length}</strong> underlyings · source: <strong>${priceSource === 'saved' ? 'snapshot' : 'Yahoo Finance'}</strong></span>`
    : `<span style="color:#f87171">Price data unavailable — delta &amp; gamma attribution requires EOD prices</span>`
  }
</div>

<div class="cards">
  ${card('Total Daily P&L',   totalPnL,   `${held.length} held position${held.length !== 1 ? 's' : ''}`)}
  ${card('Θ Theta',           totalTheta, `time decay × ${daysLabel}`)}
  ${hasPricesGlobally
    ? card('Δ Delta',   totalDelta, `price move effect (${heldWithPx.length} positions)`)
    : `<div class="card"><div class="card-label">Δ Delta</div><div class="card-value" style="color:#555">N/A</div><div class="card-note">price data unavailable</div></div>`
  }
  ${hasPricesGlobally
    ? card('Γ Gamma',   totalGamma, `convexity effect`)
    : `<div class="card"><div class="card-label">Γ Gamma</div><div class="card-value" style="color:#555">N/A</div><div class="card-note">price data unavailable</div></div>`
  }
  ${hasPricesGlobally
    ? card('Vega & other',  totalVega,  `residual: IV changes + model error`, totalVega >= 0 ? '#4ade80' : '#f87171')
    : `<div class="card"><div class="card-label">Vega & other</div><div class="card-value" style="color:#555">N/A</div></div>`
  }
</div>

<section data-section="attribution">
  <h2>Per-Spread Attribution</h2>
  <p class="subtitle">
    <strong>Daily P&amp;L</strong> = Δ(returnPct × maxProfit) between snapshots.
    <strong>Θ</strong> = prior theta × elapsed days.
    <strong>Δ P&amp;L</strong> = prior delta × Δspot.
    <strong>Γ P&amp;L</strong> = ½ × prior gamma × Δspot².
    <strong>Vega&amp;other</strong> = residual (Daily P&amp;L − Θ − Δ − Γ); captures IV changes and model error.
    Right section: current Greek exposures from today's snapshot.
    ${noPxCount > 0 ? `<br><em>${noPxCount} position(s) had no EOD price data — Mkt Effects column shows theta-excluded residual instead.</em>` : ''}
  </p>
  <table>
    <thead>
      <tr>
        <th>Symbol</th>
        <th>Expiry</th>
        <th>Position</th>
        <th class="right">Prev Ret%</th>
        <th class="right">Curr Ret%</th>
        <th class="right sep">Daily P&L</th>
        <th class="right">Θ P&L</th>
        <th class="right">Δ P&L</th>
        <th class="right">Γ P&L</th>
        <th class="right">V+other</th>
        <th class="right">Mkt Eff†</th>
        <th class="right sep2">Δ</th>
        <th class="right">Γ</th>
        <th class="right">Θ/day</th>
        <th class="right">Vega</th>
        <th class="right">Spot Δ</th>
      </tr>
    </thead>
    <tbody>
      ${tableRows}
      ${footerRow}
    </tbody>
  </table>

  <details class="col-guide">
    <summary>Column guide</summary>
    <dl>
      <dt>Prev Ret% / Curr Ret%</dt>
      <dd>Return as % of max profit at the prior and current snapshot. 100% = full premium captured (position expired worthless). No total row — return % is per-position only and can't be meaningfully summed across positions with different sizes.</dd>

      <dt>Daily P&L</dt>
      <dd>Dollar P&amp;L change between snapshots: <code>(currRetPct − prevRetPct) / 100 × maxProfit</code>. Green = gain, red = loss.</dd>

      <dt>Θ P&L</dt>
      <dd>Time-decay contribution: <code>theta (prior snapshot) × days elapsed</code>. For credit spreads this is always positive — the clock is on your side.</dd>

      <dt>Δ P&L</dt>
      <dd>Directional P&amp;L: <code>delta (prior snapshot) × Δspot</code>. Positive means the underlying moved in your favour (up for bull puts, down for bear calls). Requires EOD price data.</dd>

      <dt>Γ P&L</dt>
      <dd>Convexity cost: <code>½ × gamma (prior snapshot) × Δspot²</code>. Always negative for credit spreads — gamma accelerates losses when the underlying makes a large move in either direction. Requires EOD price data.</dd>

      <dt>V+other</dt>
      <dd>Residual after removing Θ, Δ, and Γ effects: <code>Daily P&amp;L − Θ P&L − Δ P&L − Γ P&L</code>. Primarily captures changes in implied volatility (vega), plus small contributions from rho, vanna, volga, and bid-ask spread differences. A large negative V+other usually means IV expanded (a vol spike hurt you). Requires EOD price data.</dd>

      <dt>Mkt Eff†</dt>
      <dd>Fallback column for positions where no EOD price data was available. <code>Daily P&amp;L − Θ P&L</code> — all non-theta effects (Δ + Γ + V + other) lumped together. Shown instead of the three individual columns.</dd>

      <dt>Δ / Γ / Θ/day / Vega</dt>
      <dd>Current Greek exposures from today's snapshot. <strong>Δ</strong>: directional sensitivity. <strong>Γ</strong>: rate of delta change per $1 move (always negative for credit spreads). <strong>Θ/day</strong>: expected daily decay tomorrow. <strong>Vega</strong>: $ change per 1% IV rise (negative for credit spreads).</dd>

      <dt>Spot Δ</dt>
      <dd>End-of-day closing price change for the underlying: <code>today close − prior snapshot close</code>. Fetched from Yahoo Finance. Used to calculate Δ P&L and Γ P&L.</dd>
    </dl>
  </details>
</section>

</body>
</html>`;

  // ── Write output ──────────────────────────────────────────────────────────────

  fs.mkdirSync(reportsDir, { recursive: true });
  const stamp   = tsNow.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const outFile = path.join(reportsDir, `${stamp}-daily-pnl.html`);
  fs.writeFileSync(outFile, html);
  console.log(`\nWrote → ${outFile}`);

  // Same attribution as JSON, named after the newer portfolio snapshot so brief.js can find it.
  const r2 = v => v === null ? null : Math.round(v * 100) / 100;
  const nowFile = snapNow === snap1 ? todayFile : yesterdayFile;
  const prevFile = snapNow === snap1 ? yesterdayFile : todayFile;
  const jsonOut = nowFile.replace(/-portfolio\.json$/, '-pnl.json');
  if (jsonOut === nowFile) return; // not a portfolio snapshot name; don't overwrite the input
  fs.writeFileSync(jsonOut, JSON.stringify({
    from:        tsPrev.toISOString(),
    to:          tsNow.toISOString(),
    days:        Math.round(daysElapsed * 1000) / 1000,
    previous:    path.basename(prevFile),
    priceSource,
    totals: {
      pnl:        r2(totalPnL),
      theta:      r2(totalTheta),
      delta:      hasPricesGlobally ? r2(totalDelta) : null,
      gamma:      hasPricesGlobally ? r2(totalGamma) : null,
      vegaOther:  hasPricesGlobally ? r2(totalVega)  : null,
      // Held positions without a price move: everything except theta, unattributed
      unattributed: r2(moveNoPx),
      unattributedPositions: noPxCount,
    },
    counts: {
      held:   held.length,
      new:    rows.filter(r => r.status === 'new').length,
      closed: rows.filter(r => r.status === 'closed').length,
    },
    positions: rows.map(r => ({
      name: r.name, underlying: r.underlying, expiration: r.expiration, type: r.type, status: r.status,
      prevReturnPct: r.prevReturnPct, currReturnPct: r.currReturnPct, spotMove: r2(r.spotDelta),
      pnl: r2(r.totalPnL), theta: r2(r.thetaPnL), delta: r2(r.deltaPnL), gamma: r2(r.gammaPnL), vegaOther: r2(r.vegaPnL),
    })),
  }, null, 2));
  console.log(`Wrote → ${jsonOut}`);
  console.log(`Period  : ${fmtTs(tsPrev)} → ${fmtTs(tsNow)} (${daysLabel})`);
  console.log(`Held    : ${held.length}  New: ${rows.filter(r=>r.status==='new').length}  Closed: ${rows.filter(r=>r.status==='closed').length}`);
  console.log(`P&L     : Total ${fmtD(totalPnL)}  |  Θ ${fmtD(totalTheta)}  |  Δ ${hasPricesGlobally ? fmtD(totalDelta) : 'N/A'}  |  Γ ${hasPricesGlobally ? fmtD(totalGamma) : 'N/A'}  |  V+other ${hasPricesGlobally ? fmtD(totalVega) : 'N/A'}`);

})();
