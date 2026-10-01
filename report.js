/* Spread book — client-side renderer, embedded in every portfolio report by portfolio.js.
 *
 * The page carries its own snapshot as JSON (#book-data). The snapshot menu
 * lists the newest reports from snapshots.json (written by generate-index.js)
 * and loads the chosen <base>-portfolio.json in place, so older snapshots are
 * drawn with this same page.
 */
(() => {
  "use strict";

  const SB = globalThis.SpreadBook; // book.js, inlined ahead of this script
  const { target: TARGET, stop: STOP, rollDays: ROLL_DAYS } = SB.RULES;
  const takenAt = SB.takenAt;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const fmt = (v, dp = 2) => (v < 0 ? "−" : "") + Math.abs(v).toFixed(dp);
  const signed = (v, dp = 2) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(dp);
  const pct = (v) => signed(v, 0) + "%";
  const money = (v) => { const r = Math.round(v); return (r < 0 ? "−$" : "$") + Math.abs(r).toLocaleString(); };
  const sum = (list, k) => list.reduce((s, p) => s + p[k], 0);
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const expLabel = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const snapLabel = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  // Gains as a share of max profit, losses as a share of max loss.
  const exitPct = (p) => (p.returnPct >= 0 ? pct(p.returnPct) : "−" + p.lossOfMax.toFixed(1) + "%");
  const exitLong = (p) => (p.returnPct >= 0 ? `${pct(p.returnPct)} of max profit` : `${p.lossOfMax.toFixed(1)}% of max loss`);

  // ---- state ---------------------------------------------------------------
  const embedded = JSON.parse($("book-data").textContent);
  const embeddedBase = document.body.dataset.base;
  let snap = embedded; // the snapshot on screen
  let base = []; // its positions, enriched
  let hypos = []; // trial trades
  let hypoSeq = 0;
  let greek = "theta";
  let selected = null;
  let sort = { key: "dte", dir: 1 };

  function enrich(p, id) {
    p.id = id;
    return SB.enrich(p, snap);
  }
  const tagCondors = SB.tagCondors;
  const all = () => [...base, ...hypos];

  function useSnapshot(s) {
    snap = s;
    base = s.positions.map((p, i) => enrich({ ...p }, "p" + i));
    hypos = hypos.map((h) => enrich(h, h.id));
    tagCondors(all());
    // Ids are per snapshot, so keep the selection only when it's a trial trade.
    if (!hypos.some((p) => p.id === selected)) selected = [...base].sort((a, b) => a.toward - b.toward)[0]?.id ?? null;
    render();
  }

  // ---- book strip ------------------------------------------------------------
  const GREEKS = {
    theta: { name: "Theta", unit: "per day", help: "What the book earns each day from time decay.", title: "Theta by underlying and expiration", note: "Brighter cells earn more per day. A column much brighter than the rest means income is bunched on one expiration.", dp: 2 },
    delta: { name: "Delta", unit: "", help: "Net direction. Positive gains if the market rises.", title: "Delta by underlying and expiration", note: "Bright cells lean bullish, dark cells lean bearish. The total row shows how hard each expiration leans.", dp: 1, diverging: true },
    gamma: { name: "Gamma", unit: "", help: "How quickly delta turns against you in a big move.", title: "Gamma by underlying and expiration", note: "Brighter cells lose faster in a sharp move either way. Gamma climbs as expiration nears, so watch the nearest column.", dp: 2 },
    vega: { name: "Vega", unit: "per IV point", help: "What the book loses if implied volatility rises one point.", title: "Vega by underlying and expiration", note: "Brighter cells lose more in a volatility spike. Longer-dated spreads usually carry more.", dp: 2 },
  };

  function renderBook() {
    $("book").innerHTML = Object.entries(GREEKS).map(([k, g], i) => {
      const total = sum(all(), k), diff = sum(hypos, k);
      return `<button class="greek" type="button" data-g="${k}" aria-pressed="${k === greek}" title="Press ${i + 1}">
        <span class="g-name">${g.name}${g.unit ? " " + g.unit : ""}</span>
        <span class="g-val">${fmt(total, g.dp)}${hypos.length ? `<span class="g-diff">${signed(diff, g.dp)}</span>` : ""}</span>
        <span class="g-help">${g.help}</span></button>`;
    }).join("");
  }
  $("book").addEventListener("click", (e) => {
    const b = e.target.closest(".greek"); if (!b) return;
    greek = b.dataset.g; render();
  });
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("textarea, input, select") || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = { 1: "theta", 2: "delta", 3: "gamma", 4: "vega" }[e.key];
    if (k) { greek = k; render(); }
  });

  // ---- decisions -------------------------------------------------------------
  function renderDecide() {
    const list = all();
    const what = (p) => `${esc(p.strikes)} ${p.kind}, ${p.dte} days`;
    const item = (p, num, hot, title) => `<li><button type="button" data-id="${p.id}"><span class="sym">${esc(p.underlying)}</span><span class="d-what">${what(p)}</span><span class="d-num ${hot ? "hot" : ""}" title="${title}">${num}</span></button></li>`;
    const block = (title, help, rows, empty) => {
      const shown = rows.slice(0, 6), more = rows.length - shown.length;
      return `<section><h2>${title}</h2><p class="d-help">${help}</p>${rows.length ? `<ul>${shown.join("")}</ul>${more ? `<p class="empty">and ${more} more in the scorecard</p>` : ""}` : `<p class="empty">${empty}</p>`}</section>`;
    };
    const { ready, stopped, soon, near } = SB.decide(list);
    const best = [...list].sort((a, b) => b.returnPct - a.returnPct)[0];
    const worst = [...list].sort((a, b) => b.lossOfMax - a.lossOfMax)[0];
    $("decide").innerHTML =
      block("Ready to close", `At or past ${TARGET}% of max profit.`, ready.map((p) => item(p, exitPct(p), true, exitLong(p))),
        best && best.returnPct > 0 ? `None yet. Closest is ${esc(best.underlying)} at ${pct(best.returnPct)}.` : "None yet.") +
      block("At the stop", `Loss has reached ${STOP}% of max loss.`, stopped.map((p) => item(p, exitPct(p), true, exitLong(p))),
        worst && worst.lossOfMax > 0 ? `None. Worst is ${esc(worst.underlying)} at ${worst.lossOfMax.toFixed(1)}% of max loss.` : "Nothing is losing.") +
      block(`${ROLL_DAYS} days or less`, "Close or roll before gamma speeds up.", soon.map((p) => item(p, exitPct(p), false, exitLong(p))), `Nothing expires within ${ROLL_DAYS} days.`) +
      block("Getting close", `Past ${SB.RULES.near * 100}% of the way to either exit.`, near.map((p) => item(p, exitPct(p), false, exitLong(p))), "Everything else is in the middle.");
  }
  $("decide").addEventListener("click", (e) => { const b = e.target.closest("[data-id]"); if (b) select(b.dataset.id, true); });

  // ---- heatmap ---------------------------------------------------------------
  // Magnitude pulls the signal out of the surface; negative delta pulls ink instead.
  function shade(v, max) {
    const t = max ? Math.min(1, Math.abs(v) / max) : 0;
    const mix = Math.round(8 + t * 80);
    const hue = GREEKS[greek].diverging && v < 0 ? "var(--ink)" : "var(--signal)";
    return { bg: `color-mix(in oklab, ${hue} ${mix}%, var(--surface))`, fg: mix > 55 ? "var(--ground)" : "var(--ink)" };
  }

  // One row per underlying and spread type, so the two legs of an iron condor stay apart.
  function renderHeat() {
    const g = GREEKS[greek], list = all();
    const exps = [...new Set(list.map((p) => p.expiration))].sort();
    const rows = [...new Set(list.map((p) => p.underlying + "|" + p.kind))].map((k) => { const [u, kind] = k.split("|"); return { u, kind, ps: list.filter((p) => p.underlying === u && p.kind === kind) }; });
    rows.forEach((r) => (r.total = sum(r.ps, greek)));
    rows.sort((a, b) => (g.diverging ? b.total - a.total : Math.abs(b.total) - Math.abs(a.total)));
    const cellVals = rows.flatMap((r) => exps.map((e) => sum(r.ps.filter((p) => p.expiration === e), greek)));
    const max = Math.max(...cellVals.map(Math.abs), 1e-9);
    $("grid-title").textContent = g.title;
    $("grid-note").textContent = g.note;
    $("legend").innerHTML = g.diverging
      ? `bearish <i style="background:linear-gradient(90deg, color-mix(in oklab, var(--ink) 88%, var(--surface)), var(--surface), color-mix(in oklab, var(--signal) 88%, var(--surface)))"></i> bullish`
      : `less <i style="background:linear-gradient(90deg, var(--surface), color-mix(in oklab, var(--signal) 88%, var(--surface)))"></i> more`;
    const head = `<thead><tr><th scope="col">Symbol</th>${exps.map((e) => `<th scope="col"><span class="dte">${list.find((p) => p.expiration === e).dte} days</span>${expLabel(e)}</th>`).join("")}<th scope="col">Total</th></tr></thead>`;
    const body = rows.map((r) => `<tr><th scope="row">${esc(r.u)}<small>${r.kind}</small></th>${exps.map((e) => {
      const ps = r.ps.filter((p) => p.expiration === e);
      if (!ps.length) return `<td><span class="cell none"></span></td>`;
      const v = sum(ps, greek), c = shade(v, max);
      const lead = ps.find((p) => p.id === selected) || ps[0];
      const label = ps.length > 1 ? `${ps.length} ${r.u} ${r.kind} spreads` : esc(lead.name);
      return `<td><button type="button" class="cell ${ps.some((p) => p.hypo) ? "hypo" : ""} ${ps.some((p) => p.id === selected) ? "sel" : ""}" data-id="${lead.id}" style="background:${c.bg};color:${c.fg}" aria-label="${label}, ${g.name} ${fmt(v, g.dp)}">${fmt(v, g.dp)}</button></td>`;
    }).join("")}<td class="tot">${fmt(r.total, g.dp)}</td></tr>`).join("");
    const foot = `<tfoot><tr><th scope="row">Total</th>${exps.map((e) => `<td class="tot">${fmt(sum(list.filter((p) => p.expiration === e), greek), g.dp)}</td>`).join("")}<td class="tot">${fmt(sum(list, greek), g.dp)}</td></tr></tfoot>`;
    $("heat").innerHTML = head + `<tbody>${body}</tbody>` + foot;
  }
  $("heat").addEventListener("click", (e) => { const b = e.target.closest(".cell[data-id]"); if (b) select(b.dataset.id); });

  // ---- detail ----------------------------------------------------------------
  function barHTML(p) {
    const w = Math.abs(p.toward) * 50;
    const fill = p.toward >= 0 ? `<span class="fill up" style="left:50%;width:${w}%"></span>` : `<span class="fill down" style="left:${50 - w}%;width:${w}%"></span>`;
    return `<div class="bar" aria-hidden="true">${fill}<span class="zero" style="left:50%"></span></div>`;
  }
  function rankOf(p, key) {
    if (p[key] === null) return "";
    const ranked = all().filter((x) => x[key] !== null).sort((a, b) => b[key] - a[key]);
    return `<span class="rank">${ranked.indexOf(p) + 1} of ${ranked.length}</span>`;
  }
  function renderDetail() {
    const p = all().find((x) => x.id === selected);
    if (!p) { $("detail").innerHTML = `<p class="muted">Select a cell, dot or row to see that spread.</p>`; return; }
    const hot = !!p.exit;
    const status = p.exit === "close" ? "Past the close target" : p.exit === "stop" ? "At the stop" : p.returnPct >= 0 ? `of max profit. Close at ${TARGET}%` : `of max loss. Stop at ${STOP}%`;
    const sameCell = all().filter((o) => o !== p && o.underlying === p.underlying && o.kind === p.kind && o.expiration === p.expiration);
    const partner = p.condor ? all().find((o) => o.underlying === p.underlying && o.expiration === p.expiration && o.kind !== p.kind) : null;
    $("detail").innerHTML = `
      <h3>${esc(p.underlying)} ${esc(p.strikes)}</h3>
      <div class="d-sub">${esc(p.type)} spread, expires ${expLabel(p.expiration)} (${p.dte} days)${p.hypo ? ". Trial trade, not in the book" : ""}</div>
      ${partner ? `<div class="also">Iron condor with the ${esc(partner.strikes)} ${partner.kind} spread <button type="button" data-id="${partner.id}">Show</button></div>` : ""}
      ${sameCell.length ? `<div class="also">Same cell: ${sameCell.map((o) => `<button type="button" data-id="${o.id}">${esc(o.strikes)}</button>`).join("")}</div>` : ""}
      <div class="progress">
        <div class="p-head"><span class="p-val ${hot ? "hot" : ""}">${exitPct(p)}</span><span class="p-lbl">${status}</span></div>
        ${barHTML(p)}
        <div class="bar-scale"><span>stop at ${STOP}% of max loss</span><span>0</span><span>close at ${TARGET}% of max profit</span></div>
      </div>
      <dl class="kv">
        <dt>Probability of profit</dt><dd>${Math.round(p.chance * 100)}%</dd>
        <dt>Credit</dt><dd>${money(p.credit)}</dd>
        <dt>Max loss</dt><dd>${money(p.maxLoss)}</dd>
        <dt>Expected value</dt><dd>${money(p.ev)}</dd>
        <dt>IV</dt><dd>${p.iv.toFixed(1)}%</dd>
        <dt>Days left</dt><dd class="${p.dte <= ROLL_DAYS ? "hot" : ""}">${p.dte}</dd>
      </dl>
      <h4>Greeks</h4>
      <dl class="kv">
        <dt>Theta per day</dt><dd>${fmt(p.theta)}</dd>
        <dt>Delta</dt><dd>${fmt(p.delta, 1)}</dd>
        <dt>Gamma</dt><dd>${fmt(p.gamma)}</dd>
        <dt>Vega</dt><dd>${fmt(p.vega)}</dd>
      </dl>
      <h4>Pay for risk</h4>
      <dl class="kv">
        <dt>Theta per unit gamma</dt><dd>${p.tg === null ? "no gamma" : p.tg.toFixed(2) + rankOf(p, "tg")}</dd>
        <dt>Theta per unit vega</dt><dd>${p.tv === null ? "no vega" : p.tv.toFixed(2) + rankOf(p, "tv")}</dd>
      </dl>`;
  }
  $("detail").addEventListener("click", (e) => { const b = e.target.closest("[data-id]"); if (b) select(b.dataset.id); });

  // ---- quality scatter -------------------------------------------------------
  function renderPlot() {
    const skipped = all().filter((p) => p.tg === null || p.tv === null);
    const list = all().filter((p) => p.tg !== null && p.tv !== null);
    if (!list.length) { $("plot").innerHTML = `<p class="plot-note">No spread has both gamma and vega, so there's nothing to plot.</p>`; return; }
    const W = 640, H = 300, pad = { l: 44, r: 16, t: 14, b: 36 };
    const xStep = Math.max(...list.map((p) => p.tg)) > 20 ? 5 : 2;
    const xMax = Math.max(xStep, Math.ceil((Math.max(...list.map((p) => p.tg)) * 1.08) / xStep) * xStep);
    const yMax = Math.max(0.5, Math.ceil(Math.max(...list.map((p) => p.tv)) * 1.05 * 2) / 2);
    const x = (v) => pad.l + (v / xMax) * (W - pad.l - pad.r), y = (v) => H - pad.b - (v / yMax) * (H - pad.t - pad.b);
    const real = list.filter((p) => !p.hypo);
    const mx = median((real.length ? real : list).map((p) => p.tg)), my = median((real.length ? real : list).map((p) => p.tv));
    const xt = Array.from({ length: xMax / xStep + 1 }, (_, i) => i * xStep);
    const yStep = yMax > 3 ? 1 : 0.5, yt = Array.from({ length: Math.floor(yMax / yStep) + 1 }, (_, i) => i * yStep);
    // Labels try right, left, above, then below the dot, taking the first spot that is free.
    const boxes = list.map((p) => ({ x0: x(p.tg) - 7, x1: x(p.tg) + 7, y0: y(p.tv) - 7, y1: y(p.tv) + 7 }));
    const hits = (b) => b.x0 < pad.l || b.x1 > W || b.y0 < 0 || boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
    // Name the leg when an underlying has both a put and a call spread.
    const twice = new Set(list.filter((p) => list.some((o) => o.underlying === p.underlying && o.kind !== p.kind)).map((p) => p.underlying));
    const dots = list.map((p) => {
      const name = twice.has(p.underlying) ? `${p.underlying} ${p.kind}` : p.underlying;
      const cx = x(p.tg), cy = y(p.tv), w = name.length * 7 + 2;
      const spots = [[cx + 8, cy + 4, "start"], [cx - 8, cy + 4, "end"], [cx, cy - 10, "middle"], [cx, cy + 18, "middle"]];
      const box = ([lx, ly, a]) => { const x0 = a === "start" ? lx : a === "end" ? lx - w : lx - w / 2; return { x0, x1: x0 + w, y0: ly - 10, y1: ly + 2 }; };
      const spot = spots.find((sp) => !hits(box(sp))) ?? spots[0];
      boxes.push(box(spot));
      const weak = !p.hypo && p.tg < mx && p.tv < my;
      return `<g><circle class="dot ${weak ? "weak" : ""} ${p.hypo ? "hypo" : ""} ${p.id === selected ? "sel" : ""}" data-id="${p.id}" cx="${cx}" cy="${cy}" r="${p.id === selected ? 7 : 5}" tabindex="0" role="button" aria-label="${esc(p.name)}"><title>${esc(p.name)}</title></circle><text class="lbl" x="${spot[0]}" y="${spot[1]}" text-anchor="${spot[2]}">${esc(name)}</text></g>`;
    }).join("");
    $("plot").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Theta per gamma against theta per vega for each spread">
      <rect class="zone" x="${pad.l}" y="${y(my)}" width="${x(mx) - pad.l}" height="${H - pad.b - y(my)}" rx="3"/>
      <text x="${pad.l + 6}" y="${H - pad.b - 8}">below median on both</text>
      <line class="axis" x1="${pad.l}" x2="${W - pad.r}" y1="${H - pad.b}" y2="${H - pad.b}"/>
      <line class="axis" x1="${pad.l}" x2="${pad.l}" y1="${pad.t}" y2="${H - pad.b}"/>
      <line class="med" x1="${x(mx)}" x2="${x(mx)}" y1="${pad.t}" y2="${H - pad.b}"/>
      <line class="med" x1="${pad.l}" x2="${W - pad.r}" y1="${y(my)}" y2="${y(my)}"/>
      ${xt.map((v) => `<text x="${x(v)}" y="${H - pad.b + 16}" text-anchor="middle">${v}</text>`).join("")}
      ${yt.map((v) => `<text x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${v.toFixed(1)}</text>`).join("")}
      <text x="${W - pad.r}" y="${H - 4}" text-anchor="end">theta per unit gamma</text>
      <text transform="translate(10 ${(pad.t + H - pad.b) / 2}) rotate(-90)" text-anchor="middle">theta per unit vega</text>
      ${dots}</svg>${skipped.length ? `<p class="plot-note">${skipped.map((p) => esc(p.underlying)).join(", ")} ${skipped.length > 1 ? "have" : "has"} no measurable gamma or vega, so ${skipped.length > 1 ? "they are" : "it is"} left off the chart.</p>` : ""}`;
  }
  $("plot").addEventListener("click", (e) => { const d = e.target.closest(".dot"); if (d) select(d.dataset.id); });
  $("plot").addEventListener("keydown", (e) => { const d = e.target.closest(".dot"); if (d && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(d.dataset.id); } });

  // ---- scorecard -------------------------------------------------------------
  const COLS = [
    ["underlying", "Symbol"], ["strikes", "Spread"], ["dte", "Days"], ["chance", "PoP"], ["credit", "Credit"], ["maxLoss", "Max loss"], ["ev", "EV"],
    ["toward", "Toward an exit"], ["theta", "Theta"], ["delta", "Delta"], ["gamma", "Gamma"], ["vega", "Vega"], ["iv", "IV"], ["tg", "Θ per Γ"], ["tv", "Θ per V"],
  ];
  const ASC_FIRST = ["underlying", "strikes", "dte"];
  function renderScorecard() {
    const list = all();
    const rows = [...list].sort((a, b) => {
      // Missing ratios sort last whichever way the column is sorted.
      const va = a[sort.key] ?? Infinity * sort.dir, vb = b[sort.key] ?? Infinity * sort.dir;
      const d = typeof va === "string" ? va.localeCompare(vb) : va - vb;
      return d * sort.dir || a.dte - b.dte || b.theta - a.theta;
    });
    const head = `<thead><tr>${COLS.map(([k, l]) => `<th scope="col" ${sort.key === k ? `aria-sort="${sort.dir > 0 ? "ascending" : "descending"}"` : ""}><button type="button" data-k="${k}">${l}</button></th>`).join("")}</tr></thead>`;
    const body = rows.map((p) => `<tr data-id="${p.id}" class="${p.id === selected ? "sel" : ""} ${p.hypo ? "hypo" : ""}">
      <td class="sym">${esc(p.underlying)}</td><td class="kind">${esc(p.strikes)} ${p.kind}${p.condor ? `<span class="tag">iron condor</span>` : ""}${p.hypo ? `<span class="tag">trial</span>` : ""}</td>
      <td class="num ${p.dte <= ROLL_DAYS ? "hot" : ""}">${p.dte}</td><td class="num">${Math.round(p.chance * 100)}%</td><td class="num">${money(p.credit)}</td><td class="num">${money(p.maxLoss)}</td><td class="num">${money(p.ev)}</td>
      <td class="num ${p.exit ? "hot" : ""}" title="${exitLong(p)}">${exitPct(p)}<span class="mini">${barHTML(p)}</span></td>
      <td class="num">${fmt(p.theta)}</td><td class="num">${fmt(p.delta, 1)}</td><td class="num">${fmt(p.gamma)}</td><td class="num">${fmt(p.vega)}</td>
      <td class="num">${p.iv.toFixed(0)}%</td><td class="num">${p.tg === null ? "—" : p.tg.toFixed(2)}</td><td class="num">${p.tv === null ? "—" : p.tv.toFixed(2)}</td></tr>`).join("");
    const n = list.length || 1, tTot = sum(list, "theta"), gTot = sum(list, "gamma"), vTot = sum(list, "vega");
    const foot = `<tfoot><tr><td>Book</td><td class="kind">${list.length} spreads</td><td></td>
      <td class="num">${Math.round((sum(list, "chance") / n) * 100)}%<span class="avg">avg</span></td><td class="num">${money(sum(list, "credit"))}</td><td class="num">${money(sum(list, "maxLoss"))}</td><td class="num">${money(sum(list, "ev"))}</td><td></td>
      <td class="num">${fmt(tTot)}</td><td class="num">${fmt(sum(list, "delta"), 1)}</td><td class="num">${fmt(gTot)}</td><td class="num">${fmt(vTot)}</td>
      <td class="num">${(sum(list, "iv") / n).toFixed(0)}%<span class="avg">avg</span></td><td class="num">${gTot ? (tTot / Math.abs(gTot)).toFixed(2) : "—"}</td><td class="num">${vTot ? (tTot / Math.abs(vTot)).toFixed(2) : "—"}</td></tr></tfoot>`;
    $("sc").innerHTML = head + `<tbody>${body}</tbody>` + foot;
  }
  $("sc").addEventListener("click", (e) => {
    const h = e.target.closest("th button");
    if (h) { const k = h.dataset.k; sort = { key: k, dir: sort.key === k ? -sort.dir : ASC_FIRST.includes(k) ? 1 : -1 }; renderScorecard(); return; }
    const r = e.target.closest("tbody tr[data-id]"); if (r) select(r.dataset.id, true);
  });

  // ---- trial trades ----------------------------------------------------------
  // Parses a row from the OptionStrat export, comma- or tab-separated (an Excel paste).
  // 0:Name 1:Return% 2:Return$ 3:CreatedAt 4:Expiration 5:NetCredit 6:Chance 7:MaxLoss 8:MaxProfit ... 11:Delta 12:Theta 13:Gamma 14:Vega 15:Rho 16:IV
  function parseCSVLine(line) {
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
  function parseRow(line) {
    const v = parseCSVLine(line), name = (v[0] || "").trim();
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
  function addTrial() {
    const lines = $("whatif-text").value.split("\n").map((l) => l.trim()).filter(Boolean);
    const parsed = lines.map(parseRow);
    const bad = parsed.filter((p) => !p).length;
    $("whatif-error").hidden = !bad;
    $("whatif-error").textContent = bad ? `${bad === lines.length ? "That row isn't" : `${bad} of ${lines.length} rows aren't`} a spread from the OptionStrat export. Copy the whole row, starting with the spread name.` : "";
    const good = parsed.filter(Boolean).map((p) => enrich(p, "h" + ++hypoSeq));
    if (!good.length) return;
    hypos.push(...good);
    tagCondors(all());
    selected = good[good.length - 1].id;
    $("whatif-text").value = lines.filter((_, i) => !parsed[i]).join("\n"); // leave rejected rows to fix
    render();
  }
  $("whatif-btn").addEventListener("click", () => {
    const p = $("whatif"); p.hidden = !p.hidden;
    $("whatif-btn").setAttribute("aria-expanded", String(!p.hidden));
    if (!p.hidden) $("whatif-text").focus();
  });
  $("whatif-add").addEventListener("click", addTrial);
  $("whatif-text").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addTrial(); } });
  function renderChips() {
    $("chips").innerHTML = hypos.map((p) => `<span class="chip">${esc(p.underlying)} ${esc(p.strikes)} ${p.kind}<button type="button" data-id="${p.id}" aria-label="Remove ${esc(p.name)}">×</button></span>`).join("");
  }
  $("chips").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    hypos = hypos.filter((p) => p.id !== b.dataset.id);
    tagCondors(all());
    if (selected === b.dataset.id) selected = base[0]?.id ?? null;
    render();
  });

  // ---- snapshots -------------------------------------------------------------
  // snapshots.json lists the newest reports ({ base, generatedAt }), newest first.
  let snapshots = [{ base: embeddedBase, generatedAt: takenAt(embedded) }];
  function renderSnapshots(current) {
    $("snapshot").innerHTML = snapshots.map((s) => `<option value="${esc(s.base)}" ${s.base === current ? "selected" : ""}>${snapLabel(s.generatedAt)}</option>`).join("");
  }
  function status(text, error) {
    $("snap-status").textContent = text;
    $("snap-status").classList.toggle("error", !!error);
  }
  async function loadSnapshot(b) {
    if (b === embeddedBase) { useSnapshot(embedded); status(""); return true; }
    status("Loading…");
    try {
      const res = await fetch(encodeURIComponent(b) + "-portfolio.json");
      if (!res.ok) throw new Error(res.status);
      useSnapshot(await res.json());
      status("");
      return true;
    } catch (err) {
      status("Couldn't load that snapshot. Showing the one before.", true);
      return false;
    }
  }
  let shown = embeddedBase;
  $("snapshot").addEventListener("change", async (e) => {
    const b = e.target.value;
    if (await loadSnapshot(b)) {
      shown = b;
      const url = new URL(location.href);
      if (b === embeddedBase) url.searchParams.delete("snapshot"); else url.searchParams.set("snapshot", b);
      history.replaceState(null, "", url);
    } else e.target.value = shown;
  });
  async function initSnapshots() {
    try {
      const res = await fetch("snapshots.json", { cache: "no-store" });
      if (res.ok) {
        const list = await res.json();
        if (Array.isArray(list) && list.length) snapshots = list.some((s) => s.base === embeddedBase) ? list : [{ base: embeddedBase, generatedAt: takenAt(embedded) }, ...list];
      }
    } catch (_) { /* opened from disk or the list is missing: keep just this report */ }
    const wanted = new URL(location.href).searchParams.get("snapshot");
    if (wanted && wanted !== embeddedBase && snapshots.some((s) => s.base === wanted) && (await loadSnapshot(wanted))) shown = wanted;
    renderSnapshots(shown);
  }

  // ---- theme -----------------------------------------------------------------
  const root = document.documentElement;
  const syncTheme = () => ($("theme-btn").textContent = root.dataset.theme === "light" ? "Dark mode" : "Light mode");
  $("theme-btn").addEventListener("click", () => {
    root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
    try { localStorage.setItem("optionspread.theme", root.dataset.theme); } catch (_) { /* won't persist */ }
    syncTheme();
  });
  syncTheme();

  function select(id, scroll) {
    selected = id; render();
    if (scroll && window.innerWidth <= 1040) $("detail").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function render() {
    renderBook(); renderDecide(); renderHeat(); renderDetail(); renderPlot(); renderScorecard(); renderChips();
  }

  renderSnapshots(embeddedBase);
  useSnapshot(embedded);
  initSnapshots();
})();
