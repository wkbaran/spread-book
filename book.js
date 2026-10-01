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
    return p;
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

  const api = { RULES, isoDate, fromDenver, takenAt, enrich, tagCondors, decide };
  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.SpreadBook = api;
})();
