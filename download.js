#!/usr/bin/env node
'use strict';

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const EMAIL = process.env.OPTIONSTRAT_EMAIL;
const PASSWORD = process.env.OPTIONSTRAT_PASSWORD;
const ACCOUNT_ID = process.env.OPTIONSTRAT_ACCOUNT_ID;
// In data/, which the container's user can write (the app directory is root's) and which outlives a rebuild.
const SESSION_FILE = path.join(__dirname, 'data', '.session.json');
const BASE_URL = 'https://optionstrat.com';
const API_HEADERS = { 'Content-Type': 'application/json', 'x-version': '1.9' };

if (!EMAIL || !PASSWORD || !ACCOUNT_ID) {
  console.error('Missing OPTIONSTRAT_EMAIL, OPTIONSTRAT_PASSWORD, or OPTIONSTRAT_ACCOUNT_ID in .env');
  process.exit(1);
}

function xlsxToCsv(xlsxBuffer) {
  const workbook = XLSX.read(xlsxBuffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  return XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
}

function loadSessionCookie() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    // Support old Playwright storageState format
    if (data.cookies) {
      const sid = data.cookies.find(c => c.name === 'sid');
      return sid?.value || null;
    }
    return data.sid || null;
  } catch {
    return null;
  }
}

function saveSessionCookie(sid) {
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  // The session cookie is a login: readable by its owner only. mode applies only when the file is created.
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ sid }), { mode: 0o600 });
  fs.chmodSync(SESSION_FILE, 0o600);
}

async function login() {
  console.error('Logging in...');
  const res = await fetch(`${BASE_URL}/api/session`, {
    method: 'POST',
    headers: API_HEADERS,
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${res.statusText}`);

  // Extract sid from Set-Cookie header
  const cookies = res.headers.getSetCookie();
  for (const cookie of cookies) {
    const match = cookie.match(/sid=([^;]+)/);
    if (match) {
      const sid = match[1];
      saveSessionCookie(sid);
      console.error('Login successful, session saved.');
      return sid;
    }
  }
  throw new Error('Login response did not include sid cookie');
}

async function exportXlsx(sid) {
  const res = await fetch(`${BASE_URL}/api/strategy/export`, {
    method: 'POST',
    headers: { ...API_HEADERS, Cookie: `sid=${sid}` },
    body: JSON.stringify({
      tab: 0,
      sort: 1,
      account: ACCOUNT_ID,
      timeZone: 'America/Denver',
    }),
  });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new Error(`Export failed: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

(async () => {
  let sid = loadSessionCookie();
  let xlsxBuffer = null;

  if (sid) {
    console.error('Trying saved session...');
    xlsxBuffer = await exportXlsx(sid);
  }

  if (!xlsxBuffer) {
    sid = await login();
    xlsxBuffer = await exportXlsx(sid);
    if (!xlsxBuffer) throw new Error('Export failed after fresh login');
  }

  // Save xlsx to data/
  const dataDir = path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const ts = new Date().toLocaleDateString('sv', { timeZone: 'America/Denver' })
    + '_' + new Date().toLocaleTimeString('sv', { timeZone: 'America/Denver', hour: '2-digit', minute: '2-digit' }).replace(':', '-');
  const xlsxName = `live-active-by-symbol-${ts}.xlsx`;
  const xlsxPath = path.join(dataDir, xlsxName);
  fs.writeFileSync(xlsxPath, xlsxBuffer);
  console.error(`Downloaded: ${xlsxName}`);

  // Convert to csv
  const csvName = xlsxName.replace(/\.xlsx$/i, '.csv');
  const csvPath = path.join(dataDir, csvName);
  fs.writeFileSync(csvPath, xlsxToCsv(xlsxBuffer));
  console.error(`Converted: ${csvName}`);

  // Print csv path to stdout for callers to capture
  console.log(csvPath);
})();
