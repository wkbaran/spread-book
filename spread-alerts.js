// The stop alerts spread-book wants equity-watch to watch, written to ./shared/spread-alerts.json.
//
// A desired-state file, not a list of changes: it names every alert that should exist, and
// equity-watch reconciles its own against it each run (adds new ones, moves levels, cancels the rest).
// spread-book never sees a spread close, only its absence from the next export, so absence is the
// signal. That makes two cases dangerous, and the file says which one it is:
//   complete: false  the snapshot has no exit plans (sim.js failed or predates them). Change nothing.
//   unpriced: [key]  an open spread with no stock level today (no price, or the stop is out of reach).
//                    Keep its last level rather than cancel it.
// Written by brief.js for the newest snapshot only, so republishing an old one can't rewind the alerts.

const fs   = require('fs');
const path = require('path');
const { takenAt, spreadKey } = require('./book');
const { toSchwab, writeFileAtomic } = require('./betas');

const ALERTS_SCHEMA = 'spread-book/alerts@1';

// One alert per open put or call spread: the stock price at which the spread's loss reaches the stop
// (plan.stop.spot from sim.js), crossed downward for a put spread and upward for a call spread.
// list is the snapshot's positions, enriched (book.js); open is history().open, for the episode.
function buildSpreadAlerts(snap, list, open) {
  const alerts = [], unpriced = [];
  for (const p of list) {
    if (p.kind !== 'put' && p.kind !== 'call') continue;
    const ep = open.get(spreadKey(p));
    const key = `${spreadKey(p)}#${ep ? ep.episode : 1}`;
    const stop = p.plan && p.plan.stop;
    if (!stop || stop.spot === null) { unpriced.push(key); continue; }
    const legs = p.strikes.split('/').map(Number);
    const type = p.kind === 'put' ? 'P' : 'C';
    alerts.push({
      key,
      symbol: toSchwab(p.underlying),
      role: 'stop',
      direction: p.kind === 'put' ? 'down' : 'up',
      level: stop.spot,
      spread: {
        name: p.name, kind: p.kind, expiration: p.expiration,
        short: { strike: p.shortStrike, type },
        long: { strike: p.kind === 'put' ? Math.min(...legs) : Math.max(...legs), type },
        contracts: p.plan.contracts, credit: Math.round((p.maxProfit / 100 / p.plan.contracts) * 100) / 100,
        stopDebit: stop.debit, debitNow: p.plan.debitNow, shortDeltaAtLevel: stop.shortDelta,
      },
    });
  }
  return {
    schema: ALERTS_SCHEMA,
    generatedAt: takenAt(snap),
    spotsAsOf: snap.spotsAsOf ?? null,
    source: snap.source,
    complete: !!snap.sim,
    alerts,
    unpriced,
  };
}

// Writes the file into dir when dir exists (it is the directory shared with equity-watch; without it
// there is no one to read the file). Returns the path written, or null.
function writeSpreadAlerts(dir, doc) {
  if (!fs.existsSync(dir)) return null;
  const file = path.join(dir, 'spread-alerts.json');
  writeFileAtomic(file, JSON.stringify(doc, null, 2) + '\n');
  return file;
}

module.exports = { ALERTS_SCHEMA, buildSpreadAlerts, writeSpreadAlerts };
