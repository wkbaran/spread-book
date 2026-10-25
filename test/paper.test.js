// The paper ledger (paper.js) and its tastytrade client (tastytrade.js), with fake quotes: no network.
const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');
const SB       = require('../book');
const P        = require('../paper');
const { Tastytrade, occSymbol, credentialsFromEnv } = require('../tastytrade');

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} is not ${b}`);
const AT = '2026-10-26T14:00:00.000Z'; // a Monday, 10:00 in New York
const SPEC = { symbol: 'SPY', side: 'put', expiration: '2026-12-04', shortStrike: 600, longStrike: 595, qty: 1 };
const q = (bid, ask, delta, iv = 0.2) => ({ bid, ask, delta, gamma: 0.01, theta: -0.1, vega: 0.5, iv });
// Quotes as tastytrade's client returns them: a Map by OCC symbol.
const quotes = (spec, short, long) => new Map([[occSymbol(spec.symbol, spec.expiration, spec.side, spec.shortStrike), short], [occSymbol(spec.symbol, spec.expiration, spec.side, spec.longStrike), long]]);
const opened = (over = {}) => {
  const ledger = P.emptyLedger();
  const t = P.openTrade(ledger, { ...SPEC, ...over }, { short: q(2.0, 2.1, -0.25), long: q(1.0, 1.1, -0.18) }, AT);
  return { ledger, t };
};

// ---- the OCC symbol and the credentials -------------------------------------------------------------

test('occSymbol: the root padded to six, YYMMDD, the side and the strike × 1000 in eight digits', () => {
  assert.equal(occSymbol('SPY', '2026-12-04', 'put', 600), 'SPY   261204P00600000');
  assert.equal(occSymbol('TLT', '2027-01-08', 'call', 77.5), 'TLT   270108C00077500');
});

test('credentialsFromEnv: both required, null otherwise, so the paper jobs can skip', () => {
  assert.equal(credentialsFromEnv({}), null);
  assert.equal(credentialsFromEnv({ TASTYTRADE_CLIENT_SECRET: 's' }), null);
  assert.deepEqual(credentialsFromEnv({ TASTYTRADE_CLIENT_SECRET: 's', TASTYTRADE_REFRESH_TOKEN: 'r' }), { clientSecret: 's', refreshToken: 'r', clientId: undefined, baseUrl: undefined });
});

// ---- the client --------------------------------------------------------------------------------------

function fakeApi(handler) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const { status = 200, body = {} } = handler(url, init, calls.length) || {};
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { calls, tt: new Tastytrade({ clientSecret: 'sec', refreshToken: 'ref' }, { fetch, sleep: async () => {} }) };
}
const token = { body: { access_token: 'tok' } };

test('the client trades its refresh token for an access token once, and reads option and stock quotes', async () => {
  const { calls, tt } = fakeApi((url) => {
    if (url.endsWith('/oauth/token')) return token;
    if (url.includes('equity-option=')) return { body: { data: { items: [
      { symbol: 'SPY   261204P00600000', bid: '2.0', ask: '2.1', delta: '-0.25', gamma: '0.01', theta: '-0.1', vega: '0.5', volatility: '0.2' },
      { symbol: 'SPY   261204P00595000', bid: '1.0', ask: null, delta: '-0.18' }, // one-sided: left out
    ] } } };
    return { body: { data: { items: [{ symbol: 'SPY', mark: '610.5' }] } } };
  });
  const o = await tt.optionQuotes(['SPY   261204P00600000', 'SPY   261204P00595000']);
  assert.deepEqual([...o.keys()], ['SPY   261204P00600000']);
  assert.deepEqual(o.get('SPY   261204P00600000'), { bid: 2, ask: 2.1, delta: -0.25, gamma: 0.01, theta: -0.1, vega: 0.5, iv: 0.2 });
  assert.equal((await tt.equityQuotes(['SPY'])).get('SPY'), 610.5);
  assert.equal(calls.filter((c) => c.url.endsWith('/oauth/token')).length, 1, 'the token is reused');
  assert.equal(JSON.parse(calls[0].init.body).refresh_token, 'ref');
  assert.match(calls[1].url, /equity-option=SPY%20%20%20261204P00600000,SPY%20%20%20261204P00595000$/);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer tok');
});

test('the client gets a fresh token after a 401, retries a 500, and its errors carry no query string', async () => {
  let n = 0;
  const { tt } = fakeApi((url) => {
    if (url.endsWith('/oauth/token')) return token;
    n++;
    if (n === 1) return { status: 401 };
    if (n === 2) return { status: 500 };
    return { body: { data: { items: [] } } };
  });
  assert.equal((await tt.equityQuotes(['SPY'])).size, 0);
  const { tt: down } = fakeApi((url) => (url.endsWith('/oauth/token') ? token : { status: 403 }));
  await assert.rejects(down.equityQuotes(['SECRET']), (e) => e.status === 403 && !e.message.includes('SECRET'));
});

// ---- opening ------------------------------------------------------------------------------------------

test('checkSpec: a plain bull put or bear call, the short strike nearer the money', () => {
  assert.equal(P.checkSpec(SPEC), null);
  assert.equal(P.checkSpec({ ...SPEC, side: 'call', shortStrike: 620, longStrike: 625 }), null);
  for (const [what, s] of Object.entries({
    'a lowercase symbol': { ...SPEC, symbol: 'spy' },
    'another side': { ...SPEC, side: 'straddle' },
    'a US date': { ...SPEC, expiration: '12/4/26' },
    'a put spread the wrong way round': { ...SPEC, shortStrike: 595, longStrike: 600 },
    'a call spread the wrong way round': { ...SPEC, side: 'call' },
    'no quantity': { ...SPEC, qty: 0 },
    'part of a contract': { ...SPEC, qty: 1.5 },
  })) assert.ok(P.checkSpec(s), what);
});

test('openPrice: the fill is halfway from the mid to the natural, rounded down to the cent', () => {
  const p = P.openPrice({ short: q(2.0, 2.1, -0.25), long: q(1.0, 1.1, -0.18) });
  close(p.mid, 1.0);
  close(p.natural, 0.9);
  assert.equal(p.fill, 0.95);
  assert.equal(P.openPrice({ short: q(2.0, 2.11, -0.25), long: q(1.0, 1.1, -0.18) }).fill, 0.95, '0.9525 rounds down');
});

test('openTrade records the fill, the quotes it used, the fees and the resting target at half the credit', () => {
  const { ledger, t } = opened({ qty: 2 });
  assert.equal(t.id, 'P1');
  assert.equal(t.credit, 0.95);
  assert.equal(t.target.debit, 0.48);
  assert.equal(t.fees, 4, '$1 a contract to open, two legs, two contracts');
  assert.deepEqual(t.openQuotes, { short: { bid: 2, ask: 2.1 }, long: { bid: 1, ask: 1.1 } });
  assert.equal(t.close, null);
  assert.equal(ledger.nextId, 2);
});

test('openTrade: a ticket opens one trade however often it is sent, and a fill that is no credit is refused', () => {
  const ledger = P.emptyLedger();
  const legs = { short: q(2.0, 2.1, -0.25), long: q(1.0, 1.1, -0.18) };
  P.openTrade(ledger, SPEC, legs, AT, 'tk-1');
  assert.throws(() => P.openTrade(ledger, SPEC, legs, AT, 'tk-1'), /already used/);
  assert.throws(() => P.openTrade(ledger, SPEC, { short: q(1.0, 1.1, -0.2), long: q(1.0, 1.1, -0.18) }, AT), /no credit/);
  assert.throws(() => P.openTrade(ledger, { ...SPEC, qty: 0 }, legs, AT), /quantity/);
  assert.equal(ledger.trades.length, 1);
});

test('quotesFor: both legs, two-sided, or null', () => {
  const { t } = opened();
  assert.ok(P.quotesFor(t, quotes(t, q(1, 1.1, -0.2), q(0.5, 0.6, -0.1))));
  assert.equal(P.quotesFor(t, quotes(t, q(1, 1.1, -0.2), undefined)), null);
  assert.equal(P.quotesFor(t, quotes(t, q(1, 0, -0.2), q(0.5, 0.6, -0.1))), null, 'no ask');
  assert.equal(P.quotesFor(t, quotes(t, q(1.2, 1.1, -0.2), q(0.5, 0.6, -0.1))), null, 'a crossed quote');
});

// ---- closing ------------------------------------------------------------------------------------------

test('fillTargets: closes when buying back at the natural costs no more than the limit, and fills at the limit', () => {
  const { ledger, t } = opened(); // target 0.48
  assert.deepEqual(P.fillTargets(ledger, quotes(t, q(0.6, 0.7, -0.1), q(0.2, 0.21, -0.05)), AT), [], 'natural 0.50: not yet');
  assert.equal(t.close, null);
  const done = P.fillTargets(ledger, quotes(t, q(0.55, 0.6, -0.1), q(0.12, 0.13, -0.05)), AT); // natural 0.48
  assert.equal(done.length, 1);
  assert.deepEqual({ debit: t.close.debit, reason: t.close.reason }, { debit: 0.48, reason: 'target' });
  close(P.pnl(t), 47 - 2, 1e-6);
  assert.deepEqual(P.fillTargets(ledger, quotes(t, q(0, 0.01, 0), q(0, 0.01, 0)), AT), [], 'a closed trade stays closed');
});

test('expireTrades: past the expiration, the spread is worth what is inside the short strike, up to the width', () => {
  const at = '2026-12-05T15:00:00.000Z';
  const worth = (spot, over) => {
    const { ledger, t } = opened(over);
    P.expireTrades(ledger, new Map([[t.symbol, spot]]), '2026-12-05', at);
    return t.close && t.close.debit;
  };
  assert.equal(worth(610), 0);
  assert.equal(worth(598), 2);
  assert.equal(worth(590), 5);
  assert.equal(worth(624, { side: 'call', shortStrike: 620, longStrike: 625 }), 4);
  const { ledger, t } = opened();
  P.expireTrades(ledger, new Map([[t.symbol, 590]]), '2026-12-04', at);
  assert.equal(t.close, null, 'not on the expiration day itself');
  P.expireTrades(ledger, new Map(), '2026-12-05', at);
  assert.equal(t.close, null, 'and not without a price');
});

// ---- the snapshot -------------------------------------------------------------------------------------

test('snapshotCsv writes export rows that read back as the same spread, marked at the mid', () => {
  const { ledger, t } = opened();
  const now = Date.parse(AT);
  const snap = P.snapshotCsv(ledger, quotes(t, q(1.2, 1.3, -0.2, 0.2), q(0.6, 0.7, -0.15, 0.22)), new Map([['SPY', 610]]), now);
  assert.deepEqual(snap.missing, []);
  const lines = snap.csv.trim().split('\n');
  assert.equal(lines.length, 3, 'the two header lines portfolio.js skips, then one row');
  assert.match(lines[0], /^Name,Total Return %/);
  const row = SB.parseTrade(lines[2]); // the page's own reader for an export row
  assert.equal(row.name, 'SPY Dec 4th 595/600 Bull Put Spread');
  assert.equal(row.expiration, '12/4/26 16:00');
  assert.equal(row.credit, 95);
  assert.equal(row.maxLoss, 405);
  close(row.returnPct, ((0.95 - 0.6) / 0.95) * 100, 0.006); // the mark is the mid, 0.60
  close(row.delta, 5, 1e-9); // (−0.15 − −0.2) × 100
  close(row.iv, 20, 1e-9); // the short leg's
  assert.ok(row.chance > 0.5 && row.chance < 1);
  assert.equal(SB.spreadKey(SB.enrich(row, { positions: [] })), SB.spreadKey(SB.enrich(SB.tryTrade({ symbol: 'SPY', side: 'put', expiration: '2026-12-04', credit: 0.95, short: { strike: 600 }, long: { strike: 595 } }), { positions: [] })));
});

test('snapshotCsv: closed trades are left out, and a trade with no quotes stops the snapshot', () => {
  const { ledger, t } = opened();
  const other = P.openTrade(ledger, { ...SPEC, symbol: 'QQQ', shortStrike: 500, longStrike: 495 }, { short: q(2.0, 2.1, -0.25), long: q(1.0, 1.1, -0.18) }, AT);
  const snap = P.snapshotCsv(ledger, quotes(t, q(1.2, 1.3, -0.2), q(0.6, 0.7, -0.15)), new Map(), Date.parse(AT));
  assert.deepEqual(snap.missing, [other.id]);
  assert.equal(snap.csv.trim().split('\n').length, 2, 'no rows at all: one left out would read as closed');
  P.closeTrade(other, 0.5, AT, 'manual');
  assert.equal(P.snapshotCsv(ledger, quotes(t, q(1.2, 1.3, -0.2), q(0.6, 0.7, -0.15)), new Map(), Date.parse(AT)).csv.trim().split('\n').length, 3);
});

test('chanceNow: past the break-even is likely when the stock is well above a put, and falls back to the delta', () => {
  const { t } = opened();
  const legs = { short: q(1, 1.1, -0.2, 0.2), long: q(0.5, 0.6, -0.15, 0.22) };
  const far = P.chanceNow(t, legs, 680, Date.parse(AT)), near = P.chanceNow(t, legs, 600, Date.parse(AT));
  assert.ok(far > 0.9 && near > 0.4 && near < far);
  close(P.chanceNow(t, legs, undefined, Date.parse(AT)), 0.8);
  const call = opened({ side: 'call', shortStrike: 620, longStrike: 625 }).t;
  assert.ok(P.chanceNow(call, legs, 560, Date.parse(AT)) > 0.9);
});

// ---- dates, the session, files -----------------------------------------------------------------------

test('marketOpen: 9:30 to 16:00 New York on weekdays; nyDate and denverStamp read their own zones', () => {
  assert.equal(P.marketOpen(Date.parse('2026-10-26T13:29:00Z')), false); // 9:29 EDT
  assert.equal(P.marketOpen(Date.parse('2026-10-26T13:30:00Z')), true);
  assert.equal(P.marketOpen(Date.parse('2026-10-26T19:59:00Z')), true);
  assert.equal(P.marketOpen(Date.parse('2026-10-26T20:00:00Z')), false);
  assert.equal(P.marketOpen(Date.parse('2026-10-24T15:00:00Z')), false); // a Saturday
  assert.equal(P.marketOpen(Date.parse('2026-12-01T14:45:00Z')), true); // 9:45 EST
  assert.equal(P.nyDate(new Date('2026-10-27T02:00:00Z')), '2026-10-26');
  assert.equal(P.denverStamp(new Date('2026-10-26T14:05:00Z')), '2026-10-26_08-05');
  assert.equal(P.denverShort('2026-10-26T14:05:00Z'), '10/26/26 08:05');
});

test('the ledger file: missing is empty, unreadable is an error rather than empty, and writes are whole', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spread-book-paper-'));
  try {
    const file = path.join(dir, 'ledger.json');
    assert.deepEqual(P.loadLedger(file), P.emptyLedger());
    const { ledger } = opened();
    P.saveLedger(ledger, file);
    assert.deepEqual(P.loadLedger(file), ledger);
    fs.writeFileSync(file, '{"trades": [');
    assert.throws(() => P.loadLedger(file));
    fs.writeFileSync(file, '{"trades": []}');
    assert.throws(() => P.loadLedger(file), /not a paper ledger/);
    // one command at a time
    let inner;
    await P.withLock(dir, async () => { inner = await P.withLock(dir, async () => 'twice').catch((e) => e.message); });
    assert.match(inner, /another paper command/);
    assert.equal(await P.withLock(dir, async () => 'again'), 'again', 'the lock is released');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
