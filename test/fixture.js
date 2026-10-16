// A small synthetic book, shaped like the snapshot portfolio.js writes. Taken 2026-03-24 14:12 Mountain.
// It is built to hit the awkward cases: an iron condor, two spreads in one heatmap cell, a spread with no
// beta, zero gamma, no price, and one each ready to close, at the stop and in the roll window.

const SOURCE = 'live-active-by-symbol-2026-03-24_14-12.csv';

const pos = (name, over = {}) => {
  const [underlying] = name.split(' ');
  return {
    name, underlying, expiration: '2026-04-17',
    type: name.includes('Bull Put') ? 'Bull Put' : name.includes('Bear Call') ? 'Bear Call' : 'Other',
    chance: 0.75, credit: 61, maxProfit: 61, maxLoss: 439, ev: -60, returnPct: 10,
    theta: 1.27, vega: -3.28, gamma: -0.24, delta: 5.99, iv: 31.5, ...over,
  };
};

const snapshot = (over = {}) => ({
  generatedAt: '2026-03-24T20:12:00.000Z',
  source: SOURCE,
  spots: { AAPL: 250, AMD: 220, MSFT: 420, NVDA: 170, CSCO: 80, MRNA: 30 },
  spy: 500,
  betas: { AAPL: 1.2, AMD: 1.8, MSFT: null, NVDA: 2, CSCO: 0.9, MRNA: null, SPX: null },
  betasAsOf: '2026-03-24T20:30:00.000Z',
  positions: [
    pos('AAPL Apr 17th 235/240 Bull Put Spread', { returnPct: 55 }),                                            // ready to close
    pos('AAPL Apr 17th 280/285 Bear Call Spread', { returnPct: 10, delta: -3.1, theta: 0.9 }),                  // iron condor with the one above
    pos('AMD Apr 24th 230/235 Bear Call Spread', { expiration: '2026-04-24', returnPct: -200, delta: -4.2, theta: 1.1, gamma: -0.31, vega: -2.2 }), // at the stop, inside 0.5σ
    pos('MSFT May 1st 400/405 Bull Put Spread', { expiration: '2026-05-01', returnPct: -20, gamma: 0, theta: 0.8, vega: -2.9 }), // no beta, zero gamma
    pos('NVDA Apr 17th 155/160 Bull Put Spread', { returnPct: 30, gamma: 0, theta: 1.5, delta: 3.3, vega: -4.1 }),  // zero gamma; shares a cell with the next
    pos('NVDA Apr 17th 150/155 Bull Put Spread', { returnPct: 5, theta: 1.2, delta: 2.4, gamma: -0.12, vega: -3.7 }),
    pos('CSCO Apr 10th 67.5/72.5 Bull Put Spread', { expiration: '2026-04-10', returnPct: 12, theta: 0.7, delta: 4.4, gamma: -0.5, vega: -1.9 }), // 17 days: roll window
    pos('MRNA May 1st 40/45 Bull Put Spread', { expiration: '2026-05-01', returnPct: -35, theta: 2, delta: 6, gamma: -0.9, vega: -5 }),                // no beta
    pos('SPX Apr 17th 5000/5010 Bull Put Spread', { returnPct: 15, theta: 3, delta: 9, gamma: -0.2, vega: -8 }),   // no price, no beta
  ],
  ...over,
});

module.exports = { SOURCE, snapshot, pos };
