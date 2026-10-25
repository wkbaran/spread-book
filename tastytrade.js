// A small read-only tastytrade client: option and stock quotes for the paper ledger (paper.js).
//
// A port of the quote calls in spread-scanner's src/providers/tastytrade.ts, kept here because this project
// is CommonJS with no build step (like sim.js and outcome.ts). spread-book has its own OAuth client, read-only,
// separate from the scanner's: TASTYTRADE_CLIENT_SECRET and TASTYTRADE_REFRESH_TOKEN in .env. Error messages
// never carry a query string or a response body, either of which can hold a credential.
'use strict';

const BATCH = 100; // the quote call takes at most 100 symbols a request
const TOKEN_LIFETIME_MS = 10 * 60_000; // tokens last 15 minutes; refresh early

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const chunk = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

// The OCC symbol tastytrade quotes an option by: the root padded to six, YYMMDD, C or P, strike × 1000 in 8 digits.
// e.g. occSymbol('SPY', '2026-12-04', 'put', 600) → 'SPY   261204P00600000'
function occSymbol(symbol, expiration, side, strike) {
  const [y, m, d] = expiration.split('-');
  return `${symbol.padEnd(6)}${y.slice(2)}${m}${d}${side === 'put' ? 'P' : 'C'}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
}

// The credentials in env, or null when either required one is missing (the paper jobs then skip).
function credentialsFromEnv(env = process.env) {
  const clientSecret = env.TASTYTRADE_CLIENT_SECRET, refreshToken = env.TASTYTRADE_REFRESH_TOKEN;
  if (!clientSecret || !refreshToken) return null;
  return { clientSecret, refreshToken, clientId: env.TASTYTRADE_CLIENT_ID || undefined, baseUrl: env.TASTYTRADE_BASE_URL || undefined };
}

class HttpError extends Error {
  constructor(status, where) {
    super(`HTTP ${status} from ${where}`);
    this.status = status;
  }
}

class Tastytrade {
  constructor(credentials, { fetch: fetchFn = fetch, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.credentials = credentials;
    this.baseUrl = credentials.baseUrl || 'https://api.tastyworks.com';
    this.fetch = fetchFn;
    this.now = now;
    this.sleep = sleep;
    this.token = null;
  }

  // JSON from tastytrade, retrying 429, 5xx and network errors a few times.
  async json(url, init = {}) {
    const where = url.split('?')[0];
    for (let attempt = 1; ; attempt++) {
      let res = null;
      try {
        res = await this.fetch(url, { method: init.method || 'GET', headers: { 'User-Agent': 'spread-book', Accept: 'application/json', ...init.headers }, body: init.body });
      } catch (_) { /* a network error: retried below */ }
      if (res && res.ok) return res.json();
      const status = res ? res.status : 0;
      if ((res && status !== 429 && status < 500) || attempt >= 3) throw new HttpError(status, where);
      await this.sleep(500 * 2 ** (attempt - 1));
    }
  }

  async accessToken(force) {
    if (!force && this.token && this.now() - this.token.at < TOKEN_LIFETIME_MS) return this.token.value;
    const c = this.credentials;
    const body = { grant_type: 'refresh_token', refresh_token: c.refreshToken, client_secret: c.clientSecret, ...(c.clientId ? { client_id: c.clientId } : {}) };
    const res = await this.json(`${this.baseUrl}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (typeof res.access_token !== 'string') throw new Error('tastytrade returned no access token');
    this.token = { value: res.access_token, at: this.now() };
    return this.token.value;
  }

  async items(path) {
    const call = async (force) => this.json(`${this.baseUrl}${path}`, { headers: { Authorization: `Bearer ${await this.accessToken(force)}` } });
    let res;
    try { res = await call(false); } catch (e) {
      if (!(e instanceof HttpError && e.status === 401)) throw e;
      res = await call(true); // an expired token: once more with a fresh one
    }
    const items = res && res.data && res.data.items;
    return Array.isArray(items) ? items : [];
  }

  // OCC symbol → { bid, ask, delta, gamma, theta, vega, iv }, per share, iv a fraction. Contracts not returned are absent.
  async optionQuotes(occs) {
    const out = new Map();
    for (const batch of chunk([...new Set(occs)], BATCH)) {
      for (const it of await this.items(`/market-data/by-type?equity-option=${batch.map(encodeURIComponent).join(',')}`)) {
        const bid = num(it.bid), ask = num(it.ask), delta = num(it.delta);
        if (typeof it.symbol !== 'string' || bid === null || ask === null || delta === null) continue;
        out.set(it.symbol, { bid, ask, delta, gamma: num(it.gamma), theta: num(it.theta), vega: num(it.vega), iv: num(it.volatility) });
      }
    }
    return out;
  }

  // Symbol → the stock's mark.
  async equityQuotes(symbols) {
    const out = new Map();
    for (const batch of chunk([...new Set(symbols)], BATCH)) {
      for (const it of await this.items(`/market-data/by-type?equity=${batch.map(encodeURIComponent).join(',')}`)) {
        const mark = num(it.mark) ?? num(it.mid) ?? num(it.last);
        if (typeof it.symbol === 'string' && mark !== null) out.set(it.symbol, mark);
      }
    }
    return out;
  }
}

module.exports = { Tastytrade, HttpError, occSymbol, credentialsFromEnv };
