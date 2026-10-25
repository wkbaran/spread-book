#!/usr/bin/env node
// Paper trades: a ledger of spreads opened and closed at prices from live tastytrade quotes, marked at each
// snapshot and drawn as their own report (reports/paper/), never in the real book.
//
//   node paper.js open SYMBOL put|call YYYY-MM-DD SHORT LONG [--qty N] [--ticket ID] [--anytime]
//   node paper.js close ID [--debit X] [--anytime]
//   node paper.js list
//   node paper.js check       fill resting profit targets from live quotes (regular session only)
//   node paper.js snapshot    check, then write data/paper/paper-<stamp>.csv and build reports/paper/ from it
//
// The ledger is data/paper/ledger.json. data/ is never uploaded (publish.sh), so fills, quantities and the quotes
// they used stay on the Docker host. This file is the only writer: every command that changes it takes a lock and
// writes it atomically. The report and its jobs only read the CSV a snapshot leaves.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const SB = require('./book');
const { SIM, normalCdf } = require('./sim');
const { Tastytrade, occSymbol, credentialsFromEnv } = require('./tastytrade');
const { writeFileAtomic } = require('./betas');
const { buildSpreadAlerts, asPaper, writeSpreadAlerts, ALERTS_SCHEMA } = require('./spread-alerts');

const PAPER = {
  // An opening fills this far from the mid toward the natural price (0 is the mid, 1 the natural), so paper results
  // aren't flattered. The same idea, and value, as spread-scanner's outcome.fillShare.
  fillShare: 0.5,
  target: SB.RULES.target, // the resting buy-to-close limit, at this % of the credit
  feePerContractOpen: 1, // tastytrade: $1 a contract to open, nothing to close (AUTOMATION-PLAN section 0)
  lockStaleMs: 5 * 60_000,
};
const SCHEMA = 'spread-book/paper-ledger@1';
const DIR = path.join(__dirname, 'data', 'paper');
const LEDGER = path.join(DIR, 'ledger.json');

const cents = (n) => Math.round(n * 100) / 100;
const floorCents = (n) => Math.floor(n * 100 + 1e-9) / 100;

// ---- dates and the session -----------------------------------------------------------------------

const zoned = (now, timeZone) => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
}).formatToParts(now).map((p) => [p.type, p.value]));
// The New York calendar date, which is what expirations are.
const nyDate = (now) => { const z = zoned(now, 'America/New_York'); return `${z.year}-${z.month}-${z.day}`; };
// The regular session, 9:30 to 16:00 New York, on weekdays. There is no holiday calendar: on a holiday the quotes
// are the last session's and a check can't fill anything that day's quotes wouldn't have.
function marketOpen(now) {
  const z = zoned(now, 'America/New_York');
  const mins = Number(z.hour) * 60 + Number(z.minute);
  return !['Sat', 'Sun'].includes(z.weekday) && mins >= 9 * 60 + 30 && mins < 16 * 60;
}
// "2026-10-26_08-05" in Mountain time, the stamp download.js gives the OptionStrat exports.
const denverStamp = (now) => { const z = zoned(now, 'America/Denver'); return `${z.year}-${z.month}-${z.day}_${z.hour}-${z.minute}`; };
// "10/26/26 08:05" in Mountain time, the export's Created At form.
const denverShort = (iso) => { const z = zoned(new Date(iso), 'America/Denver'); return `${Number(z.month)}/${Number(z.day)}/${z.year.slice(2)} ${z.hour}:${z.minute}`; };

// ---- the ledger ----------------------------------------------------------------------------------

const emptyLedger = () => ({ schema: SCHEMA, nextId: 1, trades: [] });
const isOpen = (t) => !t.close;

// A spread to open: { symbol, side, expiration, shortStrike, longStrike, qty }. A message when it isn't a plain
// bull put or bear call, else null.
function checkSpec(s) {
  if (!/^[A-Z][A-Z0-9./]{0,9}$/.test(s.symbol || '')) return `not a symbol: ${s.symbol}`;
  if (s.side !== 'put' && s.side !== 'call') return `side is put or call, not ${s.side}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.expiration || '')) return `expiration is YYYY-MM-DD, not ${s.expiration}`;
  if (!(Number.isFinite(s.shortStrike) && Number.isFinite(s.longStrike) && s.shortStrike > 0 && s.longStrike > 0)) return 'strikes must be positive numbers';
  if (s.side === 'put' ? !(s.shortStrike > s.longStrike) : !(s.shortStrike < s.longStrike)) {
    return s.side === 'put' ? 'a bull put sells the higher strike' : 'a bear call sells the lower strike';
  }
  if (!(Number.isInteger(s.qty) && s.qty > 0)) return 'quantity is a whole number of contracts';
  return null;
}

const legsOf = (t) => ({ short: occSymbol(t.symbol, t.expiration, t.side, t.shortStrike), long: occSymbol(t.symbol, t.expiration, t.side, t.longStrike) });
const width = (t) => Math.abs(t.shortStrike - t.longStrike);
const mid = (q) => (q.bid + q.ask) / 2;
const usable = (q) => !!q && q.ask > 0 && q.bid >= 0 && q.ask >= q.bid;

// Both legs' quotes from a Map by OCC symbol, or null when either is missing or one-sided.
function quotesFor(t, quotes) {
  const l = legsOf(t), short = quotes.get(l.short), long = quotes.get(l.long);
  return usable(short) && usable(long) ? { short, long } : null;
}

// What opening pays, per share: the mid, the natural (sell at the bid, buy at the ask) and the paper fill,
// PAPER.fillShare of the way from one to the other, rounded down to the cent.
function openPrice(q) {
  const m = mid(q.short) - mid(q.long), natural = q.short.bid - q.long.ask;
  return { mid: m, natural, fill: floorCents(m - PAPER.fillShare * (m - natural)) };
}
// What closing costs, per share: the mid (the mark) and the natural (buy the short at the ask, sell the long at the bid).
const closePrice = (q) => ({ mid: mid(q.short) - mid(q.long), natural: q.short.ask - q.long.bid });
const quoteRecord = (q) => ({ short: { bid: q.short.bid, ask: q.short.ask }, long: { bid: q.long.bid, ask: q.long.ask } });

// Opens a paper trade in the ledger and returns it. Throws when the fill isn't a credit inside the width, or the
// ticket was already used (a ticket opens one trade, however often it is sent).
function openTrade(ledger, spec, q, at, ticket) {
  const bad = checkSpec(spec);
  if (bad) throw new Error(bad);
  if (ticket && ledger.trades.some((t) => t.ticket === ticket)) throw new Error(`ticket ${ticket} was already used`);
  const price = openPrice(q);
  if (!(price.fill > 0 && price.fill < width(spec))) throw new Error(`no credit to sell: the paper fill would be ${price.fill.toFixed(2)}`);
  const trade = {
    id: 'P' + ledger.nextId++, ...(ticket ? { ticket } : {}),
    symbol: spec.symbol, side: spec.side, expiration: spec.expiration, shortStrike: spec.shortStrike, longStrike: spec.longStrike, qty: spec.qty,
    openedAt: at, credit: price.fill, openMid: cents(price.mid), openNatural: cents(price.natural), openQuotes: quoteRecord(q),
    fees: PAPER.feePerContractOpen * 2 * spec.qty,
    target: { debit: cents(price.fill * (1 - PAPER.target / 100)) }, // the resting GTC buy-to-close
    close: null,
  };
  ledger.trades.push(trade);
  return trade;
}

function closeTrade(t, debit, at, reason, q) {
  t.close = { at, debit: cents(debit), reason, ...(q ? { quotes: quoteRecord(q) } : {}) };
  return t;
}

// The resting profit targets the quotes reach: a trade closes when buying it back at the natural price costs no
// more than its limit, and fills at the limit, as a resting order does. Only call it in the regular session:
// after the close the quotes are the last prices, not a market. Returns the trades closed.
function fillTargets(ledger, quotes, at) {
  const done = [];
  for (const t of ledger.trades.filter(isOpen)) {
    const q = quotesFor(t, quotes);
    if (q && closePrice(q).natural <= t.target.debit + 1e-9) done.push(closeTrade(t, t.target.debit, at, 'target', q));
  }
  return done;
}

// Trades past their expiration (the New York date today is later) close at what the spread is worth at the stock's
// price, between 0 and the width. Approximate: the price is today's, not the one at the expiration's close. Trades
// whose stock has no price wait. Returns the trades closed.
function expireTrades(ledger, spots, today, at) {
  const done = [];
  for (const t of ledger.trades.filter((x) => isOpen(x) && x.expiration < today)) {
    const spot = spots.get(t.symbol);
    if (!(spot > 0)) continue;
    const inside = t.side === 'put' ? t.shortStrike - spot : spot - t.shortStrike;
    done.push(closeTrade(t, Math.min(width(t), Math.max(0, inside)), at, 'expired'));
  }
  return done;
}

// The chance of finishing beyond the break-even at expiration, from the short leg's IV (lognormal, SIM.rate).
// Falls back to 1 − |short delta| without a stock price or an IV.
function chanceNow(t, q, spot, now) {
  const iv = q.short.iv;
  const days = Math.max(1, (Date.parse(t.expiration + 'T20:00:00Z') - now) / 864e5);
  if (!(spot > 0) || !(iv > 0)) return Math.max(0, Math.min(1, 1 - Math.abs(q.short.delta)));
  const be = t.side === 'put' ? t.shortStrike - t.credit : t.shortStrike + t.credit;
  const years = days / 365;
  const d2 = (Math.log(spot / be) + (SIM.rate - (iv * iv) / 2) * years) / (iv * Math.sqrt(years));
  return t.side === 'put' ? normalCdf(d2) : normalCdf(-d2);
}

// ---- the snapshot: open trades as the OptionStrat export's rows ----------------------------------------
// The same rows portfolio.js reads, so the paper report is the real report's page, history and exit plans.

const HEADER = [
  'Name,Total Return %,Total Return $,Created At,Expiration,Net Debit/Credit,Chance,Max Loss,Max Profit,High,Low,Delta,Theta,Gamma,Vega,Rho,IV,Link,Group',
  'Symbol,Quantity,Entry Price,Current Price,Close Price,,,,,,,,,,,,,,',
];
const dollars = (v) => (v < 0 ? `$(${Math.abs(v).toFixed(2)})` : `$${v.toFixed(2)}`);

// One open trade as an export row: entry credit and max loss from the fill, the mark at the mid, greeks from the
// legs' quotes ((bought − sold) × 100 × contracts, through SB.tryTrade, which also names it the way OptionStrat does).
function rowOf(t, q, spot, now) {
  const leg = (strike, x) => ({ strike, delta: x.delta, gamma: x.gamma, theta: x.theta, vega: x.vega, iv: x.iv });
  const r = SB.tryTrade({ symbol: t.symbol, side: t.side, expiration: t.expiration, qty: t.qty, credit: t.credit,
    popPct: chanceNow(t, q, spot, now) * 100, short: leg(t.shortStrike, q.short), long: leg(t.longStrike, q.long) });
  const debit = closePrice(q).mid;
  const ret = (t.credit - debit) * 100 * t.qty;
  const [y, m, d] = t.expiration.split('-');
  return [r.name, ((ret / r.maxProfit) * 100).toFixed(2) + '%', dollars(ret), denverShort(t.openedAt), `${Number(m)}/${Number(d)}/${y.slice(2)} 16:00`,
    dollars(r.credit), (r.chance * 100).toFixed(2) + '%', dollars(r.maxLoss), dollars(r.maxProfit), '', '',
    r.delta, r.theta, r.gamma, r.vega, 0, r.iv.toFixed(2) + '%', '', 'Paper'].join(',');
}

// The export CSV for the open trades: { csv, missing }. missing lists trades with no usable quotes; a snapshot
// must not be written then, because a spread left out reads as closed (CLAUDE.md, the episodes).
function snapshotCsv(ledger, quotes, spots, now) {
  const open = ledger.trades.filter(isOpen);
  const missing = open.filter((t) => !quotesFor(t, quotes)).map((t) => t.id);
  const rows = missing.length ? [] : open.map((t) => rowOf(t, quotesFor(t, quotes), spots.get(t.symbol), now));
  return { csv: [...HEADER, ...rows].join('\n') + '\n', missing, count: open.length };
}

// ---- stop alerts for equity-watch -----------------------------------------------------------------
// shared/paper-spread-alerts.json: the stops of the open paper trades, as spread-alerts.js builds them for the real
// book but marked paper (asPaper), so equity-watch watches them apart. Unlike the real book's, closes are known
// here: the ledger records them. So a paper book with nothing open writes an empty, complete file and every paper
// stop is cancelled, where the real book can only leave its stops until the next export.

const PAPER_REPORTS = path.join(__dirname, 'reports', 'paper');
const SHARED = path.join(__dirname, 'shared'); // fixed ./shared, never $SHARED_DIR (see fetch.sh)

// The alerts file for the newest paper snapshot in dir, its history from every paper snapshot there.
function paperAlertsFromReports(dir = PAPER_REPORTS) {
  const snaps = fs.readdirSync(dir).filter((f) => f.endsWith('-portfolio.json')).flatMap((f) => {
    try { return [JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))]; } catch (_) { return []; }
  });
  if (!snaps.length) return null;
  const snap = snaps.reduce((a, b) => (Date.parse(SB.takenAt(b)) > Date.parse(SB.takenAt(a)) ? b : a));
  const list = snap.positions.map((p) => SB.enrich({ ...p }, snap));
  return asPaper(buildSpreadAlerts(snap, list, SB.history(snaps).open));
}
const noPaperAlerts = (now) => ({ schema: ALERTS_SCHEMA, book: 'paper', generatedAt: new Date(now).toISOString(), spotsAsOf: null, source: 'paper ledger', complete: true, alerts: [], unpriced: [] });

function writePaperAlerts(doc) {
  const file = doc && writeSpreadAlerts(SHARED, doc, 'paper-spread-alerts.json');
  if (file) console.log(`Wrote → ${file} (${doc.alerts.length} paper stops)`);
}

// ---- files ----------------------------------------------------------------------------------------

// The ledger, or an empty one when there is no file yet. A file that doesn't parse is an error, never an empty
// ledger: that would lose every paper trade on the next write.
function loadLedger(file = LEDGER) {
  if (!fs.existsSync(file)) return emptyLedger();
  const l = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (l.schema !== SCHEMA || !Array.isArray(l.trades)) throw new Error(`${file} is not a paper ledger`);
  return l;
}
const saveLedger = (ledger, file = LEDGER) => writeFileAtomic(file, JSON.stringify(ledger, null, 2) + '\n');

// Runs fn holding data/paper/.lock, so two commands never write the ledger at once. A lock older than
// PAPER.lockStaleMs is from a crashed run and is taken over.
async function withLock(dir, fn) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.lock');
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); } catch (e) {
    if (e.code !== 'EEXIST' || Date.now() - fs.statSync(lock).mtimeMs < PAPER.lockStaleMs) throw new Error('another paper command is running (data/paper/.lock)');
    fs.writeFileSync(lock, String(process.pid));
  }
  try { return await fn(); } finally { fs.rmSync(lock, { force: true }); }
}

// ---- the command line -------------------------------------------------------------------------------

function client() {
  const c = credentialsFromEnv();
  if (!c) throw new Error('no tastytrade credentials: set TASTYTRADE_CLIENT_SECRET and TASTYTRADE_REFRESH_TOKEN (see README, Paper trades)');
  return new Tastytrade(c);
}
const legOccs = (trades) => trades.flatMap((t) => Object.values(legsOf(t)));
const pnl = (t) => (t.close ? (t.credit - t.close.debit) * 100 * t.qty - t.fees : null);
const describe = (t) => `${t.id} ${t.symbol} ${t.expiration} ${Math.min(t.shortStrike, t.longStrike)}/${Math.max(t.shortStrike, t.longStrike)} ${t.side === 'put' ? 'bull put' : 'bear call'} ×${t.qty}`;

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      if (['anytime'].includes(k)) opt[k] = true; else opt[k] = argv[++i];
    } else pos.push(argv[i]);
  }
  return { pos, opt };
}

// Fills targets (in the session) and expiries for every open trade, with fresh quotes. Returns the quotes and spots.
async function update(ledger, tt, now) {
  const open = ledger.trades.filter(isOpen);
  const quotes = open.length ? await tt.optionQuotes(legOccs(open)) : new Map();
  const spots = open.length ? await tt.equityQuotes(open.map((t) => t.symbol)) : new Map();
  const at = new Date(now).toISOString();
  const closed = [...(marketOpen(now) ? fillTargets(ledger, quotes, at) : []), ...expireTrades(ledger, spots, nyDate(now), at)];
  for (const t of closed) console.log(`Closed ${describe(t)} at ${t.close.debit.toFixed(2)} (${t.close.reason}), ${dollars(pnl(t))} after fees`);
  return { quotes, spots, changed: closed.length > 0 };
}

const COMMANDS = {
  async open({ pos, opt }) {
    const [symbol, side, expiration, short, long] = pos;
    const spec = { symbol: (symbol || '').toUpperCase(), side, expiration, shortStrike: Number(short), longStrike: Number(long), qty: opt.qty === undefined ? 1 : Number(opt.qty) };
    const bad = checkSpec(spec);
    if (bad) throw new Error(bad);
    const now = Date.now();
    if (!marketOpen(now) && !opt.anytime) throw new Error('the market is closed, so the quotes are not a market. Pass --anytime to open at them anyway.');
    const tt = client();
    await withLock(DIR, async () => {
      const ledger = loadLedger();
      const q = quotesFor(spec, await tt.optionQuotes(Object.values(legsOf(spec))));
      if (!q) throw new Error(`no two-sided quotes for both legs (${Object.values(legsOf(spec)).join(', ')}): check the expiration and strikes`);
      const t = openTrade(ledger, spec, q, new Date(now).toISOString(), opt.ticket);
      saveLedger(ledger);
      console.log(`Opened ${describe(t)} for ${t.credit.toFixed(2)} (mid ${t.openMid.toFixed(2)}, natural ${t.openNatural.toFixed(2)}). Target: buy back at ${t.target.debit.toFixed(2)}.`);
    });
  },

  async close({ pos, opt }) {
    const now = Date.now();
    await withLock(DIR, async () => {
      const ledger = loadLedger();
      const t = ledger.trades.find((x) => x.id === pos[0]);
      if (!t) throw new Error(`no paper trade ${pos[0]}`);
      if (!isOpen(t)) throw new Error(`${t.id} is already closed`);
      let debit = opt.debit === undefined ? null : Number(opt.debit), q = null;
      if (debit === null) {
        if (!marketOpen(now) && !opt.anytime) throw new Error('the market is closed. Pass --debit X to close at a price, or --anytime to use the last quotes.');
        q = quotesFor(t, await client().optionQuotes(Object.values(legsOf(t))));
        if (!q) throw new Error('no two-sided quotes for both legs');
        debit = closePrice(q).natural; // a market close pays the natural price
      }
      if (!(debit >= 0 && debit <= width(t))) throw new Error(`a debit is between 0 and the width, not ${debit}`);
      closeTrade(t, debit, new Date(now).toISOString(), 'manual', q);
      saveLedger(ledger);
      console.log(`Closed ${describe(t)} at ${t.close.debit.toFixed(2)}, ${dollars(pnl(t))} after fees`);
    });
  },

  async list() {
    const ledger = loadLedger();
    const open = ledger.trades.filter(isOpen), closed = ledger.trades.filter((t) => !isOpen(t));
    console.log(open.length ? 'Open:' : 'No open paper trades.');
    for (const t of open) console.log(`  ${describe(t)}  credit ${t.credit.toFixed(2)}, target ${t.target.debit.toFixed(2)}, opened ${nyDate(new Date(t.openedAt))}`);
    if (closed.length) {
      console.log('Closed:');
      for (const t of closed) console.log(`  ${describe(t)}  ${t.credit.toFixed(2)} → ${t.close.debit.toFixed(2)} (${t.close.reason}) ${dollars(pnl(t))}`);
      console.log(`Closed P&L after fees: ${dollars(closed.reduce((s, t) => s + pnl(t), 0))}`);
    }
  },

  async check() {
    if (!loadLedger().trades.some(isOpen)) return; // nothing to watch: no API call
    const now = Date.now(), tt = client();
    await withLock(DIR, async () => {
      const ledger = loadLedger();
      if ((await update(ledger, tt, now)).changed) saveLedger(ledger);
    });
  },

  async snapshot() {
    const before = loadLedger();
    if (!before.trades.some(isOpen)) {
      console.log('No open paper trades: no paper snapshot.');
      if (before.trades.length) writePaperAlerts(noPaperAlerts(Date.now())); // all closed: cancel their stops
      return;
    }
    const now = Date.now(), tt = client();
    const csvFile = await withLock(DIR, async () => {
      const ledger = loadLedger();
      const { quotes, spots, changed } = await update(ledger, tt, now);
      if (changed) saveLedger(ledger);
      const snap = snapshotCsv(ledger, quotes, spots, now);
      if (!snap.count) {
        console.log('Every paper trade is closed: no paper snapshot.');
        writePaperAlerts(noPaperAlerts(now));
        return null;
      }
      if (snap.missing.length) throw new Error(`no quotes for ${snap.missing.join(', ')}, so no snapshot (one left out would read as closed)`);
      const file = path.join(DIR, `paper-${denverStamp(new Date(now))}.csv`);
      writeFileAtomic(file, snap.csv);
      console.log(`Wrote → ${file} (${snap.count} open)`);
      return file;
    });
    if (!csvFile) return;
    const r = spawnSync(process.execPath, [path.join(__dirname, 'portfolio.js'), csvFile, '--paper'], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('portfolio.js failed on the paper snapshot');
    writePaperAlerts(paperAlertsFromReports());
  },
};

module.exports = { PAPER, SCHEMA, emptyLedger, checkSpec, legsOf, quotesFor, openPrice, closePrice, openTrade, closeTrade, fillTargets, expireTrades,
  chanceNow, rowOf, snapshotCsv, paperAlertsFromReports, noPaperAlerts, loadLedger, saveLedger, withLock, marketOpen, nyDate, denverStamp, denverShort, pnl };

if (require.main === module) {
  // A local run reads .env like download.js does; in the container compose passes it in. Set variables win.
  try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (_) { /* no .env */ }
  const args = parseArgs(process.argv.slice(2));
  const cmd = COMMANDS[args.pos.shift()];
  if (!cmd) {
    console.error(fs.readFileSync(__filename, 'utf8').split('\n').slice(4, 9).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(1);
  }
  cmd(args).catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
