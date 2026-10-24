const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const SB       = require('../book');
const sim      = require('../sim');
const { snapshot, pos } = require('./fixture');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} is not within ${tol} of ${b}`);
const TODAY = '2026-03-24'; // the fixture's Mountain date, a Tuesday
const enriched = (raw, snap = snapshot()) => SB.enrich({ ...raw }, snap);

// A position whose mark is exactly the model's price at its spot, so nothing but the stock moves it.
function fairPosition(side, dte, spot = 100) {
  const p = { side, spot, q: 1, dte, iv: 0.3, width: 5, shortStrike: side === 'put' ? 95 : 105, longStrike: side === 'put' ? 90 : 110 };
  const years = dte / 365;
  const fair = sim.blackScholes(side, spot, p.shortStrike, p.iv, years, 0) - sim.blackScholes(side, spot, p.longStrike, p.iv, years, 0);
  return { ...p, credit: fair, maxLoss: p.width - fair, debit: fair };
}
const FREE = { ...sim.SIM, rate: 0, ivDecay: 0, exitCost: 0, paths: 4000 };

// ---- pricing ----------------------------------------------------------------------------------------------

test('Black-Scholes: put-call parity, and the delta is the slope of the price', () => {
  const [s, k, v, t, r] = [100, 95, 0.3, 30 / 365, 0.04];
  near(sim.blackScholes('call', s, k, v, t, r) - sim.blackScholes('put', s, k, v, t, r), s - k * Math.exp(-r * t), 1e-6);
  for (const side of ['put', 'call']) {
    const h = 0.01, slope = (sim.blackScholes(side, s + h, k, v, t, r) - sim.blackScholes(side, s - h, k, v, t, r)) / (2 * h);
    near(sim.bsDelta(side, s, k, v, t, r), slope, 1e-5, side);
  }
  assert.equal(sim.blackScholes('put', 90, 95, 0.3, 0, 0.04), 5);
});

test('drawNormals: antithetic pairs, and the same seed gives the same draws', () => {
  const a = sim.drawNormals(6, 5), b = sim.drawNormals(6, 5);
  for (let i = 0; i < 6; i += 2) assert.deepEqual([...a[i + 1]], [...a[i]].map((z) => -z));
  assert.deepEqual(a.map((r) => [...r]), b.map((r) => [...r]));
});

test('tradingSchedule: weekdays only, with the calendar gap since the last one', () => {
  const s = sim.tradingSchedule('2026-03-27', '2026-04-01'); // a Friday to the next Wednesday
  assert.deepEqual(s.map((d) => d.date), ['2026-03-30', '2026-03-31', '2026-04-01']);
  assert.deepEqual(s.map((d) => d.gapDays), [3, 1, 1]);
});

// ---- the mark and its inversion ---------------------------------------------------------------------------

test('the model agrees with the actual mark at today\'s price, and moves the right way with the stock', () => {
  for (const name of ['MSFT May 1st 400/405 Bull Put Spread', 'AMD Apr 24th 230/235 Bear Call Spread']) {
    const raw = snapshot().positions.find((p) => p.name === name);
    const p = enriched(raw), spot = snapshot().spots[p.underlying];
    const position = sim.positionOf(p, spot), mark = sim.markModel(position);
    near(mark(spot, p.dte), position.debit, 1e-9, name);
    near(position.debit, (p.maxProfit - (p.returnPct / 100) * p.maxProfit) / 100, 1e-9, 'the debit is the credit less the P&L');
    const toward = p.kind === 'put' ? -1 : 1; // the stock moving toward the short strike raises the spread's price
    assert.ok(mark(spot + toward * 2, p.dte) > mark(spot, p.dte) && mark(spot, p.dte) > mark(spot - toward * 2, p.dte), name);
  }
});

test('spotForDebit: the returned stock price prices the spread at the asked debit, for puts and calls', () => {
  for (const side of ['put', 'call']) {
    const p = fairPosition(side, 40);
    for (const pct of [15, 25, 35, 50]) {
      const debit = p.credit + (pct / 100) * p.maxLoss, s = sim.spotForDebit(p, debit);
      near(sim.markModel(p)(s, p.dte), debit, 1e-4, `${side} at ${pct}%`);
      assert.ok(side === 'put' ? s < p.spot : s > p.spot, `${side}: a loss is toward the short strike`);
    }
    assert.equal(sim.spotForDebit(p, p.width + 1), null, 'more than the width is never reached');
  }
});

test('exitPlan: the stop, watch and target levels round-trip, and follow RULES', () => {
  const snap = snapshot(), raw = snap.positions.find((p) => p.name.startsWith('MSFT')), p = enriched(raw, snap);
  const plan = sim.exitPlan(p, snap.spots.MSFT), position = sim.positionOf(p, snap.spots.MSFT), mark = sim.markModel(position);
  near(plan.stop.debit, position.credit + (SB.RULES.stop / 100) * position.maxLoss, 0.0051); // rounded to cents
  near(plan.watch.debit, position.credit + (SB.RULES.watch / 100) * position.maxLoss, 0.0051);
  near(plan.target.debit, position.credit * (1 - SB.RULES.target / 100), 0.0051);
  near(plan.stop.pnl, -(SB.RULES.stop / 100) * p.maxLoss, 0.01);
  for (const k of ['stop', 'watch', 'target']) near(mark(plan[k].spot, p.dte), plan[k].debit, 0.01, k);
  assert.ok(plan.target.spot > plan.spot && plan.spot > plan.watch.spot && plan.watch.spot > plan.stop.spot, 'a put spread: target above, stop below');
  assert.ok(plan.stop.shortDelta > plan.watch.shortDelta && plan.watch.shortDelta > plan.shortDeltaNow);
  assert.equal(plan.pastShortStrike, false);
  assert.equal(plan.modelGap, Math.round((position.debit - (mark(snap.spots.MSFT, p.dte) - mark.gap)) * 100) / 100);
});

test('exitPlan scales dollars, not prices, with the number of contracts', () => {
  const snap = snapshot(), raw = snap.positions.find((p) => p.name.startsWith('MSFT'));
  const one = sim.exitPlan(enriched(raw, snap), 420);
  const three = sim.exitPlan(enriched({ ...raw, credit: raw.credit * 3, maxProfit: raw.maxProfit * 3, maxLoss: raw.maxLoss * 3 }, snap), 420);
  assert.equal(three.contracts, 3);
  assert.deepEqual([three.stop.debit, three.stop.spot, three.target.spot], [one.stop.debit, one.stop.spot, one.target.spot]);
  near(three.stop.pnl, 3 * one.stop.pnl, 0.02);
});

test('exitPlan and fromHere are null without a price, an IV or a plain put or call', () => {
  const snap = snapshot(), msft = snap.positions.find((p) => p.name.startsWith('MSFT'));
  const normals = sim.drawNormals(10, 200);
  assert.equal(sim.exitPlan(enriched(msft, snap), undefined), null);
  assert.equal(sim.exitPlan(enriched({ ...msft, iv: 0 }, snap), 420), null);
  const condor = enriched(pos('MSFT May 1st 380/385/440/445 Iron Condor Spread', { expiration: '2026-05-01' }), snap);
  assert.equal(condor.kind, 'other');
  assert.equal(sim.exitPlan(condor, 420), null);
  assert.equal(sim.fromHere(condor, 420, TODAY, normals), null);
  assert.equal(sim.fromHere(enriched({ ...msft, expiration: TODAY }, snap), 420, TODAY, normals), null, 'expiring today');
});

// ---- holding from here ------------------------------------------------------------------------------------

const scheduleFor = (dte) => sim.tradingSchedule(TODAY, sim.addDays(TODAY, dte - SB.RULES.rollDays));
const normalsFor = (cfg, dte) => sim.drawNormals(cfg.paths, scheduleFor(dte).length * cfg.intraday);

test('fair prices: with no exits and free fills, holding is worth what closing now is (a martingale)', () => {
  for (const side of ['put', 'call']) for (const dte of [30, 45]) {
    const p = fairPosition(side, dte), schedule = scheduleFor(dte), mark = sim.markModel(p, FREE);
    const { pnl } = sim.walk({ spot: p.spot, sigma: p.iv, rate: 0, dte, schedule, intraday: FREE.intraday, paths: FREE.paths, normals: normalsFor(FREE, dte) },
      (s, daysLeft, atClose, last) => (last ? { pnl: p.credit - mark(s, daysLeft), reason: 'time' } : null));
    const mean = pnl.reduce((a, v) => a + v, 0) / pnl.length;
    const se = Math.sqrt(pnl.reduce((a, v) => a + (v - mean) ** 2, 0) / pnl.length / pnl.length);
    near(mean, p.credit - p.debit, 4 * se, `${side} ${dte} days`);
  }
});

test('fair prices with the exits: holding is never better than closing now by more than noise', () => {
  for (const side of ['put', 'call']) for (const dte of [30, 45]) {
    const p = fairPosition(side, dte);
    const r = sim.holdFrom(p, p.spot, scheduleFor(dte), normalsFor(FREE, dte), FREE);
    assert.ok(r.avgResultPct <= 1, `${side} ${dte}: ${r.avgResultPct}`); // closing now is 0 here
    assert.ok(r.avgResultPct > -5, `${side} ${dte}: bounded below, ${r.avgResultPct}`);
    near(r.pTarget + r.pHardStop + r.pTime, 100, 0.2);
  }
});

test('a spread already past the stop: holding returns about what closing now does', () => {
  const p = fairPosition('put', 40), debit = p.credit + 0.3 * p.maxLoss, s = sim.spotForDebit(p, debit);
  const r = sim.holdFrom(p, s, scheduleFor(40), normalsFor(FREE, 40), FREE);
  near(r.avgResultPct, -30, 3);
});

test('the recovery ladder: the deeper the loss, the less often it ends in profit or at the target, the more at the hard stop', () => {
  const snap = sim.annotate(snapshot());
  for (const name of ['MSFT', 'AMD', 'NVDA Apr 17th 155']) {
    const ladder = snap.positions.find((p) => p.name.startsWith(name)).recovery;
    assert.deepEqual(ladder.map((r) => r.lossPct), sim.SIM.ladder);
    for (let i = 1; i < ladder.length; i++) {
      assert.ok(ladder[i].pProfit <= ladder[i - 1].pProfit, `${name} pProfit at ${ladder[i].lossPct}`);
      assert.ok(ladder[i].pTarget <= ladder[i - 1].pTarget, `${name} pTarget at ${ladder[i].lossPct}`);
      assert.ok(ladder[i].pHardStop >= ladder[i - 1].pHardStop, `${name} pHardStop at ${ladder[i].lossPct}`);
      assert.ok(ladder[i].avgResultPct < ladder[i - 1].avgResultPct, `${name} avgResultPct at ${ladder[i].lossPct}`);
    }
  }
});

test('annotate: the same snapshot gives the same numbers, and the shares add up to 100', () => {
  const a = sim.annotate(snapshot()), b = sim.annotate(snapshot());
  assert.deepEqual(a, b);
  for (const p of a.positions.filter((x) => x.fromHere)) near(p.fromHere.pTarget + p.fromHere.pHardStop + p.fromHere.pTime, 100, 0.2, p.name);
  assert.equal(a.positions.find((p) => p.underlying === 'SPX').plan, null, 'no price for SPX');
  assert.equal(a.sim.hardStopPctOfMaxLoss, SB.RULES.hardStop);
  assert.equal(a.sim.stopChecked, 'close');
});

test('inside the roll window a run holds to expiration; outside it, to the roll-window exit', () => {
  const snap = sim.annotate(snapshot());
  const csco = snap.positions.find((p) => p.underlying === 'CSCO'), msft = snap.positions.find((p) => p.underlying === 'MSFT');
  assert.equal(csco.fromHere.until, '2026-04-10'); // its expiration, 17 days out
  assert.equal(msft.fromHere.until, '2026-04-10'); // May 1st less 21 days
  assert.equal(sim.lastDay('2026-03-27', '2026-04-18', 22), '2026-03-30', 'a weekend exit moves to the next trading day');
});

// ---- the port against spread-scanner -----------------------------------------------------------------------

// spread-scanner checked out next to this repo, if it is.
const SCANNER = path.join(__dirname, '..', '..', 'spread-scanner', 'src', 'outcome.ts');

test('simulateManaged gives what spread-scanner\'s outcome.ts gives', { skip: !fs.existsSync(SCANNER) && 'spread-scanner is not checked out next to this repo' }, () => {
  const cfg = { takeProfit: 0.5, stopLoss: 0.25, exitDte: 21, fillShare: 0.5, volEdge: 0, ivDecay: 0.35, paths: 200, intraday: 3 };
  const base = { spot: 100, shortIv: 0.32, longIv: 0.36, dte: 39, creditMid: 0.85, creditNatural: 0.75, pathSigma: 0.32, rate: 0.04, today: '2026-03-24', expiration: '2026-05-02' };
  const cases = [
    { ...base, side: 'put', shortStrike: 95, longStrike: 90 },
    { ...base, side: 'call', shortStrike: 105, longStrike: 110, shortIv: 0.28, longIv: 0.27 },
    { ...base, side: 'put', shortStrike: 98, longStrike: 93, dte: 25, expiration: '2026-04-18', creditMid: 1.6, creditNatural: 1.4 },
    { ...base, side: 'put', shortStrike: 95, longStrike: 90, dte: 22, expiration: '2026-04-15' }, // a one-day schedule
  ];
  const script = `
    import { simulateManaged, drawNormals, tradingSchedule, normalCdf, blackScholes } from ${JSON.stringify(pathToFileURL(SCANNER).href)};
    const { cases, cfg } = JSON.parse(process.argv[1]);
    const normals = drawNormals(cfg.paths, 60 * cfg.intraday);
    console.log(JSON.stringify({
      outcomes: cases.map((c) => simulateManaged(c, cfg, normals)),
      normals: Array.from(normals[3].slice(0, 8)),
      schedule: tradingSchedule('2026-03-27', '2026-04-08'),
      prices: [normalCdf(0.3), blackScholes('put', 100, 95, 0.3, 30 / 365, 0.04), blackScholes('call', 100, 105, 0.25, 0.2, 0.04)],
    }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ cases, cfg })], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const theirs = JSON.parse(r.stdout);
  const normals = sim.drawNormals(cfg.paths, 60 * cfg.intraday);
  assert.deepEqual(Array.from(normals[3].slice(0, 8)), theirs.normals);
  assert.deepEqual(sim.tradingSchedule('2026-03-27', '2026-04-08'), theirs.schedule);
  assert.deepEqual([sim.normalCdf(0.3), sim.blackScholes('put', 100, 95, 0.3, 30 / 365, 0.04), sim.blackScholes('call', 100, 105, 0.25, 0.2, 0.04)], theirs.prices);
  cases.forEach((c, i) => {
    const ours = sim.simulateManaged(c, cfg, normals);
    for (const k of Object.keys(theirs.outcomes[i])) near(ours[k], theirs.outcomes[i][k], 1e-9, `case ${i} ${k}`);
  });
});
