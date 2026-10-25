#!/usr/bin/env node
// The ticket watcher: an always-on process that long-polls spread-scanner's ticket queue (SQS FIFO) and acts on
// each ticket within a second or two. Today the only ticket is a paper trade (paper.open) from the scanner page's
// "Paper trade" button: page → CloudFront → Lambda (token and shape) → SQS → here. The queue and the Lambda are in
// spread-scanner's stack (infra/cloudformation.yaml there); AUTOMATION-PLAN.md 8c and 8f are the design.
//
// Rules, from equity-watch's ops queue, which this copies:
//   - A message is deleted only after its result is recorded (data/paper/tickets.json). A crash in between
//     redelivers it, and the recorded result turns the repeat into a no-op; the paper trade also carries the
//     ticket id, so one ticket can never open two trades.
//   - A ticket received more than WATCH.maxAgeMs ago is rejected, not acted on late: its price would be stale.
//   - An exception (tastytrade down, the disk) records nothing and deletes nothing. The message comes back after the
//     queue's visibility timeout, by when it is usually stale and is rejected for that.
// It writes the ledger only through paper.js's functions and under its lock, so the cron jobs and the CLI never
// write at the same time. Each result goes to tickets/<id>.json in the scanner's bucket, which the page polls.
// After a trade opens it rebuilds and publishes the paper book (paper.js snapshot, publish-paper.sh).
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('./paper');
const { Tastytrade, credentialsFromEnv } = require('./tastytrade');
const { writeFileAtomic } = require('./betas');

// Ticket types this watcher acts on. Keep in step with TYPES in spread-scanner's ticket Lambda ("ping" never
// reaches the queue).
const TICKET_TYPES = ['paper.open'];
const WATCH = {
  maxAgeMs: 5 * 60_000,
  waitSeconds: 20, // SQS long polling: the call returns as soon as a ticket arrives
  keepResults: 500,
};
const DIR = path.join(__dirname, 'data', 'paper');
const RESULTS = path.join(DIR, 'tickets.json');
const HEARTBEAT = path.join(DIR, 'watcher.json');

function loadResults(file = RESULTS) {
  if (!fs.existsSync(file)) return { schema: 'spread-book/tickets@1', results: [] };
  return JSON.parse(fs.readFileSync(file, 'utf8')); // an unreadable file throws: never forget what was done
}
function recordResult(result, file = RESULTS) {
  const doc = loadResults(file);
  doc.results = [...doc.results.filter((r) => r.id !== result.id), result].slice(-WATCH.keepResults);
  writeFileAtomic(file, JSON.stringify(doc, null, 2) + '\n');
}

const rejected = (id, at, message) => ({ id, status: 'rejected', message, at });
const describe = (t) => `${t.symbol} ${t.expiration} ${Math.min(t.shortStrike, t.longStrike)}/${Math.max(t.shortStrike, t.longStrike)} ${t.side === 'put' ? 'bull put' : 'bear call'}`;

// Acts on one message body and returns its result, { id, status: 'opened'|'rejected', message, at, ... }.
// deps: { now, quotes(occs) → Map, dir, resultsFile, ledgerFile }. Throws only on a failure worth retrying.
async function handle(body, deps) {
  const now = deps.now(), at = new Date(now).toISOString();
  let ticket;
  try { ticket = JSON.parse(body); } catch (_) { ticket = null; }
  if (!ticket || typeof ticket.id !== 'string') return rejected(null, at, 'not a ticket');
  const done = loadResults(deps.resultsFile).results.find((r) => r.id === ticket.id);
  if (done) return { ...done, repeat: true };
  if (!TICKET_TYPES.includes(ticket.type)) return rejected(ticket.id, at, `this watcher doesn't handle ${ticket.type} tickets`);
  const age = now - Date.parse(ticket.receivedAt);
  if (!(age <= WATCH.maxAgeMs)) return rejected(ticket.id, at, `the ticket is ${Number.isFinite(age) ? Math.round(age / 60000) + ' minutes' : 'of unknown'} old, so its price is stale. Send it again.`);
  if (!P.marketOpen(now)) return rejected(ticket.id, at, 'the market is closed, so there is no market to fill at. Send it again in the session (9:30 to 16:00 New York).');
  const spec = { ...ticket.trade };
  const bad = P.checkSpec(spec);
  if (bad) return rejected(ticket.id, at, bad);
  return P.withLock(deps.dir, async () => {
    const ledger = P.loadLedger(deps.ledgerFile);
    const opened = (t, again) => ({ id: ticket.id, status: 'opened', at, tradeId: t.id, spread: describe(t), credit: t.credit, mid: t.openMid, natural: t.openNatural, target: t.target.debit,
      message: `${again ? 'Already opened' : 'Opened'} ${t.id}, ${describe(t)}, for ${t.credit.toFixed(2)} (mid ${t.openMid.toFixed(2)}, natural ${t.openNatural.toFixed(2)}).` });
    const existing = ledger.trades.find((t) => t.ticket === ticket.id);
    if (existing) return opened(existing, true);
    const q = P.quotesFor(spec, await deps.quotes(Object.values(P.legsOf(spec))));
    if (!q) return rejected(ticket.id, at, `no two-sided quotes for both legs of the ${describe(spec)}`);
    let t;
    try { t = P.openTrade(ledger, spec, q, at, ticket.id); } catch (e) { return rejected(ticket.id, at, e.message); }
    P.saveLedger(ledger, deps.ledgerFile);
    return opened(t, false);
  });
}

// ---- the loop ---------------------------------------------------------------------------------------

function config(env = process.env) {
  const c = { queueUrl: env.TICKETS_QUEUE_URL, bucket: env.TICKETS_BUCKET, region: env.TICKETS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1',
    accessKeyId: env.TICKETS_AWS_ACCESS_KEY_ID, secretAccessKey: env.TICKETS_AWS_SECRET_ACCESS_KEY };
  return Object.values(c).every(Boolean) ? c : null;
}

const heartbeat = (state) => writeFileAtomic(HEARTBEAT, JSON.stringify({ at: new Date().toISOString(), ...state }) + '\n');

async function run() {
  const cfg = config(), tastytrade = credentialsFromEnv();
  if (!cfg || !tastytrade) {
    // Not an exit: compose would restart it in a loop. Idle, and say so in the heartbeat.
    const why = !cfg ? 'no ticket queue configured (TICKETS_*)' : 'no tastytrade credentials (TASTYTRADE_*)';
    console.log(`Tickets disabled: ${why}.`);
    fs.mkdirSync(DIR, { recursive: true });
    heartbeat({ state: 'disabled', why });
    setInterval(() => heartbeat({ state: 'disabled', why }), 60_000);
    return;
  }
  const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const credentials = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }; // the watcher's own, not the publish key
  const sqs = new SQSClient({ region: cfg.region, credentials });
  const s3 = new S3Client({ region: cfg.region, credentials });
  const tt = new Tastytrade(tastytrade);
  const deps = { now: Date.now, quotes: (occs) => tt.optionQuotes(occs), dir: DIR };
  let stop = false;
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stop = true; console.log('Stopping after this poll.'); });
  console.log(`Watching ${cfg.queueUrl.split('/').pop()} for tickets.`);
  fs.mkdirSync(DIR, { recursive: true });

  while (!stop) {
    heartbeat({ state: 'watching' });
    let messages = [];
    try {
      const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl: cfg.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: WATCH.waitSeconds }));
      messages = r.Messages || [];
    } catch (e) {
      console.error('Receive failed:', e.name || e.message);
      await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }
    let openedAny = false;
    for (const m of messages) {
      let result;
      try { result = await handle(m.Body, deps); } catch (e) {
        console.error('Ticket failed, left on the queue to retry:', e.message);
        continue;
      }
      if (result.id && !result.repeat) recordResult(result);
      console.log(`Ticket ${result.id}: ${result.status}. ${result.message}`);
      if (result.id) {
        try {
          await s3.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: `tickets/${result.id}.json`, Body: JSON.stringify(result), ContentType: 'application/json', CacheControl: 'no-cache' }));
        } catch (e) { console.error(`Couldn't publish the result of ${result.id}:`, e.name || e.message); }
      }
      await sqs.send(new DeleteMessageCommand({ QueueUrl: cfg.queueUrl, ReceiptHandle: m.ReceiptHandle }));
      if (result.status === 'opened' && !result.repeat) openedAny = true;
    }
    // A new paper trade shows in the paper book now, not at the next scheduled snapshot.
    if (openedAny) {
      const snap = spawnSync(process.execPath, [path.join(__dirname, 'paper.js'), 'snapshot'], { stdio: 'inherit' });
      if (snap.status === 0) spawnSync('bash', [path.join(__dirname, 'publish-paper.sh')], { stdio: 'inherit' });
    }
  }
}

module.exports = { TICKET_TYPES, WATCH, handle, loadResults, recordResult, config };

if (require.main === module) {
  try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (_) { /* no .env */ }
  run().catch((e) => { console.error(e); process.exit(1); });
}
