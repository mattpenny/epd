/**
 * Measure what the app pulls during BOOT ONLY (no tab clicks), so lazy-loading
 * changes can be proven rather than assumed.
 *
 * Usage: node tools/perf-boot.mjs [--file=path/to.html] [--seconds=12]
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
const fileArg = (argv.find((a) => a.startsWith('--file=')) || '').slice(7);
const FILE = path.resolve(ROOT, fileArg || 'index.html');
const SECONDS = Number((argv.find((a) => a.startsWith('--seconds=')) || '').slice(10)) || 12;

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  /* serve the target file for / and for its own basename, everything else from ROOT */
  const f = (p === '/' || p === '/' + path.basename(FILE)) ? FILE : path.join(ROOT, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
  const type = f.endsWith('.html') ? 'text/html; charset=utf-8'
    : f.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = path.join(ART, 'chrome-profile-perf');
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] });

const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error('timeout waiting for devtools')), 30000);
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
    reqs.push({ url: p.request.url, start: Date.now() - t0, reqId: p.requestId, bytes: 0, end: null });
  } else if (m.method === 'Network.loadingFinished') {
    const r = reqs.filter((x) => x.reqId === p.requestId && x.end === null).pop();
    if (r) { r.end = Date.now() - t0; r.bytes = p.encodedDataLength || 0; }
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

/* poll only cheap, always-defined expressions */
let firstLayer = null, spinnerHidden = null;
for (let i = 0; i < SECONDS * 10; i++) {
  await sleep(100);
  if (firstLayer == null && await ev('!!(window.__hkEnvMap && window.__hkEnvMap.layers && window.__hkEnvMap.layers.air)')) {
    firstLayer = Date.now() - t0;
  }
  if (spinnerHidden == null) {
    const hidden = await ev('document.getElementById("loading") && !document.getElementById("loading").classList.contains("show")');
    if (hidden === true && firstLayer != null) spinnerHidden = Date.now() - t0;
  }
}

await sleep(500);
const total = reqs.reduce((a, r) => a + (r.bytes || 0), 0);
const csdi = reqs.filter((r) => /csdi/.test(r.url));
const csdiBytes = csdi.reduce((a, r) => a + (r.bytes || 0), 0);

console.log(`file: ${path.relative(ROOT, FILE)}   window: ${SECONDS}s after navigation`);
console.log(`first layer present at : ${firstLayer == null ? 'not reached' : firstLayer + 'ms'}`);
console.log(`loading spinner hidden : ${spinnerHidden == null ? 'still showing' : spinnerHidden + 'ms'}`);
console.log(`total requests         : ${reqs.length}`);
console.log(`total bytes            : ${(total / 1048576).toFixed(2)} MB`);
console.log(`CSDI requests / bytes  : ${csdi.length} / ${(csdiBytes / 1048576).toFixed(2)} MB`);

const byPath = {};
for (const r of csdi) {
  const ds = (r.url.match(/common\/([^/]+)/) || [])[1] || '?';
  byPath[ds] = byPath[ds] || { n: 0, bytes: 0 };
  byPath[ds].n++; byPath[ds].bytes += r.bytes || 0;
}
console.log('\nCSDI datasets fetched during boot:');
Object.entries(byPath).sort((a, b) => b[1].bytes - a[1].bytes).forEach(([ds, v]) =>
  console.log(`  ${ds.padEnd(34)} n=${String(v.n).padStart(2)}  ${(v.bytes / 1024).toFixed(0)}KB`));

/* optional: measure the cold-load cost of a specific tab (the tradeoff of lazy loading) */
const tabArg = (argv.find((a) => a.startsWith('--tab=')) || '').slice(6);
if (tabArg) {
  const ids = tabArg.split(',');
  for (const id of ids) {
    const t1 = Date.now();
    await ev(`(async () => { await window.__hkEnvMap.activate(${JSON.stringify(id)}); })()`);
    let loaded = null;
    for (let i = 0; i < 900; i++) {
      await sleep(100);
      const ok = await ev(`!!(window.__hkEnvMap.state.loaded[window.__hkEnvMap.activeLayerId()])`);
      if (ok) { loaded = Date.now() - t1; break; }
    }
    /* count requests attributable to this tab */
    const before = reqs.length;
    console.log(`COLD LOAD "${id}": ${loaded == null ? 'did not finish in 90s' : loaded + 'ms'}`);
  }
}

fs.writeFileSync(path.join(ART, 'perf-boot.json'), JSON.stringify({ firstLayer, spinnerHidden, total, csdiBytes, reqs }, null, 2));
ws.close(); chrome.kill(); server.close(); process.exit(0);
