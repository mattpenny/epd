/**
 * Build data/wq-history.json — historical DO + BOD5 series for the marine and
 * river monitoring stations shown in the map.
 *
 * WHY THIS EXISTS: the CSDI "Historical Marine/River Water Quality Data" datasets
 * are only station indexes (no dates, no measurements) — unlike the beach one,
 * which ships 63k dated E. coli readings. EPD publishes the actual measurements
 * only through an interactive form on cd.epic.epd.gov.hk, so this script drives a
 * headless Chrome through that form, downloads the per-zone CSV, and keeps just
 * the two parameters and the station codes the app displays.
 *
 * Usage: node tools/build-wq-history.mjs [--years=10] [--headed]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'wq-history.json');
/* 下載暫存區必須放在 os.tmpdir() 之下：node 的 safe-delete shim 會攔截「非暫存區」
   路徑的 fs.rmSync，把它導向資源回收筒，而 Chrome 的 .crdownload 殘檔會在 lstat
   與送資源回收筒之間消失，導致 rmSync 拋錯、整個單位失敗。放在暫存區下則 shim 直接
   放行（呼叫原始 rmSync 真正刪除），不再有競爭。 */
const TMP = path.join(os.tmpdir(), 'epd-wq-history-tmp');
/* 進度檔：網站很不穩，跑不完是常態。記錄「哪個單位已經抓到」以及「每個管制區
   有哪些河溪」，重跑時直接跳過，不必從頭再試一次。--reset 可強制重來。 */
const PROGRESS = path.join(ROOT, 'tools', 'artifacts', 'wq-progress.json');
/* Chrome 路徑跨平台解析：優先 CHROME_PATH，否則依作業系統回退到常見安裝位置
   （CI 跑在 ubuntu-latest，Chrome 通常在 /usr/bin/google-chrome）。 */
function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('No Chrome/Edge binary found; set CHROME_PATH');
}
let CHROME = null;

const argv = process.argv.slice(2);
const HEADED = argv.includes('--headed');
const RESET = argv.includes('--reset');
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) || dflt; } catch (e) { return dflt; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1)); };
const YEARS = Number((argv.find((a) => a.startsWith('--years=')) || '--years=10').slice(8)) || 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/* 官方表格只提供這兩個參數給本應用程式（彈窗顯示的正是這兩個） */
const WANT_PARAMS = [/^Dissolved Oxygen \(mg\/L\)$/, /^5-day Biochemical Oxygen Demand \(mg\/L\)$/];

/* ---------------------------------------------------------------- CSV parse */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* ------------------------------------------------------------- browser glue */
let ws, sessionId, chrome, msgId = 0;
/* Chrome 設定檔：只建立一次，之後 resetSession() 重用同一個（已暖機的）。
   以前這裡用的是函式內的局部變數 profile，而 resetSession() 參考的是未定義的
   PROFILE —— 結果每次都開全新設定檔（冷啟動易逾時），而且 cookie 清除那段
   因 path.join(undefined, …) 擲錯被 catch 靜默吞掉，從來沒生效過。 */
let PROFILE = null;
const pending = new Map();

const send = (method, params = {}, sid) => new Promise((resolve, reject) => {
  const i = ++msgId; pending.set(i, { resolve, reject });
  ws.send(JSON.stringify(sid ? { id: i, method, params, sessionId: sid } : { id: i, method, params }));
});
const evOnce = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise }, sessionId);
  if (r.exceptionDetails) {
    const msg = (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text;
    if (/regular expression|SyntaxError|Unexpected/i.test(msg)) console.error('[EV DEBUG]\n' + expr + '\n-> ' + msg + '\n');
    if (/regular expression|SyntaxError|Unexpected|ReferenceError|TypeError/i.test(msg)) {
      console.error('[EV DUMP] ' + msg + '\n' + expr + '\n');
    }
    throw new Error(msg);
  }
  return r.result.value;
};
/* 表單提交會令頁面導航，導航期間的 evaluate 會擲 "Inspected target navigated
   or closed" —— 那是暫時性的，重試即可。 */
const ev = async (expr, awaitPromise = false) => {
  let last;
  for (let i = 0; i < 8; i++) {
    try { return await evOnce(expr, awaitPromise); }
    catch (e) {
      last = e;
      if (/navigated or closed|Cannot find context|Execution context/i.test(e.message)) { await sleep(600); continue; }
      throw e;
    }
  }
  throw last;
};
const waitForAny = (ids, ms = 45000) => ev(
  `(async () => {
     const ids = ${JSON.stringify(ids)};
     const t0 = Date.now();
     while (Date.now() - t0 < ${ms}) {
       if (ids.some((i) => document.getElementById(i))) return true;
       await new Promise((r) => setTimeout(r, 250));
     }
     return false;
   })()`, true);
const waitFor = (ids, ms = 45000) => ev(
  `(async () => {
     const ids = ${JSON.stringify(ids)};
     const t0 = Date.now();
     while (Date.now() - t0 < ${ms}) {
       if (ids.every((i) => document.getElementById(i))) return true;
       await new Promise((r) => setTimeout(r, 250));
     }
     return false;
   })()`, true);

async function startBrowser(downloadDir) {
  /* 設定檔放在系統暫存區，只建立一次並重用（不刪除任何東西 —— 大量刪除會
     觸發沙箱的保護機制）。舊的 JSF session 會令「可選清單」變空。 */
  if (!PROFILE) PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'epd-wq-'));
  if (!CHROME) CHROME = findChrome();
  /* CI 容器多以 root 執行，headless Chrome 需要 --no-sandbox，否則啟動即崩。 */
  const root = (typeof process.getuid === 'function') ? process.getuid() === 0 : false;
  chrome = spawn(CHROME, [
    HEADED ? '--new-window' : '--headless=new',
    '--disable-gpu', '--no-first-run', '--disable-extensions',
    ...(root ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
    '--remote-debugging-port=0', `--user-data-dir=${PROFILE}`,
    '--window-size=1280,900', '--hide-scrollbars', 'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('timeout waiting for DevTools')), 30000);
    chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(t); resolve(m[0]); } });
  });
  ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id != null && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  });
  const { targetInfos } = await send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page');
  sessionId = (await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true }, sessionId);
}

function stopBrowser() {
  try { ws && ws.close(); } catch (e) {}
  try { chrome && chrome.kill(); } catch (e) {}
  ws = null; chrome = null; sessionId = null;
}

/* 每個管制區都需要全新的 JSF session。做法是「暖機重啟」：關掉 Chrome、只刪
   Cookies 這個檔案（不是整個設定檔 —— 整個設定檔有數百個檔案，刪除會觸發
   沙箱的大量刪除保護）、再開同一個（已暖機的）設定檔。暖機啟動很快，不會像
   全新設定檔那樣冷啟動而逾時。
   （單純在同一個 session 內連續下載第二區會失敗：JSF 記住上一區已選的項目，
   令「可選清單」變空。） */
async function resetSession(downloadDir) {
  stopBrowser();
  await sleep(1200);   // 等 Chrome 子行程真正結束，否則它會把 cookie 寫回磁碟
  for (const rel of [['Default', 'Cookies'], ['Default', 'Network', 'Cookies'],
                     ['Default', 'Local Storage'], ['Default', 'Session Storage'],
                     ['Default', 'Sessions'], ['Default', 'Current Tabs'], ['Default', 'Current Session']]) {
    for (let i = 0; i < 3; i++) {
      try { fs.rmSync(path.join(PROFILE, ...rel), { recursive: true, force: true }); break; }
      catch (e) { await sleep(500); }
    }
  }
  await startBrowser(downloadDir);
}

/* ------------------------------------------------------- one zone → one CSV */
/* 參數頁 → 下載 CSV → 解析。海水與河溪在這一頁的結構相同。 */
async function parameterPageToCsv(downloadDir, fromYear) {
  /* 參數／測站清單是提交後才由 JSF 填好的，必須等到真的有選項才動手 */
  const ready = await ev(`(async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const st = document.getElementById('unselectStation');
      const pa = document.getElementById('unselectParameter');
      if (st && pa && st.options.length > 0 && pa.options.length > 0) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  })()`, true);
  if (!ready) return { error: 'station/parameter lists never populated' };
  await sleep(400);

  const prep = await ev(`(async () => {
    const yFrom = document.getElementById('form:FromYear');
    if (yFrom) { yFrom.value = String(${fromYear}); yFrom.dispatchEvent(new Event('change', { bubbles: true })); }
    const stations = document.getElementById('unselectStation');
    [...stations.options].forEach((o) => { o.selected = true; });
    const params = document.getElementById('unselectParameter');
    const available = [...params.options].map((o) => o.text.trim());
    let picked = [];
    [...params.options].forEach((o) => {
      if (${JSON.stringify(WANT_PARAMS.map((r) => r.source))}.some((src) => new RegExp(src).test(o.text.trim()))) {
        o.selected = true; picked.push(o.text.trim());
      }
    });
    return { picked, available };
  })()`, true);
  /* 部分河溪測站只公佈溶解氧，沒有五天生化需氧量 —— 只要有 DO 就該放行，
     BOD5 缺了就記為 null，不要因此整條河溪失敗。 */
  if (!prep.picked || !prep.picked.length) {
    return { error: 'no wanted parameters; available: ' + JSON.stringify(prep.available).slice(0, 300) };
  }
  if (!prep.picked.some((p) => /^Dissolved Oxygen \(mg\/L\)$/.test(p))) {
    return { error: 'Dissolved Oxygen missing; available: ' + JSON.stringify(prep.available).slice(0, 300) };
  }

  await ev(`(async () => {
    const btns = [...document.querySelectorAll('input[type=button]')].filter((b) => /^>/.test((b.value || '').trim()));
    for (const b of btns) { b.click(); await new Promise((r) => setTimeout(r, 1800)); }
    return true;
  })()`, true);
  await sleep(400);

  /* 移動若沒生效就不必等 75 秒才失敗 */
  const movedOk = await ev(`(() => {
    const st = document.getElementById('station');
    const pa = document.getElementById('parameter');
    return { st: st ? st.options.length : 0, pa: pa ? pa.options.length : 0 };
  })()`);
  if (!movedOk.st || !movedOk.pa) {
    return { error: `move to Selected failed (station=${movedOk.st}, parameter=${movedOk.pa})` };
  }

  fs.readdirSync(downloadDir).forEach((f) => fs.rmSync(path.join(downloadDir, f), { force: true }));
  await ev(`(() => { document.getElementById('form:display').click(); return true; })()`);
  let file = null;
  const deadline = Date.now() + 75000;
  while (Date.now() < deadline) {
    await sleep(1000);
    const files = fs.readdirSync(downloadDir);
    const csv = files.find((f) => /\.csv$/i.test(f));
    if (csv && !files.some((f) => f.endsWith('.crdownload'))) { file = path.join(downloadDir, csv); break; }
  }
  if (!file) return { error: 'no csv downloaded' };

  const rows = parseCsv(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!rows.length) return { error: 'empty csv' };
  const head = rows[0].map((h) => h.trim());
  const iZone = head.indexOf('Water Control Zone');
  const iStation = head.indexOf('Station');
  const iDate = head.indexOf('Dates');
  const iDo = head.indexOf('Dissolved Oxygen (mg/L)');
  const iBod = head.indexOf('5-day Biochemical Oxygen Demand (mg/L)');
  if (iStation < 0 || iDate < 0 || iDo < 0) {
    return { error: 'unexpected columns: ' + head.slice(0, 8).join('|') };
  }
  const byStation = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length < head.length) continue;
    const st = (row[iStation] || '').trim();
    const d = (row[iDate] || '').trim();
    if (!st || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (Number(d.slice(0, 4)) < fromYear) continue;
    const doV = (row[iDo] || '').trim();
    const bodV = (row[iBod] || '').trim();
    /* 缺測與空欄都記成 null（不要留空字串），與 marine 序列一致，也避免 App 端
       parseFloat('') 得到 NaN 而被誤判成有值。 */
    const clean = (v) => (v === 'N/A' || v === '') ? null : v;
    if (!byStation[st]) byStation[st] = [];
    byStation[st].push([d, clean(doV), clean(bodV)]);
  }
  Object.keys(byStation).forEach((s2) => byStation[s2].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  return { zone: (rows[1] && rows[1][iZone]) ? rows[1][iZone].trim() : null, stations: byStation };
}

/* 一個「單位」＝一個管制區（海水），或一個管制區 × 一條河溪（河溪）。
   河溪多一步：選完管制區後要先到「Station Selection」頁挑一條河溪，
   按 Select 才會進入參數頁。river 為 null 時只回傳該區的河溪清單。 */
async function fetchZone(kind, zone, downloadDir, fromYear, river) {
  fs.readdirSync(downloadDir).forEach((f) => fs.rmSync(path.join(downloadDir, f), { force: true }));
  await send('Page.navigate', { url: `https://cd.epic.epd.gov.hk/EPICRIVER/${kind}/?lang=en` }, sessionId);
  if (!await waitFor(['form:select', 'form:wzterControlZone']) ||
      !await waitForAny(['Aselect-download', 'download'])) {
    return { zone, error: 'step 1 form not found' };
  }
  /* 元素出現 ≠ 已經可以送出：JSF 的腳本還在初始化，太早按下去整頁會噴
     500 / "Page Invalid"。先讓頁面靜一靜，再一步一步按，每步之間留時間
     給 AJAX 回來把下一個選單填好。 */
  await sleep(2500);
  const clicked = await ev(`(async () => {
    /* 海水頁的「下載」選項是 #Aselect-download（name=Aselect），
       河溪頁是 #download（name=displayg）—— 兩者不同。 */
    const rad = document.getElementById('Aselect-download') || document.getElementById('download');
    if (!rad) return false;
    rad.checked = true; rad.click();
    await new Promise((r) => setTimeout(r, 1200));
    const sel = document.getElementById('form:wzterControlZone');
    if (!sel) return false;
    sel.value = ${JSON.stringify(zone)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 2500));
    const go = document.getElementById('form:select');
    if (!go) return false;
    go.click();
    return true;
  })()`, true).catch(() => false);
  if (!clicked) return { zone, error: 'step 1 click failed' };

  /* 送出後不是固定等幾秒就好 —— 網站反應時間落差很大，有時十幾秒才換頁。
     改成輪詢直到「河溪選單」或「參數頁」出現，才知道真的到了第 2 步；
     同時偵測官方的錯誤頁，這種情況重試通常就好了。 */
  const landed = await ev(`(async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      if (location.href.indexOf('result/nodata') >= 0) return 'nodata';
      const r = document.getElementById('form:River_Name');
      if (r && [...r.options].filter((o) => o.value).length) return 'river';
      const st = document.getElementById('unselectStation');
      const pa = document.getElementById('unselectParameter');
      if (st && pa && st.options.length > 0 && pa.options.length > 0) return 'param';
      const body = (document.body && document.body.innerText) || '';
      if (/Page Invalid|Internal Server Error|Error 500|system error|No information is available/i.test(body)) return 'error';
      await new Promise((r2) => setTimeout(r2, 300));
    }
    return null;
  })()`, true);
  if (landed === 'nodata') return { zone, error: 'no data' };
  if (landed === 'error') return { zone, error: 'EPD error page' };
  if (!landed) return { zone, error: 'step 2 page never loaded' };

  if (landed === 'river') {
    const rivers = await ev(`(() => {
      const r = document.getElementById('form:River_Name');
      return [...r.options].map((o) => o.value).filter(Boolean);
    })()`);
    if (!river) return { zone, rivers };          // 只回報清單
    const ok = await ev(`(async () => {
      const r = document.getElementById('form:River_Name');
      if (!r) return false;
      r.value = ${JSON.stringify(river)};
      r.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r2) => setTimeout(r2, 2500));
      const go = document.getElementById('form:display');
      if (!go) return false;
      go.click();
      return true;
    })()`, true).catch(() => false);
    if (!ok) return { zone, error: 'river select failed' };
  } else if (river) {
    return { zone, error: 'river list missing on Station Selection page' };
  }

  const res = await parameterPageToCsv(downloadDir, fromYear);
  return { zone: res.zone || zone, stations: res.stations, error: res.error };
}

/* ------------------------------------------------------------------- driver */
async function main() {
  /* 刻意不清空整個 TMP：Chrome 設定檔有數百個檔案，刪除會觸發沙箱的
     大量刪除保護。改為只清 downloads，設定檔重用。 */
  fs.mkdirSync(TMP, { recursive: true });
  const downloadDir = path.join(TMP, 'downloads');
  fs.mkdirSync(downloadDir, { recursive: true });
  const fromYear = new Date().getFullYear() - YEARS;

  await startBrowser(downloadDir);

  const result = {
    source: 'EPD Environmental Protection Interactive Centre — historical water quality (CSV download)',
    sourceUrls: {
      marine: 'https://cd.epic.epd.gov.hk/EPICRIVER/marine/?lang=en',
      river: 'https://cd.epic.epd.gov.hk/EPICRIVER/river/?lang=en'
    },
    generatedAt: new Date().toISOString(),
    fromYear,
    parameters: ['Dissolved Oxygen (mg/L)', '5-day Biochemical Oxygen Demand (mg/L)'],
    note: 'Series are [date, dissolvedOxygen, BOD5]; null means the official CSV had N/A.',
    marine: {},
    river: {}
  };

  /* 沿用現有快照：重跑只覆蓋本次抓到的部分，不會把已抓好的資料洗掉 */
  try {
    if (fs.existsSync(OUT)) {
      const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      if (prev && prev.marine) result.marine = prev.marine;
      if (prev && prev.river) result.river = prev.river;
      log(`resuming: marine ${Object.keys(result.marine).length} stations, river ${Object.keys(result.river).length} stations`);
    }
  } catch (e) {}

  const progress = RESET ? { done: {}, riverLists: {} } : readJson(PROGRESS, { done: {}, riverLists: {} });
  progress.done = progress.done || {};
  progress.riverLists = progress.riverLists || {};
  if (RESET) log('--reset: progress cleared');
  const saveProgress = () => writeJson(PROGRESS, progress);
  const unitKey = (kind, zone, river) => `${kind}|${zone}|${river || ''}`;

  const KINDS = (argv.find((a) => a.startsWith('--only=')) || '--only=marine,river').slice(7)
    .split(',').map((x) => x.trim()).filter((x) => x === 'marine' || x === 'river');
  for (const kind of (KINDS.length ? KINDS : ['marine', 'river'])) {
    let zones = [];
    try {
      await resetSession(downloadDir);
      await send('Page.navigate', { url: `https://cd.epic.epd.gov.hk/EPICRIVER/${kind}/?lang=en` }, sessionId);
      if (await waitFor(['form:wzterControlZone'])) {
        zones = await ev(`(() => {
          const s = document.getElementById('form:wzterControlZone');
          return [...s.options].map((o) => o.value).filter(Boolean);
        })()`);
      }
    } catch (e) {
      log(`[${kind}] zone list failed: ${e.message}`);
    }
    if (!zones.length) { log(`[${kind}] no zone list — skipped`); continue; }
    log(`[${kind}] ${zones.length} zones: ${zones.join(', ')}`);

    /* 先把「單位」列出來。海水：每個管制區一個單位。河溪：每個管制區 × 每條河溪
       一個單位（河溪清單要開瀏覽器到該區的 Station Selection 頁拿）。 */
    const units = [];
    if (kind === 'river') {
      for (const zone of zones) {
        /* 上次已成功列出的河溪清單直接沿用，省掉一次不穩定的開頁面動作 */
        let rivers = progress.riverLists[zone] || null;
        if (rivers) { log(`[${kind}] ${zone}: ${rivers.length} rivers (cached)`); }
        for (let a = 1; a <= 5 && !rivers; a++) {
          try {
            await resetSession(downloadDir);
            const r = await fetchZone(kind, zone, downloadDir, fromYear, null);
            /* 該管制區在官方歷史資料庫裡確實沒有資料（網站回 /result/nodata/），
               不是暫時性失敗，不必重試 —— 直接標記為「無河溪」並跳過。 */
            if (r.error && /^no data/.test(r.error)) { rivers = []; progress.riverLists[zone] = rivers; saveProgress(); break; }
            rivers = r.rivers || null;
            if (!rivers) log(`[${kind}] ${zone}: river list attempt ${a} failed — ${r.error || 'no rivers'}`);
            else progress.riverLists[zone] = rivers, saveProgress();
          } catch (e) {
            log(`[${kind}] ${zone}: river list attempt ${a} threw — ${e.message}`);
            if (a === 1) console.error('[STACK] discovery:\n' + (e.stack || e.message));
          }
          if (!rivers) await sleep(2000);
        }
        if (!rivers) { log(`[${kind}] ${zone}: no river list — skipped`); continue; }
        log(`[${kind}] ${zone}: ${rivers.length} rivers`);
        rivers.forEach((rv) => units.push({ zone, river: rv }));
      }
    } else {
      zones.forEach((z) => units.push({ zone: z, river: null }));
    }
    log(`[${kind}] ${units.length} units to fetch`);

    let skipped = 0;
    for (const unit of units) {
      const label = unit.river ? `${unit.zone} / ${unit.river}` : unit.zone;
      const key = unitKey(kind, unit.zone, unit.river);
      if (progress.done[key]) { skipped++; continue; }
      const t0 = Date.now();
      /* 每個單位都用全新的瀏覽器 session：JSF 會記住上一個單位已選的項目，
         令「可選清單」變空。 */
      let res = { error: 'not attempted' };
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await resetSession(downloadDir);
          res = await fetchZone(kind, unit.zone, downloadDir, fromYear, unit.river);
        } catch (e) {
          res = { error: e.message };
          if (attempt === 1) console.error('[STACK] fetch ' + label + ':\n' + (e.stack || e.message));
        }
        if (!res.error) break;
        log(`[${kind}] ${label}: attempt ${attempt} failed — ${res.error}`);
        await sleep(2000);
      }
      if (res.error) { log(`[${kind}] ${label}: FAILED — ${res.error}`); continue; }
      progress.done[key] = true; saveProgress();
      let points = 0;
      if (kind === 'river') {
        /* 河溪的官方歷史 CSV 是「子測站」級（例如 Lam Tsuen River 底下有 TR17、
            TR17L 等多個子測站），而地圖上的河溪圖層是以「河溪」為單位（A_Station_Eng
            就是河溪名）。所以這裡要把同一條河溪的所有子測站合併成一條序列：同一日期
            取第一個非空的溶解氧／生化需氧量，方便彈窗只畫一張圖。 */
        const merged = mergeStations(res.stations);
        if (merged.length) {
          points = merged.length;
          const cur = result.river[unit.river];
          if (cur) cur.series = mergeSeries(cur.series, merged);
          else result.river[unit.river] = { zone: res.zone || unit.zone, series: merged };
        }
      } else {
        Object.keys(res.stations).forEach((st) => {
          const series = res.stations[st];
          if (!series.length) return;
          points += series.length;
          const cur = result.marine[st];
          if (cur) cur.series = cur.series.concat(series).sort((a, b) => (a[0] < b[0] ? -1 : 1));
          else result.marine[st] = { zone: res.zone || unit.zone, series };
        });
      }
      writeOut();   // 每完成一個單位就寫檔，中途失敗也不致前功盡棄
      log(`[${kind}] ${label}: ${points} samples (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      await sleep(800);   // 別打太快，這個網站會間歇性回 500
    }
    if (skipped) log(`[${kind}] skipped ${skipped} already-done units`);
  }

  function writeOut() {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result));
  }
  /* 把同一河溪的數個子測站序列合併成「日期 → [溶解氧, 生化需氧量]」一條序列：
     同一日期取第一個非空值（不取平均，因為子測站數量與涵蓋日期不固定）。 */
  function mergeStations(byStation) {
    const byDate = new Map();
    for (const st of Object.keys(byStation)) {
      for (const row of byStation[st]) {
        const [d, dov, bodv] = row;
        if (!d) continue;
        let e = byDate.get(d);
        if (!e) { e = [d, null, null]; byDate.set(d, e); }
        if (e[1] == null && dov != null) e[1] = dov;
        if (e[2] == null && bodv != null) e[2] = bodv;
      }
    }
    return [...byDate.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }
  function mergeSeries(a, b) {
    const byDate = new Map();
    for (const row of a.concat(b)) {
      const [d, dov, bodv] = row;
      let e = byDate.get(d);
      if (!e) { e = [d, null, null]; byDate.set(d, e); }
      if (e[1] == null && dov != null) e[1] = dov;
      if (e[2] == null && bodv != null) e[2] = bodv;
    }
    return [...byDate.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }
  const count = (o) => Object.keys(o).length;
  const samples = (o) => Object.values(o).reduce((a, v) => a + v.series.length, 0);
  writeOut();
  log(`\nwrote ${OUT}`);
  log(`  marine: ${count(result.marine)} stations / ${samples(result.marine)} samples`);
  log(`  river:  ${count(result.river)} stations / ${samples(result.river)} samples`);
  log(`  size:   ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);

  stopBrowser();
}

main().catch((e) => { console.error(e); try { chrome && chrome.kill(); } catch (x) {} process.exit(1); });
