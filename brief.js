#!/usr/bin/env node
// Writes the agent-readable brief for the newest portfolio snapshot:
// reports/<base>-brief.json, copied to reports/latest.json.
//
// Usage: node brief.js [<base>-portfolio.json]
// Without an argument it uses the newest *-portfolio.json in reports/. The
// matching <base>-pnl.json from daily-pnl.js is folded in when it exists.

const fs   = require('fs');
const path = require('path');
const { RULES, takenAt, enrich, tagCondors, decide } = require('./book');

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

const round = (v, dp = 2) => v === null || v === undefined ? null : Math.round(v * 10 ** dp) / 10 ** dp;
const sum   = (ps, k) => ps.reduce((s, p) => s + p[k], 0);
const GREEKS = ['theta', 'delta', 'gamma', 'vega'];
const greeks = ps => Object.fromEntries(GREEKS.map(k => [k, round(sum(ps, k), 3)]));

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
  pop:             round(p.chance, 3),
  credit:          round(p.credit),
  maxProfit:       round(p.maxProfit),
  maxLoss:         round(p.maxLoss),
  ev:              round(p.ev),
  theta:           round(p.theta, 3),
  delta:           round(p.delta, 3),
  gamma:           round(p.gamma, 4),
  vega:            round(p.vega, 3),
  iv:              round(p.iv, 1),
  thetaPerGamma:   round(p.tg),
  thetaPerVega:    round(p.tv),
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

const closest = [...list].filter(p => !p.exit).sort((a, b) => b.toward - a.toward);

const brief = {
  schema:      'spread-book/brief@1',
  generatedAt: takenAt(snap),
  source:      snap.source,
  about:       'Open credit spreads on OptionStrat, analysed against fixed exit rules. Refreshed at about 7:45 AM and 1:25 PM America/Denver on weekdays. Paths are relative to this file. Not investment advice; confirm with the broker before acting.',
  links: {
    report:    base + '-portfolio.html',
    positions: base + '-portfolio.json',
    pnl:       pnl ? base + '-pnl.json' : null,
    snapshots: 'snapshots.json',
  },
  rules: {
    closeAtPctOfMaxProfit: RULES.target,
    stopAtPctOfMaxLoss:    RULES.stop,
    rollWindowDays:        RULES.rollDays,
    gettingClosePct:       RULES.near * 100,
  },
  glossary: {
    returnPct:     'Current gain or loss as a percentage of max profit, from OptionStrat.',
    lossOfMaxPct:  'For a losing spread, the loss as a percentage of max loss. 0 when winning. Compared against stopAtPctOfMaxLoss.',
    progressPct:   'How far toward an exit: +100 is the close target, -100 is the stop, 0 is breakeven.',
    readyToClose:  'At or past the close target.',
    atStop:        'The loss has reached the stop.',
    inRollWindow:  'No exit hit, but rollWindowDays or fewer to expiration: close or roll before gamma speeds up.',
    gettingClose:  'Outside the roll window and at least gettingClosePct of the way to either exit.',
    theta:         'Dollars per day from time decay.',
    delta:         'Net direction. Positive gains if the underlying rises.',
    gamma:         'How quickly delta turns against the position in a big move. Negative for credit spreads.',
    vega:          'Dollars per one-point rise in implied volatility.',
    pop:           'OptionStrat probability of keeping the full credit.',
    ev:            'pop × maxProfit − (1 − pop) × maxLoss. All-or-nothing, so usually negative; compare, do not act on alone.',
    thetaPerGamma: 'Theta earned per unit of gamma. Low values are most exposed to a sharp move.',
    thetaPerVega:  'Theta earned per unit of vega. Low values are most exposed to a volatility spike.',
  },
  summary: {
    positions:    list.length,
    underlyings:  new Set(list.map(p => p.underlying)).size,
    readyToClose: lists.ready.length,
    atStop:       lists.stopped.length,
    inRollWindow: lists.soon.length,
    gettingClose: lists.near.length,
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
  totals: {
    ...greeks(list),
    credit:    round(sum(list, 'credit')),
    maxProfit: round(sum(list, 'maxProfit')),
    maxLoss:   round(sum(list, 'maxLoss')),
  },
  concentration: {
    byUnderlying: concentration(p => p.underlying).map(({ key, ...g }) => ({ underlying: key, ...g })),
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
  positions: [...list].sort((a, b) => a.dte - b.dte || a.name.localeCompare(b.name)).map(position),
};

const out  = JSON.stringify(brief, null, 2);
const file = path.join(reportsDir, base + '-brief.json');
fs.mkdirSync(reportsDir, { recursive: true });
fs.writeFileSync(file, out);
fs.writeFileSync(path.join(reportsDir, 'latest.json'), out);
console.log(`Wrote → ${file} and reports/latest.json`);
console.log(`Decisions: ${lists.ready.length} to close, ${lists.stopped.length} at the stop, ${lists.soon.length} in the roll window, ${lists.near.length} getting close`);
