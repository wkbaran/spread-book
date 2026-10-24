#!/usr/bin/env node
// Writes the agent-readable brief for the newest portfolio snapshot:
// reports/<base>-brief.json, copied to reports/latest.json.
//
// Usage: node brief.js [<base>-portfolio.json]
// Without an argument it uses the newest *-portfolio.json in reports/. The
// matching <base>-pnl.json from daily-pnl.js is folded in when it exists.

const fs   = require('fs');
const path = require('path');
const { RULES, takenAt, enrich, tagCondors, decide, spreadKey, history } = require('./book');
const { buildSpreadAlerts, writeSpreadAlerts } = require('./spread-alerts');

const reportsDir = path.join(__dirname, 'reports');

function newestSnapshot() {
  const files = fs.readdirSync(reportsDir).filter(f => f.endsWith('-portfolio.json')).sort();
  if (!files.length) { console.error('No *-portfolio.json snapshots in reports/'); process.exit(1); }
  return path.join(reportsDir, files[files.length - 1]);
}

const snapFile = process.argv[2] || newestSnapshot();
const base     = path.basename(snapFile).replace(/-portfolio\.json$/, '');
const snap     = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
const pnlFile  = path.join(path.dirname(snapFile), base + '-pnl.json');
const pnl      = fs.existsSync(pnlFile) ? JSON.parse(fs.readFileSync(pnlFile, 'utf8')) : null;

const list = snap.positions.map(p => enrich({ ...p }, snap));
tagCondors(list);
const lists = decide(list);

// Every earlier snapshot in the same folder, up to this one, for each spread's entry and the closed list.
// A snapshot that won't parse is skipped: losing a little history is better than no brief.
function earlierSnapshots() {
  const here = path.resolve(snapFile), now = Date.parse(takenAt(snap)), out = [];
  for (const f of fs.readdirSync(path.dirname(snapFile)).filter(f => f.endsWith('-portfolio.json'))) {
    if (path.resolve(path.dirname(snapFile), f) === here) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(path.dirname(snapFile), f), 'utf8'));
      if (Date.parse(takenAt(s)) < now) out.push(s);
    } catch (e) { console.warn(`WARN: skipping ${f} in the history: ${e.message}`); }
  }
  return out;
}
const { open, closed } = history([...earlierSnapshots(), snap]);

const round = (v, dp = 2) => v === null || v === undefined ? null : Math.round(v * 10 ** dp) / 10 ** dp;
const sum   = (ps, k) => ps.reduce((s, p) => s + p[k], 0);
const GREEKS = ['theta', 'delta', 'gamma', 'vega'];
const greeks = ps => Object.fromEntries(GREEKS.map(k => [k, round(sum(ps, k), 3)]));

const entry = e => !e || !e.known ? { known: false } : {
  known:              true,
  firstSeenAt:        e.firstSeenAt,
  pop:                round(e.pop, 3),
  iv:                 round(e.iv, 1),
  dte:                e.dte,
  credit:             round(e.credit),
  maxLoss:            round(e.maxLoss),
  sigmaToShortStrike: round(e.z, 2),
  spot:               round(e.spot),
  creditToWidthPct:   round(e.creditToWidthPct, 1),
};

// Which run of a spread this is (1 for the first); episodeBreak says why a later one began.
const episode = e => ({
  episode:      e ? e.episode : 1,
  reopened:     e ? e.episode > 1 : false,
  episodeBreak: e ? e.episodeBreak : null,
});

const position = p => ({
  name:            p.name,
  underlying:      p.underlying,
  kind:            p.kind,
  strikes:         p.strikes,
  expiration:      p.expiration,
  dte:             p.dte,
  ironCondorLeg:   p.condor,
  returnPct:       round(p.returnPct, 1),
  lossOfMaxPct:    round(p.lossOfMax, 1),
  progressPct:     round(p.toward * 100, 0),
  exit:            p.exit || null,
  shortStrike:     p.shortStrike,
  sigmaToShortStrike: round(p.z, 2),
  nearShortStrike: p.nearStrike,
  pop:             round(p.chance, 3),
  popPct:          round(p.popPct, 1),
  width:           p.width,
  creditToWidthPct: round(p.creditToWidthPct, 1),
  profitOfRiskPct: round(p.profitOfRiskPct, 1),
  entry:           entry(open.get(spreadKey(p))?.entry),
  ...episode(open.get(spreadKey(p))),
  credit:          round(p.credit),
  maxProfit:       round(p.maxProfit),
  maxLoss:         round(p.maxLoss),
  ev:              round(p.ev),
  theta:           round(p.theta, 3),
  delta:           round(p.delta, 3),
  beta:            round(p.beta, 2),
  betaWeightedDelta: round(p.bwDelta, 2),
  gamma:           round(p.gamma, 4),
  vega:            round(p.vega, 3),
  iv:              round(p.iv, 1),
  thetaPerGamma:   round(p.tg),
  thetaPerVega:    round(p.tv),
  plan:            p.plan ?? null,
  fromHere:        p.fromHere ?? null,
  recovery:        p.recovery ?? null,
});

// Book greeks grouped by a key, largest theta first, with each group's share of the book's theta.
function concentration(keyOf, extra = () => ({})) {
  const totalTheta = sum(list, 'theta');
  const groups = new Map();
  for (const p of list) {
    const k = keyOf(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  return [...groups.entries()]
    .map(([k, ps]) => ({ key: k, ...extra(ps), positions: ps.length, ...greeks(ps),
      thetaSharePct: totalTheta ? round(sum(ps, 'theta') / totalTheta * 100, 1) : null }))
    .sort((a, b) => Math.abs(b.theta) - Math.abs(a.theta));
}

// Informational: spreads whose short strike is within RULES.strikeSigma expected moves, closest first.
const watch = list.filter(p => p.nearStrike).sort((a, b) => a.z - b.z);

const haveBw = list.filter(p => p.bwDelta !== null);

const KINDS = ['put', 'call', 'other'];
const ofKind = k => list.filter(p => p.kind === k);
const byKind = f => Object.fromEntries(KINDS.map(k => [k, f(ofKind(k))]));

const closest = [...list].filter(p => !p.exit).sort((a, b) => b.toward - a.toward);

const brief = {
  schema:      'spread-book/brief@1',
  generatedAt: takenAt(snap),
  source:      snap.source,
  about:       'Open credit spreads on OptionStrat, analysed against fixed exit rules. Positions are pulled at about 7:45 AM and 1:25 PM America/Denver on weekdays and the report is published at about 8:10 AM and 2:10 PM. Paths are relative to this file. Not investment advice; confirm with the broker before acting.',
  links: {
    report:    base + '-portfolio.html',
    positions: base + '-portfolio.json',
    pnl:       pnl ? base + '-pnl.json' : null,
    snapshots: 'snapshots.json',
  },
  rules: {
    closeAtPctOfMaxProfit: RULES.target,
    stopAtPctOfMaxLoss:    RULES.stop,
    watchAtPctOfMaxLoss:   RULES.watch,
    hardStopAtPctOfMaxLoss: RULES.hardStop,
    rollWindowDays:        RULES.rollDays,
    gettingClosePct:       RULES.near * 100,
    warnWithinSigmaOfShortStrike: RULES.strikeSigma,
    closedLookbackDays:    RULES.closedDays,
    betaMaxAgeDays:        RULES.betaMaxAgeDays,
  },
  glossary: {
    returnPct:     'Current gain or loss as a percentage of max profit, from OptionStrat.',
    lossOfMaxPct:  'For a losing spread, the loss as a percentage of max loss. 0 when winning. Compared against stopAtPctOfMaxLoss.',
    progressPct:   'How far toward an exit: +100 is the close target, -100 is the stop, 0 is breakeven.',
    readyToClose:  'At or past the close target.',
    atStop:        'The loss has reached the stop.',
    inRollWindow:  'No exit hit, but rollWindowDays or fewer to expiration: close or roll before gamma speeds up.',
    gettingClose:  'Outside the roll window and at least gettingClosePct of the way to either exit.',
    sigmaToShortStrike: 'Expected moves between the underlying and the short strike: (price − short strike) ÷ (price × IV × √(days ÷ 365)) for a put spread, the reverse for a call spread. Negative means the strike is already breached. null when Yahoo had no price.',
    nearShortStrike:    'sigmaToShortStrike is below warnWithinSigmaOfShortStrike. A heads-up only: it is not an exit rule and no decision list uses it.',
    theta:         'Dollars per day from time decay.',
    delta:         'Net direction. Positive gains if the underlying rises.',
    betaWeightedDelta: 'delta × beta × (underlying price ÷ SPY price): the number of SPY shares the position behaves like. Beta is Schwab\'s, passed on by equity-watch. null when the underlying has no beta, or the betas are more than betaMaxAgeDays older than the snapshot. totals.betaWeightedDelta adds up only the positions that have one (see totals.betaCoverage).',
    gamma:         'How quickly delta turns against the position in a big move. Negative for credit spreads.',
    vega:          'Dollars per one-point rise in implied volatility.',
    pop:           'OptionStrat probability of keeping the full credit, 0 to 1. A current value, not the value at entry: read entry.pop for that.',
    popPct:        'pop × 100.',
    ev:            'pop × maxProfit − (1 − pop) × maxLoss. All-or-nothing, so usually negative; compare, do not act on alone. A current value, not the value at entry; entry has no ev.',
    width:         'Dollar distance between the two strikes. null unless both are plain numbers in the spread name.',
    creditToWidthPct: 'Credit as a percentage of the width, per contract: credit ÷ (maxProfit + maxLoss) × 100, which is credit ÷ (width × 100) for one contract and stays right for more. null for a spread that is neither a put nor a call spread, whose "credit" may be a debit.',
    profitOfRiskPct:  'maxProfit ÷ maxLoss × 100: what the spread can earn for each 100 it can lose.',
    entry:         'What the spread looked like in the first snapshot of its episode (firstSeenAt, so up to a few hours after it was opened): pop, iv, dte, credit, maxLoss, sigmaToShortStrike, spot and creditToWidthPct. { known: false } when it was already open in the oldest snapshot we hold, because its true entry is not on file. This is the only place to find entry numbers: pop, ev and every other field on a position are current.',
    episode:       'Which run of this spread it is, counting from 1. The same name, expiration and strikes is one spread until an episode break, and each episode is its own position with its own entry and, when it ends, its own closed record.',
    reopened:      'true when episode is above 1: the spread was closed and opened again, or resized.',
    episodeBreak:  'Why an episode above 1 began, null for episode 1. "gap": the spread was missing from at least one snapshot between two sightings. "resized": its credit or maxLoss changed by a cent or more since the last sighting, so a contract was added or it was reopened at another price (when both apply, "gap"). A snapshot file that could not be read counts as neither presence nor absence. Blind spot: a close and reopen at the same credit between two consecutive snapshots (1.6 to 66 hours apart, median 5.7) looks like nothing happened.',
    closed:        'Episodes that ended before this snapshot, closed within closedLookbackDays, newest first. A spread held as two saved trades counts once. openedAt, daysHeld and entry come from the first snapshot containing it (openedAt and daysHeld are null when entry.known is false). closedAt is the first snapshot without it. lastReturnPct is from the last snapshot with it, so approximate is always true: the real close, and the return at it, came somewhere between.',
    outcome:       'Judged on the last snapshot with the spread: target (returnPct at or past closeAtPctOfMaxProfit), else stop (loss at or past stopAtPctOfMaxLoss), else expired (dte 0 or less), else other. A spread that expired worthless counts as target when its last return was already 50 or more.',
    book:          'The whole book by kind: counts and maxLoss for put (Bull Put), call (Bear Call) and other spreads, netDelta, and betaWeightedDelta over the positions that have a beta (null when none do; betaCoverage says how many). Same figures as totals, regrouped.',
    spotsAsOf:     'When the Yahoo prices behind sigmaToShortStrike, underlyingSpot, plan, fromHere and recovery were fetched. They are fetched 25 to 45 minutes after the positions in generatedAt, so the distance is that stale. Prices of a re-published old snapshot are the time of the re-run. null for snapshots from before this was recorded, or when Yahoo returned nothing.',
    plan:          'The exit stated before it is needed, as of this snapshot, from sim.js. Prices are per share of the spread, as a broker quotes it. debitNow is the mark now (the credit less the P&L), spot the Yahoo price it used, shortDeltaNow the short leg\'s delta at that price. stop, watch and target each give the spread price (debit) at stopAtPctOfMaxLoss and watchAtPctOfMaxLoss of max loss and at closeAtPctOfMaxProfit, the P&L there in dollars for the whole position (pnl), the stock price that would put the spread there today (spot) and the short leg\'s delta at that price (shortDelta). The spread price is the rule; spot and shortDelta are the same level said other ways, and they drift as days pass, because time decay moves the spread at a fixed stock price. spot is null when no stock price gets the spread there today (a profit target only time can reach). The watch level is a heads-up, not an exit. pastShortStrike (the stock is beyond the short strike) is a warning, not an exit. contracts is derived, (maxProfit + maxLoss) ÷ (width × 100). modelGap is the mark less the model\'s price at today\'s stock price, per share: the model is moved by it so it matches the mark today, and a large one (tens of cents) means the model fits that spread badly. Black-Scholes with the position\'s one IV for both legs, so treat the stock prices as approximate. null for a spread that is not a plain put or call spread, or has no price or IV.',
    fromHere:      'Of simulation.paths simulated stock paths from today\'s price, what holding does: a resting order at closeAtPctOfMaxProfit, a hard stop when the loss reaches hardStopAtPctOfMaxLoss at a close, otherwise out on until (rollWindowDays before expiration, or expiration for a spread already inside that window). pProfit is the share of runs that end with a gain, pTarget, pHardStop and pTime how they end (adding to 100). avgResultPct is the average result as a percentage of max loss, signed (a gain is positive), avgResult the same in dollars; exitNowPct and exitNow are what closing at the mark now gets, less simulation.exitCost per share. pLossPastHalf is the share of runs that lose half of max loss or more, worst5Pct the average of the worst 5% of runs. A model calibrated to one trading record, not a forecast: the stock is drawn at the position\'s IV, so a fairly priced spread has no edge and holding is roughly a fair bet against closing now, with a worse tail. null when the model cannot price the spread (see plan).',
    recovery:      'The same simulation as fromHere, started from the stock price at which the spread would show each loss level today (lossPct, as a percentage of max loss; spot is that price, null when the spread cannot get there today, and then the other fields are missing). It shows how the odds fall as a loss deepens, which is what waiting past the stop costs. null when fromHere is.',
    simulation:    'What the plan, fromHere and recovery numbers assumed: paths, steps per trading day (intraday), a flat rate, ivDecay (the share the IV falls by over decayDays, at that daily rate from the snapshot and capped there; calibrated to one trading record, not derived), exitCost per share for fills that cross the market (the export has no bid or ask), the hard stop, and stopChecked: the stop is judged at each simulated close. null for snapshots written before these numbers were added.',
    thetaPerGamma: 'Theta earned per unit of gamma. Low values are most exposed to a sharp move.',
    thetaPerVega:  'Theta earned per unit of vega. Low values are most exposed to a volatility spike.',
  },
  spotsAsOf: snap.spotsAsOf ?? null,
  simulation: snap.sim ?? null,
  summary: {
    positions:    list.length,
    underlyings:  new Set(list.map(p => p.underlying)).size,
    readyToClose: lists.ready.length,
    atStop:       lists.stopped.length,
    inRollWindow: lists.soon.length,
    gettingClose: lists.near.length,
    nearShortStrike: watch.length,
    closestToTarget: closest[0] && closest[0].toward > 0 ? { name: closest[0].name, returnPct: round(closest[0].returnPct, 1) } : null,
    closestToStop:   closest.length && closest[closest.length - 1].toward < 0
      ? { name: closest[closest.length - 1].name, lossOfMaxPct: round(closest[closest.length - 1].lossOfMax, 1) } : null,
  },
  decisions: {
    readyToClose: lists.ready.map(position),
    atStop:       lists.stopped.map(position),
    inRollWindow: lists.soon.map(position),
    gettingClose: lists.near.map(position),
  },
  watch: {
    nearShortStrike: watch.map(position),
  },
  book: {
    counts:           { puts: ofKind('put').length, calls: ofKind('call').length, other: ofKind('other').length },
    maxLossTotal:     round(sum(list, 'maxLoss')),
    maxLossByKind:    byKind(ps => round(sum(ps, 'maxLoss'))),
    netDelta:         round(sum(list, 'delta'), 3),
    betaWeightedDelta: haveBw.length ? round(sum(haveBw, 'bwDelta'), 2) : null,
    betaCoverage:     { positions: haveBw.length, of: list.length },
  },
  totals: {
    ...greeks(list),
    betaWeightedDelta: haveBw.length ? round(sum(haveBw, 'bwDelta'), 2) : null,
    betaCoverage:      { positions: haveBw.length, of: list.length },
    betasAsOf:         snap.betasAsOf ?? null,
    credit:    round(sum(list, 'credit')),
    maxProfit: round(sum(list, 'maxProfit')),
    maxLoss:   round(sum(list, 'maxLoss')),
  },
  concentration: {
    byUnderlying: concentration(p => p.underlying, ps => ({
      maxLoss:        round(sum(ps, 'maxLoss')),
      kinds:          Object.fromEntries(KINDS.map(k => [k, ps.filter(p => p.kind === k).length])),
      expirations:    [...new Set(ps.map(p => p.expiration))].sort(),
      underlyingSpot: round(snap.spots && snap.spots[ps[0].underlying] > 0 ? snap.spots[ps[0].underlying] : null),
    })).map(({ key, ...g }) => ({ underlying: key, ...g })),
    byExpiration: concentration(p => p.expiration, ps => ({ dte: ps[0].dte }))
      .map(({ key, ...g }) => ({ expiration: key, ...g }))
      .sort((a, b) => a.expiration.localeCompare(b.expiration)),
  },
  pnl: pnl && { from: pnl.from, to: pnl.to, days: pnl.days, totals: pnl.totals, counts: pnl.counts,
    // The biggest movers either way; the full list is in links.pnl
    movers: pnl.positions.filter(p => p.pnl !== null).sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)).slice(0, 5)
      .map(p => ({ name: p.name, status: p.status, pnl: p.pnl, prevReturnPct: p.prevReturnPct, currReturnPct: p.currReturnPct })),
    closed: pnl.positions.filter(p => p.status === 'closed').map(p => p.name),
    opened: pnl.positions.filter(p => p.status === 'new').map(p => p.name) },
  closed: closed.map(c => ({
    name: c.name, underlying: c.underlying, kind: c.kind, openedAt: c.openedAt, closedAt: c.closedAt,
    daysHeld: round(c.daysHeld, 1), entry: entry(c.entry), ...episode(c), lastReturnPct: round(c.lastReturnPct, 1),
    outcome: c.outcome, approximate: c.approximate,
  })),
  positions: [...list].sort((a, b) => a.dte - b.dte || a.name.localeCompare(b.name)).map(position),
};

const out  = JSON.stringify(brief, null, 2);
const file = path.join(reportsDir, base + '-brief.json');
fs.mkdirSync(reportsDir, { recursive: true });
fs.writeFileSync(file, out);
fs.writeFileSync(path.join(reportsDir, 'latest.json'), out);
console.log(`Wrote → ${file} and reports/latest.json`);
// The stop alerts for equity-watch (spread-alerts.js), from the newest snapshot only: a brief for an old
// one must not move the live alerts back. Fixed ./shared, never $SHARED_DIR (see fetch.sh).
if (path.resolve(snapFile) === path.resolve(newestSnapshot())) {
  const doc = buildSpreadAlerts(snap, list, open);
  const written = writeSpreadAlerts(path.join(__dirname, 'shared'), doc);
  console.log(written
    ? `Wrote → ${written} (${doc.alerts.length} stop alerts, ${doc.unpriced.length} unpriced${doc.complete ? '' : ', marked incomplete'})`
    : 'No shared/ directory, so no stop alerts for equity-watch');
}
console.log(`Decisions: ${lists.ready.length} to close, ${lists.stopped.length} at the stop, ${lists.soon.length} in the roll window, ${lists.near.length} getting close`);
