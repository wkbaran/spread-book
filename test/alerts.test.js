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

test('optionStratLinks reads the hyperlinks the CSV loses, by spread name, and only OptionStrat ones', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), XLSX = require('xlsx');
  const { optionStratLinks } = require('../spread-alerts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spread-book-xlsx-'));
  try {
    const rows = [['Name', 'Link'], ['Symbol', ''], ['MSFT May 1st 400/405 Bull Put Spread', 'Open'], ['.MSFT260501P405', ''], ['AMD Apr 24th 230/235 Bear Call Spread', 'Open']];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws.B3.l = { Target: 'https://optionstrat.com/AbC123xyz' };
    ws.B5.l = { Target: 'https://example.com/elsewhere' };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Live');
    const file = path.join(dir, 'export.xlsx');
    XLSX.writeFile(wb, file);
    const links = optionStratLinks(file);
    assert.deepEqual([...links], [['MSFT May 1st 400/405 Bull Put Spread', 'https://optionstrat.com/AbC123xyz']]);
    assert.equal(optionStratLinks(path.join(dir, 'missing.xlsx')).size, 0);
    // And they reach the alerts file by name.
    const snap = sim.annotate(snapshot()), list = snap.positions.map((p) => SB.enrich({ ...p }, snap));
    const doc = buildSpreadAlerts(snap, list, SB.history([snap]).open, links);
    assert.equal(of(doc, 'MSFT').spread.optionStratUrl, 'https://optionstrat.com/AbC123xyz');
    assert.equal(of(doc, 'AMD').spread.optionStratUrl, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the OptionStrat links stay out of latest.json', () => {
  const b = runBrief(sim.annotate(snapshot()), undefined, { shared: true });
  assert.doesNotMatch(JSON.stringify({ ...b, alerts: undefined }), /optionstrat\.com/i);
});
