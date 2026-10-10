/**
 * Capture screenshots of each tab, in both themes and languages, into
 * tools/artifacts/. Serves the repo root and drives Chrome over CDP.
 *
 * Usage: node tools/screenshot.mjs [--file=path/to.html] [--tab=ev]
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
const onlyTab = (argv.find((a) => a.startsWith('--tab=')) || '').slice(6);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/' || p === '/' + path.basename(FILE)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    fs.createReadStream(FILE).pipe(res);
    return;
  }
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = path.join(ART, 'chrome-profile-shot');
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, '--window-size=1440,900', '--hide-scrollbars', 'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] });

const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error('timeout\n' + buf)), 30000);
  chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(t); resolve(m[0]); } });
});

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let msgId = 0; const pending = new Map(); let sessionId = null;
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id != null && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
});
const send = (method, params = {}, sid) => new Promise((resolve, reject) => {
  const id = ++msgId; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify(sid ? { id, method, params, sessionId: sid } : { id, method, params }));
});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
sessionId = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
await send('Page.navigate', { url: `${origin}/${path.basename(FILE)}` }, sessionId);
await sleep(3500);

const ev = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise }, sessionId);
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
};

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const f = path.join(ART, name + '.png');
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
  console.log('  wrote tools/artifacts/' + name + '.png');
}

const tabs = onlyTab ? [onlyTab] : JSON.parse(await ev('JSON.stringify(Array.from(document.querySelectorAll("#tabs .tab")).map(b=>b.dataset.tab))'));
for (const t of tabs) {
  await ev(`(async()=>{ await window.__hkEnvMap.activate(${JSON.stringify(t)}); })()`, true);
  await sleep(t === 'habitat' ? 30000 : 3000);
  await shot('tab-' + t);
}
/* theme + popup on the EV tab */
await ev(`(async()=>{ await window.__hkEnvMap.activate('ev'); })()`, true);
await sleep(2500);
await ev('document.getElementById("theme-btn").click()');
await sleep(3500);
await shot('tab-ev-dark');
await ev('document.getElementById("theme-btn").click()');
await sleep(2000);

/* zoom onto a real marker and open its popup so popup styling is visible */
const popupTab = (argv.find((a) => a.startsWith('--popup-tab=')) || '--popup-tab=ev').split('=')[1];
try {
  const picked = await ev(`(async () => {
    const h = window.__hkEnvMap;
    const isBeach = ${JSON.stringify(popupTab)} === 'beachHistory';
    if (isBeach) {
      h.setWaterSub('beach');
      await h.activate('water');
      await new Promise((r) => setTimeout(r, 1500));
    }
    const lid = isBeach ? 'beach' : 'ev';
    const lyr = h.layers[lid];
    if (!lyr) return null;
    let target = null;
    lyr.eachLayer((l) => {
      if (target) return;
      const p = l.feature && l.feature.properties;
      if (!p || !l.getLatLng) return;
      if (!isBeach && !Object.keys(p).some((k) => /_no$/.test(k) && Number(p[k]) > 0)) return;
      target = l;
    });
    if (!target) return null;
    const ll = target.getLatLng();
    h.map.setView(ll, isBeach ? 13 : 15, { animate: false });
    target.openPopup();
    if (isBeach) {
      /* click through to the history view exactly as a user would */
      await new Promise((r) => setTimeout(r, 600));
      const btn = document.querySelector('.leaflet-popup [data-bh-view="history"]');
      if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 8000));
    }
    return { lat: ll.lat, lng: ll.lng, name: (target.feature.properties||{}).LOCATION_EN || (target.feature.properties||{}).Beach || null };
  })()`, true);
  console.log('  popup target:', JSON.stringify(picked));
  await sleep(2500);
  await shot('popup-' + popupTab);
} catch (e) { console.log('  popup shot skipped:', e.message); }

ws.close(); chrome.kill(); server.close(); process.exit(0);
