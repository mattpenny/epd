/**
 * Per-second network activity from first paint, and how long background work
 * keeps the (rate-limited) connection busy after the app is "ready".
 *
 * Usage: node tools/perf-timeline.mjs [--file=...] [--tab=ev,habitat] [--seconds=30]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ART = path.join(ROOT, 'tools', 'artifacts');
fs.mkdirSync(ART, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const FILE = path.resolve(ROOT, (argv.find((a) => a.startsWith('--file=')) || '').slice(7) || 'index.html');
const SECONDS = Number((argv.find((a) => a.startsWith('--seconds=')) || '').slice(10)) || 30;
const TABARG = (argv.find((a) => a.startsWith('--tab=')) || '').slice(6);

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = (p === '/' || p === '/' + path.basename(FILE)) ? FILE : path.join(ROOT, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
  const type = f.endsWith('.html') ? 'text/html; charset=utf-8'
    : f.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = path.join(ART, 'chrome-profile-tl');
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error('timeout')), 30000);
  chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(t); resolve(m[0]); } });
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let id = 0; const pending = new Map(); let sessionId = null;
const reqs = [];
let t0 = Date.now();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id != null && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    return;
  }
  if (!sessionId || m.sessionId !== sessionId) return;
  const p = m.params || {};
  if (m.method === 'Network.requestWillBeSent') {
    reqs.push({ url: p.request.url, at: Date.now() - t0, reqId: p.requestId, bytes: 0 });
  } else if (m.method === 'Network.loadingFinished') {
    const r = reqs.filter((x) => x.reqId === p.requestId).pop();
    if (r) r.bytes = p.encodedDataLength || 0;
  }
});
const send = (m, p = {}, sid) => new Promise((resolve, reject) => {
  const i = ++id; pending.set(i, { resolve, reject });
  ws.send(JSON.stringify(sid ? { id: i, method: m, params: p, sessionId: sid } : { id: i, method: m, params: p }));
});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
sessionId = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
await send('Network.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);

t0 = Date.now();
await send('Page.navigate', { url: origin + '/' + path.basename(FILE) }, sessionId);
const ev = async (expr) => {
  try {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
    return r.exceptionDetails ? null : r.result.value;
  } catch { return null; }
};

const tabMarks = [];
if (TABARG) {
  for (const id2 of TABARG.split(',')) {
    /* wait until the app is up, then click */
    for (let i = 0; i < 100; i++) { if (await ev('!!window.__hkEnvMap')) break; await sleep(100); }
    const at = Date.now() - t0;
    await ev(`(async () => { await window.__hkEnvMap.activate(${JSON.stringify(id2)}); })()`);
    tabMarks.push({ id: id2, at });
    await sleep(2500);
  }
}

await sleep(Math.max(0, SECONDS * 1000 - (Date.now() - t0)));

console.log(`file: ${path.relative(ROOT, FILE)}`);
if (tabMarks.length) console.log('tab clicks at: ' + tabMarks.map((m) => `${m.id}@+${m.at}ms`).join(', '));
console.log('\nper-second network activity (CSDI/EPD requests only):');
const csdi = reqs.filter((r) => /csdi|epd\.gov\.hk|ev-availability|data\.gov\.hk/.test(r.url));
const buckets = {};
for (const r of csdi) {
  const s = Math.floor(r.at / 1000);
  buckets[s] = buckets[s] || { n: 0, bytes: 0 };
  buckets[s].n++; buckets[s].bytes += r.bytes;
}
const maxSec = Math.ceil((Date.now() - t0) / 1000);
for (let s = 0; s <= maxSec; s++) {
  const b = buckets[s] || { n: 0, bytes: 0 };
  const mark = tabMarks.filter((m) => Math.floor(m.at / 1000) === s).map((m) => `  <-- clicked ${m.id}`).join('');
  if (b.n || mark) {
    console.log(`  +${String(s).padStart(3)}s  ${String(b.n).padStart(2)} req  ${String(Math.round(b.bytes / 1024)).padStart(5)}KB${mark}`);
  }
}
const last = csdi.length ? Math.max(...csdi.map((r) => r.at)) : 0;
console.log(`\ntotal EPD/CSDI requests: ${csdi.length}, last one STARTED at +${last}ms`);
console.log(`total bytes (all hosts) : ${(reqs.reduce((a, r) => a + r.bytes, 0) / 1048576).toFixed(2)} MB`);
ws.close(); chrome.kill(); server.close(); process.exit(0);
