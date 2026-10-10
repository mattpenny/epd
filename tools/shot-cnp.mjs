/**
 * Capture the CNP popup to show the corrected link and permit number.
 * Usage: node tools/shot-cnp.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ART = path.join(ROOT, 'tools', 'artifacts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(ROOT, p === '/' ? '/index.html' : p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = path.join(ART, 'chrome-profile-cnp');
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, '--window-size=1440,900', '--hide-scrollbars', 'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error('timeout')), 30000);
  chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(t); resolve(m[0]); } });
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map(); let sessionId = null;
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id != null && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
});
const send = (m, p = {}, sid) => new Promise((resolve, reject) => {
  const i = ++id; pending.set(i, { resolve, reject });
  ws.send(JSON.stringify(sid ? { id: i, method: m, params: p, sessionId: sid } : { id: i, method: m, params: p }));
});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
sessionId = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Page.navigate', { url: origin + '/index.html' }, sessionId);
await sleep(3500);
const ev = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise }, sessionId);
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
};

const info = await ev(`(async () => {
  const h = window.__hkEnvMap;
  await h.activate('cnp');
  await new Promise((r) => setTimeout(r, 2000));
  let target = null;
  h.layers.cnp.eachLayer((l) => {
    if (target || !l.feature || !l.getLatLng) return;
    const p = l.feature.properties || {};
    if (!p.PERMIT_NO) return;
    target = l;
  });
  const ll = target.getLatLng();
  h.map.setView(ll, 16, { animate: false });
  target.openPopup();
  return { permit: target.feature.properties.PERMIT_NO, lat: ll.lat, lng: ll.lng };
})()`, true);
console.log('popup target:', JSON.stringify(info));
await sleep(3000);
const shot = await send('Page.captureScreenshot', {
  format: 'png', clip: { x: 420, y: 80, width: 620, height: 560, scale: 2 }
}, sessionId);
fs.writeFileSync(path.join(ART, 'popup-cnp.png'), Buffer.from(shot.data, 'base64'));
console.log('wrote tools/artifacts/popup-cnp.png');
ws.close(); chrome.kill(); server.close(); process.exit(0);
