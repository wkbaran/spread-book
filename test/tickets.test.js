// The ticket watcher's handling of one ticket (ticket-watch.js), with a scratch ledger and fake quotes.
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');
const P        = require('../paper');
const W        = require('../ticket-watch');
const { occSymbol } = require('../tastytrade');

const NOW = Date.parse('2026-10-26T15:00:00Z'); // a Monday, 11:00 in New York
const trade = { symbol: 'SPY', side: 'put', expiration: '2026-12-04', shortStrike: 600, longStrike: 595, qty: 1 };
const q = (bid, ask, delta) => ({ bid, ask, delta, gamma: 0.01, theta: -0.1, vega: 0.5, iv: 0.2 });
const body = (over = {}) => JSON.stringify({ id: 'tk-0001-aaaa', type: 'paper.open', receivedAt: new Date(NOW - 5000).toISOString(), trade, ...over });

function scratch(t, quotes = new Map([[occSymbol('SPY', '2026-12-04', 'put', 600), q(2.0, 2.1, -0.25)], [occSymbol('SPY', '2026-12-04', 'put', 595), q(1.0, 1.1, -0.18)]])) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spread-book-tickets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const deps = { now: () => NOW, dir, ledgerFile: path.join(dir, 'ledger.json'), resultsFile: path.join(dir, 'tickets.json'),
    quotes: async (occs) => { calls.push(occs); return quotes; } };
  return { dir, deps, calls, ledger: () => P.loadLedger(deps.ledgerFile) };
}

test('a paper.open ticket opens a paper trade carrying the ticket id, at the paper fill', async (t) => {
  const s = scratch(t);
  const r = await W.handle(body(), s.deps);
  assert.equal(r.status, 'opened');
  assert.equal(r.tradeId, 'P1');
  assert.equal(r.credit, 0.95);
  assert.match(r.message, /^Opened P1, SPY 2026-12-04 595\/600 bull put, for 0\.95/);
  const [tr] = s.ledger().trades;
  assert.equal(tr.ticket, 'tk-0001-aaaa');
  assert.equal(tr.qty, 1);
});

test('the same ticket twice opens one trade: a recorded result is returned again, and so is a trade already opened', async (t) => {
  const s = scratch(t);
  const first = await W.handle(body(), s.deps);
  W.recordResult(first, s.deps.resultsFile);
  const again = await W.handle(body(), s.deps);
  assert.equal(again.repeat, true);
  assert.equal(again.tradeId, 'P1');
  // a crash after the ledger was written but before the result was recorded
  fs.rmSync(s.deps.resultsFile);
  const replay = await W.handle(body(), s.deps);
  assert.equal(replay.status, 'opened');
  assert.match(replay.message, /^Already opened P1/);
  assert.equal(s.ledger().trades.length, 1);
});

test('tickets that are stale, from outside the session, of another type or malformed are rejected without quotes', async (t) => {
  const s = scratch(t);
  for (const [what, b, want] of [
    ['stale', body({ receivedAt: new Date(NOW - 6 * 60_000).toISOString() }), /6 minutes old/],
    ['no receipt time', body({ receivedAt: undefined }), /unknown/],
    ['another type', body({ type: 'real.open' }), /doesn't handle real\.open/],
    ['a bad spread', body({ trade: { ...trade, shortStrike: 590 } }), /bull put sells the higher strike/],
    ['too many contracts', body({ trade: { ...trade, qty: 11 } }), /at most 10 contracts/],
    ['not JSON', '{', /not a ticket/],
    ['an id that is a path', body({ id: '../../index' }), /not a ticket/],
  ]) {
    const r = await W.handle(b, s.deps);
    assert.equal(r.status, 'rejected', what);
    assert.match(r.message, want, what);
  }
  const evening = Date.parse('2026-10-26T21:00:00Z'); // 17:00 in New York
  const closed = await W.handle(body({ receivedAt: new Date(evening - 5000).toISOString() }), { ...s.deps, now: () => evening });
  assert.match(closed.message, /market is closed/);
  assert.equal(s.calls.length, 0, 'no quotes asked for');
  assert.equal(s.ledger().trades.length, 0);
});

test('no quotes, or no credit at them, is a rejection; a quote failure is an exception, left to retry', async (t) => {
  const none = scratch(t, new Map());
  assert.match((await W.handle(body(), none.deps)).message, /no two-sided quotes/);
  const flat = scratch(t, new Map([[occSymbol('SPY', '2026-12-04', 'put', 600), q(1, 1.1, -0.2)], [occSymbol('SPY', '2026-12-04', 'put', 595), q(1, 1.1, -0.18)]]));
  assert.match((await W.handle(body(), flat.deps)).message, /no credit/);
  const down = scratch(t);
  await assert.rejects(W.handle(body(), { ...down.deps, quotes: async () => { throw new Error('tastytrade down'); } }), /tastytrade down/);
  assert.equal(down.ledger().trades.length, 0);
});

test('results are kept by id, newest last, and an unreadable results file is an error, not a fresh start', (t) => {
  const s = scratch(t);
  W.recordResult({ id: 'a', status: 'rejected' }, s.deps.resultsFile);
  W.recordResult({ id: 'b', status: 'opened' }, s.deps.resultsFile);
  W.recordResult({ id: 'a', status: 'opened' }, s.deps.resultsFile);
  assert.deepEqual(W.loadResults(s.deps.resultsFile).results.map((r) => r.id + ':' + r.status), ['b:opened', 'a:opened']);
  fs.writeFileSync(s.deps.resultsFile, '{');
  assert.throws(() => W.loadResults(s.deps.resultsFile));
});

test('the watcher is configured only when the queue, bucket and its own keys are all set', () => {
  const full = { TICKETS_QUEUE_URL: 'https://sqs.example/q.fifo', TICKETS_BUCKET: 'b', TICKETS_AWS_ACCESS_KEY_ID: 'k', TICKETS_AWS_SECRET_ACCESS_KEY: 's' };
  assert.equal(W.config(full).region, 'us-east-1');
  assert.equal(W.config({ ...full, TICKETS_BUCKET: '' }), null);
  assert.equal(W.config({ ...full, AWS_ACCESS_KEY_ID: 'publish', TICKETS_AWS_ACCESS_KEY_ID: undefined }), null, 'never the publish key');
});

// spread-scanner's ticket Lambda queues exactly the types this watcher handles (plus "ping", which never reaches the queue).
const scannerStack = path.join(__dirname, '..', '..', 'spread-scanner', 'infra', 'cloudformation.yaml');
test('the scanner\'s ticket Lambda and this watcher agree on the ticket types', { skip: !fs.existsSync(scannerStack) && 'spread-scanner is not checked out next to this repo' }, () => {
  const m = /const TYPES = (\[[^\]]*\]);/.exec(fs.readFileSync(scannerStack, 'utf8'));
  assert.ok(m, 'TYPES moved in the scanner\'s template');
  assert.deepEqual(JSON.parse(m[1]).filter((x) => x !== 'ping').sort(), [...W.TICKET_TYPES].sort());
});

test('the scanner\'s ticket Lambda and this watcher accept the same ids and quantities', { skip: !fs.existsSync(scannerStack) && 'spread-scanner is not checked out next to this repo' }, () => {
  const src = fs.readFileSync(scannerStack, 'utf8');
  const id = /const ID = \/(.+)\/;/.exec(src), qty = /t\.qty > (\d+)\)/.exec(src);
  assert.ok(id && qty, 'ID or the qty limit moved in the scanner\'s template');
  assert.equal(id[1], W.TICKET_ID.source);
  assert.equal(Number(qty[1]), W.WATCH.maxQty);
});
