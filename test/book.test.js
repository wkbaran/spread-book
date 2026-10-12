const { test } = require('node:test');
const assert   = require('node:assert/strict');
const SB       = require('../book');

// A snapshot taken 2026-03-24 Mountain time, so a spread expiring 4/17/26 has 24 days left.
const SOURCE = 'live-active-by-symbol-2026-03-24_14-12.csv';
const snap = (spots) => ({ source: SOURCE, generatedAt: '2026-03-24T20:12:00.000Z', spots });

const spread = (over = {}) => ({
  name: 'AAPL Apr 17th 235/240 Bull Put Spread', underlying: 'AAPL', type: 'Bull Put',
  expiration: '4/17/26 20:00', returnPct: 0, maxLoss: 439, maxProfit: 61, chance: 0.75,
  theta: 1.27, gamma: -0.24, vega: -3.28, iv: 31.49, ...over,
});

const move = (spot, iv, days) => spot * (iv / 100) * Math.sqrt(days / 365);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

// The spot at which a spread sits exactly z expected moves from its short strike.
function spotAt(p, z) {
  const m = (p.iv / 100) * Math.sqrt(p.dte / 365);
  return p.kind === 'put' ? p.shortStrike / (1 - z * m) : p.shortStrike / (1 + z * m);
}

test('a put spread measures from the higher strike, up to the stock', () => {
  const p = SB.enrich(spread(), snap({ AAPL: 250 }));
  assert.equal(p.dte, 24);
  assert.equal(p.shortStrike, 240);
  close(p.z, (250 - 240) / move(250, 31.49, 24));
});

test('a call spread measures from the lower strike, down to the stock', () => {
  const p = SB.enrich(spread({ name: 'AMD Apr 17th 230/235 Bear Call Spread', underlying: 'AMD', type: 'Bear Call' }), snap({ AMD: 220 }));
  assert.equal(p.shortStrike, 230);
  close(p.z, (230 - 220) / move(220, 31.49, 24));
});

test('decimal strikes are read whole', () => {
  const p = SB.enrich(spread({ name: 'CSCO Apr 17th 67.5/72.5 Bull Put Spread', underlying: 'CSCO' }), snap({ CSCO: 80 }));
  assert.equal(p.shortStrike, 72.5);
});

test('a stock past the short strike is negative and flagged', () => {
  const p = SB.enrich(spread(), snap({ AAPL: 238 }));
  assert.ok(p.z < 0);
  assert.equal(p.nearStrike, true);
});

test('the flag turns on just inside RULES.strikeSigma and off just outside', () => {
  const probe = SB.enrich(spread(), snap({}));
  const inside  = SB.enrich(spread(), snap({ AAPL: spotAt(probe, SB.RULES.strikeSigma - 0.01) }));
  const outside = SB.enrich(spread(), snap({ AAPL: spotAt(probe, SB.RULES.strikeSigma + 0.01) }));
  assert.equal(inside.nearStrike, true);
  assert.equal(outside.nearStrike, false);
  close(inside.z, SB.RULES.strikeSigma - 0.01);
});

test('z is null, and nothing is flagged, when it cannot be worked out', () => {
  const cases = {
    'no spots at all':        [spread(), snap(undefined)],
    'no price for the symbol': [spread(), snap({ MSFT: 400 })],
    'a zero price':           [spread(), snap({ AAPL: 0 })],
    'no IV':                  [spread({ iv: 0 }), snap({ AAPL: 250 })],
    'a spread that is neither put nor call': [spread({ type: 'Other' }), snap({ AAPL: 250 })],
    'no strikes in the name': [spread({ name: 'AAPL Apr 17th Bull Put Spread' }), snap({ AAPL: 250 })],
  };
  for (const [what, [p, s]] of Object.entries(cases)) {
    const out = SB.enrich(p, s);
    assert.equal(out.z, null, what);
    assert.equal(out.nearStrike, false, what);
  }
});

test('a spread expiring today still has a day of room, so z stays finite', () => {
  const p = SB.enrich(spread({ expiration: '3/24/26 20:00' }), snap({ AAPL: 250 }));
  assert.equal(p.dte, 0);
  close(p.z, (250 - 240) / move(250, 31.49, 1));
});

test('the warning is informational: it adds nobody to a decision list', () => {
  const p = SB.enrich(spread(), snap({ AAPL: 238 }));
  assert.equal(p.nearStrike, true);
  const lists = SB.decide([p]);
  assert.deepEqual(Object.values(lists).map((l) => l.length), [0, 0, 0, 0]);
});

test('the exit rules are unchanged by a price', () => {
  const win  = SB.enrich(spread({ returnPct: 55 }), snap({ AAPL: 250 }));
  // Return % is a share of max profit; -200% of $61 is $122, 27.8% of the $439 max loss.
  const lose = SB.enrich(spread({ returnPct: -200 }), snap({ AAPL: 250 }));
  assert.equal(win.exit, 'close');
  assert.equal(lose.exit, 'stop');
});
