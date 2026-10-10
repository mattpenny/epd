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
const TMP = path.join(ROOT, 'tools', 'artifacts', 'wq-history-tmp');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const argv = process.argv.slice(2);
const HEADED = argv.includes('--headed');
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
const pending = new Map();

const send = (method, params = {}, sid) => new Promise((resolve, reject) => {
  const i = ++msgId; pending.set(i, { resolve, reject });
  ws.send(JSON.stringify(sid ? { id: i, method, params, sessionId: sid } : { id: i, method, params }));
});
const evOnce = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise }, sessionId);
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
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
  /* 每次都用全新的設定檔（放在系統暫存區，不刪除任何東西 —— 刪除會觸發
     沙箱的大量刪除保護）。舊的 JSF session 會令「可選清單」變空。 */
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'epd-wq-'));
  chrome = spawn(CHROME, [
    HEADED ? '--new-window' : '--headless=new',
    '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
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
  for (const rel of [['Default', 'Cookies'], ['Default', 'Network', 'Cookies'],
                     ['Default', 'Local Storage'], ['Default', 'Session Storage']]) {
    try { fs.rmSync(path.join(PROFILE, ...rel), { recursive: true, force: true }); } catch (e) {}
  }
  await startBrowser(downloadDir);
}

/* ------------------------------------------------------- one zone → one CSV */
async function fetchZone(kind, zone, downloadDir, fromYear) {
  fs.readdirSync(downloadDir).forEach((f) => fs.rmSync(path.join(downloadDir, f), { force: true }));
  await send('Page.navigate', { url: `https://cd.epic.epd.gov.hk/EPICRIVER/${kind}/?lang=en` }, sessionId);
  if (!await waitFor(['form:select', 'form:wzterControlZone']) ||
      !await waitForAny(['Aselect-download', 'download'])) {
    return { zone, error: 'step 1 form not found' };
  }
  await ev(`(() => {
    /* 海水頁的「下載」選項是 #Aselect-download（name=Aselect），
       河溪頁是 #download（name=displayg）—— 兩者不同。 */
    const rad = document.getElementById('Aselect-download') || document.getElementById('download');
    if (!rad) return false;
    rad.checked = true; rad.click();
    const sel = document.getElementById('form:wzterControlZone');
    sel.value = ${JSON.stringify(zone)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('form:select').click();
    return true;
  })()`).catch(() => {});
  await sleep(4000);   // 提交後頁面會導航到 /download/，先讓它穩定
  if (!await waitFor(['form:display', 'unselectStation', 'unselectParameter'])) {
    return { zone, error: 'step 2 (parameter page) not found' };
  }
  /* 參數／測站清單是提交後才由 JSF 填好的，必須等到真的有選項才動手
     （第一區之後往往仍是空清單，這正是先前只有第一區成功的原因）。 */
  const listsReady = await ev(`(async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const st = document.getElementById('unselectStation');
      const pa = document.getElementById('unselectParameter');
      if (st && pa && st.options.length > 0 && pa.options.length > 0) return { st: st.options.length, pa: pa.options.length };
      await new Promise((r) => setTimeout(r, 300));
    }
    return null;
  })()`, true);
  if (!listsReady) return { zone, error: 'station/parameter lists never populated' };
  await sleep(500);

  /* 只挑兩個參數、全部測站，並把年份下限設為 fromYear */
  const prep = await ev(`(async () => {
    const yFrom = document.getElementById('form:FromYear');
    if (yFrom) { yFrom.value = String(${fromYear}); yFrom.dispatchEvent(new Event('change', { bubbles: true })); }
    const stations = document.getElementById('unselectStation');
    [...stations.options].forEach((o) => { o.selected = true; });
    const params = document.getElementById('unselectParameter');
    let picked = [];
    [...params.options].forEach((o) => {
      if (${JSON.stringify(WANT_PARAMS.map((r) => r.source))}.some((src) => new RegExp(src).test(o.text.trim()))) {
        o.selected = true; picked.push(o.text.trim());
      }
    });
    return { stations: stations.options.length, params: params.options.length, picked };
  })()`, true);
  if (!prep.picked || prep.picked.length !== 2) {
    return { zone, error: 'expected 2 parameters, got ' + JSON.stringify(prep.picked) };
  }

  await ev(`(async () => {
    const btns = [...document.querySelectorAll('input[type=button]')].filter((b) => /^>/.test((b.value || '').trim()));
    for (const b of btns) { b.click(); await new Promise((r) => setTimeout(r, 1800)); }
    return true;
  })()`, true);
  await sleep(500);
  /* 移動若沒生效，就不必等 60 秒才失敗 —— 先檢查「已選」清單是否真的有東西 */
  const movedOk = await ev(`(() => {
    const st = document.getElementById('station');
    const pa = document.getElementById('parameter');
    return { st: st ? st.options.length : 0, pa: pa ? pa.options.length : 0 };
  })()`);
  if (!movedOk.st || !movedOk.pa) {
    return { zone, error: `move to Selected failed (station=${movedOk.st}, parameter=${movedOk.pa})` };
  }

  await ev(`(() => { document.getElementById('form:display').click(); return true; })()`);

  let file = null;
  const deadline = Date.now() + 75000;
  while (Date.now() < deadline) {
    await sleep(1000);
    const files = fs.readdirSync(downloadDir);
    const csv = files.find((f) => /\.csv$/i.test(f));
    const busy = files.some((f) => f.endsWith('.crdownload'));
    if (csv && !busy) { file = path.join(downloadDir, csv); break; }
  }
  if (!file) return { zone, error: 'no csv downloaded' };

  const rows = parseCsv(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!rows.length) return { zone, error: 'empty csv' };
  const head = rows[0].map((h) => h.trim());
  const iZone = head.indexOf('Water Control Zone');
  const iStation = head.indexOf('Station');
  const iDate = head.indexOf('Dates');
  const iDo = head.indexOf('Dissolved Oxygen (mg/L)');
  const iBod = head.indexOf('5-day Biochemical Oxygen Demand (mg/L)');
  if (iStation < 0 || iDate < 0 || iDo < 0 || iBod < 0) {
    return { zone, error: 'unexpected columns: ' + head.slice(0, 8).join('|') };
  }
  const byStation = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length < head.length) continue;
    const st = (row[iStation] || '').trim();
    const d = (row[iDate] || '').trim();
    if (!st || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const y = Number(d.slice(0, 4));
    if (y < fromYear) continue;
    const doV = (row[iDo] || '').trim();
    const bodV = (row[iBod] || '').trim();
    if (!byStation[st]) byStation[st] = [];
    byStation[st].push([d, doV === 'N/A' ? null : doV, bodV === 'N/A' ? null : bodV]);
  }
  Object.keys(byStation).forEach((s) => byStation[s].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  return { zone: (rows[1] && rows[1][iZone]) ? rows[1][iZone].trim() : zone, stations: byStation };
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

  for (const kind of ['marine', 'river']) {
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
    for (const zone of zones) {
      const t0 = Date.now();
      /* 每個管制區都用全新的瀏覽器（＝全新的 JSF session）。JSF 會記住上一區
         已選的項目，令第二區之後的「可選清單」變空 —— 這正是先前只有第一區
         成功的原因。 */
      let res = { zone, error: 'not attempted' };
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await resetSession(downloadDir);
          res = await fetchZone(kind, zone, downloadDir, fromYear);
        } catch (e) {
          res = { zone, error: e.message };
        }
        if (!res.error) break;
        log(`[${kind}] ${zone}: attempt ${attempt} failed — ${res.error}`);
        await sleep(1500);
      }
      if (res.error) { log(`[${kind}] ${zone}: FAILED — ${res.error}`); continue; }
      let points = 0;
      Object.keys(res.stations).forEach((st) => {
        const series = res.stations[st];
        if (!series.length) return;
        points += series.length;
        const cur = result[kind][st];
        if (cur) cur.series = cur.series.concat(series).sort((a, b) => (a[0] < b[0] ? -1 : 1));
        else result[kind][st] = { zone: res.zone, series };
      });
      writeOut();   // 每完成一區就寫檔，中途失敗也不致前功盡棄
      log(`[${kind}] ${zone}: ${Object.keys(res.stations).length} stations, ${points} samples (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
  }

  function writeOut() {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result));
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
