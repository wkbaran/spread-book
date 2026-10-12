/* Spread book — exit rules and the numbers derived from each spread.
 *
 * Shared by report.js in the browser (portfolio.js inlines this file ahead of
 * it, where it sets globalThis.SpreadBook) and brief.js in Node, so the page
 * and latest.json always agree on what is ready to close.
 */
(function () {
  "use strict";

  const RULES = {
    target: 50, // close winners at 50% of max profit
    stop: 25, // close losers when the loss reaches 25% of max loss
    rollDays: 21, // close or roll inside this many days
    near: 0.6, // "getting close": this far toward either exit
    strikeSigma: 0.5, // flag a spread when its short strike is within this many expected moves of the stock
    betaMaxAgeDays: 10, // ignore betas computed more than this long before the snapshot
    closedDays: 60, // how far back the closed-spreads list reaches
  };

  // "4/17/26 14:00" or "2026-04-17" → "2026-04-17"
  function isoDate(s) {
    const m = String(s || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (!m) return String(s || "").slice(0, 10);
    return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }

  // download.js stamps filenames with America/Denver wall-clock time; turn one into an instant.
  function fromDenver(date, hh, mm) {
    const guess = new Date(`${date}T${hh}:${mm}:00Z`);
    const off = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", timeZoneName: "longOffset" })
      .formatToParts(guess).find((p) => p.type === "timeZoneName").value; // e.g. "GMT-06:00"
    const m = off.match(/([+-])(\d{2}):(\d{2})/);
    const mins = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
    return new Date(guess.getTime() - mins * 60000);
  }

  // When the snapshot was taken. The source CSV's name carries it in Mountain time (download.js
  // stamps it that way). Older JSON files were backfilled or read the stamp as UTC, so their
  // generatedAt can't be trusted.
  function takenAt(snap) {
    const m = String(snap.source || "").match(/(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})/);
    return m ? fromDenver(m[1], m[2], m[3]).toISOString() : snap.generatedAt;
  }

  // Adds the derived fields to a snapshot position in place.
  function enrich(p, snap) {
    p.expiration = isoDate(p.expiration);
    p.strikes = (p.name.match(/[\d.]+\/[\d.]+/) || [""])[0];
    p.kind = p.type === "Bull Put" ? "put" : p.type === "Bear Call" ? "call" : "other";
    // Count days from the snapshot's Mountain-time calendar date, the same clock as the filenames.
    const snapDate = new Date(takenAt(snap)).toLocaleDateString("sv", { timeZone: "America/Denver" });
    const snapDay = Date.UTC(...snapDate.split("-").map((n, i) => (i === 1 ? n - 1 : +n)));
    const [y, mo, d] = p.expiration.split("-").map(Number);
    p.dte = Math.round((Date.UTC(y, mo - 1, d) - snapDay) / 864e5);
    p.tg = p.gamma ? p.theta / Math.abs(p.gamma) : null;
    p.tv = p.vega ? p.theta / Math.abs(p.vega) : null;
    p.ev = p.chance * p.maxProfit - (1 - p.chance) * p.maxLoss;
    // Same formula as lossOfRisk in portfolio.js, as a positive share.
    p.lossOfMax = p.returnPct < 0 && p.maxLoss > 0 ? ((-p.returnPct / 100) * p.maxProfit / p.maxLoss) * 100 : 0;
    p.toward = p.returnPct >= 0 ? Math.min(1, p.returnPct / RULES.target) : -Math.min(1, p.lossOfMax / RULES.stop);
    p.exit = p.returnPct >= RULES.target ? "close" : p.lossOfMax >= RULES.stop ? "stop" : "";
    strikeDistance(p, snap.spots && snap.spots[p.underlying]);
    betaWeight(p, snap);
    sizing(p);
    return p;
  }

  // Entry-quality numbers, as percentages. Needs p.strikes, p.kind and strikeDistance's shortStrike.
  // width is the dollar distance between the two strikes (null unless both are plain numbers).
  // OptionStrat's credit, max profit and max loss cover every contract held, and the export has no
  // quantity, but maxProfit + maxLoss = width × 100 × contracts, so dividing by that keeps
  // creditToWidthPct per contract. It is null for a spread that is neither put nor call, because
  // its "credit" may be a debit.
  function sizing(p) {
    const legs = p.strikes.split("/").map(Number);
    p.width = legs.length === 2 && legs.every((n) => n > 0) ? Math.abs(legs[0] - legs[1]) : null;
    const gross = p.maxProfit + p.maxLoss;
    p.creditToWidthPct = p.width > 0 && p.kind !== "other" && gross > 0 ? (p.credit / gross) * 100 : null;
    p.profitOfRiskPct = p.maxLoss > 0 ? (p.maxProfit / p.maxLoss) * 100 : null;
    p.popPct = p.chance * 100;
  }

  // Delta in SPY shares: delta × beta × (stock price ÷ SPY price), the number of SPY shares the
  // spread behaves like. Sets beta (null when there is none, or the file is older than
  // RULES.betaMaxAgeDays at the snapshot) and bwDelta (null when it also lacks a price).
  function betaWeight(p, snap) {
    const beta = snap.betas && snap.betas[p.underlying];
    const spot = snap.spots && snap.spots[p.underlying];
    const ageDays = (Date.parse(takenAt(snap)) - Date.parse(snap.betasAsOf)) / 864e5; // NaN without betasAsOf
    p.beta = ageDays <= RULES.betaMaxAgeDays && Number.isFinite(beta) ? beta : null;
    p.bwDelta = p.beta !== null && spot > 0 && snap.spy > 0 ? (p.delta * p.beta * spot) / snap.spy : null;
  }

  // How far the stock is from the short strike, in expected moves: the one-standard-deviation move
  // to expiration, spot × IV × √(days/365). Positive is the safe side, negative is past the strike.
  // Sets z and shortStrike (null when there is no spot, no IV or the spread isn't a plain put or call)
  // and nearStrike, whether z is inside RULES.strikeSigma. That flag is informational: no decision list uses it.
  function strikeDistance(p, spot) {
    const legs = p.strikes.split("/").map(Number);
    const plain = legs.length === 2 && legs.every((n) => n > 0);
    p.shortStrike = !plain ? null : p.kind === "put" ? Math.max(...legs) : p.kind === "call" ? Math.min(...legs) : null;
    p.z = null;
    p.nearStrike = false;
    if (p.shortStrike === null || !(spot > 0) || !(p.iv > 0)) return;
    const move = spot * (p.iv / 100) * Math.sqrt(Math.max(p.dte, 1) / 365); // a spread expiring today still has a day of room
    p.z = (p.kind === "put" ? spot - p.shortStrike : p.shortStrike - spot) / move;
    p.nearStrike = p.z < RULES.strikeSigma;
  }

  // A bull put and a bear call on the same underlying and expiration are an iron condor.
  function tagCondors(list) {
    for (const p of list) {
      p.condor = list.some((o) => o !== p && o.underlying === p.underlying && o.expiration === p.expiration && o.kind !== p.kind && o.kind !== "other" && p.kind !== "other");
    }
  }

  // The four decision lists at the top of the report, each in display order. Takes enriched positions.
  function decide(list) {
    return {
      ready: list.filter((p) => p.exit === "close").sort((a, b) => b.returnPct - a.returnPct),
      stopped: list.filter((p) => p.exit === "stop").sort((a, b) => b.lossOfMax - a.lossOfMax),
      soon: list.filter((p) => !p.exit && p.dte <= RULES.rollDays).sort((a, b) => a.dte - b.dte),
      near: list.filter((p) => !p.exit && p.dte > RULES.rollDays && Math.abs(p.toward) >= RULES.near).sort((a, b) => Math.abs(b.toward) - Math.abs(a.toward)),
    };
  }

  // One spread across snapshots: the same name, expiration and strikes.
  const spreadKey = (p) => [p.name, p.expiration, p.strikes].join("|");

  // What a spread looked like in the snapshot where it first appeared (p enriched against snap).
  function entryOf(p, snap) {
    const spot = snap.spots && snap.spots[p.underlying];
    return {
      known: true, firstSeenAt: takenAt(snap), pop: p.chance, iv: p.iv, dte: p.dte, credit: p.credit,
      maxLoss: p.maxLoss, z: p.z, spot: spot > 0 ? spot : null, creditToWidthPct: p.creditToWidthPct,
    };
  }

  // Why a spread left the book, judged on its last snapshot. Approximate: the real close came later.
  const outcomeOf = (p) => (p.exit === "close" ? "target" : p.exit === "stop" ? "stop" : p.dte <= 0 ? "expired" : "other");

  // Each stretch of a spread's life in the snapshots, as its own position (an "episode"), and what it showed
  // when the episode began. snaps are saved snapshots in any order; the newest by takenAt is the current book.
  //   open:   Map of spreadKey → { entry, episode, episodeBreak } for each spread in the newest snapshot.
  //           entry is entryOf(...), or { known: false } for a spread already open in the oldest snapshot,
  //           since when it opened can't be told.
  //   closed: episodes that ended before the newest snapshot, closed within RULES.closedDays, newest first,
  //           with the same episode fields. closedAt is the first snapshot without it, openedAt the first
  //           with it (null when entry is unknown), and the last return is from the snapshot before.
  // The same name, expiration and strikes is one spread, until an episode break starts a new episode:
  //   "gap"     it was missing from at least one snapshot between two sightings, so it was closed and reopened;
  //   "resized" its credit or max loss changed (to the cent) since the last sighting: a contract added or
  //             a reopen at another price.
  // Only snapshots passed in count, so one that failed to load is neither a presence nor an absence and
  // can't cause a gap. Blind spot: a close and reopen at the same credit between two consecutive snapshots
  // looks like nothing happened.
  function history(snaps) {
    const rows = snaps
      .filter((s) => s && Array.isArray(s.positions))
      .map((s) => ({ snap: s, at: takenAt(s) }))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const cents = (n) => Math.round(n * 100);
    const latest = new Map(); // key → its newest episode
    const episodes = [];
    rows.forEach((row, i) => {
      const done = new Set(); // a spread held as two saved trades is one sighting
      for (const raw of row.snap.positions) {
        const p = enrich({ ...raw }, row.snap);
        const k = spreadKey(p);
        if (done.has(k)) continue;
        done.add(k);
        const ep = latest.get(k);
        const brk = !ep ? null : ep.last < i - 1 ? "gap"
          : cents(ep.p.credit) !== cents(p.credit) || cents(ep.p.maxLoss) !== cents(p.maxLoss) ? "resized" : "";
        if (ep && !brk) { ep.last = i; ep.p = p; continue; }
        const next = { key: k, episode: ep ? ep.episode + 1 : 1, episodeBreak: brk || null, first: i, last: i, p,
          entry: i === 0 ? { known: false } : entryOf(p, row.snap) };
        latest.set(k, next);
        episodes.push(next);
      }
    });
    const open = new Map(), closed = [];
    if (!rows.length) return { open, closed };
    const now = rows.length - 1;
    const since = Date.parse(rows[now].at) - RULES.closedDays * 864e5;
    for (const ep of episodes) {
      const { entry, episode, episodeBreak } = ep;
      if (ep.last === now) { open.set(ep.key, { entry, episode, episodeBreak }); continue; }
      const closedAt = rows[ep.last + 1].at;
      if (Date.parse(closedAt) < since) continue;
      const known = entry.known;
      closed.push({
        name: ep.p.name, underlying: ep.p.underlying, kind: ep.p.kind,
        openedAt: known ? entry.firstSeenAt : null, closedAt,
        daysHeld: known ? (Date.parse(closedAt) - Date.parse(entry.firstSeenAt)) / 864e5 : null,
        entry, episode, episodeBreak, lastReturnPct: ep.p.returnPct, outcome: outcomeOf(ep.p), approximate: true,
      });
    }
    closed.sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt));
    return { open, closed };
  }

  const api = { RULES, isoDate, fromDenver, takenAt, enrich, tagCondors, decide, spreadKey, history };
  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.SpreadBook = api;
})();
