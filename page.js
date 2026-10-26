// The report's HTML shell: styles, the snapshot as JSON and the scripts, inlined into one file.
// report.js draws everything in the browser. portfolio.js writes the result to reports/.

const fs   = require('fs');
const path = require('path');
const { RULES } = require('./book');

const asset = f => fs.readFileSync(path.join(__dirname, f), 'utf8');

const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
// Keep "</script>" inside the data from closing the tag.
const embedJSON = obj => JSON.stringify(obj).replace(/</g, '\\u003c');

function buildPage(snapshot, basename) {
  // A paper snapshot (paper.js) says so in the title and the header, so it is never mistaken for the real book.
  const paper = !!snapshot.paper;
  const name = paper ? 'Paper book' : 'Spread book';
  return `<!DOCTYPE html>
  <html lang="en" data-theme="dark" data-palette="#0e2a31,#ece4d0,#f3a83b">
  <head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${name}</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect x='12' y='12' width='34' height='34' rx='6' fill='%23f3a83b'/><rect x='54' y='54' width='34' height='34' rx='6' fill='%23f3a83b'/><rect x='54' y='12' width='34' height='34' rx='6' fill='%23f3a83b' opacity='.45'/><rect x='12' y='54' width='34' height='34' rx='6' fill='%23f3a83b' opacity='.45'/></svg>">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&display=swap" rel="stylesheet">
  <script>
    try { if (localStorage.getItem("optionspread.theme") === "light") document.documentElement.setAttribute("data-theme", "light"); } catch (e) {}
  </script>
  <script>${asset('palette.js')}</script>
  <style>
  ${asset('theme.css')}
  ${asset('report.css')}
  </style>
  </head>
  <body data-base="${escAttr(basename)}">
  <header class="top">
    <h1 class="brand"><a href="index.html">${name}</a></h1>${paper ? '\n    <span class="paper-tag" title="Paper trades: opened and closed at prices from live quotes, never placed. Not in the real book.">Paper trades</span>' : ''}
    <label class="snap">Snapshot <select id="snapshot"></select></label>
    <span class="snap-status" id="snap-status" role="status"></span>
    <span class="spacer"></span>
    <nav><a href="archive.html">Archive</a></nav>
    <button id="theme-btn" type="button">Light mode</button>
    <button id="whatif-btn" type="button" class="btn-signal" aria-expanded="false" aria-controls="whatif">Try a trade</button>
  </header>

  <main class="wrap">
    <section class="whatif" id="whatif" hidden>
      <h2>Try a trade before you place it</h2>
      <p>Paste a row from the OptionStrat export, or several rows copied from Excel. Each trade is added to every total, the grid and the scorecard with a dashed outline, so you can see what it changes.</p>
      <div class="whatif-row">
        <textarea id="whatif-text" aria-label="Spread rows from the OptionStrat export" spellcheck="false" placeholder="AAPL Jun 18th 180/185 Bull Put Spread,0%,$0,..."></textarea>
        <button id="whatif-add" type="button" class="btn-signal">Add to book</button>
      </div>
      <p class="error" id="whatif-error" role="alert" hidden></p>
      <div class="chips" id="chips"></div>
    </section>

    <div class="decide" id="decide"></div>

    <div class="book" id="book" role="group" aria-label="Book totals. Choose one to show it in the grid."></div>

    <div class="split">
      <section>
        <div class="section-head">
          <h2 class="section-title" id="grid-title">Theta by underlying and expiration</h2>
          <div class="legend" id="legend"></div>
        </div>
        <p class="section-note" id="grid-note"></p>
        <div class="heat-scroll"><table class="heat" id="heat"></table></div>
      </section>
      <aside class="detail" id="detail" aria-live="polite"></aside>
    </div>

    <section class="quality">
      <div class="section-head">
        <h2 class="section-title">What each spread pays for its risk</h2>
      </div>
      <div class="plot" id="plot"></div>
      <details class="guide">
        <summary>How to read the graph</summary>
        <dl>
          <dt>Right</dt><dd>More theta for each unit of gamma. These hold up better through a sharp move.</dd>
          <dt>Up</dt><dd>More theta for each unit of vega. These hold up better through an IV spike.</dd>
          <dt>Shaded corner</dt><dd>Below the median on both. Those spreads are the first to close when you want capital back.</dd>
        </dl>
      </details>
    </section>

    <section class="scorecard">
      <div class="section-head">
        <h2 class="section-title">Scorecard</h2>
        <span class="section-note">Select a heading to sort. Gains count toward the close at 50% of max profit, losses toward the stop at 25% of max loss.</span>
      </div>
      <div class="table-scroll"><table class="sc" id="sc"></table></div>
      <details class="guide">
        <summary>What the columns mean</summary>
        <dl>
          <dt>Days</dt><dd>Days to expiration as of the snapshot. Highlighted at 21 or fewer, the window to close or roll before gamma speeds up.</dd>
          <dt>PoP</dt><dd>OptionStrat's probability that both legs expire worthless and you keep the full credit.</dd>
          <dt>EV</dt><dd><code>PoP × max profit − (1 − PoP) × max loss</code>. It treats the trade as all or nothing, so it's usually negative for credit spreads. Use it to compare positions, not as a signal on its own.</dd>
          <dt>Toward an exit</dt><dd>A gain is shown as a share of max profit and counts toward the close at 50%. A loss is shown as a share of max loss and counts toward the stop at 25%. The bar's left end is the stop and its right end is the close.</dd>
          <dt>To short strike</dt><dd>How many expected moves (σ) the stock is from the short strike. One expected move, 1σ, is the one-standard-deviation price move from now to expiration: <code>price × IV × √(days ÷ 365)</code>. Lower is closer, and negative means the stock has passed the strike. It is highlighted below ${RULES.strikeSigma}σ as a heads-up, not an exit. Blank when Yahoo had no price for the underlying.</dd>
        <dt>Theta</dt><dd>Dollars earned per day from time decay, all else equal.</dd>
          <dt>Delta</dt><dd>Direction. Bull puts are positive, bear calls negative.</dd>
        <dt>β Δ</dt><dd>Beta-weighted delta: <code>delta × beta × (stock price ÷ SPY price)</code>, the number of SPY shares the spread behaves like. Adding it up shows how much the book moves with the market. It uses Schwab's beta, passed on by equity-watch, so it is blank for a spread with no beta, or when the betas are more than ${RULES.betaMaxAgeDays} days old. The book total counts only the spreads that have one.</dd>
          <dt>Gamma</dt><dd>How fast delta moves against you. Negative for credit spreads, and largest near expiration and near the short strike.</dd>
          <dt>Vega</dt><dd>Dollars lost per one-point rise in implied volatility.</dd>
          <dt>IV</dt><dd>Implied volatility from the export.</dd>
          <dt>Θ per Γ</dt><dd>Theta earned for each unit of gamma. Low values are the most exposed to a sharp move. Blank when gamma is zero.</dd>
          <dt>Θ per V</dt><dd>Theta earned for each unit of vega. Low values are the first to close into a volatility spike.</dd>
          <dt>Exit plan</dt><dd>Opens from the spread detail as a panel at the side. The stop (${RULES.stop}% of max loss), the ${RULES.watch}% watch line and the target (${RULES.target}% of max profit), each as the spread's price, the stock price that would put the spread there today, and the short leg's delta at that price. The spread's price is the rule; the stock price lets you check it against a live quote during the day. Black-Scholes with the export's one IV for both legs, matched to today's mark, so the stock prices are approximate and shift as days pass. A stock past the short strike is a warning, not an exit.</dd>
          <dt>If you hold from here</dt><dd>In the exit-plan panel, for every spread the model can price. Simulated stock paths from today's price, held to the profit target, a ${RULES.hardStop}% loss at a close, or ${RULES.rollDays} days before expiration (to expiration inside that window), against closing now. The table runs the same spread from deeper losses. The options get no edge in the model and its fall in IV with time is fitted to one trading record, so it is a base rate, not a forecast.</dd>
        </dl>
      </details>
    </section>
  </main>

  <aside class="drawer" id="drawer" aria-labelledby="drawer-title" aria-hidden="true" inert>
    <div class="drawer-head">
      <h2 id="drawer-title">Exit plan</h2>
      <button type="button" id="drawer-close" aria-label="Close the exit plan">Close</button>
    </div>
    <div class="drawer-body" id="drawer-body"></div>
  </aside>

  <script type="application/json" id="book-data">${embedJSON(snapshot)}</script>
  <script>${asset('book.js')}</script>
  <script>${asset('report.js')}</script>
  </body>
  </html>`;
}

module.exports = { buildPage };
