const { test } = require('node:test');
const assert   = require('node:assert/strict');
const SB       = require('../book');
const sim      = require('../sim');
const { buildSpreadAlerts, ALERTS_SCHEMA } = require('../spread-alerts');
const { snapshot, pos } = require('./fixture');
const { runBrief } = require('./page-support');

const build = (snap) => {
  const list = snap.positions.map((p) => SB.enrich({ ...p }, snap));
  return buildSpreadAlerts(snap, list, SB.history([snap]).open);
};
const of = (doc, sym) => doc.alerts.find((a) => a.symbol === sym);

test('one stop alert per priced put or call spread, at the plan\'s stock level, crossed toward the strike', () => {
  const snap = sim.annotate(snapshot()), doc = build(snap);
  assert.equal(doc.schema, ALERTS_SCHEMA);
  assert.equal(doc.complete, true);
  const amd = of(doc, 'AMD'), amdPlan = snap.positions.find((p) => p.underlying === 'AMD').plan;
  assert.deepEqual([amd.role, amd.direction, amd.level], ['stop', 'up', amdPlan.stop.spot]);
  assert.deepEqual([amd.spread.short, amd.spread.long], [{ strike: 230, type: 'C' }, { strike: 235, type: 'C' }]);
  assert.equal(amd.spread.stopDebit, amdPlan.stop.debit);
  const msft = of(doc, 'MSFT');
  assert.equal(msft.direction, 'down');
  assert.deepEqual([msft.spread.short.strike, msft.spread.long.strike], [405, 400]);
  assert.match(msft.key, /^MSFT May 1st 400\/405 Bull Put Spread\|2026-05-01\|400\/405#1$/);
});

test('a spread with no stock level is listed as unpriced, never left out, so it is not cancelled', () => {
  const doc = build(sim.annotate(snapshot()));
  // SPX has no price; MRNA's stop can't be reached by any stock price today.
  assert.equal(of(doc, 'SPX'), undefined);
  assert.equal(of(doc, 'MRNA'), undefined);
  assert.deepEqual(doc.unpriced.map((k) => k.split(' ')[0]).sort(), ['MRNA', 'SPX']);
  assert.equal(doc.alerts.length + doc.unpriced.length, 9, 'every put and call spread is in one list or the other');
});

test('a snapshot without exit plans is marked incomplete, and every spread is unpriced', () => {
  const doc = build(snapshot());
  assert.equal(doc.complete, false);
  assert.equal(doc.alerts.length, 0);
});

test('iron condors\' own rows and other spreads are not alerted; class shares use Schwab\'s spelling', () => {
  const snap = sim.annotate(snapshot({ spots: { 'BRK.B': 480, MSFT: 420 }, positions: [
    pos('BRK.B May 1st 450/455 Bull Put Spread', { expiration: '2026-05-01' }),
    pos('MSFT May 1st 380/385/440/445 Iron Condor Spread', { expiration: '2026-05-01' }),
  ] }));
  const doc = build(snap);
  assert.deepEqual(doc.alerts.map((a) => a.symbol), ['BRK/B']);
  assert.deepEqual(doc.unpriced, []);
});

test('a reopened spread gets a new key', () => {
  const name = 'MSFT May 1st 400/405 Bull Put Spread';
  const at = (src, gen, positions) => sim.annotate(snapshot({ source: src, generatedAt: gen, positions }));
  const snaps = [
    at('live-active-by-symbol-2026-03-23_07-45.csv', '2026-03-23T13:45:00.000Z', [pos(name, { expiration: '2026-05-01' })]),
    at('live-active-by-symbol-2026-03-23_13-25.csv', '2026-03-23T19:25:00.000Z', [pos('AAPL Apr 17th 235/240 Bull Put Spread')]),
    at('live-active-by-symbol-2026-03-24_07-45.csv', '2026-03-24T13:45:00.000Z', [pos(name, { expiration: '2026-05-01' })]),
  ];
  const now = snaps[2], list = now.positions.map((p) => SB.enrich({ ...p }, now));
  const doc = buildSpreadAlerts(now, list, SB.history(snaps).open);
  assert.match(doc.alerts[0].key, /#2$/);
});

test('brief.js writes the file into shared/ for the newest snapshot, and not for an older one', () => {
  const snap = sim.annotate(snapshot());
  const b = runBrief(snap, undefined, { shared: true });
  assert.equal(b.alerts.schema, ALERTS_SCHEMA);
  assert.deepEqual(b.alerts, JSON.parse(JSON.stringify(build(snap))));
  const older = { 'live-active-by-symbol-2026-03-23_13-25': sim.annotate(snapshot({ source: 'live-active-by-symbol-2026-03-23_13-25.csv', generatedAt: '2026-03-23T19:25:00.000Z' })) };
  const old = runBrief(snap, undefined, { shared: true, older, arg: 'live-active-by-symbol-2026-03-23_13-25' });
  assert.equal(old.alerts, null, 'a brief for an old snapshot leaves the alerts alone');
  assert.equal(runBrief(snap).alerts, undefined, 'no shared/ directory, no file');
});
