const { test } = require('node:test');
const assert   = require('node:assert/strict');
const SB       = require('../book');
const { snapshot, pos } = require('./fixture');

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} ${a} is not ${b}`);

// The fixture book, enriched the way the page and brief.js do it.
const book = (over) => {
  const snap = snapshot(over);
  const list = snap.positions.map((p) => SB.enrich({ ...p }, snap));
  SB.tagCondors(list);
  return list;
};
const by = (list, name) => list.find((p) => p.name.startsWith(name));

// ---- median, counts, addUp ----------------------------------------------------------------------

test('median: middle of an odd list, mean of the middle two of an even one, any order', () => {
  assert.equal(SB.median([3, 1, 2]), 2);
  assert.equal(SB.median([4, 1, 3, 2]), 2.5);
  assert.equal(SB.median([7]), 7);
});

test('addUp skips spreads without a value, and counts says which those are', () => {
  const ps = [{ x: 1 }, { x: null }, { x: undefined }, { x: 2.5 }, { x: 0 }];
  assert.deepEqual(ps.map((p) => SB.counts(p, 'x')), [true, false, false, true, true]);
  assert.equal(SB.addUp(ps, 'x'), 3.5);
  assert.equal(SB.addUp([{ x: null }], 'x'), 0);
});

// ---- heatmap ------------------------------------------------------------------------------------

test('heatmap: one row per underlying and kind, so an iron condor stays in two rows', () => {
  const h = SB.heatmap(book(), 'theta', false);
  const aapl = h.rows.filter((r) => r.u === 'AAPL');
  assert.deepEqual(aapl.map((r) => r.kind).sort(), ['call', 'put']);
  assert.equal(h.rows.length, 8);
  assert.deepEqual(h.exps, ['2026-04-10', '2026-04-17', '2026-04-24', '2026-05-01']);
});

test('heatmap: two spreads of one kind on one underlying share a row and add up', () => {
  const h = SB.heatmap(book(), 'theta', false);
  const nvda = h.rows.find((r) => r.u === 'NVDA');
  assert.equal(nvda.ps.length, 2);
  close(nvda.total, 1.5 + 1.2);
});

test('heatmap: theta rows run from the largest magnitude down', () => {
  const h = SB.heatmap(book(), 'theta', false);
  const mags = h.rows.map((r) => Math.abs(r.total));
  assert.deepEqual(mags, [...mags].sort((a, b) => b - a));
});

test('heatmap: delta rows run from most bullish to most bearish', () => {
  const h = SB.heatmap(book(), 'delta', true);
  const totals = h.rows.map((r) => r.total);
  assert.deepEqual(totals, [...totals].sort((a, b) => b - a));
  assert.ok(totals[0] > 0 && totals[totals.length - 1] < 0);
});

test('heatmap: rows with no beta go last for the beta-weighted view, and are not counted', () => {
  const list = book();
  const h = SB.heatmap(list, 'bwDelta', true);
  assert.equal(h.covered, list.filter((p) => p.bwDelta !== null).length);
  assert.ok(h.covered < list.length);
  const flags = h.rows.map((r) => r.has);
  assert.deepEqual(flags, [...flags].sort((a, b) => b - a)); // every true before every false
  assert.deepEqual(h.rows.filter((r) => !r.has).map((r) => r.u).sort(), ['MRNA', 'MSFT', 'SPX']);
  assert.ok(h.rows.filter((r) => !r.has).every((r) => r.total === 0));
});

test('heatmap: max is the largest cell, not the largest row total, and never zero', () => {
  const list = book();
  const h = SB.heatmap(list, 'theta', false);
  // NVDA's two spreads share a cell: 2.7 is the biggest cell short of SPX's 3.
  close(h.max, 3);
  const empty = SB.heatmap(book({ positions: [pos('AAPL Apr 17th 235/240 Bull Put Spread', { theta: 0 })] }), 'theta', false);
  assert.ok(empty.max > 0);
});

test('heatmap: an empty book has no rows and nothing covered', () => {
  const h = SB.heatmap([], 'theta', false);
  assert.deepEqual([h.exps, h.rows, h.covered], [[], [], 0]);
});

// ---- rank ---------------------------------------------------------------------------------------

test('rank: highest value is 1, counted among spreads that have one', () => {
  const list = [{ tg: 5 }, { tg: 1 }, { tg: null }, { tg: 3 }];
  assert.deepEqual(SB.rank(list, list[0], 'tg'), { pos: 1, of: 3 });
  assert.deepEqual(SB.rank(list, list[3], 'tg'), { pos: 2, of: 3 });
  assert.deepEqual(SB.rank(list, list[1], 'tg'), { pos: 3, of: 3 });
  assert.equal(SB.rank(list, list[2], 'tg'), null);
});

// ---- plotModel ----------------------------------------------------------------------------------

test('plotModel: nothing measured, nothing to plot', () => {
  assert.equal(SB.plotModel([]), null);
  assert.equal(SB.plotModel(book({ positions: [pos('AAPL Apr 17th 235/240 Bull Put Spread', { gamma: 0 })] })), null);
});

test('plotModel: a spread with no gamma sits at x = 0, and no vega at y = 0', () => {
  const list = book();
  const m = SB.plotModel(list);
  const msft = by(list, 'MSFT');
  assert.equal(msft.tg, null);
  assert.equal(m.px(msft), 0);
  assert.equal(m.py(msft), msft.tv); // vega was measured, so its height is real
  assert.equal(m.unmeasured(msft), true);
  assert.equal(m.px(by(list, 'AAPL Apr 17th 235')), by(list, 'AAPL Apr 17th 235').tg);
  assert.equal(m.py({ tg: 2, tv: null }), 0);
});

test('plotModel: medians come from the measured spreads only', () => {
  const list = book();
  const m = SB.plotModel(list);
  const measured = list.filter((p) => p.tg !== null && p.tv !== null);
  assert.ok(measured.length < list.length);
  close(m.mx, SB.median(measured.map((p) => p.tg)));
  close(m.my, SB.median(measured.map((p) => p.tv)));
});

test('plotModel: an unmeasured spread is never weak, however low it sits', () => {
  const list = book();
  const m = SB.plotModel(list);
  for (const p of list.filter(m.unmeasured)) assert.equal(m.weak(p), false);
  const low = list.find((p) => !m.unmeasured(p) && p.tg < m.mx && p.tv < m.my);
  assert.ok(low, 'the fixture has a measured spread below both medians');
  assert.equal(m.weak(low), true);
  assert.equal(m.weak({ ...low, hypo: true }), false); // a trial trade is never flagged
});

test('plotModel: trial trades stay out of the medians while there are real spreads', () => {
  const real = book();
  const trial = SB.enrich({ ...pos('ZZZ Apr 17th 10/15 Bull Put Spread', { theta: 50, gamma: -0.01, vega: -0.1 }), hypo: true }, snapshot());
  const m = SB.plotModel([...real, trial]);
  const base = SB.plotModel(real);
  close(m.mx, base.mx);
  close(m.my, base.my);
  assert.ok(m.xMax > base.xMax); // but the axis still has to fit the dot
  // With only trial trades, they are the basis.
  assert.notEqual(SB.plotModel([trial]), null);
});

test('plotModel: axes cover the data and ticks start at 0', () => {
  const m = SB.plotModel(book());
  const list = book().filter((p) => p.tg !== null && p.tv !== null);
  assert.ok(m.xMax >= Math.max(...list.map((p) => p.tg)));
  assert.ok(m.yMax >= Math.max(...list.map((p) => p.tv)));
  assert.equal(m.xTicks[0], 0);
  assert.equal(m.xTicks.at(-1), m.xMax);
  assert.equal(m.yTicks[0], 0);
  assert.ok(m.yTicks.at(-1) <= m.yMax);
});

test('plotModel: the x axis steps by 5 once ratios pass 20, otherwise by 2', () => {
  const at = (theta) => SB.plotModel(book({ positions: [pos('AAPL Apr 17th 235/240 Bull Put Spread', { theta, gamma: -1, vega: -1 })] }));
  assert.equal(at(5).xStep, 2);
  assert.equal(at(30).xStep, 5);
  assert.equal(at(30).xMax % 5, 0);
});

// ---- sortSpreads --------------------------------------------------------------------------------

test('sortSpreads: numbers either way, strings by name, original list untouched', () => {
  const list = book();
  const before = list.map((p) => p.name);
  const up = SB.sortSpreads(list, 'theta', 1).map((p) => p.theta);
  assert.deepEqual(up, [...up].sort((a, b) => a - b));
  const down = SB.sortSpreads(list, 'theta', -1).map((p) => p.theta);
  assert.deepEqual(down, [...down].sort((a, b) => b - a));
  const names = SB.sortSpreads(list, 'underlying', 1).map((p) => p.underlying);
  assert.deepEqual(names, [...names].sort());
  assert.deepEqual(list.map((p) => p.name), before);
});

test('sortSpreads: a missing value sorts last whichever way the column runs', () => {
  const list = book();
  for (const dir of [1, -1]) {
    const tgs = SB.sortSpreads(list, 'tg', dir).map((p) => p.tg);
    const firstNull = tgs.indexOf(null);
    assert.ok(firstNull > 0);
    assert.ok(tgs.slice(firstNull).every((v) => v === null), `nulls last, dir ${dir}`);
    const bw = SB.sortSpreads(list, 'bwDelta', dir).map((p) => p.bwDelta);
    assert.ok(bw.slice(bw.indexOf(null)).every((v) => v === null), `bw nulls last, dir ${dir}`);
  }
});

test('sortSpreads: ties fall back to fewer days, then more theta', () => {
  const a = { dte: 20, theta: 1, tg: 2 }, b = { dte: 10, theta: 1, tg: 2 }, c = { dte: 10, theta: 3, tg: 2 };
  assert.deepEqual(SB.sortSpreads([a, b, c], 'tg', 1), [c, b, a]);
});

// ---- bookTotals ---------------------------------------------------------------------------------

test('bookTotals: sums and averages, with beta-weighted delta over the spreads that have one', () => {
  const list = book();
  const t = SB.bookTotals(list);
  assert.equal(t.count, list.length);
  close(t.theta, list.reduce((s, p) => s + p.theta, 0));
  close(t.avgChance, 0.75);
  close(t.avgIv, 31.5);
  const bw = list.filter((p) => p.bwDelta !== null);
  assert.equal(t.bwCount, bw.length);
  assert.ok(t.bwCount < t.count);
  close(t.bwDelta, bw.reduce((s, p) => s + p.bwDelta, 0));
  close(t.thetaPerGamma, t.theta / Math.abs(t.gamma));
  close(t.thetaPerVega, t.theta / Math.abs(t.vega));
});

test('bookTotals: bwDelta is null, not zero, when no spread has a beta', () => {
  const t = SB.bookTotals(book({ betas: undefined, betasAsOf: undefined }));
  assert.equal(t.bwDelta, null);
  assert.equal(t.bwCount, 0);
});

test('bookTotals: ratios are null when the book has no net gamma or vega, and an empty book is zeros', () => {
  const none = SB.bookTotals(book({ positions: [pos('AAPL Apr 17th 235/240 Bull Put Spread', { gamma: 0, vega: 0 })] }));
  assert.equal(none.thetaPerGamma, null);
  assert.equal(none.thetaPerVega, null);
  const empty = SB.bookTotals([]);
  assert.deepEqual([empty.count, empty.theta, empty.avgChance, empty.avgIv, empty.bwDelta], [0, 0, 0, 0, null]);
});

// ---- parseTrade ---------------------------------------------------------------------------------

const ROW = 'AAPL Jun 18th 180/185 Bull Put Spread,0%,$0,3/24/26 14:00,6/18/26 14:00, $65.00 ,82.00%, $435.00 , $65.00 ,0%,0%,3.5,1.2,-0.15,-2.5,0.4,28.5%,Open,Live';

test('parseTrade reads an OptionStrat row', () => {
  const t = SB.parseTrade(ROW);
  assert.equal(t.name, 'AAPL Jun 18th 180/185 Bull Put Spread');
  assert.equal(t.underlying, 'AAPL');
  assert.equal(t.type, 'Bull Put');
  assert.equal(t.expiration, '6/18/26 14:00');
  assert.equal(t.credit, 65);
  assert.equal(t.chance, 0.82);
  assert.equal(t.maxLoss, 435);
  assert.equal(t.maxProfit, 65);
  assert.deepEqual([t.delta, t.theta, t.gamma, t.vega, t.iv], [3.5, 1.2, -0.15, -2.5, 28.5]);
  assert.equal(t.hypo, true);
});

test('parseTrade reads an Excel paste, tab-separated', () => {
  const t = SB.parseTrade(ROW.split(',').join('\t'));
  assert.equal(t.credit, 65);
  assert.equal(t.iv, 28.5);
});

test('parseTrade: a quoted comma does not split a field, and dollar amounts come out as absolute values', () => {
  const t = SB.parseTrade('AMD Jun 18th 230/235 Bear Call Spread,"-12.5%","($25.00)",3/24/26 14:00,6/18/26 14:00,"$1,065.00",70%,"$4,000.00",$1065,0,0,-4,1,-0.2,-2,0,40%');
  assert.equal(t.returnPct, -12.5);
  assert.equal(t.type, 'Bear Call');
  assert.equal(t.credit, 1065); // credit is an absolute value
  assert.equal(t.maxLoss, 4000);
});

test('parseTrade: other spreads are typed Other, and ISO expirations are accepted', () => {
  const t = SB.parseTrade('AAPL Jun 18th 180/185 Bull Call Spread,0%,$0,x,2026-06-18,$0,50%,$100,$100,0,0,1,1,0,0,0,30%');
  assert.equal(t.type, 'Other');
  assert.equal(t.expiration, '2026-06-18');
});

test('parseTrade rejects what is not a spread row', () => {
  for (const [what, line] of Object.entries({
    'empty': '',
    'free text': 'not a spread',
    'a single leg': 'AAPL Jun 18th 180 Call,0%,$0,x,6/18/26 14:00,$0,50%',
    'no date': 'AAPL Jun 18th 180/185 Bull Put Spread,0%,$0,x,soon,$0,50%',
    'too few fields': 'AAPL Jun 18th 180/185 Bull Put Spread',
  })) assert.equal(SB.parseTrade(line), null, what);
});

test('a parsed trade enriches like any other spread', () => {
  const t = SB.enrich(SB.parseTrade(ROW), snapshot({ spots: { AAPL: 200 } }));
  assert.equal(t.kind, 'put');
  assert.equal(t.expiration, '2026-06-18');
  assert.equal(t.shortStrike, 185);
  assert.ok(t.z > 0);
});

// ---- tryTrade and readTry: trades sent from spread-scanner ----------------------------------------------

// A scanner trade in the scanner's units: per-share greeks, iv a fraction, popPct in percent, credit per share.
const leg = (strike, delta, gamma, theta, vega, iv) => ({ strike, delta, gamma, theta, vega, iv });
const TRY = {
  symbol: 'AAPL', side: 'put', expiration: '2026-04-17', qty: 1, credit: 0.61, popPct: 74.15,
  short: leg(240, -0.30, 0.0300, -0.060, 0.250, 0.3114),
  long: leg(235, -0.237, 0.0252, -0.048, 0.217, 0.3250),
};
const encode = (payload) => '#try=' + Buffer.from(JSON.stringify(payload)).toString('base64url');

test('tryTrade turns a scanner bull put into a trial trade in the export\'s units', () => {
  const t = SB.tryTrade(TRY);
  assert.equal(t.name, 'AAPL Apr 17th 235/240 Bull Put Spread'); // the export's own name for this spread
  assert.equal(t.underlying, 'AAPL');
  assert.equal(t.type, 'Bull Put');
  assert.equal(t.expiration, '2026-04-17');
  assert.equal(t.returnPct, 0);
  assert.equal(t.credit, 61);
  assert.equal(t.maxProfit, 61);
  assert.equal(t.maxLoss, 439);
  close(t.chance, 0.7415);
  // (bought − sold) × 100: a bull put leans long, and the seller collects theta
  close(t.delta, 6.3);
  close(t.gamma, -0.48);
  close(t.theta, 1.2);
  close(t.vega, -3.3);
  close(t.iv, 31.14); // the short leg's, in percent
  assert.equal(t.hypo, true);
});

test('tryTrade: a bear call is named low/high like the export, with a negative delta', () => {
  const t = SB.tryTrade({ ...TRY, symbol: 'AMD', side: 'call', expiration: '2026-05-01',
    short: leg(230, 0.22, 0.02, -0.07, 0.2, 0.5), long: leg(235, 0.17, 0.017, -0.06, 0.18, 0.52) });
  assert.equal(t.name, 'AMD May 1st 230/235 Bear Call Spread');
  assert.equal(t.type, 'Bear Call');
  assert.ok(t.delta < 0);
  assert.ok(t.theta > 0);
});

test('tryTrade: contracts scale money and greeks, half-dollar strikes keep their decimal, ordinals read right', () => {
  const t = SB.tryTrade({ ...TRY, qty: 2, short: { ...TRY.short, strike: 102.5 }, long: { ...TRY.long, strike: 97.5 } });
  assert.equal(t.credit, 122);
  assert.equal(t.maxLoss, 878);
  close(t.delta, 12.6);
  assert.match(t.name, / 97\.5\/102\.5 /);
  const day = (d) => SB.tryTrade({ ...TRY, expiration: `2026-04-${String(d).padStart(2, '0')}` }).name.split(' ')[2];
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 30].map(day), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '30th']);
});

test('tryTrade: a greek a leg lacks counts as 0, and a missing quantity is one contract', () => {
  const { qty, ...noQty } = TRY;
  const t = SB.tryTrade({ ...noQty, short: { ...TRY.short, gamma: null }, long: { ...TRY.long, gamma: undefined } });
  assert.equal(t.gamma, 0);
  assert.equal(t.credit, 61);
});

test('tryTrade rejects what is not a plain bull put or bear call', () => {
  for (const [what, t] of Object.entries({
    'nothing': null,
    'no legs': { ...TRY, short: undefined },
    'an unknown side': { ...TRY, side: 'straddle' },
    'a bad date': { ...TRY, expiration: '4/17/26' },
    'a month that is not one': { ...TRY, expiration: '2026-13-01' },
    'a put spread the wrong way round': { ...TRY, short: TRY.long, long: TRY.short },
    'equal strikes': { ...TRY, long: { ...TRY.long, strike: 240 } },
    'no credit': { ...TRY, credit: 0 },
    'a credit as wide as the spread': { ...TRY, credit: 5 },
    'a fractional quantity': { ...TRY, qty: 0.5 },
    'a symbol with markup in it': { ...TRY, symbol: '<b>X' },
  })) assert.equal(SB.tryTrade(t), null, what);
});

test('a tried trade enriches like a pasted one, and gets the same spreadKey as the export\'s row', () => {
  const t = SB.enrich(SB.tryTrade(TRY), snapshot({ spots: { AAPL: 250 } }));
  assert.equal(t.kind, 'put');
  assert.equal(t.strikes, '235/240');
  assert.equal(t.shortStrike, 240);
  assert.equal(t.width, 5);
  assert.ok(t.z > 0);
  const row = SB.enrich(SB.parseTrade('AAPL Apr 17th 235/240 Bull Put Spread,0%,$0,3/4/26 19:06,4/17/26 20:00, $61.00 ,74.15%, $439.00 , $61.00 ,0,0,6.3,1.2,-0.48,-3.3,1,31.14%'), snapshot());
  assert.equal(SB.spreadKey(t), SB.spreadKey(row));
});

test('readTry reads the trades in a #try= fragment', () => {
  const two = SB.readTry(encode({ v: 1, trades: [TRY, { ...TRY, side: 'call' }] }));
  assert.equal(two.length, 2);
  assert.equal(two[0].name, 'AAPL Apr 17th 235/240 Bull Put Spread');
  assert.equal(two[1], null, 'a trade that cannot be read is null, so the page can say so');
  assert.equal(SB.readTry(encode({ v: 1, trades: [TRY] }).slice(1))[0].credit, 61, 'with or without the #');
});

test('readTry: no try= is null; an unreadable one is [null]', () => {
  assert.equal(SB.readTry(''), null);
  assert.equal(SB.readTry('#'), null);
  assert.equal(SB.readTry('#other=1'), null);
  for (const [what, hash] of Object.entries({
    'empty': '#try=',
    'not base64': '#try=!!!',
    'not JSON': '#try=' + Buffer.from('nope').toString('base64url'),
    'another version': encode({ v: 2, trades: [TRY] }),
    'no trades': encode({ v: 1, trades: [] }),
  })) assert.deepEqual(SB.readTry(hash), [null], what);
});

// ---- the exit plan and the "from here" panel ---------------------------------------------------------------

const level = (debit, spot, shortDelta = 0.3) => ({ debit, spot, shortDelta, pnl: 0 });
const withPlan = (over = {}) => ({
  plan: { debitNow: 1.2, spot: 100, shortDeltaNow: 0.3, target: level(0.4, 104), watch: level(1.5, 98), stop: level(1.9, 96) },
  fromHere: { pProfit: 30, pTarget: 20, pHardStop: 25, avgResultPct: -15 },
  recovery: [15, 25, 35, 50].map((lossPct, i) => ({ lossPct, spot: 98 - i, pProfit: 40 - i * 10, pTarget: 10, pHardStop: 10 + i * 20, avgResultPct: -lossPct })),
  lossOfMax: 20, returnPct: -40, exit: '', dte: 30, toward: -0.8, ...over,
});

test('planRows: target, now, watch and stop ordered by the spread price, now where it falls', () => {
  assert.deepEqual(SB.planRows(withPlan()).map((r) => r.key), ['target', 'now', 'watch', 'stop']);
  const past = withPlan({ plan: { ...withPlan().plan, debitNow: 2.1 } });
  assert.deepEqual(SB.planRows(past).map((r) => r.key), ['target', 'watch', 'stop', 'now']);
  assert.deepEqual(SB.planRows(withPlan()).map((r) => r.pct), [SB.RULES.target, null, -SB.RULES.watch, -SB.RULES.stop]);
  assert.deepEqual(SB.planRows({ plan: null }), []);
});

test('recoveryRows: the ladder with the current loss slotted in and marked now', () => {
  const rows = SB.recoveryRows(withPlan());
  assert.deepEqual(rows.map((r) => [r.lossPct, r.now]), [[15, false], [20, true], [25, false], [35, false], [50, false]]);
  assert.equal(rows[1].pProfit, 30, 'now comes from fromHere');
  assert.deepEqual(SB.recoveryRows(withPlan({ lossOfMax: 0 })).map((r) => r.lossPct), [0, 15, 25, 35, 50]);
  assert.deepEqual(SB.recoveryRows(withPlan({ lossOfMax: 60 })).map((r) => r.lossPct), [15, 25, 35, 50, 60]);
  const unreachable = withPlan({ recovery: withPlan().recovery.map((r) => (r.lossPct === 50 ? { lossPct: 50, spot: null } : r)) });
  assert.deepEqual(SB.recoveryRows(unreachable).map((r) => r.lossPct), [15, 20, 25, 35], 'a level the spread can\'t reach is left out');
  assert.deepEqual(SB.recoveryRows({ recovery: null, fromHere: null }), []);
});

test('showsFromHere: every spread with the numbers, winners included, never one without them', () => {
  assert.equal(SB.showsFromHere(withPlan()), true);
  const quiet = { lossOfMax: 0, returnPct: 10, exit: '', dte: 30, toward: 0.2 };
  assert.equal(SB.showsFromHere(withPlan(quiet)), true, 'a quiet winner');
  assert.equal(SB.showsFromHere(withPlan({ ...quiet, exit: 'close', returnPct: 60 })), true, 'ready to close');
  assert.equal(SB.showsFromHere(withPlan({ fromHere: null })), false);
});

test('findSpread: the spread a ?spread= link names, with or without equity-watch\'s episode suffix', () => {
  const list = book();
  const msft = by(list, 'MSFT');
  assert.equal(SB.findSpread(list, SB.spreadKey(msft)), msft);
  assert.equal(SB.findSpread(list, SB.spreadKey(msft) + '#2'), msft);
  assert.equal(SB.findSpread(list, 'MSFT May 1st 400/405 Bull Put Spread|2026-05-01|395/400'), null);
  assert.equal(SB.findSpread(list, ''), null);
  assert.equal(SB.findSpread(list, null), null);
});

test('optionStratUrl: the builder link spread-scanner makes, bought leg first, sold leg with a minus', () => {
  const list = book();
  assert.equal(SB.optionStratUrl(by(list, 'AAPL Apr 17th 235/240 Bull')),
    'https://optionstrat.com/build/bull-put-spread/AAPL/.AAPL260417P235,-.AAPL260417P240');
  assert.equal(SB.optionStratUrl(by(list, 'AMD')),
    'https://optionstrat.com/build/bear-call-spread/AMD/.AMD260424C235,-.AMD260424C230');
  assert.equal(SB.optionStratUrl(by(list, 'CSCO')),
    'https://optionstrat.com/build/bull-put-spread/CSCO/.CSCO260410P67.5,-.CSCO260410P72.5');
  const other = SB.enrich({ ...pos('AAPL Apr 17th 235/240 Iron Butterfly') }, snapshot());
  assert.equal(SB.optionStratUrl(other), null);
  const odd = SB.enrich({ ...pos('BRK/B Apr 17th 400/405 Bull Put Spread'), underlying: 'BRK/B' }, snapshot());
  assert.equal(SB.optionStratUrl(odd), null);
});
