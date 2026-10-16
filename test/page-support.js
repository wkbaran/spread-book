// Loads a report page, built exactly as portfolio.js builds it, in jsdom, and runs its scripts.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { JSDOM, VirtualConsole } = require('jsdom');
const { buildPage } = require('../page');

const tick = () => new Promise((r) => setTimeout(r, 0));

// files maps a URL the page fetches to its JSON, e.g. { 'snapshots.json': [...] }. Anything else is a 404.
async function loadPage(snapshot, { base = 'fixture', files = {}, url = 'http://localhost/index.html' } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e.message));
  virtualConsole.on('error', (...a) => errors.push(a.join(' ')));
  const dom = new JSDOM(buildPage(snapshot, base), {
    runScripts: 'dangerously', url, virtualConsole, pretendToBeVisual: true,
    beforeParse(window) {
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.fetch = async (u) => {
        const key = decodeURIComponent(String(u));
        return key in files ? { ok: true, status: 200, json: async () => files[key] } : { ok: false, status: 404, json: async () => { throw new Error('404'); } };
      };
    },
  });
  await tick(); await tick();
  const { window } = dom;
  const { document } = window;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const key = (k) => document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  const text = (sel) => ($(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim();
  return { dom, window, document, errors, $, $$, click, key, text, tick, close: () => window.close() };
}

// Runs the real brief.js on a snapshot, in a scratch copy so it reads and writes nothing of the project's,
// and returns the latest.json it wrote.
function runBrief(snapshot, base = 'live-active-by-symbol-2026-03-24_14-12') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spread-book-test-'));
  try {
    for (const f of ['brief.js', 'book.js']) fs.copyFileSync(path.join(__dirname, '..', f), path.join(dir, f));
    fs.mkdirSync(path.join(dir, 'reports'));
    fs.writeFileSync(path.join(dir, 'reports', base + '-portfolio.json'), JSON.stringify(snapshot));
    const r = spawnSync(process.execPath, ['brief.js'], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('brief.js failed: ' + r.stderr);
    return JSON.parse(fs.readFileSync(path.join(dir, 'reports', 'latest.json'), 'utf8'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = { loadPage, runBrief, tick };
