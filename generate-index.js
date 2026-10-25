'use strict';

const fs = require('fs');
const path = require('path');

const REPORTS_DIR = path.join(__dirname, 'reports');

// download.js stamps filenames with America/Denver wall-clock time; turn one into an instant.
function fromDenver(date, hh, mm) {
  const guess = new Date(`${date}T${hh}:${mm}:00Z`);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', timeZoneName: 'longOffset' })
    .formatToParts(guess).find(p => p.type === 'timeZoneName').value; // e.g. "GMT-06:00"
  const m = off.match(/([+-])(\d{2}):(\d{2})/);
  const mins = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return new Date(guess.getTime() - mins * 60000);
}

// "live-active-by-symbol-2026-03-16_14-44" → "Mon, Mar 16, 2:44 PM MDT"
function describe(basename) {
  const m = basename.match(/(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})$/);
  if (!m) return basename;
  return fromDenver(m[1], m[2], m[3]).toLocaleString('en-US', {
    timeZone: 'America/Denver', weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

// Returns the Monday of the week containing the given YYYY-MM-DD string
function weekStart(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = d.getUTCDay(); // 0=Sun
  const diff = (day === 0 ? -6 : 1 - day);
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function weekLabel(monday) {
  const d = new Date(monday + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

const asset = f => fs.readFileSync(path.join(__dirname, f), 'utf8');

function generateArchive(sorted, title = 'Spread book') {
  // Group by week
  const weeks = new Map(); // monday ISO → [{base, heatmaps, portfolio}]
  for (const [base, files] of sorted) {
    const m = base.match(/(\d{4}-\d{2}-\d{2})/);
    const monday = m ? weekStart(m[1]) : '0000-00-00';
    if (!weeks.has(monday)) weeks.set(monday, []);
    weeks.get(monday).push({ base, ...files });
  }

  const todayMonday = weekStart(new Date().toISOString().slice(0, 10));

  const sections = [...weeks.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([monday, entries]) => {
      const open = monday === todayMonday ? ' open' : '';
      const rows = entries.map(({ base, heatmaps, portfolio }) => {
        const links = [];
        if (portfolio) links.push(`<a href="${portfolio}">Spread book</a>`);
        if (heatmaps)  links.push(`<a href="${heatmaps}">Heatmaps</a>`);
        return `        <li><span>${describe(base)}</span>${links.join('')}</li>`;
      }).join('\n');
      return `  <details${open}>
    <summary>Week of ${weekLabel(monday)} <span class="muted">${entries.length} report${entries.length === 1 ? '' : 's'}</span></summary>
    <ul>
${rows}
    </ul>
  </details>`;
    }).join('\n');

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark" data-palette="#0e2a31,#ece4d0,#f3a83b">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Report archive</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&display=swap" rel="stylesheet">
<script>
  try { if (localStorage.getItem("optionspread.theme") === "light") document.documentElement.setAttribute("data-theme", "light"); } catch (e) {}
</script>
<script>${asset('palette.js')}</script>
<style>
${asset('theme.css')}
  .wrap { max-width: 48rem; padding-top: 2rem; }
  .section-title { margin-bottom: 1.25rem; }
  details { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-m); margin-bottom: 0.6rem; }
  summary { padding: 0.7rem 1rem; cursor: pointer; font-weight: 600; font-stretch: 85%; }
  summary .muted { font-weight: 450; margin-left: 0.4rem; font-size: 0.86rem; }
  ul { list-style: none; margin: 0; padding: 0 1rem 0.6rem; }
  li { display: flex; flex-wrap: wrap; gap: 0.3rem 1.2rem; align-items: baseline; padding: 0.45rem 0; border-top: 1px solid var(--line); font-size: 0.9rem; }
  li span { flex: 1; min-width: 12rem; color: var(--sub); font-stretch: 90%; }
</style>
</head>
<body>
<header class="top">
  <h1 class="brand"><a href="index.html">${title}</a></h1>
  <span class="spacer"></span>
  <nav><a href="index.html">Latest report</a></nav>
</header>
<main class="wrap">
  <h2 class="section-title">Report archive</h2>
${sorted.length ? sections : '<p class="muted">No reports yet. They appear here after the first run.</p>'}
</main>
</body>
</html>`;
}

// The report's snapshot menu reads this: the newest portfolio snapshots, newest first.
// Reports publish twice each trading day, so 14 is about a week.
const SNAPSHOT_LIMIT = 14;
function snapshotList(allFiles) {
  return allFiles
    .map(f => f.match(/^(.*-(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2}))-portfolio\.json$/))
    .filter(Boolean)
    .map(([, base, date, hh, mm]) => ({ base, generatedAt: fromDenver(date, hh, mm).toISOString() }))
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
    .slice(0, SNAPSHOT_LIMIT);
}

// dir is the reports directory (reports/, or reports/paper/ for paper trades) and title the archive's heading.
module.exports = function generateIndex(fileList, dir = REPORTS_DIR, title) {
  const allFiles = fileList || fs.readdirSync(dir);
  const files = allFiles
    .filter(f => f.endsWith('.html') && f !== 'index.html' && f !== 'archive.html');

  // Group files by their base key (strip trailing -heatmaps / -portfolio)
  const groups = new Map();
  for (const file of files) {
    const base = file.replace(/-(heatmaps|portfolio)\.html$/, '');
    const type = file.match(/-(heatmaps|portfolio)\.html$/)?.[1];
    if (!type) continue;
    if (!groups.has(base)) groups.set(base, { heatmaps: null, portfolio: null });
    groups.get(base)[type] = file;
  }

  // Sort groups by embedded date descending (most recent first)
  const sorted = [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));

  fs.mkdirSync(dir, { recursive: true });

  if (sorted.length) {
    const [, { heatmaps, portfolio }] = sorted[0];
    const latestFile = portfolio || heatmaps;
    const content = fs.readFileSync(path.join(dir, latestFile), 'utf8');
    fs.writeFileSync(path.join(dir, 'index.html'), content);
  }

  fs.writeFileSync(path.join(dir, 'archive.html'), generateArchive(sorted, title));
  fs.writeFileSync(path.join(dir, 'snapshots.json'), JSON.stringify(snapshotList(allFiles), null, 2));

  console.log(`Index updated — ${sorted.length} report${sorted.length === 1 ? '' : 's'}`);
};

// CLI: pipe a file list via stdin to generate index from external source (e.g. S3)
//   aws s3 ls s3://bucket/ | awk '{print $4}' | node generate-index.js --stdin
if (require.main === module) {
  if (process.argv.includes('--stdin')) {
    const input = fs.readFileSync('/dev/stdin', 'utf8');
    const files = input.trim().split('\n').filter(Boolean);
    module.exports(files);
  } else {
    module.exports();
  }
}
