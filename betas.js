#!/usr/bin/env node
// What spread-book exchanges with equity-watch through the shared directory (./shared in
// the container): the underlyings it needs betas for, and the betas it hands back.
//
//   node betas.js write-underlyings <csv> <file>   list the CSV's underlyings, and the open paper trades'
//                                                  (data/paper/ledger.json), for equity-watch
//
// Also required by portfolio.js, which reads the betas into each snapshot.

const fs   = require('fs');
const path = require('path');

const BETAS_SCHEMA = 'equity-watch/betas@1';

// Schwab writes a class share as BRK/B; the OptionStrat export may print BRK.B.
const toSchwab   = symbol => symbol.replace('.', '/');
const fromSchwab = symbol => symbol.replace('/', '.');

// The first field of a CSV line, honouring quotes. Spread names never hold a comma, but be safe.
function firstField(line) {
  let out = '', inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) break;
    else out += ch;
  }
  return out.trim();
}

// Same rows portfolio.js reads: two header lines, then one row per spread, each followed by
// its legs (names starting with '.').
function underlyingsFromCsv(text) {
  const seen = new Set();
  text.split('\n').slice(2).forEach(line => {
    const name = firstField(line);
    if (name && !name.startsWith('.') && name.toLowerCase().includes('spread')) seen.add(name.split(' ')[0]);
  });
  return [...seen];
}

// Renamed into place so equity-watch never reads half a file. Mode 0644: it runs as another user.
function writeFileAtomic(file, text) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temp, text, { mode: 0o644 });
    fs.chmodSync(temp, 0o644);
    fs.renameSync(temp, file);
  } catch (e) {
    fs.rmSync(temp, { force: true });
    throw e;
  }
}

// The symbols of the open paper trades (paper.js's ledger), so they get betas too. [] when there is no ledger;
// one that won't parse is a warning, not a failure: the real book's list matters more.
function paperUnderlyings(ledgerFile) {
  if (!fs.existsSync(ledgerFile)) return [];
  try {
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    return [...new Set((ledger.trades || []).filter(t => !t.close).map(t => t.symbol))];
  } catch (e) {
    console.warn(`WARN: ${ledgerFile} unreadable, so no paper symbols: ${e.message}`);
    return [];
  }
}

// One symbol per line; equity-watch ignores the '#' comment. Returns how many symbols were written.
// extra are more symbols to list (the paper book's), after the export's. Writes nothing when the export has
// no spreads, even with extra ones, so a bad download can't blank the list equity-watch last saw.
function writeUnderlyings(csvFile, outFile, now = new Date(), extra = []) {
  const fromCsv = underlyingsFromCsv(fs.readFileSync(csvFile, 'utf8'));
  if (!fromCsv.length) return 0;
  const symbols = [...new Set([...fromCsv, ...extra])].map(toSchwab);
  writeFileAtomic(outFile, `# written by spread-book from ${path.basename(csvFile)} at ${now.toISOString()}\n${symbols.join('\n')}\n`);
  return symbols.length;
}

// equity-watch's betas file as { asOf, betas }, keyed by the symbols as the export spells them,
// or null when it is missing, unreadable or not the schema this expects. A symbol equity-watch
// has no beta for is null. Whether the file is too old to use is the caller's call, from asOf.
function readBetas(file) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') console.warn(`WARN: ${file} unreadable: ${e.message}`); return null; }
  if (!doc || doc.schema !== BETAS_SCHEMA || !doc.betas || typeof doc.betas !== 'object' || !doc.generatedAt) {
    console.warn(`WARN: ${file} is not an ${BETAS_SCHEMA} file; ignoring it`);
    return null;
  }
  const betas = {};
  for (const [symbol, beta] of Object.entries(doc.betas)) betas[fromSchwab(symbol)] = Number.isFinite(beta) ? beta : null;
  return { asOf: doc.generatedAt, betas };
}

module.exports = { BETAS_SCHEMA, toSchwab, fromSchwab, underlyingsFromCsv, paperUnderlyings, writeFileAtomic, writeUnderlyings, readBetas };

if (require.main === module) {
  const [cmd, csv, out] = process.argv.slice(2);
  if (cmd !== 'write-underlyings' || !csv || !out) {
    console.error('Usage: node betas.js write-underlyings <csv> <file>');
    process.exit(1);
  }
  const n = writeUnderlyings(csv, out, new Date(), paperUnderlyings(path.join(__dirname, 'data', 'paper', 'ledger.json')));
  console.log(n ? `Wrote ${n} underlyings → ${out}` : `No spreads in ${csv}; left ${out} alone`);
}
