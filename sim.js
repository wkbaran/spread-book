// The exit plan and the "from here" odds for each open spread, worked out when portfolio.js writes a snapshot.
//
// Node only: the report page reads the stored results and never runs this. The pricing and the path simulation
// are a port of spread-scanner's src/outcome.ts (the same Black-Scholes, seed, antithetic draws and trading
// calendar), so the two tools agree; test/sim.test.js checks the port against the scanner when it is checked
// out next to this repo. Change one, change the other.
//
// What the export gives us is thin, so the model is too: one IV for the whole position stands in for both legs,
// the rate is flat, there are no dividends, and the stock price is Yahoo's, fetched after the positions.

const { RULES, enrich, takenAt } = require('./book');

const SIM = {
  paths: 800, // simulated stock paths, in antithetic pairs
  intraday: 3, // price steps per trading day; the profit target is checked at each, the stop only at the close
  seed: 20261023, // spread-scanner's: every spread is run on the same paths, so a rerun gives the same numbers
  rate: 0.04, // flat risk-free rate
  // Implied volatility drifts down as a position ages (it rolls down an upward-sloping term structure). Calibrated,
  // not derived: in spread-scanner, a fall of this share of the IV between entry and the 21-day exit reproduced
  // the owner's record of closed spreads, where flat IV reached the profit target far less often than real trades
  // did. decayDays is the entry-to-exit span that fall was spread over. Here it runs at that daily rate from the snapshot, capped at the
  // same total. One record fitted with one parameter: a base rate, not a forecast.
  ivDecay: 0.35,
  decayDays: 18,
  // The export has no bid or ask, so every fill that crosses the market (a stop, the time exit, closing now)
  // pays this much per share of the spread. A resting profit order fills at its price.
  exitCost: 0.03,
  ladder: [15, 25, 35, 50], // loss levels, as % of max loss, for the "if it were here" table
};

const DAYS_IN_YEAR = 365;

// ---- pricing (ported from spread-scanner's outcome.ts) -------------------------------------------------------

// Standard normal CDF, Abramowitz and Stegun 26.2.17 (absolute error under 1e-7).
function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = 0.3989422804014327 * Math.exp((-x * x) / 2) * poly;
  return x >= 0 ? 1 - tail : tail;
}

// Black-Scholes price of a European option on a stock paying no dividend. side is 'put' or 'call'.
function blackScholes(side, spot, strike, sigma, years, rate) {
  if (years <= 0) return Math.max(0, side === 'call' ? spot - strike : strike - spot);
  const sd = sigma * Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (rate + (sigma * sigma) / 2) * years) / sd;
  const d2 = d1 - sd;
  const discount = Math.exp(-rate * years);
  return side === 'call' ? spot * normalCdf(d1) - strike * discount * normalCdf(d2) : strike * discount * normalCdf(-d2) - spot * normalCdf(-d1);
}

// Black-Scholes delta of one option, per share: 0 to 1 for a call, -1 to 0 for a put.
function bsDelta(side, spot, strike, sigma, years, rate) {
  if (years <= 0) return side === 'call' ? (spot > strike ? 1 : 0) : spot < strike ? -1 : 0;
  const d1 = (Math.log(spot / strike) + (rate + (sigma * sigma) / 2) * years) / (sigma * Math.sqrt(years));
  return side === 'call' ? normalCdf(d1) : normalCdf(d1) - 1;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// paths rows of steps standard normals, in antithetic pairs (the second of a pair is the mirror of the first).
function drawNormals(paths, steps, seed = SIM.seed) {
  const next = mulberry32(seed);
  const rows = [];
  for (let p = 0; p < paths; p += 2) {
    const row = new Float64Array(steps);
    for (let i = 0; i < steps; i += 2) {
      const r = Math.sqrt(-2 * Math.log(1 - next()));
      const angle = 2 * Math.PI * next();
      row[i] = r * Math.cos(angle);
      if (i + 1 < steps) row[i + 1] = r * Math.sin(angle);
    }
    rows.push(row, row.map((z) => -z));
  }
  return rows.slice(0, paths);
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// The weekdays after today up to and including last, each with the calendar days since the previous one.
function tradingSchedule(today, last) {
  const out = [];
  let elapsed = 0;
  for (let date = addDays(today, 1); date <= last; date = addDays(date, 1)) {
    elapsed += 1;
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    out.push({ date, gapDays: elapsed - (out.length ? out[out.length - 1].elapsedDays : 0), elapsedDays: elapsed });
  }
  return out;
}

// Walks every path through the schedule. At each step decide(spot, daysLeft, atClose, last) returns null to keep
// holding or the per-share result of leaving; on the schedule's last close it must leave.
function walk({ spot: start, sigma, rate, dte, schedule, intraday, paths, normals }, decide) {
  const pnl = new Float64Array(paths);
  const reason = new Array(paths);
  for (let p = 0; p < paths; p++) {
    const z = normals[p];
    let spot = start, step = 0, out = null;
    for (let d = 0; d < schedule.length && out === null; d++) {
      const day = schedule[d];
      const before = day.elapsedDays - day.gapDays;
      for (let k = 1; k <= intraday; k++) {
        const dt = day.gapDays / intraday / DAYS_IN_YEAR;
        spot *= Math.exp((rate - (sigma * sigma) / 2) * dt + sigma * Math.sqrt(dt) * z[step++]);
        const daysLeft = dte - (before + (day.gapDays * k) / intraday);
        out = decide(spot, daysLeft, k === intraday, k === intraday && d === schedule.length - 1);
        if (out !== null) break;
      }
    }
    if (out === null) out = decide(start, dte, true, true); // an empty schedule leaves at once
    pnl[p] = out.pnl;
    reason[p] = out.reason;
  }
  return { pnl, reason };
}

// spread-scanner's simulateManaged, unchanged in what it computes: the managed outcome of a new spread from its
// quotes. Kept so the cross-check test can compare the port against the original; fromHere below is the version
// that starts from an open position. input and cfg have the scanner's field names; percentages out, as there.
function simulateManaged(input, cfg, normals) {
  const width = Math.abs(input.shortStrike - input.longStrike);
  const half = cfg.fillShare * (input.creditMid - input.creditNatural);
  const credit = input.creditMid - half;
  const exitCost = half;
  const maxLoss = width - credit;
  const target = (1 - cfg.takeProfit) * credit;
  const stopLevel = credit + cfg.stopLoss * maxLoss;
  const schedule = tradingSchedule(input.today, addDays(input.expiration, -cfg.exitDte));
  const horizonDays = Math.max(1, input.dte - cfg.exitDte);
  const model = (spot, daysLeft) => {
    const years = Math.max(daysLeft, 0) / DAYS_IN_YEAR;
    const shrink = 1 - cfg.ivDecay * Math.min(1, Math.max(0, input.dte - daysLeft) / horizonDays);
    return blackScholes(input.side, spot, input.shortStrike, input.shortIv * shrink, years, input.rate) -
      blackScholes(input.side, spot, input.longStrike, input.longIv * shrink, years, input.rate);
  };
  const start = model(input.spot, input.dte);
  const debitAt = (spot, daysLeft) => Math.min(width, Math.max(0, input.creditMid + (model(spot, daysLeft) - start) + exitCost));
  const { pnl, reason } = walk(
    { spot: input.spot, sigma: input.pathSigma, rate: input.rate, dte: input.dte, schedule, intraday: cfg.intraday, paths: cfg.paths, normals },
    (spot, daysLeft, atClose, last) => {
      const debit = debitAt(spot, daysLeft);
      if (debit <= target) return { pnl: cfg.takeProfit * credit, reason: 'target' };
      if (atClose && debit >= stopLevel) return { pnl: credit - debit, reason: 'stop' };
      return last ? { pnl: credit - debit, reason: 'time' } : null;
    });
  // An empty schedule: the scanner prices the exit at the start without checking the target or stop.
  if (!schedule.length) pnl.fill(credit - debitAt(input.spot, input.dte)), reason.fill('time');
  const n = cfg.paths;
  let wins = 0, losses = 0, winSum = 0, lossSum = 0;
  for (const v of pnl) { if (v > 0) { wins++; winSum += v; } else { losses++; lossSum += -v; } }
  const share = (r) => (reason.filter((x) => x === r).length / n) * 100;
  const avgWin = wins === 0 ? 0 : (winSum / wins) * 100;
  const avgLoss = losses === 0 ? 0 : (lossSum / losses) * 100;
  const breakEven = avgWin + avgLoss === 0 ? 0 : (avgLoss / (avgWin + avgLoss)) * 100;
  const winRate = (wins / n) * 100;
  return { winRate, pTarget: share('target'), pStop: share('stop'), pTime: share('time'), avgWin, avgLoss,
    ev: ((winSum - lossSum) / n) * 100, breakEvenWinRate: breakEven, edge: winRate - breakEven };
}

// ---- an open position ----------------------------------------------------------------------------------------

// What the model needs from an enriched position (book.js enrich) and the stock's price, all per share of the
// spread: null unless it is a plain put or call spread with a price, an IV and a day or more left.
function positionOf(p, spot) {
  if (p.kind !== 'put' && p.kind !== 'call') return null;
  if (!(spot > 0) || !(p.iv > 0) || !(p.width > 0) || !(p.dte >= 1) || p.shortStrike === null) return null;
  const legs = p.strikes.split('/').map(Number);
  const q = (p.maxProfit + p.maxLoss) / (p.width * 100); // contracts: the export doesn't say
  if (!(q > 0)) return null;
  const credit = p.maxProfit / (100 * q); // returnPct is relative to max profit, so this is the credit it counts from
  return {
    side: p.kind, spot, q, dte: p.dte, iv: p.iv / 100, width: p.width, credit, maxLoss: p.maxLoss / (100 * q),
    shortStrike: p.shortStrike, longStrike: p.kind === 'put' ? Math.min(...legs) : Math.max(...legs),
    debit: credit - (p.returnPct / 100) * p.maxProfit / (100 * q), // what buying it back costs at the mark
  };
}

// The spread's mark at a stock price and days left, per share. Black-Scholes for both legs at the position's IV
// (shrunk by ivDecay for the days elapsed), moved so that it equals today's actual mark at today's price. The
// difference between model and market (mostly skew: the two legs don't really share one IV) is carried forward
// and shrinks with √(days left), as vega does, to nothing at expiration, where both are intrinsic value. A
// linear fade would add a steady drift toward or against holding whenever the gap is large.
function markModel(pos, cfg = SIM) {
  const value = (spot, daysLeft) => {
    const years = Math.max(daysLeft, 0) / DAYS_IN_YEAR;
    const elapsed = Math.max(0, pos.dte - daysLeft);
    const sigma = pos.iv * (1 - Math.min(cfg.ivDecay, (cfg.ivDecay * elapsed) / cfg.decayDays));
    return blackScholes(pos.side, spot, pos.shortStrike, sigma, years, cfg.rate) - blackScholes(pos.side, spot, pos.longStrike, sigma, years, cfg.rate);
  };
  const offset = pos.debit - value(pos.spot, pos.dte);
  const mark = (spot, daysLeft) => Math.min(pos.width, Math.max(0, value(spot, daysLeft) + offset * Math.sqrt(Math.max(daysLeft, 0) / pos.dte)));
  mark.gap = offset;
  return mark;
}

// The stock price at which the spread's mark today would be debit, by bisection (the mark rises as the stock
// moves toward the short strike). null when no price gets it there today: a profit target that only time decay
// can reach, or a loss deeper than the spread can show this far from expiration.
function spotForDebit(pos, debit, cfg = SIM) {
  const mark = markModel(pos, cfg);
  const at = (s) => mark(s, pos.dte) - debit; // rises toward the strike
  let safe = pos.spot, risky = pos.spot; // safe side has the lower mark
  const out = pos.side === 'put' ? 1.25 : 0.8;
  for (let i = 0; i < 40 && at(safe) > 0; i++) safe *= out;
  for (let i = 0; i < 40 && at(risky) < 0; i++) risky /= out;
  if (at(safe) > 0 || at(risky) < 0) return null;
  for (let i = 0; i < 100 && Math.abs(safe - risky) > 1e-6 * pos.spot; i++) {
    const mid = (safe + risky) / 2;
    if (at(mid) > 0) risky = mid; else safe = mid;
  }
  return (safe + risky) / 2;
}

const shortDelta = (pos, spot) => Math.abs(bsDelta(pos.side, spot, pos.shortStrike, pos.iv, pos.dte / DAYS_IN_YEAR, SIM.rate));
const r2 = (v) => (v === null ? null : Math.round(v * 100) / 100);
const r1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

// The exit stated three ways before it is needed, as of the snapshot: the spread's price (per share, what the
// broker quotes), the stock price that would put it there today, and the short leg's delta at that stock price.
// Loss levels follow RULES.stop and RULES.watch, the profit level RULES.target. Stock prices drift as days pass,
// since time decay moves the spread's price at a fixed stock price; the spread's own price is the rule.
function exitPlan(p, spot) {
  const pos = positionOf(p, spot);
  if (!pos) return null;
  const level = (debit) => {
    const s = spotForDebit(pos, debit);
    return { debit: r2(debit), spot: r2(s), shortDelta: s === null ? null : r2(shortDelta(pos, s)) };
  };
  const loss = (pct) => ({ ...level(pos.credit + (pct / 100) * pos.maxLoss), pnl: r2(-(pct / 100) * pos.maxLoss * 100 * pos.q) });
  const t = level(pos.credit * (1 - RULES.target / 100));
  return {
    debitNow: r2(pos.debit), spot: r2(spot), shortDeltaNow: r2(shortDelta(pos, spot)), contracts: r2(pos.q),
    modelGap: r2(markModel(pos).gap), // mark minus the model's price today; large means the model fits this spread badly
    pastShortStrike: pos.side === 'put' ? spot < pos.shortStrike : spot > pos.shortStrike,
    stop: loss(RULES.stop),
    watch: loss(RULES.watch),
    target: { ...t, pnl: r2((RULES.target / 100) * pos.credit * 100 * pos.q) },
  };
}

// The last day a "from here" run can hold: the roll-window exit, or expiration for a spread already inside the
// window (holding it is what not rolling means), and never before the next trading day.
function lastDay(today, expiration, dte) {
  let last = dte > RULES.rollDays ? addDays(expiration, -RULES.rollDays) : expiration;
  while (!tradingSchedule(today, last).length && last < expiration) last = addDays(last, 1);
  return last;
}

// What holding from a starting stock price does, over cfg.paths runs: a resting order at the profit target
// (RULES.target), a hard stop when the loss reaches RULES.hardStop of max loss at a close, otherwise out at
// lastDay. The stock is drawn at the position's IV (no edge assumed). Results are % of max loss, signed (a
// gain is positive), and dollars for the whole position.
function holdFrom(pos, spot, schedule, normals, cfg = SIM) {
  const mark = markModel(pos, cfg);
  const target = pos.credit * (1 - RULES.target / 100);
  const hard = pos.credit + (RULES.hardStop / 100) * pos.maxLoss;
  const { pnl, reason } = walk(
    { spot, sigma: pos.iv, rate: cfg.rate, dte: pos.dte, schedule, intraday: cfg.intraday, paths: cfg.paths, normals },
    (s, daysLeft, atClose, last) => {
      const m = mark(s, daysLeft);
      if (m + cfg.exitCost <= target) return { pnl: pos.credit - target, reason: 'target' }; // its price, however the stock got there
      if (atClose && m >= hard) return { pnl: pos.credit - Math.min(pos.width, m + cfg.exitCost), reason: 'hardStop' }; // a market order after the close
      return last ? { pnl: pos.credit - Math.min(pos.width, m + cfg.exitCost), reason: 'time' } : null;
    });
  const n = cfg.paths;
  const share = (f) => r1((pnl.filter(f).length / n) * 100);
  const why = (r) => r1((reason.filter((x) => x === r).length / n) * 100);
  const pct = (v) => (v / pos.maxLoss) * 100;
  const sorted = [...pnl].sort((a, b) => a - b);
  const worst = sorted.slice(0, Math.max(1, Math.round(n * 0.05)));
  const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
  return {
    pProfit: share((v) => v > 0), pTarget: why('target'), pHardStop: why('hardStop'), pTime: why('time'),
    avgResultPct: r1(pct(mean(pnl))), avgResult: r2(mean(pnl) * 100 * pos.q),
    pLossPastHalf: share((v) => -v >= 0.5 * pos.maxLoss), worst5Pct: r1(pct(mean(worst))),
  };
}

// The "from here" numbers for one position: holding from today's price (fromHere, beside what closing now
// gets), and the same spread run from the stock price at which each SIM.ladder loss would show today
// (recovery). null when the model can't price it (see positionOf). today is the snapshot's Mountain date.
function fromHere(p, spot, today, normals, cfg = SIM) {
  const pos = positionOf(p, spot);
  if (!pos) return null;
  const schedule = tradingSchedule(today, lastDay(today, p.expiration, p.dte));
  const exitNow = pos.credit - Math.min(pos.width, pos.debit + cfg.exitCost);
  const here = holdFrom(pos, spot, schedule, normals, cfg);
  const recovery = cfg.ladder.map((pct) => {
    const s = spotForDebit(pos, pos.credit + (pct / 100) * pos.maxLoss, cfg);
    if (s === null) return { lossPct: pct, spot: null };
    const { pProfit, pTarget, pHardStop, avgResultPct } = holdFrom(pos, s, schedule, normals, cfg); // same mark curve, another start
    return { lossPct: pct, spot: r2(s), pProfit, pTarget, pHardStop, avgResultPct };
  });
  return {
    fromHere: { ...here, until: schedule.length ? schedule[schedule.length - 1].date : today,
      exitNowPct: r1((exitNow / pos.maxLoss) * 100), exitNow: r2(exitNow * 100 * pos.q) },
    recovery,
  };
}

// Adds plan, fromHere and recovery to each position of a snapshot in place, and the simulation's settings as
// snap.sim, so a reader knows what the stored numbers assumed. Positions the model can't price get null.
function annotate(snap, cfg = SIM) {
  const today = new Date(takenAt(snap)).toLocaleDateString('sv', { timeZone: 'America/Denver' });
  const list = snap.positions.map((raw) => ({ raw, p: enrich({ ...raw }, snap) }));
  const days = list.map(({ p }) => (p.expiration > today ? tradingSchedule(today, lastDay(today, p.expiration, p.dte)).length : 0));
  const normals = drawNormals(cfg.paths, Math.max(1, ...days) * cfg.intraday, cfg.seed);
  for (const { raw, p } of list) {
    const spot = snap.spots && snap.spots[p.underlying];
    raw.plan = exitPlan(p, spot);
    const f = fromHere(p, spot, today, normals, cfg);
    raw.fromHere = f ? f.fromHere : null;
    raw.recovery = f ? f.recovery : null;
  }
  snap.sim = { paths: cfg.paths, intraday: cfg.intraday, rate: cfg.rate, ivDecay: cfg.ivDecay, decayDays: cfg.decayDays,
    exitCost: cfg.exitCost, hardStopPctOfMaxLoss: RULES.hardStop, stopChecked: 'close' };
  return snap;
}

module.exports = { SIM, normalCdf, blackScholes, bsDelta, drawNormals, tradingSchedule, addDays, walk, simulateManaged,
  positionOf, markModel, spotForDebit, exitPlan, lastDay, holdFrom, fromHere, annotate };
