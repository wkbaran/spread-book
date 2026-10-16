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
