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
    watch: 15, // a heads-up in the exit plan before the stop: not an exit
    hardStop: 50, // where the "from here" runs give up on a spread held past the stop (sim.js)
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

  // Whether the page shows a spread's "from here" panel: whenever sim.js could work the numbers out. A quiet
  // winner's odds are as useful as a loser's (the owner's call, 2026-10-24), so there is no other condition.
  const showsFromHere = (p) => !!p.fromHere;

  // The exit plan (sim.js) as rows from best to worst by the spread's price: the target, the watch line, the stop
  // and where it is now, each { key, debit, spot, shortDelta }. pct is the level's rule, signed like the P&L.
  // [] without a plan.
  function planRows(p) {
    const plan = p.plan;
    if (!plan) return [];
    return [
      { key: "target", pct: RULES.target, ...plan.target },
      { key: "now", pct: null, debit: plan.debitNow, spot: plan.spot, shortDelta: plan.shortDeltaNow },
      { key: "watch", pct: -RULES.watch, ...plan.watch },
      { key: "stop", pct: -RULES.stop, ...plan.stop },
    ].sort((a, b) => a.debit - b.debit || (a.key === "now" ? -1 : b.key === "now" ? 1 : 0));
  }

  // The recovery ladder as the page lists it: each SIM.ladder loss level the model could reach, shallowest first,
  // with the spread where it is now (sim.js fromHere) put in its place and marked now. [] without the numbers.
  function recoveryRows(p) {
    if (!p.recovery || !p.fromHere) return [];
    const rungs = p.recovery.filter((r) => r.spot !== null).map((r) => ({ ...r, now: false }));
    const f = p.fromHere;
    const here = { lossPct: p.lossOfMax, spot: p.plan ? p.plan.spot : null, pProfit: f.pProfit, pTarget: f.pTarget, pHardStop: f.pHardStop, avgResultPct: f.avgResultPct, now: true };
    const at = rungs.findIndex((r) => r.lossPct > here.lossPct);
    rungs.splice(at < 0 ? rungs.length : at, 0, here);
    return rungs;
  }

  // ---- what the report page draws ----------------------------------------------------------------
  // Pure calculations from report.js, kept here so tests can reach them without a browser.

  const sumOf = (list, k) => list.reduce((s, p) => s + p[k], 0);
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  // A spread without a beta has no beta-weighted delta (null). It is left out of every sum for that view,
  // so a total never looks more complete than it is.
  const counts = (p, k) => p[k] !== null && p[k] !== undefined;
  const addUp = (ps, k) => sumOf(ps.filter((p) => counts(p, k)), k);

  // The heatmap grid for one greek: expirations across, one row per underlying and spread kind (so an iron
  // condor's two legs stay apart), each row's total, and the largest cell for scaling the colours.
  // Rows with nothing to add (no beta) go last, not in the middle at zero. diverging greeks (delta) run
  // from most bullish to most bearish; the rest from the largest magnitude down.
  function heatmap(list, key, diverging) {
    const exps = [...new Set(list.map((p) => p.expiration))].sort();
    const rows = [...new Set(list.map((p) => p.underlying + "|" + p.kind))].map((k) => {
      const [u, kind] = k.split("|");
      return { u, kind, ps: list.filter((p) => p.underlying === u && p.kind === kind) };
    });
    rows.forEach((r) => { r.total = addUp(r.ps, key); r.has = r.ps.some((p) => counts(p, key)); });
    rows.sort((a, b) => (a.has !== b.has ? (a.has ? -1 : 1) : diverging ? b.total - a.total : Math.abs(b.total) - Math.abs(a.total)));
    const cells = rows.flatMap((r) => exps.map((e) => addUp(r.ps.filter((p) => p.expiration === e), key)));
    return { exps, rows, max: Math.max(...cells.map(Math.abs), 1e-9), covered: list.filter((p) => counts(p, key)).length };
  }

  // Where p stands on a ratio among the list, best first: { pos, of }. null when p has no value.
  function rank(list, p, key) {
    if (p[key] === null) return null;
    const ranked = list.filter((x) => x[key] !== null).sort((a, b) => b[key] - a[key]);
    return { pos: ranked.indexOf(p) + 1, of: ranked.length };
  }

  // The theta-per-gamma against theta-per-vega scatter, in data units. A spread with no gamma (or vega)
  // has no ratio: it sits on the axis at 0, and the medians and the shaded corner come only from the spreads
  // that were measured. Trial trades (hypo) stay out of the medians when there are real spreads. null when
  // nothing was measured.
  function plotModel(list) {
    const measured = list.filter((p) => p.tg !== null && p.tv !== null);
    if (!measured.length) return null;
    const px = (p) => p.tg ?? 0, py = (p) => p.tv ?? 0;
    const xStep = Math.max(...measured.map(px)) > 20 ? 5 : 2;
    const xMax = Math.max(xStep, Math.ceil((Math.max(...measured.map(px)) * 1.08) / xStep) * xStep);
    const yMax = Math.max(0.5, Math.ceil(Math.max(...measured.map(py)) * 1.05 * 2) / 2);
    const yStep = yMax > 3 ? 1 : 0.5;
    const real = measured.filter((p) => !p.hypo);
    const basis = real.length ? real : measured;
    const mx = median(basis.map(px)), my = median(basis.map(py));
    const unmeasured = (p) => p.tg === null || p.tv === null;
    return {
      px, py, xStep, xMax, yStep, yMax, mx, my, unmeasured,
      xTicks: Array.from({ length: xMax / xStep + 1 }, (_, i) => i * xStep),
      yTicks: Array.from({ length: Math.floor(yMax / yStep) + 1 }, (_, i) => i * yStep),
      weak: (p) => !p.hypo && !unmeasured(p) && p.tg < mx && p.tv < my,
    };
  }

  // Scorecard order. Missing ratios sort last whichever way the column is sorted.
  function sortSpreads(list, key, dir) {
    return [...list].sort((a, b) => {
      const va = a[key] ?? Infinity * dir, vb = b[key] ?? Infinity * dir;
      const d = typeof va === "string" ? va.localeCompare(vb) : va - vb;
      return d * dir || a.dte - b.dte || b.theta - a.theta;
    });
  }

  // The scorecard's Book row. bwDelta adds up only the spreads that have a beta (bwCount of count).
  function bookTotals(list) {
    const n = list.length || 1, theta = sumOf(list, "theta"), gamma = sumOf(list, "gamma"), vega = sumOf(list, "vega");
    const bw = list.filter((p) => p.bwDelta !== null);
    return {
      count: list.length, avgChance: sumOf(list, "chance") / n, credit: sumOf(list, "credit"), maxLoss: sumOf(list, "maxLoss"),
      ev: sumOf(list, "ev"), theta, delta: sumOf(list, "delta"), gamma, vega,
      bwDelta: bw.length ? sumOf(bw, "bwDelta") : null, bwCount: bw.length,
      avgIv: sumOf(list, "iv") / n,
      thetaPerGamma: gamma ? theta / Math.abs(gamma) : null, thetaPerVega: vega ? theta / Math.abs(vega) : null,
    };
  }

  // A row pasted from the OptionStrat export, comma- or tab-separated (an Excel paste), as a trial trade.
  // 0:Name 1:Return% 2:Return$ 3:CreatedAt 4:Expiration 5:NetCredit 6:Chance 7:MaxLoss 8:MaxProfit ... 11:Delta 12:Theta 13:Gamma 14:Vega 15:Rho 16:IV
  // null when the line isn't a spread row.
  function csvFields(line) {
    if (line.includes("\t")) return line.split("\t").map((s) => s.trim());
    const out = []; let cur = "", q = false;
    for (const c of line) {
      if (c === '"') q = !q;
      else if (c === "," && !q) { out.push(cur.trim()); cur = ""; }
      else cur += c;
    }
    out.push(cur.trim());
    return out;
  }
  const parsePct = (s) => parseFloat((s || "").replace("%", "")) || 0;
  const parseDollar = (s) => (s && s.includes("(") ? -1 : 1) * (parseFloat((s || "").replace(/[^0-9.]/g, "")) || 0);
  function parseTrade(line) {
    const v = csvFields(line), name = (v[0] || "").trim();
    if (!name || !name.toLowerCase().includes("spread")) return null;
    if (!/^\d{1,2}\/\d{1,2}\/\d{2,4}|^\d{4}-\d{2}-\d{2}/.test(v[4] || "")) return null;
    return {
      name, underlying: name.split(" ")[0], expiration: v[4],
      type: name.includes("Bull Put") ? "Bull Put" : name.includes("Bear Call") ? "Bear Call" : "Other",
      returnPct: parsePct(v[1]), credit: Math.abs(parseDollar(v[5])), chance: parsePct(v[6]) / 100,
      maxLoss: Math.abs(parseDollar(v[7])), maxProfit: Math.abs(parseDollar(v[8])),
      delta: parseFloat(v[11]) || 0, theta: parseFloat(v[12]) || 0, gamma: parseFloat(v[13]) || 0, vega: parseFloat(v[14]) || 0, iv: parsePct(v[16]),
      hypo: true,
    };
  }

  // ---- trades sent from spread-scanner ("Try in spread-book") -------------------------------------
  // The scanner's button opens this page with #try=<base64url of JSON>, { v: 1, trades: [...] }, each trade
  //   { symbol, side: "put"|"call", expiration: "YYYY-MM-DD", qty, credit, popPct,
  //     short: { strike, delta, gamma, theta, vega, iv }, long: { ... } }
  // in the scanner's own units: credit per share at the mid, popPct in percent, leg greeks per share (theta per
  // day, vega per vol point) and iv as a fraction. A fragment never reaches the server or CloudFront's logs.

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const ordinal = (d) => d + ([11, 12, 13].includes(d) ? "th" : ["th", "st", "nd", "rd"][d % 10] || "th");
  const cents = (n) => Math.round(n * 100) / 100;

  // One scanner trade as a trial trade, in the export's units, the same fields parseTrade returns: the name in
  // OptionStrat's form (strikes low/high whichever the side), money in dollars for the position, chance as a
  // fraction, greeks in share-equivalents ((leg bought − leg sold) × 100 × contracts, so a bull put has a
  // positive delta and a credit spread a positive theta) and iv in percent, the short leg's. A greek a leg
  // lacks counts as 0. null when the trade isn't a plain bull put or bear call.
  function tryTrade(t) {
    const finite = (n) => typeof n === "number" && Number.isFinite(n);
    if (!t || typeof t !== "object" || !t.short || !t.long) return null;
    const { symbol, side, expiration, short: s, long: l } = t;
    const qty = t.qty === undefined ? 1 : t.qty;
    const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiration || "");
    if (!/^[A-Z][A-Z0-9./]{0,9}$/.test(symbol || "") || (side !== "put" && side !== "call") || !ymd) return null;
    const [, , month, day] = ymd.map(Number);
    if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
    if (!(finite(s.strike) && finite(l.strike) && s.strike > 0 && l.strike > 0)) return null;
    // A bull put sells the higher strike, a bear call the lower.
    if (side === "put" ? !(s.strike > l.strike) : !(s.strike < l.strike)) return null;
    const width = Math.abs(s.strike - l.strike);
    if (!(finite(t.credit) && t.credit > 0 && t.credit < width) || !(Number.isInteger(qty) && qty > 0)) return null;
    const n = 100 * qty;
    const net = (k) => ((finite(l[k]) ? l[k] : 0) - (finite(s[k]) ? s[k] : 0)) * n;
    const type = side === "put" ? "Bull Put" : "Bear Call";
    return {
      name: `${symbol} ${MONTHS[month - 1]} ${ordinal(day)} ${Math.min(s.strike, l.strike)}/${Math.max(s.strike, l.strike)} ${type} Spread`,
      underlying: symbol, expiration, type,
      returnPct: 0, credit: cents(t.credit * n), chance: finite(t.popPct) ? t.popPct / 100 : 0,
      maxLoss: cents((width - t.credit) * n), maxProfit: cents(t.credit * n),
      delta: net("delta"), theta: net("theta"), gamma: net("gamma"), vega: net("vega"), iv: finite(s.iv) ? s.iv * 100 : 0,
      hypo: true,
    };
  }

  // The trades in a location.hash's try= value, each tryTrade(...) (null for one that can't be read).
  // null when the hash has no try=; [null] when its value isn't a payload this page reads.
  function readTry(hash) {
    const v = new URLSearchParams(String(hash || "").replace(/^#/, "")).get("try");
    if (v === null) return null;
    try {
      const b64 = v.replace(/-/g, "+").replace(/_/g, "/");
      const json = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
      if (!json || json.v !== 1 || !Array.isArray(json.trades) || !json.trades.length) return [null];
      return json.trades.map(tryTrade);
    } catch (_) {
      return [null];
    }
  }

  // One spread across snapshots: the same name, expiration and strikes.
  const spreadKey = (p) => [p.name, p.expiration, p.strikes].join("|");

  // The spread a link names (the report's ?spread=), by spreadKey. equity-watch's stops append "#<episode>",
  // which is dropped: the page shows one snapshot, where a key is one spread. null when it isn't in the list.
  const findSpread = (list, key) => {
    const want = String(key || "").replace(/#\d+$/, "");
    return (want && list.find((p) => !p.hypo && spreadKey(p) === want)) || null;
  };

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

  const api = { RULES, isoDate, fromDenver, takenAt, enrich, tagCondors, decide, showsFromHere, planRows, recoveryRows, spreadKey, findSpread, history,
    sumOf, median, counts, addUp, heatmap, rank, plotModel, sortSpreads, bookTotals, parseTrade, tryTrade, readTry };
  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.SpreadBook = api;
})();
