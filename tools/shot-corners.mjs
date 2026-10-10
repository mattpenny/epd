/**
 * Capture the top-left region at several viewport widths to inspect the header
 * brand and the Leaflet zoom control alignment.
 * Usage: node tools/shot-corners.mjs
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

const profile = path.join(ART, 'chrome-profile-corner');
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
await sleep(4000);

const ev = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise }, sessionId);
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
};

for (const w of [360, 768, 1440]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 720, deviceScaleFactor: 2, mobile: w < 768 }, sessionId);
  await sleep(1800);
  await ev('window.dispatchEvent(new Event("resize"))');
  await sleep(900);
  const geom = await ev(`JSON.stringify((function(){
    const z = document.querySelector('.leaflet-control-zoom');
    const b = document.querySelector('.brand');
    const dot = document.querySelector('.brand-dot');
    const bn = document.querySelector('.bottom-nav');
    const acts = document.querySelector('.actions');
    const hdr = document.querySelector('.topbar');
    const r = z ? z.getBoundingClientRect() : null;
    const rb = b ? b.getBoundingClientRect() : null;
    const rd = dot ? dot.getBoundingClientRect() : null;
    const rbn = bn ? bn.getBoundingClientRect() : null;
    const ra = acts ? acts.getBoundingClientRect() : null;
    const rh = hdr ? hdr.getBoundingClientRect() : null;
    const m = document.getElementById('map').getBoundingClientRect();
    return {
      viewport: [window.innerWidth, window.innerHeight],
      docScrollW: document.documentElement.scrollWidth,
      zoom: r && { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) },
      gapBelowHeader: r ? Math.round(r.y - m.top) : null,
      mapTop: Math.round(m.top), mapBottom: Math.round(m.bottom),
      headerH: Math.round(rh ? rh.height : 0),
      brand: rb && { x: Math.round(rb.x), y: Math.round(rb.y), w: Math.round(rb.width), right: Math.round(rb.right) },
      dot: rd && { x: Math.round(rd.x), y: Math.round(rd.y), w: Math.round(rd.width), h: Math.round(rd.height) },
      actions: ra && { x: Math.round(ra.x), right: Math.round(ra.right), w: Math.round(ra.width) },
      bottomNav: rbn && { y: Math.round(rbn.y), h: Math.round(rbn.height), visible: rbn.height > 0 },
      brandOverlapsActions: !!(rb && ra && rb.right > ra.x)
    };
  })())`);
  console.log(`w=${w}`, geom);
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: Math.min(w, 420), height: 260, scale: 2 }
  }, sessionId);
  fs.writeFileSync(path.join(ART, `corner-${w}.png`), Buffer.from(shot.data, 'base64'));
  console.log(`  wrote corner-${w}.png`);
}

ws.close(); chrome.kill(); server.close(); process.exit(0);
