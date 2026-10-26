// Smoke tests for the report page: build it as portfolio.js does, run its scripts in jsdom, and check what it
// draws against book.js and against brief.js, the other reader of the same snapshot.
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const SB       = require('../book');
const { snapshot, pos } = require('./fixture');
const { loadPage, runBrief } = require('./page-support');

// Loads a page and closes it when the test ends, so jsdom's timers don't keep the runner alive.
async function open(t, snap = snapshot(), opts) {
  const p = await loadPage(snap, opts);
  t.after(() => p.close());
  return p;
}
const num = (s) => parseFloat(String(s).replace('−', '-'));
const enriched = (snap = snapshot()) => { const l = snap.positions.map((p) => SB.enrich({ ...p }, snap)); SB.tagCondors(l); return l; };
const bookValue = (p, g) => num(p.$(`.greek[data-g="${g}"] .g-val`).firstChild.textContent);

test('the page loads and draws without an error', async (t) => {
  const p = await open(t);
  assert.deepEqual(p.errors, []);
  assert.equal(p.text('.brand'), 'Spread book');
  assert.equal(p.$('#detail .muted'), null, 'a spread is selected by default');
});

test('every spread is on the scorecard and the chart, and in exactly one heatmap cell', async (t) => {
  const list = enriched(), p = await open(t);
  assert.equal(p.$$('#sc tbody tr').length, list.length);
  assert.equal(p.$$('#plot .dot').length, list.length);
  const cells = new Set(list.map((x) => [x.underlying, x.kind, x.expiration].join('|')));
  assert.equal(p.$$('#heat .cell[data-id]').length, cells.size);
  const ids = p.$$('#sc tbody tr').map((r) => r.dataset.id);
  assert.equal(new Set(ids).size, list.length);
});

test('the book totals match brief.js for the same snapshot', async (t) => {
  const snap = snapshot(), p = await open(t, snap), b = runBrief(snap);
  for (const [g, v] of Object.entries({ theta: b.totals.theta, delta: b.totals.delta, gamma: b.totals.gamma, vega: b.totals.vega, bwDelta: b.totals.betaWeightedDelta })) {
    assert.ok(Math.abs(bookValue(p, g) - v) < 0.06, `${g}: page ${bookValue(p, g)}, brief ${v}`);
  }
  // The scorecard's Book row says the same, and how many spreads have a beta.
  const foot = [...p.$('#sc tfoot tr').children].map((td) => td.textContent);
  assert.equal(foot[1], `${b.summary.positions} spreads`);
  assert.equal(foot[11], `${b.totals.betaWeightedDelta.toFixed(1).replace('-', '−')}${b.totals.betaCoverage.positions}/${b.totals.betaCoverage.of}`);
  assert.equal(b.book.counts.puts + b.book.counts.calls + b.book.counts.other, b.summary.positions);
});

test('the decision lists match brief.js', async (t) => {
  const snap = snapshot(), p = await open(t, snap), b = runBrief(snap);
  const onPage = (title) => p.$$('#decide section').find((s) => s.querySelector('h2').textContent === title);
  const syms = (s) => [...s.querySelectorAll('.sym')].map((e) => e.textContent);
  const brief = (k) => b.decisions[k].map((x) => x.underlying);
  assert.deepEqual(syms(onPage('Ready to close')), brief('readyToClose'));
  assert.deepEqual(syms(onPage('At the stop')), brief('atStop'));
  assert.deepEqual(syms(onPage('21 days or less')), brief('inRollWindow'));
  assert.deepEqual(syms(onPage('Getting close')), brief('gettingClose'));
  // The fixture is built to put someone in each of the first three.
  assert.deepEqual([brief('readyToClose'), brief('atStop'), brief('inRollWindow')], [['AAPL'], ['AMD'], ['CSCO']]);
});

test('the number keys switch the heatmap, and the beta view dashes spreads with no beta', async (t) => {
  const p = await open(t);
  assert.equal(p.text('#grid-title'), 'Theta by underlying and expiration');
  p.key('2');
  assert.equal(p.text('#grid-title'), 'Delta by underlying and expiration');
  assert.equal(p.$('.greek[aria-pressed="true"]').dataset.g, 'delta');
  p.key('5');
  assert.equal(p.text('#grid-title'), 'Beta-weighted delta by underlying and expiration');
  assert.match(p.text('#grid-note'), /6 of 9 spreads have a beta/);
  const dashed = p.$$('#heat .cell.nobeta');
  assert.deepEqual(dashed.map((c) => c.textContent), ['—', '—', '—']);
  assert.equal(p.text('.greek[data-g="bwDelta"] .g-bw'), '6 of 9 spreads have a beta');
  // Beta-weighted rows without a beta are last.
  const rowNames = p.$$('#heat tbody th').map((th) => th.firstChild.textContent);
  assert.deepEqual(rowNames.slice(-3).sort(), ['MRNA', 'MSFT', 'SPX']);
  p.key('1');
  assert.equal(p.$$('#heat .cell.nobeta').length, 0);
});

test('a heatmap cell with two spreads says so, and selecting a cell shows that spread', async (t) => {
  const p = await open(t);
  const nvda = p.$$('#heat tbody tr').find((tr) => tr.querySelector('th').firstChild.textContent === 'NVDA');
  const cell = nvda.querySelector('.cell[data-id]');
  assert.match(cell.getAttribute('aria-label'), /^2 NVDA put spreads, Theta 2\.70$/);
  p.click(cell);
  assert.match(p.text('#detail h3'), /^NVDA /);
  assert.match(p.text('#detail .also'), /Same cell/);
});

test('selecting a spread rings its dot on the chart and draws it last', async (t) => {
  const p = await open(t);
  const row = p.$$('#sc tbody tr').find((r) => r.textContent.includes('400/405'));
  p.click(row);
  const sel = p.$$('#plot .dot.sel');
  assert.equal(sel.length, 1);
  assert.equal(sel[0].dataset.id, row.dataset.id);
  assert.equal(p.$$('#plot .halo').length, 1);
  assert.equal(p.$$('#plot svg > g').at(-1).querySelector('.dot').dataset.id, row.dataset.id);
});

test('the detail title opens the spread in OptionStrat, in its own named tab', async (t) => {
  const p = await open(t);
  p.click(p.$$('#sc tbody tr').find((r) => r.textContent.includes('235/240')));
  const a = p.$('#detail h3 a');
  assert.equal(a.getAttribute('href'), 'https://optionstrat.com/build/bull-put-spread/AAPL/.AAPL260417P235,-.AAPL260417P240');
  assert.equal(a.getAttribute('target'), 'optionstrat');
});

test('the iron condor legs link to each other', async (t) => {
  const p = await open(t);
  const row = p.$$('#sc tbody tr').find((r) => r.textContent.includes('235/240'));
  p.click(row);
  assert.match(p.text('#detail .also'), /Iron condor with the 280\/285 call spread/);
  p.click(p.$('#detail .also button'));
  assert.match(p.text('#detail h3'), /AAPL 280\/285/);
});

test('the scorecard sorts on a heading click, and again to reverse', async (t) => {
  const p = await open(t);
  const col = (i) => p.$$('#sc tbody tr').map((r) => r.children[i].textContent);
  const head = (k) => p.$(`#sc th button[data-k="${k}"]`);
  assert.deepEqual(col(2).map(Number), [...col(2).map(Number)].sort((a, b) => a - b)); // days, ascending by default
  p.click(head('theta'));
  const theta = col(9).map(num);
  assert.deepEqual(theta, [...theta].sort((a, b) => b - a));
  p.click(head('theta'));
  const reversed = col(9).map(num);
  assert.deepEqual(reversed, [...reversed].sort((a, b) => a - b));
  assert.equal(p.$('#sc th[aria-sort]').getAttribute('aria-sort'), 'ascending');
});

test('spreads with no gamma sit on the chart axis, with no note under it', async (t) => {
  const list = enriched(), p = await open(t);
  const onAxis = p.$$('#plot .dot').filter((d) => Number(d.getAttribute('cx')) === 44).map((d) => d.dataset.id);
  const unmeasured = p.$$('#sc tbody tr').filter((r) => r.children[15].textContent === '—').map((r) => r.dataset.id);
  assert.equal(unmeasured.length, list.filter((x) => x.tg === null).length);
  assert.ok(unmeasured.length >= 2);
  assert.deepEqual(onAxis.sort(), unmeasured.sort());
  assert.equal(p.$('#plot .plot-note'), null);
  assert.equal(p.$$('#plot .dot.weak').length, SB.plotModel(list) && list.filter((x) => SB.plotModel(list).weak(x)).length);
});

test('a book with no gamma anywhere says there is nothing to plot', async (t) => {
  const p = await open(t, snapshot({ positions: snapshot().positions.map((x) => ({ ...x, gamma: 0 })) }));
  assert.deepEqual(p.errors, []);
  assert.match(p.text('#plot'), /nothing to plot/);
  assert.equal(p.$$('#sc tbody tr').length, 9);
});

test('a book with no betas shows dashes and says so', async (t) => {
  const p = await open(t, snapshot({ betas: undefined, betasAsOf: undefined }));
  assert.deepEqual(p.errors, []);
  assert.equal(p.text('.greek[data-g="bwDelta"] .g-val'), '—');
  assert.equal(p.text('.greek[data-g="bwDelta"] .g-bw'), 'No betas available');
  p.key('5');
  assert.match(p.text('#grid-note'), /No spread has a beta/);
});

test('a one-spread book draws', async (t) => {
  const p = await open(t, snapshot({ positions: [pos('AAPL Apr 17th 235/240 Bull Put Spread')] }));
  assert.deepEqual(p.errors, []);
  assert.equal(p.$$('#sc tbody tr').length, 1);
  assert.equal(p.$$('#plot .dot').length, 1);
});

// ---- trial trades ----
const ROW = (name, exp, theta) => `${name},0%,$0,3/24/26 14:00,${exp},$80.00,80%,$420.00,$80.00,0%,0%,5,${theta},-0.2,-3,0,30%,Open,Live`;

test('a trial trade joins every total, and can be removed', async (t) => {
  const p = await open(t);
  const before = bookValue(p, 'theta');
  p.$('#whatif-text').value = ROW('GOOGL Apr 17th 270/275 Bull Put Spread', '4/17/26 14:00', 1.4);
  p.click(p.$('#whatif-add'));
  assert.equal(p.$$('#sc tbody tr').length, 10);
  assert.equal(p.$$('#plot .dot').length, 10);
  assert.equal(p.$$('#sc tbody tr.hypo').length, 1);
  assert.ok(Math.abs(bookValue(p, 'theta') - (before + 1.4)) < 0.006);
  assert.equal(p.text('.greek[data-g="theta"] .g-diff'), '+1.40');
  assert.equal(p.$$('#chips .chip').length, 1);
  assert.equal(p.$('#whatif-text').value, '');
  p.click(p.$('#chips button'));
  assert.equal(p.$$('#sc tbody tr').length, 9);
  assert.ok(Math.abs(bookValue(p, 'theta') - before) < 1e-9);
  assert.equal(p.$('.greek[data-g="theta"] .g-diff'), null);
  assert.deepEqual(p.errors, []);
});

test('rows that are not spreads are rejected with a message, and left in the box to fix', async (t) => {
  const p = await open(t);
  p.$('#whatif-text').value = ROW('GOOGL Apr 17th 270/275 Bull Put Spread', '4/17/26 14:00', 1) + '\nnot a spread';
  p.click(p.$('#whatif-add'));
  assert.equal(p.$$('#sc tbody tr').length, 10, 'the good row was added');
  assert.equal(p.$('#whatif-error').hidden, false);
  assert.match(p.text('#whatif-error'), /^1 of 2 rows aren't a spread/);
  assert.equal(p.$('#whatif-text').value, 'not a spread');
  p.$('#whatif-text').value = 'garbage';
  p.click(p.$('#whatif-add'));
  assert.match(p.text('#whatif-error'), /^That row isn't a spread/);
  assert.equal(p.$$('#sc tbody tr').length, 10);
});

test('a trial trade that makes an iron condor links to its partner', async (t) => {
  const p = await open(t);
  p.$('#whatif-text').value = ROW('AMD Apr 24th 250/255 Bull Put Spread', '4/24/26 14:00', 1);
  p.click(p.$('#whatif-add'));
  assert.match(p.text('#detail .also'), /Iron condor with the 230\/235 call spread/);
});

// ---- trades sent from spread-scanner (#try=) ----
const leg = (strike, delta) => ({ strike, delta, gamma: 0.02, theta: -0.05, vega: 0.2, iv: 0.3 });
const TRY = { symbol: 'GOOGL', side: 'put', expiration: '2026-04-17', qty: 1, credit: 0.8, popPct: 80, short: leg(275, -0.25), long: leg(270, -0.2) };
const tryHash = (...trades) => '#try=' + Buffer.from(JSON.stringify({ v: 1, trades })).toString('base64url');

test('#try= adds the scanner\'s spread as a trial trade, selects it, and is cleared from the URL', async (t) => {
  const p = await open(t, snapshot(), { url: 'http://localhost/index.html?snapshot=fixture' + tryHash(TRY) });
  assert.deepEqual(p.errors, []);
  assert.equal(p.$$('#sc tbody tr').length, 10);
  assert.equal(p.$$('#sc tbody tr.hypo').length, 1);
  assert.equal(p.text('#chips .chip').replace('×', '').trim(), 'GOOGL 270/275 put');
  assert.match(p.text('#detail'), /GOOGL/);
  assert.equal(p.window.location.hash, '', 'a reload does not add it again');
  assert.equal(p.window.location.search, '?snapshot=fixture', 'the rest of the URL is kept');
  assert.equal(p.$('#whatif-error').hidden, true);
});

test('a later #try= in the same tab stacks, and the same spread twice is one trial trade', async (t) => {
  const p = await open(t, snapshot(), { url: 'http://localhost/index.html' + tryHash(TRY) });
  const call = { ...TRY, side: 'call', short: leg(300, 0.2), long: leg(305, 0.15) };
  for (const h of [tryHash(call), tryHash(TRY)]) {
    p.window.location.hash = h;
    await p.tick(); await p.tick();
  }
  assert.equal(p.$$('#chips .chip').length, 2);
  assert.match(p.text('#chips'), /GOOGL 300\/305 call/);
  assert.equal(p.$$('#sc tbody tr.hypo').length, 2);
  assert.deepEqual(p.errors, []);
});

test('a #try= the page cannot read says so and adds nothing', async (t) => {
  const p = await open(t, snapshot(), { url: 'http://localhost/index.html#try=garbage' });
  assert.equal(p.$$('#sc tbody tr').length, 9);
  assert.equal(p.$('#whatif').hidden, false);
  assert.equal(p.$('#whatif-error').hidden, false);
  assert.match(p.text('#whatif-error'), /^The spread sent from the scanner couldn't be read/);
  const q = await open(t, snapshot(), { url: 'http://localhost/index.html' + tryHash(TRY, { ...TRY, credit: 9 }) });
  assert.equal(q.$$('#sc tbody tr.hypo').length, 1, 'the good one is still added');
  assert.match(q.text('#whatif-error'), /^1 of 2 spreads/);
});

test('a paper snapshot says so in the title and the header; the real book does not', async (t) => {
  const p = await open(t, snapshot({ paper: true }));
  assert.equal(p.document.title, 'Paper book');
  assert.equal(p.text('.brand'), 'Paper book');
  assert.equal(p.text('.paper-tag'), 'Paper trades');
  const q = await open(t);
  assert.equal(q.document.title, 'Spread book');
  assert.equal(q.$('.paper-tag'), null);
});

// ---- snapshot menu ----
const older = () => snapshot({ source: 'live-active-by-symbol-2026-03-23_19-39.csv', generatedAt: '2026-03-23T01:39:00.000Z', positions: snapshot().positions.slice(0, 4) });
const LIST = [{ base: 'fixture', generatedAt: '2026-03-24T20:12:00.000Z' }, { base: 'older', generatedAt: '2026-03-23T19:39:00.000Z' }];

test('choosing an older snapshot redraws the page in place and keeps the choice in the URL', async (t) => {
  const p = await open(t, snapshot(), { files: { 'snapshots.json': LIST, 'older-portfolio.json': older() } });
  assert.deepEqual([...p.$('#snapshot').options].map((o) => o.value), ['fixture', 'older']);
  p.$('#snapshot').value = 'older';
  p.$('#snapshot').dispatchEvent(new p.window.Event('change', { bubbles: true }));
  await p.tick(); await p.tick();
  assert.equal(p.$$('#sc tbody tr').length, 4);
  assert.equal(p.window.location.search, '?snapshot=older');
  assert.equal(p.text('#snap-status'), '');
  // and back to the embedded one
  p.$('#snapshot').value = 'fixture';
  p.$('#snapshot').dispatchEvent(new p.window.Event('change', { bubbles: true }));
  await p.tick(); await p.tick();
  assert.equal(p.$$('#sc tbody tr').length, 9);
  assert.equal(p.window.location.search, '');
});

test('a snapshot that will not load leaves the page as it was and says so', async (t) => {
  const p = await open(t, snapshot(), { files: { 'snapshots.json': LIST } }); // older-portfolio.json is a 404
  p.$('#snapshot').value = 'older';
  p.$('#snapshot').dispatchEvent(new p.window.Event('change', { bubbles: true }));
  await p.tick(); await p.tick();
  assert.equal(p.$$('#sc tbody tr').length, 9);
  assert.match(p.text('#snap-status'), /Couldn't load that snapshot/);
  assert.equal(p.$('#snapshot').value, 'fixture');
  assert.equal(p.window.location.search, '');
});

test('?snapshot= in the URL opens that snapshot', async (t) => {
  const p = await open(t, snapshot(), { url: 'http://localhost/index.html?snapshot=older', files: { 'snapshots.json': LIST, 'older-portfolio.json': older() } });
  assert.equal(p.$$('#sc tbody tr').length, 4);
  assert.equal(p.$('#snapshot').value, 'older');
});

test('opened from disk, with no snapshots.json, the page still draws the embedded snapshot', async (t) => {
  const p = await open(t);
  assert.equal(p.$$('#snapshot option').length, 1);
  assert.deepEqual(p.errors, []);
});

// ---- the exit plan and the "from here" panel (stored in the snapshot by sim.js) ----
const sim = require('../sim');
const planned = () => sim.annotate(snapshot());
const showSpread = (p, sym, strikes = '') => p.click(p.$$('#sc tbody tr').find((r) => r.children[0].textContent === sym && r.children[1].textContent.startsWith(strikes)));

test('the exit-plan panel shows the plan three ways, and what holding does, for a spread at the stop', async (t) => {
  const snap = planned(), p = await open(t, snap);
  assert.deepEqual(p.errors, []);
  showSpread(p, 'AMD');
  const amd = snap.positions.find((x) => x.underlying === 'AMD');
  const rows = p.$$('#drawer table.plan tbody tr');
  assert.deepEqual(rows.map((r) => r.className), SB.planRows(SB.enrich({ ...amd }, snap)).map((r) => r.key));
  const stop = p.$('#drawer table.plan tr.stop');
  assert.deepEqual([...stop.children].slice(1).map((td) => td.textContent),
    [`$${amd.plan.stop.debit.toFixed(2)}`, `≈ $${amd.plan.stop.spot.toFixed(2)}`, amd.plan.stop.shortDelta.toFixed(2)]);
  assert.doesNotMatch(p.text('#detail'), /If you hold from here/, 'it is in the panel, not the detail');
  assert.match(p.text('#plan-open'), new RegExp(`Held from here, ${Math.round(amd.fromHere.pProfit)}% of simulated runs end with a gain`));
  assert.match(p.text('#drawer'), /If you hold from here/);
  assert.match(p.text('#drawer'), new RegExp(`Of ${snap.sim.paths} simulated runs`));
  assert.equal(p.$$('#drawer table.ladder tbody tr').length, 5, 'four loss levels and now');
  assert.equal(p.$$('#drawer table.ladder tr.now').length, 1);
  assert.doesNotMatch(p.text('#drawer'), /will recover|likely to recover/);
});

test('the At the stop list says where the exit is and how often runs from here end with a gain', async (t) => {
  const snap = planned(), p = await open(t, snap);
  const amd = snap.positions.find((x) => x.underlying === 'AMD');
  const stopped = p.$$('#decide section').find((s) => s.querySelector('h2').textContent === 'At the stop');
  assert.equal(stopped.querySelector('.d-plan').textContent,
    `Exit at $${amd.plan.stop.debit.toFixed(2)}, stock ≈ $${amd.plan.stop.spot.toFixed(2)}. ${Math.round(amd.fromHere.pProfit)}% of runs from here end with a gain`);
});

test('a quiet winner gets the exit plan and the from-here panel too', async (t) => {
  const p = await open(t, planned());
  showSpread(p, 'NVDA', '150/155'); // +5%, 24 days, in no list
  assert.match(p.text('#detail h3'), /NVDA 150\/155/);
  assert.ok(p.$('#plan-open'));
  assert.ok(p.$('#drawer table.plan'));
  assert.match(p.text('#drawer'), /If you hold from here/);
  assert.match(p.text('#plan-open'), /Held from here/);
});

test('a stock past the short strike is a warning, not an exit', async (t) => {
  const p = await open(t, planned());
  showSpread(p, 'MRNA'); // spot 30 below a 45 short put
  assert.match(p.text('#drawer .warn'), /past the short strike.*warning, not an exit/);
});

test('snapshots from before the exit plan, and trial trades, draw without one', async (t) => {
  const p = await open(t);
  assert.deepEqual(p.errors, []);
  assert.equal(p.$('#plan-open'), null);
  assert.equal(p.$('#drawer table.plan'), null);
  assert.equal(p.$('#decide .d-plan'), null);
  const q = await open(t, planned());
  q.$('#whatif-text').value = ROW('GOOGL Apr 17th 270/275 Bull Put Spread', '4/17/26 14:00', 1);
  q.click(q.$('#whatif-add'));
  assert.match(q.text('#detail h3'), /GOOGL/);
  assert.equal(q.$('#plan-open'), null);
  assert.equal(q.$('#drawer table.plan'), null);
  assert.deepEqual(q.errors, []);
});

test('latest.json carries the plan, fromHere and recovery, and describes them', () => {
  const snap = planned(), b = runBrief(snap);
  const amd = b.positions.find((x) => x.underlying === 'AMD'), stored = snap.positions.find((x) => x.underlying === 'AMD');
  assert.deepEqual([amd.plan, amd.fromHere, amd.recovery], [stored.plan, stored.fromHere, stored.recovery]);
  assert.deepEqual(b.decisions.atStop[0].plan, stored.plan);
  assert.equal(b.positions.find((x) => x.underlying === 'SPX').plan, null);
  for (const k of ['plan', 'fromHere', 'recovery', 'simulation']) assert.ok(b.glossary[k], k);
  assert.deepEqual(b.simulation, snap.sim);
  assert.equal(b.rules.watchAtPctOfMaxLoss, SB.RULES.watch);
  assert.equal(b.rules.hardStopAtPctOfMaxLoss, SB.RULES.hardStop);
  assert.equal(runBrief(snapshot()).simulation, null, 'an old snapshot has none');
});

test('the exit plan slides out from the detail, follows the selected spread, and closes', async (t) => {
  const p = await open(t, planned());
  const drawer = p.$('#drawer');
  showSpread(p, 'AMD');
  assert.equal(drawer.classList.contains('open'), false);
  assert.ok(drawer.hasAttribute('inert'), 'closed, it is out of the tab order');
  assert.match(p.text('#plan-open'), /^Exit plan Stop at \$\d+\.\d\d, stock ≈ \$/);
  p.click(p.$('#plan-open'));
  assert.ok(drawer.classList.contains('open'));
  assert.equal(drawer.hasAttribute('inert'), false);
  assert.equal(p.$('#plan-open').getAttribute('aria-expanded'), 'true');
  assert.equal(p.document.activeElement, p.$('#drawer-close'));
  assert.match(p.text('#drawer-title'), /AMD 230\/235/);
  showSpread(p, 'MSFT');
  assert.ok(drawer.classList.contains('open'), 'stays open for another spread');
  assert.match(p.text('#drawer-title'), /MSFT 400\/405/);
  p.key('Escape');
  assert.equal(drawer.classList.contains('open'), false);
  p.click(p.$('#plan-open'));
  p.click(p.$('#drawer-close'));
  assert.equal(drawer.classList.contains('open'), false);
  // A spread with no plan closes it.
  p.click(p.$('#plan-open'));
  showSpread(p, 'SPX');
  assert.equal(drawer.classList.contains('open'), false);
  assert.deepEqual(p.errors, []);
});

test('the greeks and pay for risk are accordions that start closed and stay as left', async (t) => {
  const p = await open(t, planned());
  const acc = (k) => p.$(`#detail details[data-acc="${k}"]`);
  assert.deepEqual([acc('greeks').open, acc('risk').open], [false, false]);
  assert.match(p.text('#detail details[data-acc="greeks"] summary'), /^Greeks/);
  acc('greeks').open = true;
  acc('greeks').dispatchEvent(new p.window.Event('toggle'));
  showSpread(p, 'MSFT');
  assert.deepEqual([acc('greeks').open, acc('risk').open], [true, false]);
  assert.match(p.text('#detail details[data-acc="greeks"]'), /Theta per day/);
});

test('?spread= opens the page on that spread', async (t) => {
  const snap = planned(), key = SB.spreadKey(SB.enrich({ ...snap.positions.find((x) => x.underlying === 'CSCO') }, snap));
  const p = await open(t, snap, { url: 'http://localhost/index.html?spread=' + encodeURIComponent(key + '#1') });
  assert.match(p.text('#detail h3'), /^CSCO 67\.5\/72\.5/);
  const q = await open(t, snap, { url: 'http://localhost/index.html?spread=nothing' });
  assert.match(q.text('#detail h3'), /^AMD/, 'an unknown key falls back to the usual first spread');
  assert.deepEqual([...p.errors, ...q.errors], []);
});
