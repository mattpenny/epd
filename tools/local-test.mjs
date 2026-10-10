/**
 * Local verification harness for index.html (EPD data map).
 *
 * Serves the repo root over http://127.0.0.1:<port>, drives real Chrome via the
 * DevTools Protocol, and asserts each layer actually loads from the LIVE
 * government endpoints. Every upstream request is recorded with its HTTP status,
 * content-type and Access-Control-Allow-Origin so CORS / 403 problems are
 * observed rather than guessed.
 *
 * Usage: node tools/local-test.mjs [--headed] [--only=ev,recycle]
 * Exit code 0 = all checks passed. Artifacts land in tools/artifacts/.
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

const argv = process.argv.slice(2);
const HEADED = argv.includes('--headed');
const onlyArg = argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice(7).split(',').map((s) => s.trim()).filter(Boolean) : null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('No Chrome/Edge binary found; set CHROME_PATH');
}

function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Minimal CDP client over Node's built-in WebSocket. */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.listeners.forEach((fn) => fn(msg));
      }
    });
  }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('websocket error connecting to ' + wsUrl)), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
  on(fn) { this.listeners.push(fn); }
  close() { try { this.ws.close(); } catch {} }
}

/* ------------------------------------------------------------------- run */
const results = [];
const net = [];
const consoleErrs = [];
const pageErrors = [];

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   [' + detail + ']' : ''}`);
}

let server, chrome, cdp, sessionId;

try {
  server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  console.log(`serving ${ROOT}\nat ${origin}\n`);

  const bin = findChrome();
  const profile = path.join(ART, 'chrome-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const args = [
    HEADED ? '--new-window' : '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--window-size=1440,900',
    '--hide-scrollbars',
    'about:blank'
  ];
  chrome = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const wsEndpoint = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('timeout waiting for DevTools ws endpoint\n' + buf)), 30000);
    chrome.stderr.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/ws:\/\/[^\s]+/);
      if (m) { clearTimeout(t); resolve(m[0]); }
    });
    chrome.on('exit', (c) => { clearTimeout(t); reject(new Error('chrome exited ' + c + '\n' + buf)); });
  });

  cdp = await CDP.connect(wsEndpoint);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  sessionId = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;

  cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    const p = msg.params || {};
    if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
      consoleErrs.push((p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails || {};
      pageErrors.push((d.exception && d.exception.description) || d.text || 'unknown exception');
    }
    if (msg.method === 'Network.responseReceived') {
      const r = p.response || {};
      const u = r.url || '';
      if (/csdi|data\.gov\.hk|epd\.gov\.hk|geodata|unpkg|arcgisonline|aqhi|ev-availability/.test(u)) {
        const h = r.headers || {};
        net.push({
          url: u,
          status: r.status,
          mime: h['content-type'] || h['Content-Type'] || '',
          acao: h['access-control-allow-origin'] || h['Access-Control-Allow-Origin'] || '',
          type: p.type
        });
      }
    }
  });

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url: origin + '/index.html' }, sessionId);
  await sleep(2000);

  const evalJs = async (expr, awaitPromise = false) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise, timeout: 120000
    }, sessionId);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('eval: ' + ((d.exception && d.exception.description) || d.text));
    }
    return r.result.value;
  };

  const wants = (id) => !ONLY || ONLY.includes(id);

  /* ---------- structural checks ---------- */
  check('page exposes __hkEnvMap test hook', await evalJs('!!window.__hkEnvMap'));
  const tabCount = await evalJs("document.querySelectorAll('#tabs .tab').length");
  check('top tabs rendered', tabCount >= 6, 'count=' + tabCount);
  check('EV tab button present', await evalJs("!!document.querySelector('.tab[data-tab=\"ev\"]')"));
  check('EV tab has a label', await evalJs("(document.querySelector('.tab[data-tab=\"ev\"] .tab-label')||{}).textContent || ''") !== '');

  /* ---------- per-layer live load ---------- */
  const layers = [
    { id: 'air', label: 'air (regression)' },
    { id: 'ev', label: 'EV chargers' },
    { id: 'recycle', label: 'recycle (regression)' },
    { id: 'water', label: 'water/beach (regression)' },
    { id: 'cnp', label: 'cnp (regression)' },
    { id: 'noise', label: 'noise (regression)' },
    { id: 'habitat', label: 'habitat maps (NEW)', min: 5000, countVia: 'featureCount', waitMs: 45000 }
  ];

  /** Habitat is a layerGroup of per-habitat-type sub-layers, so getLayers()
   *  counts categories (16), not features. Count features for that case. */
  const countExpr = (L) => L.countVia === 'featureCount'
    ? `(function (lyr) {
         let f = 0;
         if (lyr && lyr.eachLayer) lyr.eachLayer((sub) => { if (sub.eachLayer) sub.eachLayer((l) => { if (l.feature) f++; }); });
         else if (lyr && lyr.getLayers) f = lyr.getLayers().length;
         return f;
       })(h.layers[lid])`
    : `(lyr && lyr.getLayers ? lyr.getLayers().length : 0)`;
  const wanted = ONLY ? layers.filter((l) => ONLY.includes(l.id)) : layers;

  for (const L of wanted) {
    let info = null;
    try {
      info = await evalJs(`(async () => {
        const h = window.__hkEnvMap;
        await h.activate(${JSON.stringify(L.id)});
        const lid = h.activeLayerId();
        let lyr = h.layers[lid];
        ${L.waitMs ? `/* progressive loader: wait for it to finish filling in */
        const deadline = Date.now() + ${L.waitMs};
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1000));
          lyr = h.layers[lid];
          if (lyr && lyr._habitatTotal && lyr._habitatDone >= lyr._habitatTotal) break;
        }` : ''}
        const n = ${countExpr(L)};
        return { lid: lid, count: n, err: !!h.state.errors[lid], loaded: !!h.state.loaded[lid] };
      })()`, true);
    } catch (e) {
      check(L.label + ' loads', false, 'exception: ' + e.message);
      continue;
    }
    const min = L.min || 1;
    const ok = info && info.count >= min && !info.err;
    check(`${L.label} loads features`, ok,
      `layer=${info && info.lid} features=${info && info.count} error=${info && info.err}`);
    await sleep(400);
  }

  /* ---------- water tab: back to 3 sub-tabs; history folded into the beach card ---------- */
  if (wants('water')) {
  const subs = await evalJs(`(async () => {
    const h = window.__hkEnvMap;
    await h.activate('water');
    await new Promise((r) => setTimeout(r, 400));
    return Array.from(document.querySelectorAll('#sub-tabs .sub-tab')).map((b) => b.dataset.sub);
  })()`, true);
  check('water tab shows 3 sub-tabs again', Array.isArray(subs) && subs.length === 3, JSON.stringify(subs));
  check('historical beach no longer a separate sub-tab',
    Array.isArray(subs) && !subs.includes('histBeach'), JSON.stringify(subs));

  /* The history is now lazy: it must NOT be fetched while the beach layer loads.
     Assert 0 series loaded straight after the beach tab appears. */
  const lazy = await evalJs(`(async () => {
    const h = window.__hkEnvMap;
    h.setWaterSub('beach');
    await h.activate('water');
    const lyr = h.layers.beach;
    return { beachMarkers: lyr && lyr.getLayers ? lyr.getLayers().length : 0 };
  })()`, true);
  check('beach layer still loads its 40 markers', lazy && lazy.beachMarkers === 40,
    'markers=' + (lazy && lazy.beachMarkers));

  /* The beach popup must expose the two views, defaulting to the grade. */
  const views = await evalJs(`(() => {
    const h = window.__hkEnvMap;
    let html = null, marker = null;
    h.layers.beach.eachLayer((l) => {
      if (html || !l.feature) return;
      const c = l.getPopup().getContent();
      const node = L.DomUtil.create('div');
      node.innerHTML = (typeof c === 'function') ? c(l) : String(c);
      html = node.innerHTML; marker = l.feature.properties.Beach;
    });
    return { html, marker };
  })()`);
  check('beach card shows a Water quality / History switch',
    !!views && /data-bh-view="grade"/.test(views.html) && /data-bh-view="history"/.test(views.html),
    'marker=' + (views && views.marker));
  check('beach card defaults to the water-quality view (no eager history fetch)',
    !!views && /大腸桿菌|E\. coli/.test(views.html) === false,
    views && /cp-tab is-on[^>]*>/.test(views.html) ? 'grade tab active' : 'view markup unclear');

  /* Clicking through to history must fetch ONE beach's series and chart it. */
  const hist = await evalJs(`(async () => {
    const h = window.__hkEnvMap;
    /* drive the real handler through a synthetic click on the marker's popup */
    let marker = null;
    h.layers.beach.eachLayer((l) => { if (!marker && l.feature) marker = l; });
    h.map.setView(marker.getLatLng(), 14, { animate: false });
    marker.openPopup();
    await new Promise((r) => setTimeout(r, 400));
    const btn = document.querySelector('.leaflet-popup [data-bh-view="history"]');
    if (!btn) return { err: 'no history button in rendered popup' };
    /* dispatch a REAL bubbling click so the delegated listener on #map runs */
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 200));
    const midText = (document.querySelector('.leaflet-popup .custom-popup') || {}).textContent || '';
    await new Promise((r) => setTimeout(r, 9000));
    const node = document.querySelector('.leaflet-popup .custom-popup');
    return {
      clicked: true,
      beach: marker.feature.properties.Beach,
      midText: midText.replace(/\s+/g, ' ').slice(0, 60),
      bars: node ? node.querySelectorAll('svg rect').length : 0,
      hasLatest: node ? /大腸桿菌|E\. coli/.test(node.textContent || '') : false,
      text: node ? (node.textContent || '').replace(/\s+/g, ' ').slice(0, 130) : null
    };
  })()`, true);
  check('clicking History in the beach card renders the E. coli chart',
    hist && hist.bars >= 60,
    `beach=${hist && hist.beach} bars=${hist && hist.bars} afterClick="${hist && hist.midText}"`);
  check('history chart covers well over a year, not just months',
    hist && hist.bars >= 60, `bars=${hist && hist.bars} (must be > 60)`);
  check('history view shows the latest reading and explanatory note',
    hist && hist.hasLatest, hist && hist.text ? hist.text.replace(/\s+/g, ' ').slice(0, 90) : 'n/a');
  }

  /* ---------- EV popup content sanity ---------- */
  if (wants('ev')) {
  const popup = await evalJs(`(() => {
    const h = window.__hkEnvMap;
    const lyr = h.layers.ev;
    if (!lyr) return null;
    const feats = [];
    lyr.eachLayer((l) => { if (l.feature) feats.push(l.feature); });
    const withConn = feats.filter((f) => {
      const p = f.properties || {};
      return Object.keys(p).some((k) => /_no$/.test(k) && Number(p[k]) > 0);
    });
    return {
      total: feats.length,
      withConnectors: withConn.length,
      sample: withConn[0] ? {
        props: Object.keys(withConn[0].properties),
        loc: withConn[0].properties.LOCATION_EN,
        mediumIec: withConn[0].properties.MEDIUM_IEC62196_no,
        geom: withConn[0].geometry && withConn[0].geometry.type
      } : null
    };
  })()`);
  check('EV features present', popup && popup.total > 0, 'total=' + (popup && popup.total));
  check('EV features carry connector counts', popup && popup.withConnectors > 0,
    `withConnectors=${popup && popup.withConnectors}`);
  check('EV geometry is Point', popup && popup.sample && popup.sample.geom === 'Point',
    'geom=' + (popup && popup.sample && popup.sample.geom));

  /* ---------- EV popup HTML renders ----------
     bindPopup(fn) stores a lazy content *function*, so getContent() returns the
     function rather than markup. Render that function into a detached node and
     inspect the result — same code path Leaflet uses when the popup opens. */
  const popupHtml = await evalJs(`(() => {
    const h = window.__hkEnvMap;
    const lyr = h.layers.ev;
    let target = null;
    lyr.eachLayer((l) => {
      if (target) return;
      const p = l.feature && l.feature.properties;
      if (!p) return;
      if (!Object.keys(p).some((k) => /_no$/.test(k) && Number(p[k]) > 0)) return;
      target = l;
    });
    if (!target) return { err: 'no EV feature with connectors' };
    const pop = target.getPopup();
    if (!pop) return { err: 'no popup bound' };
    const c = pop.getContent();
    let node;
    if (typeof c === 'function') { node = L.DomUtil.create('div'); node.innerHTML = c(target); }
    else { node = L.DomUtil.create('div'); node.innerHTML = String(c); }
    return { html: node.innerHTML, title: (node.querySelector('.cp-title') || {}).textContent || null };
  })()`);
  const hasBadge = popupHtml && typeof popupHtml.html === 'string' && /class="badge"/.test(popupHtml.html);
  const hasRows = popupHtml && typeof popupHtml.html === 'string' && /cp-row/.test(popupHtml.html);
  check('EV popup renders connector badges', hasBadge && hasRows,
    `title=${popupHtml && popupHtml.title} len=${popupHtml && popupHtml.html ? popupHtml.html.length : 0} ${popupHtml && popupHtml.err ? popupHtml.err : ''}`);
  if (popupHtml && popupHtml.html) fs.writeFileSync(path.join(ART, 'ev-popup.html'), popupHtml.html);

  /* ---------- EV real-time availability, from the same-origin snapshot ----------
     The official host sends no CORS header and answers preflight with 405, so the
     page CANNOT fetch it. A build script snapshots it to data/ev-availability.json;
     the page reads that local file lazily (NOT during layer load) and shows live
     numbers inline. */
  const snapBeforePopup = net.filter((n) => /ev-availability/.test(n.url)).length;
  const avail = await evalJs(`(async () => {
    const h = window.__hkEnvMap;
    await h.activate('ev');
    await new Promise((r) => setTimeout(r, 2500));
    /* open one popup to trigger the lazy snapshot fetch */
    let marker = null;
    h.layers.ev.eachLayer((l) => { if (!marker && l.feature && l.getLatLng) marker = l; });
    h.map.setView(marker.getLatLng(), 15, { animate: false });
    marker.openPopup();
    await new Promise((r) => setTimeout(r, 6000));
    let withNumber = 0, notProvided = 0, total = 0, sample = null;
    h.layers.ev.eachLayer((l) => {
      if (!l.feature || !l.getLatLng) return;
      total++;
      const c = l.getPopup().getContent();
      const node = L.DomUtil.create('div');
      node.innerHTML = (typeof c === 'function') ? c(l) : String(c);
      const txt = node.textContent || '';
      const m = /(\\d+)\\s*\\/\\s*(\\d+)/.exec(txt);
      if (m) { withNumber++; if (!sample) sample = { loc: l.feature.properties.LOCATION_EN, shown: m[0] }; }
      else if (/未為此位置提供|no live figure/.test(txt)) notProvided++;
    });
    return { total, withNumber, notProvided, sample };
  })()`, true);
  check('EV popup shows live availability inline (no redirect needed)',
    avail && avail.withNumber > 0,
    `sites=${avail && avail.total} withNumber=${avail && avail.withNumber} ` +
    `notProvided=${avail && avail.notProvided}` +
    (avail && avail.sample ? ` e.g. ${avail.sample.loc} -> ${avail.sample.shown}` : ''));
  check('sites without a published live figure say so instead of showing 0',
    avail && avail.notProvided > 0,
    `notProvided=${avail && avail.notProvided}`);
  check('availability snapshot is NOT fetched during layer load (lazy)',
    snapBeforePopup === 0,
    snapBeforePopup === 0 ? 'deferred until popup open'
      : `already fetched ${snapBeforePopup}x before any popup`);

  /* the snapshot must be same-origin, and no ev-charger.epd.gov.hk fetch may happen */
  const evHost = net.filter((n) => /ev-charger\\.epd\\.gov\\.hk/.test(n.url));
  check('page never fetches the CORS-blocked EPD host directly',
    evHost.length === 0,
    evHost.length ? 'attempted: ' + evHost.map((n) => n.status + ' ' + n.url.slice(0, 60)).join(', ')
                  : 'no direct requests');
  const localSnap = net.filter((n) => /ev-availability/.test(n.url));
  check('page loads the same-origin snapshot',
    localSnap.length > 0 && localSnap.every((n) => n.status === 200),
    localSnap.map((n) => n.status + ' ' + n.url.slice(-40)).join(', ') || 'not requested');

  /* ---------- EV charger badges must be inside a stacked row ---------- */
  const stacked = await evalJs(`(() => {
    const h = window.__hkEnvMap;
    const lyr = h.layers.ev;
    let html = null;
    lyr.eachLayer((l) => {
      if (html) return;
      const p = l.feature && l.feature.properties;
      if (!p) return;
      if (!Object.keys(p).some((k) => /_no$/.test(k) && Number(p[k]) > 0)) return;
      const c = l.getPopup().getContent();
      const node = L.DomUtil.create('div');
      node.innerHTML = (typeof c === 'function') ? c(l) : String(c);
      html = node.innerHTML;
    });
    return html;
  })()`);
  check('charger badges use a stacked full-width row',
    !!stacked && /cp-row--stack/.test(stacked) && /cp-chargers/.test(stacked),
    'len=' + (stacked ? stacked.length : 0));
  }   /* end wants('ev') */

  /* ---------- REGRESSION: language switch on the noise tab ----------
     Pre-existing bug found by this harness: DATA has no 'noise' entry (the tab
     maps to DATA.lnrs), so activate() threw on the noise tab whenever the layer
     needed loading, aborting applyLang(). Verified reproducible on the pristine
     upstream file at activate:2107. */
  const noiseLang = await evalJs(`(async () => {
    const h = window.__hkEnvMap;
    await h.activate('noise');
    await new Promise((r) => setTimeout(r, 600));
    const before = h.state.lang;
    document.getElementById('lang-btn').click();
    await new Promise((r) => setTimeout(r, 2500));
    return { before, after: h.state.lang, active: h.state.active, lid: h.activeLayerId() };
  })()`, true);
  check('language switch on noise tab does not crash', noiseLang && noiseLang.after !== noiseLang.before,
    `lang ${noiseLang && noiseLang.before} -> ${noiseLang && noiseLang.after}, active=${noiseLang && noiseLang.active}`);

  /* ---------- legend ---------- */
  const legendRows = await evalJs(`document.querySelectorAll('#legend-body .legend-row').length`);
  check('legend rendered after activate', legendRows > 0, 'rows=' + legendRows);

  /* ---------- language switch about tab labels ----------
     Abbreviated labels (EV, WQ, CNP…) are intentionally language-neutral, so the
     label itself does NOT change. The full name in title/aria-label must. */
  const langOk = await evalJs(`(async () => {
    const h = window.__hkEnvMap;
    await h.activate('ev');
    await new Promise((r) => setTimeout(r, 800));
    const sel = '.tab[data-tab="ev"]';
    const before = {
      lang: h.state.lang,
      label: (document.querySelector(sel + ' .tab-label')||{}).textContent || '',
      title: (document.querySelector(sel)||{}).getAttribute('title') || ''
    };
    document.getElementById('lang-btn').click();
    await new Promise((r) => setTimeout(r, 2500));
    const after = {
      lang: h.state.lang,
      label: (document.querySelector(sel + ' .tab-label')||{}).textContent || '',
      title: (document.querySelector(sel)||{}).getAttribute('title') || ''
    };
    return { before, after };
  })()`, true);
  const switched = langOk && langOk.after.lang !== langOk.before.lang &&
    langOk.after.title !== langOk.before.title && langOk.after.title !== '';
  check('tab full name (hover title) follows the language switch', switched,
    `${langOk && langOk.before.lang}:"${langOk && langOk.before.title}" -> ${langOk && langOk.after.lang}:"${langOk && langOk.after.title}"`);
  check('abbreviated label follows the language (Chinese names in Chinese mode)',
    !!langOk && langOk.after.label !== langOk.before.label && langOk.after.label.length <= 8,
    `${langOk && langOk.before.lang}:"${langOk && langOk.before.label}" -> ${langOk && langOk.after.lang}:"${langOk && langOk.after.label}"`);

  /* ---------- tab labels are short, full names on hover ---------- */
  const tabLabels = await evalJs(`(() => {
    const out = [];
    document.querySelectorAll('#tabs .tab').forEach((b) => {
      out.push({
        id: b.dataset.tab,
        label: (b.querySelector('.tab-label') || {}).textContent || '',
        title: b.getAttribute('title') || '',
        aria: b.getAttribute('aria-label') || ''
      });
    });
    return out;
  })()`);
  const tooLong = (tabLabels || []).filter((t) => t.label.length > 8);
  check('tab labels are abbreviated (<= 8 chars)',
    Array.isArray(tabLabels) && tabLabels.length === 7 && tooLong.length === 0,
    tooLong.length ? 'too long: ' + tooLong.map((t) => `${t.id}="${t.label}"`).join(', ')
                   : (tabLabels || []).map((t) => `${t.id}:${t.label}`).join(' '));
  const noTitle = (tabLabels || []).filter((t) => !t.title || t.title.length <= t.label.length);
  check('every abbreviated tab keeps the full name in title + aria-label',
    noTitle.length === 0,
    noTitle.length ? 'missing full name: ' + noTitle.map((t) => t.id).join(', ')
                   : 'all tabs carry full names');
  /* Chinese mode must use Chinese short names, not the English abbreviations. */
  const cnTabs = (tabLabels || []).filter((t) => /[\u4e00-\u9fff]/.test(t.label));
  check('Chinese mode uses Chinese tab names',
    cnTabs.length === 7,
    `chinese=${cnTabs.length}/7 -> ` + (tabLabels || []).map((t) => t.label).join(' '));

  /* ---------- habitat must not block: layer returns before data arrives ---------- */
  const habLatency = await evalJs(`(async () => {
    const h = window.__hkEnvMap;
    h.state.loaded.habitat = false; h.layers.habitat = null;
    const t0 = performance.now();
    await h.activate('habitat');
    const blocked = performance.now() - t0;          /* includes the loader's await */
    const first = h.layers.habitat;
    const immediate = first && first.getLayers ? first.getLayers().length : 0;
    /* wait for the progressive load to finish */
    let layers = 0, features = 0;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const g = h.layers.habitat;
      layers = g && g.getLayers ? g.getLayers().length : 0;
      features = (g && g._habitatCount) || 0;
      if (g && g._habitatDone >= g._habitatTotal) break;
    }
    return { blockedMs: Math.round(blocked), immediate, layers, features };
  })()`, true);
  check('habitat tab returns quickly instead of hanging on 16 layers',
    habLatency && habLatency.blockedMs < 1500,
    `activate() blocked ${habLatency && habLatency.blockedMs}ms (was ~10s+)`);
  check('habitat loads progressively and ends up complete',
    habLatency && habLatency.features > 14000,
    `layers=${habLatency && habLatency.layers} features=${habLatency && habLatency.features}`);

  /* ---------- CNP popup: one official link (EPIC permit search) ----------
     Re-verified — there is NO deep-linkable per-permit target:
       - all 1,962 permits share ONE dataset URL: the EPIC search-page entry
         (...apps-construct?execution=e8s1). It is not a per-permit link; it only
         resolves to the generic search form (and 302-loops without a cookie jar).
       - the EPIC "Construction Noise Permit" search page IS public and real, but it
         is captcha-protected (BotDetect) and has NO permit-number field — search is
         by permit type / district / dates / site address / permittee — so it cannot
         be deep-linked or pre-filled to a specific permit.
       - the data.gov.hk "API" is only the CSDI WFS/WMS/ArcGIS REST service (already
         used to fetch this layer); that layer has hasAttachments=false, so there is
         no permit document to open.
     So the popup offers the single official page that actually helps: the EPIC permit
     search (to look up / download permits). The permit number is plain text. */
  const cnp = await evalJs(`(async () => {
    const h = window.__hkEnvMap;
    await h.activate('cnp');
    await new Promise((r) => setTimeout(r, 1500));
    let html = null, permitNo = null;
    h.layers.cnp.eachLayer((l) => {
      if (html || !l.feature) return;
      const p = l.feature.properties || {};
      permitNo = String(p.PERMIT_NO || '').trim();
      const c = l.getPopup().getContent();
      const node = L.DomUtil.create('div');
      node.innerHTML = (typeof c === 'function') ? c(l) : String(c);
      html = node.innerHTML;
    });
    return { html, permitNo, lang: h.state.lang };
  })()`, true);
  check('CNP popup links to the official EPD permit search page',
    !!cnp && /href="https:\/\/epic\.epd\.gov\.hk\/EFORMUPD\/main\/epic\/apps-construct\?lang=en"/.test(cnp.html || ''),
    cnp ? ((cnp.html || '').match(/https:\/\/epic\.epd\.gov\.hk\/[^"]*/) || ['none'])[0] : 'no popup');
  check('CNP popup offers exactly one link (the EPD search)',
    !!cnp && ((cnp.html || '').match(/<a\s/gi) || []).length === 1,
    `anchors=${cnp ? ((cnp.html || '').match(/<a\s/gi) || []).length : '?'}`);
  check('CNP popup no longer links to the DATA.GOV.HK dataset page',
    !!cnp && !/data\.gov\.hk/.test(cnp.html || ''),
    'dataset link removed');
  check('CNP popup never references the broken per-permit URL or the EPICDI page',
    !!cnp && !/execution=/.test(cnp.html || '') && !/EPICDI/.test(cnp.html || ''),
    'clean');
  check('CNP popup shows the permit number as the title',
    !!cnp && !!cnp.permitNo && (cnp.html || '').includes(cnp.permitNo),
    `PERMIT_NO=${cnp && cnp.permitNo}`);
  check('CNP permit number is plain text, not a copy control',
    !!cnp && /<span class="cp-permit-no">[^<]+<\/span>/.test(cnp.html || '') &&
      !/data-cnp-copy/.test(cnp.html || '') && !/cnp-copy-hint/.test(cnp.html || '') &&
      !/role="button"/.test(cnp.html || ''),
    'plain span, no copy chip');
  /* the dataset's own URL is worthless — assert we are not silently using it */
  const cnpRaw = await evalJs(`(() => {
    let u = null;
    window.__hkEnvMap.layers.cnp.eachLayer((l) => { if (!u && l.feature) u = l.feature.properties.URL; });
    return u;
  })()`);
  check('dataset CNP URL is indeed a single shared (broken) value',
    !!cnpRaw && /apps-construct/.test(cnpRaw),
    'raw URL = ' + cnpRaw);

  /* ---------- popup must never overflow its own card (mobile regression) ----------
     The mobile CSS used to force `.custom-popup` to `width: 90vw`, but Leaflet
     caps the popup card at the bindPopup `maxWidth` (300 or 320). On any viewport
     wider than ~333px the content was therefore WIDER than the white card and the
     description/footer text spilled outside it (at 600px: 540px content in a
     301px card). Assert the invariant at a narrow viewport: the content's right
     edge must not pass the card's right edge. */
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 600, height: 900, deviceScaleFactor: 1, mobile: true }, sessionId);
  await sleep(400);
  const popFit = await evalJs(`(async () => {
    const h = window.__hkEnvMap;
    await h.activate('beach');
    await new Promise((r) => setTimeout(r, 2500));
    let marker = null;
    h.layers.beach.eachLayer((l) => { if (!marker && l.feature && l.getLatLng) marker = l; });
    if (!marker) return { err: 'no beach marker' };
    h.map.setView(marker.getLatLng(), 14, { animate: false });
    marker.openPopup();
    await new Promise((r) => setTimeout(r, 900));
    const card = document.querySelector('.leaflet-popup-content-wrapper');
    const inner = document.querySelector('.leaflet-popup-content .custom-popup');
    if (!card || !inner) return { err: 'no popup' };
    const c = card.getBoundingClientRect(), i = inner.getBoundingClientRect();
    const spill = [...document.querySelectorAll('.leaflet-popup-content .cp-desc, .leaflet-popup-content .cp-foot')]
      .map((el) => Math.round(el.scrollWidth - el.clientWidth));
    return {
      viewport: window.innerWidth,
      cardW: Math.round(c.width), cardR: Math.round(c.right),
      innerW: Math.round(i.width), innerR: Math.round(i.right),
      maxSpill: spill.length ? Math.max(...spill) : 0
    };
  })()`, true);
  check('popup content stays inside its card at a narrow viewport',
    !!popFit && !popFit.err && popFit.innerR <= popFit.cardR + 1 && popFit.maxSpill === 0,
    popFit ? `viewport=${popFit.viewport} card=${popFit.cardW}px(r=${popFit.cardR}) content=${popFit.innerW}px(r=${popFit.innerR}) spill=${popFit.maxSpill}px` : 'no popup');

  /* ---------- font-size control (A− / A+), elderly friendly ----------
     The topbar buttons scale every text size through the `--fs` custom property.
     Step 0 IS the original size, so A− must be disabled there and A+ must clamp
     at the top. The choice persists in localStorage. */
  const fsCtl = await evalJs(`(() => {
    const up = document.getElementById('fs-up'), down = document.getElementById('fs-down');
    if (!up || !down) return { present: false };
    const fsVar = () => getComputedStyle(document.documentElement).getPropertyValue('--fs').trim();
    const titlePx = () => parseFloat(getComputedStyle(document.getElementById('app-title')).fontSize);
    const out = {
      present: true,
      initialFs: fsVar(),
      initialDownDisabled: down.disabled,
      initialUpDisabled: up.disabled
    };
    const t0 = titlePx();
    up.click(); up.click();
    out.afterTwoFs = fsVar();
    out.titleGrew = titlePx() > t0;
    out.stored = localStorage.getItem('hk-env-map-fs');
    for (let i = 0; i < 10; i++) up.click();
    out.maxFs = fsVar();
    out.upDisabledAtMax = up.disabled;
    for (let i = 0; i < 10; i++) down.click();
    out.minFs = fsVar();
    out.downDisabledAtMin = down.disabled;
    return out;
  })()`);
  check('font-size A− / A+ control present in the topbar',
    !!fsCtl && fsCtl.present === true, fsCtl && fsCtl.present ? 'both buttons' : 'missing');
  check('font size starts at the smallest step (A− disabled, A+ enabled)',
    !!fsCtl && fsCtl.initialFs === '1' && fsCtl.initialDownDisabled === true && fsCtl.initialUpDisabled === false,
    fsCtl ? `--fs=${fsCtl.initialFs} down=${fsCtl.initialDownDisabled} up=${fsCtl.initialUpDisabled}` : '?');
  check('A+ raises the scale and the rendered text grows',
    !!fsCtl && parseFloat(fsCtl.afterTwoFs) > 1 && fsCtl.titleGrew === true,
    fsCtl ? `--fs=${fsCtl.afterTwoFs} titleGrew=${fsCtl.titleGrew}` : '?');
  check('font scale clamps at the top and disables A+',
    !!fsCtl && fsCtl.maxFs === '1.6' && fsCtl.upDisabledAtMax === true,
    fsCtl ? `--fs=${fsCtl.maxFs} upDisabled=${fsCtl.upDisabledAtMax}` : '?');
  check('A− cannot go below the original size',
    !!fsCtl && fsCtl.minFs === '1' && fsCtl.downDisabledAtMin === true,
    fsCtl ? `--fs=${fsCtl.minFs} downDisabled=${fsCtl.downDisabledAtMin}` : '?');
  check('font size choice is persisted',
    !!fsCtl && fsCtl.stored !== null, fsCtl ? `stored=${fsCtl.stored}` : '?');

  /* At the largest step the topbar must still fit and popups must still stay inside. */
  const fsBig = await evalJs(`(async () => {
    const up = document.getElementById('fs-up');
    for (let i = 0; i < 10; i++) up.click();
    await new Promise((r) => setTimeout(r, 400));
    const tb = document.querySelector('.topbar');
    const act = document.querySelector('.actions');
    let popup = null;
    const h = window.__hkEnvMap;
    let marker = null;
    h.layers.beach.eachLayer((l) => { if (!marker && l.feature && l.getLatLng) marker = l; });
    if (marker) {
      h.map.setView(marker.getLatLng(), 14, { animate: false });
      marker.openPopup();
      await new Promise((r) => setTimeout(r, 900));
      const card = document.querySelector('.leaflet-popup-content-wrapper');
      const inner = document.querySelector('.leaflet-popup-content .custom-popup');
      if (card && inner) {
        const c = card.getBoundingClientRect(), i = inner.getBoundingClientRect();
        popup = { cardR: Math.round(c.right), innerR: Math.round(i.right), fits: i.right <= c.right + 1 };
      }
    }
    return {
      fs: getComputedStyle(document.documentElement).getPropertyValue('--fs').trim(),
      headerScrollW: tb.scrollWidth, headerClientW: tb.clientWidth,
      actionsRight: Math.round(act.getBoundingClientRect().right), viewport: window.innerWidth,
      popup
    };
  })()`, true);
  check('topbar still fits at the largest font step (narrow viewport)',
    !!fsBig && fsBig.headerScrollW <= fsBig.headerClientW + 1 && fsBig.actionsRight <= fsBig.viewport + 1,
    fsBig ? `--fs=${fsBig.fs} scrollW=${fsBig.headerScrollW} clientW=${fsBig.headerClientW} actionsRight=${fsBig.actionsRight} vw=${fsBig.viewport}` : '?');
  check('popup still fits its card at the largest font step',
    !!fsBig && !!fsBig.popup && fsBig.popup.fits === true,
    fsBig && fsBig.popup ? `cardR=${fsBig.popup.cardR} innerR=${fsBig.popup.innerR}` : 'no popup');
  /* restore the smallest step so later checks see the default UI */
  await evalJs(`(() => { const d = document.getElementById('fs-down'); for (let i = 0; i < 10; i++) d.click(); })()`);
  await sleep(300);

  await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
  await sleep(400);

  /* ---------- no uncaught page exceptions ---------- */
  check('no uncaught page exceptions', pageErrors.length === 0,
    pageErrors.slice(0, 3).join(' ;; ') || 'none');
  const realConsoleErrs = consoleErrs.filter((e) => !/favicon|manifest|sw\.js|service worker/i.test(e));
  check('no console errors', realConsoleErrs.length === 0,
    realConsoleErrs.slice(0, 3).join(' ;; ') || 'none');

  /* ---------- upstream network report ---------- */
  const bad = net.filter((n) => n.status >= 400);
  check('no failing upstream requests', bad.length === 0,
    bad.slice(0, 4).map((b) => `${b.status} ${b.url.slice(0, 90)}`).join(' | ') || 'none');

  const epdNet = net.filter((n) => /csdi|data\.gov\.hk/.test(n.url));
  const noCors = epdNet.filter((n) => !n.acao);
  check('all EPD/CSDI responses carry CORS', noCors.length === 0,
    noCors.slice(0, 3).map((b) => `${b.status} no-ACAO ${b.url.slice(0, 80)}`).join(' | ') || 'all have ACAO');

  fs.writeFileSync(path.join(ART, 'network.json'), JSON.stringify(net, null, 2));
  fs.writeFileSync(path.join(ART, 'results.json'), JSON.stringify({
    results, consoleErrs, pageErrors, when: new Date().toISOString()
  }, null, 2));
  console.log(`\nnetwork log: tools/artifacts/network.json (${net.length} gov requests)`);
} catch (err) {
  console.error('\nHARNESS ERROR:', (err && err.message) || err);
  check('harness completed', false, (err && err.message) || String(err));
} finally {
  try { cdp && cdp.close(); } catch {}
  try { chrome && chrome.kill(); } catch {}
  try { server && server.close(); } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
