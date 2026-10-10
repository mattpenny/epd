/**
 * Layer/language test harness for a specific HTML file.
 *
 * Serves a single HTML file (from anywhere) plus the repo's assets, drives Chrome
 * over CDP, and reports per-layer load results and any exceptions. Used to A/B
 * the pristine upstream file against local changes.
 *
 * Usage: node tools/test-file.mjs --file=tools/artifacts/pristine.html [--lang-switch-at=noise]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ART = path.join(__dirname, 'artifacts');
fs.mkdirSync(ART, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const fileArg = (argv.find((a) => a.startsWith('--file=')) || '').slice(7);
const FILE = path.resolve(ROOT, fileArg || 'index.html');
if (!fs.existsSync(FILE)) { console.error('no such file: ' + FILE); process.exit(2); }
/* Which tab to be on when the language button is clicked */
const langAt = (argv.find((a) => a.startsWith('--lang-switch-at=')) || '--lang-switch-at=noise').split('=')[1];

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/' || p === '/' + path.basename(FILE)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    fs.createReadStream(FILE).pipe(res);
    return;
  }
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const pageUrl = `${origin}/${path.basename(FILE)}`;

const profile = path.join(ART, 'chrome-profile-testfile');
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] });

const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error('timeout\n' + buf)), 30000);
  chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(t); resolve(m[0]); } });
});

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let msgId = 0; const pending = new Map(); let sessionId = null;
const exceptions = []; const consoleErrs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id != null && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result); return;
  }
  if (!sessionId || m.sessionId !== sessionId) return;
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails || {};
    exceptions.push(((d.stackTrace && d.stackTrace.callFrames) || [])
      .map((f) => `${f.functionName || '(anon)'}:${f.lineNumber + 1}`).join(' <- ') + ' :: ' +
      ((d.exception && d.exception.description) || d.text));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrs.push((m.params.args || []).map((a) => a.value ?? a.description).join(' '));
  }
});
const send = (method, params = {}, sid) => new Promise((resolve, reject) => {
  const id = ++msgId; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify(sid ? { id, method, params, sessionId: sid } : { id, method, params }));
});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
sessionId = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
await send('Page.navigate', { url: pageUrl }, sessionId);
await sleep(2500);

const ev = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise }, sessionId);
  if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
  return r.result.value;
};
const has = await ev('!!window.__hkEnvMap');

console.log(`file   : ${path.relative(ROOT, FILE)}`);
console.log(`url    : ${pageUrl}`);
console.log(`hook   : ${has}`);
if (!has) {
  console.log('page did not boot; exceptions:', exceptions);
  ws.close(); chrome.kill(); server.close(); process.exit(1);
}

/* Activate every tab the file defines (discover from the DOM, not hardcoded,
   so the pristine file and the modified file are each tested as they are). */
const tabIds = await ev('JSON.stringify(Array.from(document.querySelectorAll("#tabs .tab")).map(b=>b.dataset.tab))');
console.log('tabs   :', tabIds);

for (const id of JSON.parse(tabIds)) {
  const res = await ev(`(async()=>{ try { await window.__hkEnvMap.activate(${JSON.stringify(id)}); } catch(e) { return {crash: String(e && e.message)}; } const lid = window.__hkEnvMap.activeLayerId(); const l = window.__hkEnvMap.layers[lid]; return { lid, n: l && l.getLayers ? l.getLayers().length : 0 }; })()`, true);
  console.log(`  activate ${id.padEnd(9)} -> ${JSON.stringify(res)}`);
  await sleep(500);
}

console.log(`\nswitching language while on "${langAt}"...`);
await ev(`(async()=>{ try { await window.__hkEnvMap.activate(${JSON.stringify(langAt)}); } catch(e){} })()`, true);
await sleep(500);
await ev('document.getElementById("lang-btn").click()');
await sleep(3500);
console.log('  after switch: lang =', JSON.stringify(await ev('window.__hkEnvMap.state.lang')),
            ' active =', JSON.stringify(await ev('window.__hkEnvMap.state.active')));

console.log(`\n=== exceptions (${exceptions.length}) ===`);
exceptions.forEach((e, i) => console.log(` [${i}] ${e.slice(0, 400)}`));
console.log(`=== console errors (${consoleErrs.length}) ===`);
consoleErrs.forEach((c) => console.log('  - ' + String(c).slice(0, 220)));

ws.close(); chrome.kill(); server.close();
process.exit(exceptions.length ? 1 : 0);
