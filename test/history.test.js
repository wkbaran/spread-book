const { test } = require('node:test');
const assert   = require('node:assert/strict');
const SB       = require('../book');

// A snapshot taken at 14:12 Mountain on the given day of 2026-03.
const snapOn = (day, positions, spots = { AAPL: 250 }) => ({
  source: `live-active-by-symbol-2026-03-${String(day).padStart(2, '0')}_14-12.csv`,
  generatedAt: 'ignored: takenAt reads the file name', spots, positions,
});

const spread = (over = {}) => ({
  name: 'AAPL Apr 17th 235/240 Bull Put Spread', underlying: 'AAPL', type: 'Bull Put',
  expiration: '2026-04-17', returnPct: 10, credit: 61, maxLoss: 439, maxProfit: 61, chance: 0.75,
  theta: 1.27, gamma: -0.24, vega: -3.28, delta: 5.99, iv: 31.49, ...over,
});
const other = (over = {}) => spread({ name: 'MSFT Apr 17th 400/405 Bull Put Spread', underlying: 'MSFT', ...over });

const key = (p) => SB.spreadKey(SB.enrich({ ...p }, snapOn(24, [])));

test('a spread already in the oldest snapshot has an unknown entry, not a guess', () => {
  const { open } = SB.history([snapOn(10, [spread()]), snapOn(11, [spread()])]);
  assert.deepEqual(open.get(key(spread())).entry, { known: false });
});

test('with one snapshot, every entry is unknown', () => {
  const { open, closed } = SB.history([snapOn(10, [spread(), other()])]);
  assert.deepEqual([...open.values()].map((o) => o.entry), [{ known: false }, { known: false }]);
  assert.deepEqual(closed, []);
});

test('the entry is what the first snapshot containing the spread showed, not the latest', () => {
  const { open } = SB.history([
    snapOn(10, [other()]),
    snapOn(11, [other(), spread({ chance: 0.8, iv: 28, credit: 70, maxProfit: 70, maxLoss: 430 })], { AAPL: 262, MSFT: 410 }),
    snapOn(12, [other(), spread({ chance: 0.6, iv: 40, credit: 70, maxProfit: 70, maxLoss: 430 })], { AAPL: 245 }),
  ]);
  const e = open.get(key(spread())).entry;
  assert.equal(e.known, true);
  assert.equal(e.firstSeenAt, '2026-03-11T20:12:00.000Z'); // 14:12 MDT
  assert.equal(e.pop, 0.8);
  assert.equal(e.iv, 28);
  assert.equal(e.dte, 37);
  assert.equal(e.credit, 70);
  assert.equal(e.maxLoss, 430);
  assert.equal(e.spot, 262);
  assert.ok(Math.abs(e.creditToWidthPct - 14) < 1e-9); // 70 of the 500 between the strikes
  assert.ok(e.z > 0);
});

test('entry spot and sigma are null when the first snapshot had no price', () => {
  const { open } = SB.history([snapOn(10, [other()]), snapOn(11, [other(), spread()], {})]);
  const e = open.get(key(spread())).entry;
  assert.equal(e.known, true);
  assert.equal(e.spot, null);
  assert.equal(e.z, null);
});

test('snapshots are ordered by when they were taken, not by the order given', () => {
  const { open } = SB.history([snapOn(12, [spread()]), snapOn(10, [other()]), snapOn(11, [spread({ chance: 0.9 })])]);
  assert.equal(open.get(key(spread())).entry.pop, 0.9);
});

test('a spread that left the book is closed, with its entry, hold time and last return', () => {
  const { open, closed } = SB.history([
    snapOn(10, [other()]),
    snapOn(11, [other(), spread({ returnPct: 5 })]),
    snapOn(14, [other(), spread({ returnPct: 62 })]),
    snapOn(15, [other()]),
  ]);
  assert.equal(open.has(key(spread())), false);
  assert.equal(closed.length, 1);
  const c = closed[0];
  assert.equal(c.name, spread().name);
  assert.equal(c.underlying, 'AAPL');
  assert.equal(c.kind, 'put');
  assert.equal(c.openedAt, '2026-03-11T20:12:00.000Z');
  assert.equal(c.closedAt, '2026-03-15T20:12:00.000Z');
  assert.equal(c.daysHeld, 4);
  assert.equal(c.entry.known, true);
  assert.equal(c.lastReturnPct, 62);
  assert.equal(c.outcome, 'target');
  assert.equal(c.approximate, true);
});

test('a closed spread that was open in the oldest snapshot keeps an unknown entry and no hold time', () => {
  const { closed } = SB.history([snapOn(10, [spread(), other()]), snapOn(11, [other()])]);
  assert.equal(closed.length, 1);
  assert.deepEqual(closed[0].entry, { known: false });
  assert.equal(closed[0].openedAt, null);
  assert.equal(closed[0].daysHeld, null);
  assert.equal(closed[0].closedAt, '2026-03-11T20:12:00.000Z');
});

test('the outcome follows the exit rules on the last snapshot, then expiry, then other', () => {
  const outcome = (over, day = 11) => {
    const { closed } = SB.history([snapOn(10, [other()]), snapOn(day - 1, [other(), spread(over)]), snapOn(day, [other()])]);
    return closed[0].outcome;
  };
  assert.equal(outcome({ returnPct: SB.RULES.target }), 'target');
  assert.equal(outcome({ returnPct: SB.RULES.target - 1 }), 'other');
  // −200% of $61 is $122, 27.8% of the $439 max loss
  assert.equal(outcome({ returnPct: -200 }), 'stop');
  assert.equal(outcome({ returnPct: -100 }), 'other'); // 13.9% of max loss
});

test('a spread last seen on or after its expiration day is expired', () => {
  const exp = (day, over) => SB.history([
    snapOn(10, [other()]),
    snapOn(day - 1, [other(), spread({ expiration: '2026-03-20', returnPct: 20, ...over })]),
    snapOn(day, [other()]),
  ]).closed[0].outcome;
  assert.equal(exp(19), 'other'); // last seen 3/18, two days before it expires
  assert.equal(exp(21), 'expired'); // last seen 3/20, its expiration day
  assert.equal(exp(22), 'expired'); // last seen 3/21, the day after
});

test('the same name, expiration and strikes is one closed spread, however often it was seen', () => {
  const { closed } = SB.history([
    snapOn(10, [other()]),
    snapOn(11, [other(), spread(), spread()]), // two saved trades of one spread
    snapOn(12, [other(), spread()]),
    snapOn(13, [other()]),
  ]);
  assert.equal(closed.length, 1);
});

test('the same name with another expiration or strikes is a different spread', () => {
  const rolled = spread({ name: 'AAPL May 1st 235/240 Bull Put Spread', expiration: '2026-05-01' });
  const { open, closed } = SB.history([snapOn(10, [other(), spread()]), snapOn(11, [other(), rolled])]);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].name, spread().name);
  assert.equal(open.get(key(rolled)).entry.known, true);
});

// Episodes: the same spread key can be several positions over time.
const run = (...days) => SB.history(days.map(([d, ps, spots]) => snapOn(d, ps, spots)));

test('an unchanged spread stays one episode', () => {
  const { open, closed } = run([10, [other()]], [11, [other(), spread()]], [12, [other(), spread({ returnPct: 30 })]], [13, [other(), spread({ returnPct: 40 })]]);
  const o = open.get(key(spread()));
  assert.equal(o.episode, 1);
  assert.equal(o.episodeBreak, null);
  assert.deepEqual(closed, []);
});

test('a spread closed and reopened is two episodes: the first closed, the second live with its own entry', () => {
  const { open, closed } = run(
    [10, [other()]],
    [11, [other(), spread({ chance: 0.8 })]],
    [12, [other()]],
    [13, [other(), spread({ chance: 0.6 })]],
  );
  const o = open.get(key(spread()));
  assert.equal(o.episode, 2);
  assert.equal(o.episodeBreak, 'gap');
  assert.equal(o.entry.firstSeenAt, '2026-03-13T20:12:00.000Z');
  assert.equal(o.entry.pop, 0.6);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].episode, 1);
  assert.equal(closed[0].episodeBreak, null);
  assert.equal(closed[0].entry.pop, 0.8);
  assert.equal(closed[0].closedAt, '2026-03-12T20:12:00.000Z');
});

test('a gap of several snapshots, and a second reopen, count up the episodes', () => {
  const { open, closed } = run([10, [other()]], [11, [other(), spread()]], [12, [other()]], [13, [other()]], [14, [other(), spread()]], [15, [other()]], [16, [other(), spread()]]);
  assert.equal(open.get(key(spread())).episode, 3);
  assert.deepEqual(closed.map((c) => c.episode), [2, 1]);
});

test('a spread that changed credit or max loss is a new episode, resized', () => {
  for (const [what, over] of Object.entries({
    'credit': { credit: 70 },
    'max loss': { maxLoss: 430 },
    'a contract added': { credit: 122, maxProfit: 122, maxLoss: 878 },
  })) {
    const { open, closed } = run([10, [other()]], [11, [other(), spread()]], [12, [other(), spread(over)]]);
    const o = open.get(key(spread()));
    assert.equal(o.episode, 2, what);
    assert.equal(o.episodeBreak, 'resized', what);
    assert.equal(o.entry.firstSeenAt, '2026-03-12T20:12:00.000Z', what);
    assert.equal(closed.length, 1, what);
    assert.equal(closed[0].closedAt, '2026-03-12T20:12:00.000Z', what);
  }
});

test('credit and max loss are compared to the cent, so rounding noise is not a resize', () => {
  const quiet = run([10, [other()]], [11, [other(), spread()]], [12, [other(), spread({ credit: 61.004, maxLoss: 438.996 })]]);
  assert.equal(quiet.open.get(key(spread())).episode, 1);
  const loud = run([10, [other()]], [11, [other(), spread()]], [12, [other(), spread({ credit: 61.01 })]]);
  assert.equal(loud.open.get(key(spread())).episode, 2);
});

test('returns, greeks and prices moving do not start an episode', () => {
  const { open } = run([10, [other()]], [11, [other(), spread()]],
    [12, [other(), spread({ returnPct: -80, chance: 0.5, iv: 50, delta: 1, theta: 3 })], { AAPL: 200 }]);
  assert.equal(open.get(key(spread())).episode, 1);
});

test('a gap beats a resize when both apply', () => {
  const { open } = run([10, [other()]], [11, [other(), spread()]], [12, [other()]], [13, [other(), spread({ credit: 70 })]]);
  assert.equal(open.get(key(spread())).episodeBreak, 'gap');
});

test('a spread resized and then unchanged keeps the second episode going', () => {
  const { open, closed } = run([10, [other()]], [11, [other(), spread()]], [12, [other(), spread({ credit: 70 })]], [13, [other(), spread({ credit: 70 })]]);
  assert.equal(open.get(key(spread())).episode, 2);
  assert.equal(open.get(key(spread())).entry.firstSeenAt, '2026-03-12T20:12:00.000Z');
  assert.equal(closed.length, 1);
});

test('an episode that starts in the oldest snapshot is unknown; its successors are known', () => {
  const { open, closed } = run([10, [spread()]], [11, []], [12, [spread()]]);
  assert.deepEqual(closed[0].entry, { known: false });
  assert.equal(open.get(key(spread())).entry.known, true);
});

test('a skipped corrupt snapshot between two sightings causes no break', () => {
  // A file that fails to parse never reaches history(), so it is neither a presence nor an absence.
  const withCorrupt = [snapOn(10, [other()]), snapOn(11, [other(), spread()]), snapOn(13, [other(), spread()])];
  const { open, closed } = SB.history(withCorrupt); // 3/12 is simply missing
  assert.equal(open.get(key(spread())).episode, 1);
  assert.deepEqual(closed, []);
  // The same run with the file loaded but empty is a gap.
  const absent = SB.history([snapOn(10, [other()]), snapOn(11, [other(), spread()]), snapOn(12, [other()]), snapOn(13, [other(), spread()])]);
  assert.equal(absent.open.get(key(spread())).episode, 2);
});

test('closed episodes of one spread are separate records, each deduped by its own run', () => {
  const { closed } = run([10, [other()]], [11, [other(), spread(), spread()]], [12, [other()]], [13, [other(), spread()]], [14, [other()]]);
  assert.deepEqual(closed.map((c) => c.episode), [2, 1]);
});

test('only spreads closed within the last RULES.closedDays are listed', () => {
  const days = SB.RULES.closedDays;
  const at = (offset) => ({ ...snapOn(10, [other()]), source: `live-active-by-symbol-2026-01-${String(1 + offset).padStart(2, '0')}_14-12.csv` });
  // old: seen on Jan 2, gone by Jan 3. Recent: gone on the newest snapshot.
  const old = { ...at(1), positions: [other(), spread()] };
  const gone = { ...at(2), positions: [other()] };
  const newest = { ...snapOn(28, [other()]), source: 'live-active-by-symbol-2026-03-28_14-12.csv' };
  assert.ok((Date.parse(SB.takenAt(newest)) - Date.parse(SB.takenAt(gone))) / 864e5 > days);
  assert.deepEqual(SB.history([at(0), old, gone, newest]).closed, []);
  const recent = SB.history([snapOn(10, [other()]), snapOn(11, [other(), spread()]), snapOn(12, [other()])]);
  assert.equal(recent.closed.length, 1);
});

test('closed spreads come newest first', () => {
  const a = spread(), b = spread({ name: 'AAPL Apr 24th 235/240 Bull Put Spread', expiration: '2026-04-24' });
  const { closed } = SB.history([snapOn(10, [other()]), snapOn(11, [other(), a, b]), snapOn(12, [other(), b]), snapOn(13, [other()])]);
  assert.deepEqual(closed.map((c) => c.name), [b.name, a.name]);
});

test('no snapshots, or none with positions, gives nothing', () => {
  assert.deepEqual(SB.history([]), { open: new Map(), closed: [] });
  assert.deepEqual(SB.history([{ source: snapOn(10, []).source }]), { open: new Map(), closed: [] });
});
