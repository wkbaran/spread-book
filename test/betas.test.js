const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');
const B        = require('../betas');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betas-'));
const write = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };

// Two header lines, then each spread followed by its legs, as OptionStrat exports them.
const CSV = [
  'Name,Total Return %,Total Return $,Created At,Expiration',
  'Symbol,Quantity,Entry Price,Current Price,Close Price',
  'AAPL Apr 17th 235/240 Bull Put Spread,-26.23%, $(16.00),3/4/26 19:06,4/17/26 20:00',
  '.AAPL260417P235,1, $2.32 , $2.00 ,',
  '.AAPL260417P240,-1, $2.93 , $2.77 ,',
  'AMD Apr 24th 230/235 Bear Call Spread,-24.81%, $(16.00),3/13/26 16:39,4/24/26 20:00',
  'AAPL May 15th 230/235 Bear Call Spread,1%, $1.00,3/13/26 16:39,5/15/26 20:00',
  'BRK.B Apr 17th 480/485 Bull Put Spread,1%, $1.00,3/13/26 16:39,4/17/26 20:00',
  '',
].join('\n');

test('the underlyings are each symbol once, in file order, skipping legs and headers', () => {
  assert.deepEqual(B.underlyingsFromCsv(CSV), ['AAPL', 'AMD', 'BRK.B']);
});

test('class shares are spelled the way Schwab wants them, and back', () => {
  assert.equal(B.toSchwab('BRK.B'), 'BRK/B');
  assert.equal(B.fromSchwab('BRK/B'), 'BRK.B');
  assert.equal(B.toSchwab('AAPL'), 'AAPL');
});

test('the list file is one symbol per line under a comment, in the form equity-watch reads', () => {
  const out = path.join(dir, 'underlyings.txt');
  const n = B.writeUnderlyings(write('book.csv', CSV), out, new Date('2026-10-12T13:45:00Z'));
  assert.equal(n, 3);
  const text = fs.readFileSync(out, 'utf8');
  assert.ok(text.startsWith('# written by spread-book from book.csv at 2026-10-12T13:45:00.000Z\n'));
  // equity-watch drops everything after '#', then blanks, then trims.
  const symbols = text.split(/\r?\n/).map(l => l.split('#')[0].trim()).filter(Boolean);
  assert.deepEqual(symbols, ['AAPL', 'AMD', 'BRK/B']);
  assert.equal(fs.statSync(out).mode & 0o777, 0o644);
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), []);
});

test('an empty list leaves the existing file alone', () => {
  const out = write('keep.txt', 'AAPL\n');
  assert.equal(B.writeUnderlyings(write('empty.csv', 'a\nb\n'), out), 0);
  assert.equal(fs.readFileSync(out, 'utf8'), 'AAPL\n');
});

const doc = (over = {}) => JSON.stringify({
  schema: 'equity-watch/betas@1', generatedAt: '2026-10-12T14:05:00.000Z',
  source: 'schwab instruments fundamental', definition: 'x', betas: { AAPL: 1.21, IWM: null, 'BRK/B': 0.9 }, ...over,
});

test('betas are read back under the export\'s spelling, with null kept', () => {
  const got = B.readBetas(write('ok.json', doc()));
  assert.deepEqual(got, { asOf: '2026-10-12T14:05:00.000Z', betas: { AAPL: 1.21, IWM: null, 'BRK.B': 0.9 } });
});

test('a value that is not a number reads as null, not as a beta', () => {
  const got = B.readBetas(write('odd.json', doc({ betas: { AAPL: '1.2', MSFT: 1.1 } })));
  assert.deepEqual(got.betas, { AAPL: null, MSFT: 1.1 });
});

test('a missing, unreadable or foreign file is null rather than an error', () => {
  const warn = console.warn; console.warn = () => {};
  try {
    assert.equal(B.readBetas(path.join(dir, 'absent.json')), null);
    assert.equal(B.readBetas(write('junk.json', '{not json')), null);
    assert.equal(B.readBetas(write('v2.json', doc({ schema: 'equity-watch/betas@2' }))), null);
    assert.equal(B.readBetas(write('nodate.json', doc({ generatedAt: undefined }))), null);
    assert.equal(B.readBetas(write('nobetas.json', doc({ betas: undefined }))), null);
  } finally { console.warn = warn; }
});

test('the open paper trades\' symbols are listed too, after the export\'s, once each; never on their own', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spread-book-betas-paper-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = path.join(dir, 'ledger.json');
  assert.deepEqual(B.paperUnderlyings(ledger), [], 'no ledger, no paper symbols');
  fs.writeFileSync(ledger, JSON.stringify({ trades: [{ symbol: 'SPY', close: null }, { symbol: 'AAPL', close: null }, { symbol: 'QQQ', close: { debit: 1 } }, { symbol: 'SPY', close: null }] }));
  assert.deepEqual(B.paperUnderlyings(ledger), ['SPY', 'AAPL'], 'open trades only, once each');
  const csv = path.join(dir, 'book.csv'), out = path.join(dir, 'underlyings.txt');
  fs.writeFileSync(csv, CSV);
  assert.equal(B.writeUnderlyings(csv, out, new Date(), B.paperUnderlyings(ledger)), 4);
  assert.deepEqual(fs.readFileSync(out, 'utf8').split('\n').slice(1, -1), ['AAPL', 'AMD', 'BRK/B', 'SPY']);
  fs.writeFileSync(csv, 'a\nb\n');
  fs.rmSync(out);
  assert.equal(B.writeUnderlyings(csv, out, new Date(), ['SPY']), 0, 'an empty export writes nothing, paper or not');
  assert.equal(fs.existsSync(out), false);
  fs.writeFileSync(ledger, '{');
  assert.deepEqual(B.paperUnderlyings(ledger), []);
});
