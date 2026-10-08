/* 香港環保數據地圖 — 自動化驗證腳本 (Playwright, CommonJS) */
const { chromium } = require('C:/Users/sfcheang/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core');
const path = require('path');

const CHROME = 'C:/Users/sfcheang/AppData/Local/ms-playwright/chromium-1246/chrome-win64/chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8777/index.html';
const OUT = path.resolve('C:/EPD/.verify');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/* 官方 EPD「最新泳灘水質等級」圖例用色。等級 1 是淺青而非綠色，
   這是官方慣例，因此把色碼釘在測試裡當作規格。 */
const OFFICIAL = { 1: '#7CE7F0', 2: '#4CE84C', 3: '#F5C33B', 4: '#F0433D' };
const CLOSED = '#9AA7B0';
const PALETTE = Object.values(OFFICIAL).concat([CLOSED]).map((c) => c.toUpperCase());
const ZH_DISTRICTS = ['南區', '荃灣區', '屯門區', '大埔區', '西貢區', '離島區'];
const EN_DISTRICTS = ['Southern', 'Tsuen Wan', 'Tuen Mun', 'Tai Po', 'Sai Kung', 'Islands'];
// 瀏覽器把 inline 色碼序列化成 rgb(...)，統一站成 #RRGGBB 再比對
const norm = (s) => {
  const m = String(s || '').match(/rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/i);
  if (m) return '#' + [1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, '0')).join('').toUpperCase();
  return String(s || '').trim().toUpperCase();
};
/* 逐個泳灘標記抽出：自身等級、標記色、tooltip 內容 */
const readBeachMarks = (page) => page.evaluate(() => {
  const out = [];
  const grp = window.__hkEnvMap.layers.beach;
  if (!grp || !grp.eachLayer) return out;
  grp.eachLayer((l) => {
    const p = (l.feature && l.feature.properties) || null;
    if (!p) return;
    const html = (l.options.icon && l.options.icon.options && l.options.icon.options.html) || '';
    const m = html.match(/background:\s*([^;"]+)/i);
    /* tooltip 內容可能是字串，也可能是延遲求值的函式 —— Leaflet 於開啟時
       呼叫它（_updateContent），所以這裡照樣呼叫，才是真實渲染路徑。 */
    let tip = '';
    if (l.getTooltip()) {
      const c = l.getTooltip().getContent();
      const raw = typeof c === 'function' ? c(l) : c;
      const el = document.createElement('div');
      el.innerHTML = String(raw == null ? '' : raw);
      tip = (el.textContent || '').replace(/\s+/g, ' ').trim();
    }
    out.push({
      // 數據集有 3 個名稱帶尾隨空白 → trim 後才是查表鍵
      beach: String(p.Beach || '').trim(),
      rawBeach: String(p.Beach || ''),
      grading: String(p.Beach_Gradings_TC || p.Beach_Gradings || ''),
      color: m ? m[1] : '',
      tip
    });
  });
  return out;
});

/* 量測子分頁列與它所屬分頁的對齊情形。
   桌面＝對齊頂部分頁列的「水質數據」；手機＝對齊底部導覽的「水質數據」。
   refEdge 是箭嘴尖端應該觸及的那條邊（桌面＝頂欄底邊、手機＝底部導覽頂邊）。 */
const readSubTabGeo = (page) => page.evaluate(() => {
  const nav = document.querySelector('#sub-tabs');
  const caret = document.querySelector('#sub-caret');
  const mobile = window.matchMedia('(max-width: 767px)').matches;
  const anchor = document.querySelector(
    mobile ? '#bottom-nav .tab[data-tab="water"]' : '#tabs .tab[data-tab="water"]');
  const topbar = document.querySelector('.topbar');
  const bottomNav = document.querySelector('.bottom-nav');
  if (!nav || !anchor || !topbar || !bottomNav) return null;
  const a = anchor.getBoundingClientRect();
  const n = nav.getBoundingClientRect();
  const c = caret ? caret.getBoundingClientRect() : null;
  const refEdge = mobile
    ? bottomNav.getBoundingClientRect().top
    : topbar.getBoundingClientRect().bottom;
  const vw = document.documentElement.clientWidth;
  return {
    mobile,
    anchorLeft: Math.round(a.left),
    anchorCenter: Math.round(a.left + a.width / 2),
    navLeft: Math.round(n.left),
    navRight: Math.round(n.right),
    caretCenter: c ? Math.round(c.left + c.width / 2) : null,
    caretTip: c ? Math.round(mobile ? c.bottom : c.top) : null,
    refEdge: Math.round(refEdge),
    vw,
    overflowsViewport: n.right > vw + 1 || n.left < -1,
    chipsScroll: nav.scrollWidth > nav.clientWidth + 1
  };
});

/* 等待地圖範圍內的圖塊全部載入完成 */
async function waitTiles(page, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = await page.evaluate(() => {
      const mapEl = document.querySelector('#map');
      if (!mapEl) return { total: 0, pending: 0 };
      const r = mapEl.getBoundingClientRect();
      const tiles = [...document.querySelectorAll('img.leaflet-tile')].filter((el) => {
        const tr = el.getBoundingClientRect();
        return tr.bottom > r.top && tr.top < r.bottom && tr.right > r.left && tr.left < r.right;
      });
      return { total: tiles.length, pending: tiles.filter((t) => !(t.complete && t.naturalWidth > 0)).length };
    });
    if (s.total > 0 && s.pending === 0) return s;
    await page.waitForTimeout(400);
  }
  return null;
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-HK' });
  const page = await ctx.newPage();

  const consoleMsgs = [];
  const pageErrors = [];
  page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('requestfailed', (r) => consoleMsgs.push(`[reqfail] ${r.url()} :: ${r.failure() && r.failure().errorText}`));

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 清空舊快取，確保測到的是真實網絡路徑
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });

  // ---- 1. 地圖容器與底圖 ----
  await page.waitForSelector('.leaflet-container', { timeout: 30000 });
  check('地圖容器已建立', true);

  // 等待圖塊繪製
  await page.waitForTimeout(6000);

  // ---- 2. 圖塊覆蓋率（依 skill 建議，只計與地圖 rect 相交的圖塊）----
  const tileStats = await page.evaluate(() => {
    const mapEl = document.querySelector('#map');
    const r = mapEl.getBoundingClientRect();
    const tiles = [...document.querySelectorAll('img.leaflet-tile')].filter((el) => {
      const tr = el.getBoundingClientRect();
      return tr.bottom > r.top && tr.top < r.bottom && tr.right > r.left && tr.left < r.right;
    });
    const ok = tiles.filter((t) => t.complete && t.naturalWidth > 0).length;
    return { total: tiles.length, ok, pct: tiles.length ? Math.round(ok / tiles.length * 100) : 0 };
  });
  check('底圖圖塊已繪製', tileStats.pct >= 90 && tileStats.total >= 6,
    `${tileStats.ok}/${tileStats.total} = ${tileStats.pct}%`);

  // ---- 3. 七個圖層載入（由 console 效能紀錄斷言）----
  // 等待全部圖層都留下載入紀錄，而非固定等待（CSDI 服務偶有暫時性失敗會重試）
  const needLogs = [
    '\\[效能\\]\\s*香港空氣質素監測網絡：\\s*\\d+',
    '\\[效能\\]\\s*泳灘水質等級：\\s*\\d+',
    '\\[效能\\]\\s*近期海水水質數據：\\s*\\d+',
    '\\[效能\\]\\s*近期河溪水質數據：\\s*\\d+',
    '\\[效能\\]\\s*低噪音路面：\\s*\\d+',
    '\\[效能\\]\\s*回收點數據資料：\\s*\\d+',
    '\\[效能\\]\\s*已簽發的建築噪音許可證：\\s*\\d+'
  ];
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const txt = consoleMsgs.join('\n');
    if (needLogs.every((p) => new RegExp(p).test(txt))) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(2000);
  const logText = consoleMsgs.join('\n');

  const expect = [
    ['香港空氣質素監測網絡', 18],
    ['泳灘水質等級', 40],
    ['近期海水水質數據', 10],
    ['近期河溪水質數據', 13],
    ['低噪音路面', 1613],
    ['回收點數據資料', 8858],
    ['已簽發的建築噪音許可證', 1954]
  ];
  for (const [name, n] of expect) {
    const re = new RegExp('\\[效能\\]\\s*' + name + '：\\s*(\\d+)\\s*筆');
    const m = logText.match(re);
    check(`圖層「${name}」載入筆數`, !!m && Number(m[1]) === n, m ? `${m[1]} 筆` : '找不到載入紀錄');
  }

  const aqhiMatch = logText.match(/\[空氣\]\s*AQHI 對照成功：(\d+)\/(\d+)/);
  check('AQHI 與監測站空間關聯', !!aqhiMatch && aqhiMatch[1] === aqhiMatch[2],
    aqhiMatch ? `${aqhiMatch[1]}/${aqhiMatch[2]} 對應` : '找不到對照紀錄');

  const unmatched = logText.match(/\[空氣\] 有 (\d+) 個監測站未能對應/);
  check('沒有未對應的監測站', !unmatched, unmatched ? unmatched[0] : '全部對應');

  // ---- 4. 預設顯示空氣圖層 ----
  const activeTab = await page.getAttribute('.tab[aria-selected="true"]', 'data-tab');
  check('預設顯示空氣質素圖層', activeTab === 'air', `active=${activeTab}`);

  const legendTitle = await page.textContent('#legend-title');
  check('圖例顯示官方數據集名稱', /香港空氣質素監測網絡/.test(legendTitle), legendTitle.trim());

  // ---- 5. 標記與 Popup ----
  const markerInfo = await page.evaluate(() => ({
    markers: document.querySelectorAll('.leaflet-marker-icon .pin, .leaflet-marker-icon').length,
    clusters: document.querySelectorAll('.marker-cluster').length
  }));
  check('地圖上有標記或聚合點', markerInfo.markers + markerInfo.clusters > 0,
    `markers=${markerInfo.markers} clusters=${markerInfo.clusters}`);

  // 點擊第一個標記 → 檢查 Popup 內容
  const firstMarker = await page.$('.leaflet-marker-icon');
  let popupText = '';
  if (firstMarker) {
    await firstMarker.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1200);
    popupText = await page.evaluate(() => {
      const el = document.querySelector('.custom-popup');
      return el ? el.innerText.replace(/\s+/g, ' ').trim() : '';
    });
  }
  check('Popup 顯示官方欄位標籤', /監測站|空氣質素健康指數|健康風險級別/.test(popupText),
    popupText.slice(0, 110));
  check('Popup 底部有資料來源註腳', /資料來源：環境保護署/.test(popupText), '');

  // ---- 6. Tab 切換 ----
  for (const id of ['water', 'recycle', 'noise', 'cnp']) {
    await page.click(`.tab[data-tab="${id}"]`);
    await page.waitForTimeout(3500);
    const cur = await page.getAttribute('.tab[aria-selected="true"]', 'data-tab');
    const lt = (await page.textContent('#legend-title')).trim();
    check(`切換至「${id}」Tab`, cur === id, `legend=${lt}`);

    if (id !== 'water') {
      /* 非「水質數據」分頁不該留下子分頁箭嘴飄在地圖上 */
      const caretHidden = await page.evaluate(() => {
        const c = document.querySelector('#sub-caret');
        const n = document.querySelector('#sub-tabs');
        return (!c || getComputedStyle(c).display === 'none')
          && (!n || getComputedStyle(n).display === 'none');
      });
      check(`切換至「${id}」後子分頁與箭嘴皆隱藏`, caretHidden, '');
    }

    if (id === 'water') {
      /* 「水質數據」分頁必須出現 3 個子分頁，且預設停在泳灘 */
      const subInfo = await page.evaluate(() => ({
        count: document.querySelectorAll('.sub-tab').length,
        labels: [...document.querySelectorAll('.sub-tab')].map((b) => b.innerText.trim()),
        selected: (document.querySelector('.sub-tab[aria-selected="true"]') || {}).dataset
          ? document.querySelector('.sub-tab[aria-selected="true"]').dataset.sub : null,
        bodyHas: document.body.classList.contains('has-subtabs'),
        layerId: window.__hkEnvMap.activeLayerId()
      }));
      check('水質數據分頁顯示 3 個子分頁',
        subInfo.count === 3 && subInfo.bodyHas,
        `n=${subInfo.count} :: ${subInfo.labels.join(' | ')}`);
      check('水質數據子分頁名稱為官方數據集標題',
        subInfo.labels.join('|') === '泳灘水質等級|近期海水水質數據|近期河溪水質數據',
        subInfo.labels.join(' | '));
      check('水質數據預設子分頁為泳灘水質等級',
        subInfo.selected === 'beach' && subInfo.layerId === 'beach',
        `selected=${subInfo.selected} layer=${subInfo.layerId}`);

      const nm = await page.evaluate(() => document.querySelectorAll('.leaflet-marker-icon').length);
      check('泳灘圖層有標記', nm > 0, `markers=${nm}`);

      /* ---- (a0) 子分頁列必須「開在它所屬的分頁正下方」 ----
         只檢查左緣對齊與箭嘴指向：使用者要能一眼看出子分頁隸屬「水質數據」。 */
      const geo = await readSubTabGeo(page);
      check('子分頁列左緣對齊「水質數據」分頁',
        !!geo && Math.abs(geo.navLeft - geo.anchorLeft) <= 2,
        `navLeft=${geo && geo.navLeft} anchorLeft=${geo && geo.anchorLeft}`);
      check('子分頁箭嘴指向「水質數據」分頁中心',
        !!geo && Math.abs(geo.caretCenter - geo.anchorCenter) <= 2,
        `caret=${geo && geo.caretCenter} anchorCenter=${geo && geo.anchorCenter}`);
      check('子分頁箭嘴尖端觸及頂部分頁列底邊',
        !!geo && Math.abs(geo.caretTip - geo.refEdge) <= 3,
        `tip=${geo && geo.caretTip} ref=${geo && geo.refEdge}`);
      check('子分頁列不超出視窗，且三個子分頁無需橫向捲動',
        !!geo && !geo.overflowsViewport && !geo.chipsScroll,
        `left=${geo && geo.navLeft} right=${geo && geo.navRight} vw=${geo && geo.vw} scroll=${geo && geo.chipsScroll}`);

      /* 迴歸守門：載入轉圈（12px + 6px 間距）會把分頁撐寬 18px，連帶推移
         「水質數據」的位置。修復前子分頁列只在切換當下量一次，因此會偏掉 18px。
         這裡在「水質數據」左邊的分頁上掛轉圈，驗證子分頁列會自動跟上。 */
      await page.evaluate(() => {
        document.querySelectorAll('.tab[data-tab="air"]').forEach((b) => b.classList.add('is-loading'));
      });
      await page.waitForTimeout(600);
      const geoSpin = await readSubTabGeo(page);
      check('左側分頁轉圈撐寬後，子分頁列仍自動保持對齊',
        !!geoSpin && Math.abs(geoSpin.navLeft - geoSpin.anchorLeft) <= 2,
        `navLeft=${geoSpin && geoSpin.navLeft} anchorLeft=${geoSpin && geoSpin.anchorLeft}`);
      await page.evaluate(() => {
        document.querySelectorAll('.tab[data-tab="air"]').forEach((b) => b.classList.remove('is-loading'));
      });
      await page.waitForTimeout(400);

      /* 官方 EPD「最新泳灘水質等級」圖例用色。等級 1 是淺青而非綠色，
         這是官方慣例，因此把色碼釘在測試裡當作規格。 */
      // ---- (a) 圖例：四級 + 未開放，色碼必須等於官方 EPD 用色 ----
      const legend = await page.evaluate(() =>
        [...document.querySelectorAll('#legend-body .legend-row')].map((r) => {
          const sw = r.querySelector('.legend-swatch');
          return { color: sw ? sw.style.background : '', label: r.innerText.replace(/\s+/g, ' ').trim() };
        }));
      const gotLegend = legend.map((r) => norm(r.color));
      check('泳灘圖例為官方四級 + 未開放共 5 項',
        legend.length === 5, `rows=${legend.length} :: ${legend.map((r) => r.label).join(' | ')}`);
      check('泳灘圖例用色等於官方 EPD 等級色碼',
        JSON.stringify(gotLegend) === JSON.stringify(PALETTE),
        `got=${gotLegend.join(',')} want=${PALETTE.join(',')}`);

      // ---- (b) 逐個標記：顏色由自身等級推得，且必屬官方色盤 ----
      const marks = await readBeachMarks(page);
      check('泳灘標記數與數據集一致', marks.length === 40, `n=${marks.length}`);
      check('泳灘標記顏色全部取自官方 EPD 色盤',
        marks.length > 0 && marks.every((m) => PALETTE.indexOf(norm(m.color)) >= 0),
        `off=${marks.filter((m) => PALETTE.indexOf(norm(m.color)) < 0).slice(0, 3).map((m) => m.beach + '=' + m.color).join(',') || 'none'}`);
      const mismatched = marks.filter((m) => {
        const g = (m.grading.match(/(\d)/) || [])[1];
        return norm(m.color) !== (OFFICIAL[g] || CLOSED);
      });
      check('泳灘標記顏色與其水質等級一致',
        marks.length > 0 && mismatched.length === 0,
        `n=${marks.length} mismatch=${mismatched.slice(0, 3).map((m) => `${m.beach}[${m.grading}] ${m.color}`).join(' , ') || 'none'}`);

      // ---- (c) 官方中文名稱 + 中文地區（走真實 tooltip 渲染路徑） ----
      const noZhName = marks.filter((m) => !/泳灘/.test(m.tip));
      check('泳灘 Tooltip 顯示官方中文名稱',
        marks.length > 0 && noZhName.length === 0,
        `n=${marks.length} 缺中文名=${noZhName.map((m) => m.beach).join(',') || 'none'}`);

      /* 名稱未 trim 就會靜默查不到地區（數據集有 3 個尾隨空白名稱），
         因此這項同時是「trim 前處理」的回歸守門。 */
      const noDistrict = marks.filter((m) => !ZH_DISTRICTS.some((d) => m.tip.indexOf(d) >= 0));
      check('每個線上泳灘都能對應中文地區（100% 覆蓋）',
        marks.length > 0 && noDistrict.length === 0,
        `n=${marks.length} 未對應=${noDistrict.map((m) => m.beach).join(',') || 'none'}`);

      const padded = marks.filter((m) => m.rawBeach !== m.beach);
      check('泳灘名稱已去除官方數據集的尾隨空白',
        marks.length > 0 && padded.every((m) => ZH_DISTRICTS.some((d) => m.tip.indexOf(d) >= 0)),
        `padded=${padded.length} :: ${padded.map((m) => JSON.stringify(m.rawBeach)).join(',') || 'none'}`);

      // tooltip 真的會出現在 DOM 裡（不是只有內容函式回得對）
      const hovered = await page.$('.leaflet-marker-icon');
      if (hovered) {
        await hovered.hover().catch(() => {});
        await page.waitForTimeout(700);
        const tipText = await page.evaluate(() => {
          const e = document.querySelector('.leaflet-tooltip');
          return e ? e.innerText.replace(/\s+/g, ' ').trim() : '';
        });
        check('滑過泳灘標記會顯示「中文名稱 · 中文地區」Tooltip',
          /泳灘/.test(tipText) && ZH_DISTRICTS.some((d) => tipText.indexOf(d) >= 0) && /·/.test(tipText),
          tipText.slice(0, 80));
      }

      /* 官方名單共 43 個泳灘（屯門 6／荃灣 8／離島 10／大埔 1／西貢 6／南區 12），
         數據集只發布 40 個，未發布的是南區 Hairpin／Rocky Bay 與荃灣 Gemini，
         故實際分佈應為南區 10／荃灣 7／其餘不變，合計 40。 */
      const EXPECT_DIST = { 南區: 10, 荃灣區: 7, 離島區: 10, 屯門區: 6, 西貢區: 6, 大埔區: 1 };
      const distCount = {};
      marks.forEach((m) => {
        const d = ZH_DISTRICTS.find((x) => m.tip.indexOf(x) >= 0);
        if (d) distCount[d] = (distCount[d] || 0) + 1;
      });
      // 逐區比對（不比較 key 順序）
      const distBad = Object.keys(EXPECT_DIST).filter((k) => distCount[k] !== EXPECT_DIST[k]);
      check('泳灘地區分佈與官方名單相符',
        distBad.length === 0,
        `got=${JSON.stringify(distCount)} bad=${distBad.join(',') || 'none'}`);

      // ---- (d) 圖例註記須誠實交代缺漏欄位 ----
      const note = await page.evaluate(() => {
        const e = document.querySelector('#legend-body .legend-note');
        return e ? e.innerText.replace(/\s+/g, ' ') : '';
      });
      check('泳灘圖例註記交代無採樣日期及地區來源',
        /採樣日期/.test(note) && /地區/.test(note), note.slice(0, 110));

      // ---- (e) Popup：中文名稱 + 中文地區 + 官方色碼徽章 ----
      const m = await page.$('.leaflet-marker-icon');
      if (m) {
        await m.click({ force: true }).catch(() => {});
        await page.waitForTimeout(1200);
        const txt = await page.evaluate(() => {
          const e = document.querySelector('.custom-popup');
          return e ? e.innerText.replace(/\s+/g, ' ') : '';
        });
        check('泳灘 Popup 顯示水質等級', /水質等級/.test(txt), txt.slice(0, 90));
        check('泳灘 Popup 誠實標示無採樣日期', /官方數據集未提供採樣日期/.test(txt), '');
        check('泳灘 Popup 顯示官方中文名稱與中文地區',
          /泳灘/.test(txt) && /地區/.test(txt) && ZH_DISTRICTS.some((d) => txt.indexOf(d) >= 0),
          txt.slice(0, 120));
        const badge = await page.evaluate(() => {
          const b = document.querySelector('.custom-popup .badge');
          if (!b) return null;
          const cs = getComputedStyle(b);
          return { bg: cs.backgroundColor, text: b.innerText.trim() };
        });
        check('泳灘 Popup 等級徽章使用官方色碼',
          !!badge && PALETTE.indexOf(norm(badge.bg)) >= 0,
          badge ? `bg=${badge.bg} text=${badge.text}` : 'no badge');
      }

      /* ---- 切換子分頁：海水 → 河溪，圖層與圖例都要跟著換 ---- */
      for (const [sub, expectTitle, expectGlyph] of [
        ['marine', '近期海水水質數據', '🌊'],
        ['river', '近期河溪水質數據', '💧']
      ]) {
        await page.click(`.sub-tab[data-sub="${sub}"]`);
        await page.waitForTimeout(3500);
        const st = await page.evaluate(() => {
          const s = window.__hkEnvMap;
          const sel = document.querySelector('.sub-tab[aria-selected="true"]');
          return {
            selected: sel ? sel.dataset.sub : null,
            layerId: s.activeLayerId(),
            legendTitle: document.querySelector('#legend-title').textContent.trim(),
            markers: document.querySelectorAll('.leaflet-marker-icon').length,
            // 子分頁切換不應改動主分頁
            tab: document.querySelector('.tab[aria-selected="true"]').dataset.tab
          };
        });
        check(`子分頁切換至「${expectTitle}」`,
          st.selected === sub && st.layerId === sub && st.tab === 'water',
          `selected=${st.selected} layer=${st.layerId} tab=${st.tab}`);
        check(`「${expectTitle}」圖例標題正確`,
          st.legendTitle === expectTitle, `legend=${st.legendTitle}`);
        check(`「${expectTitle}」有標記`, st.markers > 0, `markers=${st.markers}`);

        /* 監測站：單一顏色（官方無等級評級 → 不得自行分級）＋官方欄位標籤與單位 */
        const stations = await page.evaluate(() => {
          const s = window.__hkEnvMap;
          const lid = s.activeLayerId();
          const out = { colors: {}, n: 0, tips: [], doVals: [] };
          const grp = s.layers[lid];
          if (!grp || !grp.eachLayer) return out;
          grp.eachLayer((l) => {
            const p = l.feature && l.feature.properties;
            if (!p) return;
            out.n++;
            const html = (l.options.icon && l.options.icon.options && l.options.icon.options.html) || '';
            const m = html.match(/background:\s*([^;"]+)/i);
            if (m) out.colors[m[1].toUpperCase()] = (out.colors[m[1].toUpperCase()] || 0) + 1;
            const c = l.getTooltip() ? l.getTooltip().getContent() : '';
            out.tips.push(String(typeof c === 'function' ? c(l) : c).replace(/<[^>]*>/g, ''));
            out.doVals.push(String(p.C_Dissolved_Oxygen_C || p.C_Dissolved_Oxygen_Eng || ''));
          });
          return out;
        });
        const wantColor = sub === 'marine' ? '#1565C0' : '#00838F';
        check(`「${expectTitle}」監測站只用單一顏色（無自創分級）`,
          stations.n > 0 && Object.keys(stations.colors).length === 1 &&
            Object.keys(stations.colors)[0] === wantColor,
          `n=${stations.n} colors=${JSON.stringify(stations.colors)}`);
        check(`「${expectTitle}」Tooltip 顯示官方中文站名`,
          stations.tips.length > 0 && stations.tips.every((t) => /[\u4e00-\u9fff]/.test(t)),
          stations.tips.slice(0, 3).join(' | '));

        // 開第一個監測站的 Popup，核對官方欄位標籤（含單位）
        const opened = await page.evaluate(() => {
          const s = window.__hkEnvMap;
          const kids = s.layers[s.activeLayerId()].getLayers();
          if (!kids.length) return false;
          s.map.setView(kids[0].getLatLng(), 13);
          kids[0].openPopup();
          return true;
        });
        await page.waitForTimeout(1500);
        const txt = await page.evaluate(() => {
          const e = document.querySelector('.custom-popup');
          return e ? e.innerText.replace(/\s+/g, ' ') : '';
        });
        check(`「${expectTitle}」Popup 使用官方欄位標籤與單位`,
          opened && /溶解氧 \(毫克\/升\)/.test(txt) && /五天生化需氧量 \(毫克\/升\)/.test(txt),
          txt.slice(0, 130));
        check(`「${expectTitle}」Popup 顯示樣本日期與監測站編號`,
          /樣本日期/.test(txt) && /監測站編號/.test(txt), '');
      }

      // 圖例註記必須說明「官方無等級評級，故不設顏色分級」
      const wNote = await page.evaluate(() => {
        const e = document.querySelector('#legend-body .legend-note');
        return e ? e.innerText.replace(/\s+/g, ' ') : '';
      });
      check('水質監測站圖例註記說明無官方評級、不設顏色分級',
        /並無官方等級評級/.test(wNote) && /不設顏色分級/.test(wNote), wNote.slice(0, 120));
    }
    if (id === 'cnp') {
      const cnp = await page.evaluate(() => {
        const s = window.__hkEnvMap;
        const grp = s.layers.cnp;
        const types = {}, districts = {}, badStatus = [];
        let n = 0;
        if (grp && grp.eachLayer) {
          grp.eachLayer((l) => {
            const p = l.feature && l.feature.properties;
            if (!p) return;
            n++;
            const ty = String(p.PERMIT_TYPE_ENG || '').trim();
            types[ty] = (types[ty] || 0) + 1;
            const d = String(p.DISTRICT_CHIN || p.DISTRICT_ENG || '').trim();
            if (d) districts[d] = (districts[d] || 0) + 1;
          });
        }
        return {
          n, types, districtCount: Object.keys(districts).length,
          clusters: document.querySelectorAll('.marker-cluster').length,
          markers: document.querySelectorAll('.leaflet-marker-icon').length
        };
      });
      check('建築噪音許可證載入全部 1954 筆', cnp.n === 1954, `n=${cnp.n}`);
      check('許可證只有官方兩種類別',
        Object.keys(cnp.types).sort().join('|') === 'General Construction Works|Percussive Piling',
        JSON.stringify(cnp.types));
      check('許可證圖層啟用聚合', cnp.clusters > 0, `clusters=${cnp.clusters} markers=${cnp.markers}`);

      const rows = await page.evaluate(() =>
        [...document.querySelectorAll('#legend-body .legend-row')].map((r) => ({
          color: r.querySelector('.legend-swatch') ? r.querySelector('.legend-swatch').style.background : '',
          label: r.innerText.replace(/\s+/g, ' ').trim()
        })));
      check('許可證圖例按官方類別列出並附筆數',
        rows.length === 2 && /一般建築工程 \(1936\)/.test(rows.map((r) => r.label).join('|')) &&
          /撞擊式打樁工程 \(18\)/.test(rows.map((r) => r.label).join('|')),
        rows.map((r) => r.label).join(' | '));

      const opened = await page.evaluate(() => {
        const s = window.__hkEnvMap;
        const kids = s.layers.cnp.getLayers();
        if (!kids.length) return false;
        s.map.setView(kids[0].getLatLng(), 17);
        kids[0].openPopup();
        return true;
      });
      await page.waitForTimeout(1800);
      const txt = await page.evaluate(() => {
        const e = document.querySelector('.custom-popup');
        return e ? e.innerText.replace(/\s+/g, ' ') : '';
      });
      check('許可證 Popup 顯示官方欄位',
        opened && /許可證編號/.test(txt) && /許可證類別/.test(txt) && /有效期/.test(txt) &&
          /簽發日期/.test(txt) && /工地地址/.test(txt),
        txt.slice(0, 150));
      check('許可證 Popup 標明「現況」為推算值',
        /現況（按有效期推算）/.test(txt) && /(生效中|已屆滿|未生效)/.test(txt), txt.slice(0, 150));
      const cnpNote = await page.evaluate(() => {
        const e = document.querySelector('#legend-body .legend-note');
        return e ? e.innerText.replace(/\s+/g, ' ') : '';
      });
      check('許可證圖例註記說明現況為推算、非官方欄位',
        /並非數據集原有欄位/.test(cnpNote), cnpNote.slice(0, 120));
      // 還原縮放，避免影響後續的主題／圖塊檢查
      await page.evaluate(() => { window.__hkEnvMap.map.setZoom(11); });
      await page.waitForTimeout(2000);
    }
    if (id === 'recycle') {
      const rc = await page.evaluate(() => ({
        clusters: document.querySelectorAll('.marker-cluster').length,
        markers: document.querySelectorAll('.leaflet-marker-icon').length
      }));
      check('回收點圖層啟用聚合', rc.clusters > 0, `clusters=${rc.clusters} markers=${rc.markers}`);
      // 放大至聚合停用級別，直接開啟個別標記的 Popup（避免點到聚合點）
      const opened = await page.evaluate(() => {
        const s = window.__hkEnvMap;
        const kids = s.layers.recycle.getLayers();
        if (!kids.length) return false;
        const m = kids[0];
        s.map.setView(m.getLatLng(), 18);
        m.openPopup();
        return true;
      });
      await page.waitForTimeout(2000);
      const txt = await page.evaluate(() => {
        const e = document.querySelector('.custom-popup');
        return e ? e.innerText.replace(/\s+/g, ' ') : '';
      });
      check('回收點 Popup 使用官方欄位標籤', opened && /回收物種類|地址|設施類別/.test(txt), txt.slice(0, 100));
      await page.evaluate(() => { window.__hkEnvMap.map.setZoom(11); });
      await page.waitForTimeout(2000);
    }
    if (id === 'noise') {
      const lines = await page.evaluate(() => document.querySelectorAll('.leaflet-overlay-pane svg path').length);
      check('低噪音路面以線狀要素繪製', lines > 0, `paths=${lines}`);
    }
  }

  // ---- 7. 主題切換 ----
  await page.click('.tab[data-tab="air"]');
  await page.waitForTimeout(2000);
  await page.click('#theme-btn');
  await page.waitForTimeout(4000);
  await waitTiles(page, 20000);
  const themeInfo = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    esri: [...document.querySelectorAll('img.leaflet-tile')].some((t) => /arcgisonline/.test(t.src)),
    gov: [...document.querySelectorAll('img.leaflet-tile')].some((t) => /mapapi\.geodata/.test(t.src))
  }));
  check('深色模式已套用', themeInfo.theme === 'dark', `theme=${themeInfo.theme}`);
  check('深色模式底圖已換成 Esri 深色圖', themeInfo.esri && !themeInfo.gov,
    `esri=${themeInfo.esri} gov=${themeInfo.gov}`);

  // 關鍵：確認深色圖塊是「真實地圖」而非帶浮水印的佔位圖
  // （CartoDB 免費圖層現會回傳 "API KEY REQUIRED" 佔位圖，體積約 2.5KB）
  // 關鍵：確認深色圖塊是「真實地圖」而非帶浮水印的佔位圖
  // （CartoDB 免費圖層現會回傳 "API KEY REQUIRED" 佔位圖，體積約 2.5KB）
  /* 由 Node 直接抓「World_Dark_Gray_Base」的圖塊來量，原因有三：
     1) 必須指名 Base：同一組 URL 裡還有 World_Dark_Gray_Reference（地名標註層），
        它的圖塊大多是空白，用大小判斷會誤判成佔位圖。
     2) 不經瀏覽器 fetch()：圖塊會被 Service Worker 攔截，結果不穩定
        （實測會整批 Failed to fetch）。
     3) 取最大值而非第一塊：浮水印是「每一塊」都很小，取最大值仍能分辨。 */
  const darkTileUrls = await page.evaluate(() =>
    [...document.querySelectorAll('img.leaflet-tile')]
      .map((el) => el.src)
      .filter((s) => /World_Dark_Gray_Base\/MapServer\/tile\//.test(s))
      .slice(0, 8));
  let darkBest = { bytes: 0, magic: '', url: '' };
  for (const u of darkTileUrls) {
    try {
      const r = await fetch(u);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > darkBest.bytes) {
        darkBest = { bytes: buf.length, magic: buf.subarray(0, 4).toString('hex'), url: u };
      }
    } catch (e) { /* 個別圖塊失敗不影響整體判斷 */ }
  }
  // JPEG 開頭 ffd8ff、PNG 開頭 89504e47 —— 確保拿到的是圖像而非錯誤頁
  const darkIsImage = /^ffd8ff/.test(darkBest.magic) || darkBest.magic === '89504e47';
  check('深色底圖圖塊為真實地圖（非浮水印佔位圖）',
    darkTileUrls.length > 0 && darkBest.bytes > 5000 && darkIsImage,
    `baseTiles=${darkTileUrls.length} bytes=${darkBest.bytes} magic=${darkBest.magic}`);
  const storedTheme = await page.evaluate(() => localStorage.getItem('hk-env-map-theme'));
  check('主題偏好已存入 localStorage', storedTheme === 'dark', `hk-env-map-theme=${storedTheme}`);

  // 切回淺色
  await page.click('#theme-btn');
  await page.waitForTimeout(3000);
  const lightGov = await page.evaluate(() =>
    [...document.querySelectorAll('img.leaflet-tile')].some((t) => /mapapi\.geodata/.test(t.src)));
  check('切回淺色模式使用政府地形圖', lightGov, '');

  // ---- 8. 語言切換 ----
  await page.click('#lang-btn');
  await page.waitForTimeout(6000);
  const enInfo = await page.evaluate(() => ({
    lang: document.documentElement.getAttribute('lang'),
    title: document.querySelector('#app-title').textContent,
    tab: document.querySelector('.tab[data-tab="air"] .tab-label').textContent,
    legend: document.querySelector('#legend-title').textContent,
    labelEn: [...document.querySelectorAll('img.leaflet-tile')].some((t) => /label\/hk\/en/.test(t.src)),
    labelTc: [...document.querySelectorAll('img.leaflet-tile')].some((t) => /label\/hk\/tc/.test(t.src))
  }));
  check('語言切換為英文', enInfo.lang === 'en' && /Environmental Data Map/.test(enInfo.title), enInfo.title);
  check('英文 Tab 文字正確', /Air Quality Monitoring Network/.test(enInfo.tab), enInfo.tab);
  check('地名標籤圖層切換為英文', enInfo.labelEn && !enInfo.labelTc,
    `en=${enInfo.labelEn} tc=${enInfo.labelTc}`);

  /* 新增分頁／子分頁的英文標題（官方數據集英文標題） */
  const enTabs = await page.evaluate(() => ({
    cnp: document.querySelector('.tab[data-tab="cnp"] .tab-label').textContent.trim(),
    water: document.querySelector('.tab[data-tab="water"] .tab-label').textContent.trim()
  }));
  check('英文模式「已簽發的建築噪音許可證」分頁標題正確',
    enTabs.cnp === 'Issued Construction Noise Permit', enTabs.cnp);
  check('英文模式「水質數據」分頁標題正確',
    enTabs.water === 'Water Quality Data', enTabs.water);

  /* 泳灘圖層是在切換語言「之前」載入的（第 6 節已開過水質數據 Tab）。
     applyLang 只重建當前圖層，所以非當前圖層的 tooltip 若在載入時就把
     語言寫死，切換語言後會殘留舊語言 —— 這項就是該回歸的守門。
     第 6 節最後停在「河溪」子分頁，這裡要先切回泳灘。 */
  await page.click('.tab[data-tab="water"]');
  await page.waitForTimeout(1500);
  const enSubLabels = await page.evaluate(() =>
    [...document.querySelectorAll('.sub-tab')].map((b) => b.innerText.trim()).join('|'));
  check('英文模式子分頁使用官方英文數據集標題',
    enSubLabels === 'Beach Water Quality Grading|Recent Marine Water Quality Data|Recent River Water Quality Data',
    enSubLabels);
  await page.click('.sub-tab[data-sub="beach"]');
  await page.waitForTimeout(4500);
  const enBeachRows = await page.evaluate(() =>
    [...document.querySelectorAll('#legend-body .legend-row')].map((r) => {
      const sw = r.querySelector('.legend-swatch');
      return { color: sw ? sw.style.background : '', label: r.innerText.replace(/\s+/g, ' ').trim() };
    }));
  check('英文模式泳灘圖例仍為官方 5 項色碼',
    enBeachRows.length === 5 &&
      JSON.stringify(enBeachRows.map((r) => norm(r.color))) === JSON.stringify(PALETTE),
    enBeachRows.map((r) => r.label).join(' | '));

  const enMarks = await readBeachMarks(page);
  const enNoDist = enMarks.filter((m) => !EN_DISTRICTS.some((d) => m.tip.indexOf(d) >= 0));
  check('切換語言後泳灘 Tooltip 改用英文地區（無殘留中文）',
    enMarks.length > 0 && enNoDist.length === 0,
    `n=${enMarks.length} 未轉英文=${enNoDist.slice(0, 3).map((m) => m.beach + ' → ' + m.tip).join(' , ') || 'none'}`);

  await page.click('.tab[data-tab="air"]');
  await page.waitForTimeout(2500);
  const storedLang = await page.evaluate(() => localStorage.getItem('hk-env-map-lang'));
  check('語言偏好已存入 localStorage', storedLang === 'en', `hk-env-map-lang=${storedLang}`);

  // 切回中文
  await page.click('#lang-btn');
  await page.waitForTimeout(5000);

  // ---- 9. 緩存（重新載入應命中快取）----
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(12000);
  const reloadLog = consoleMsgs.join('\n');
  check('重新載入後命中 24 小時快取', /來自 24 小時快取/.test(reloadLog), '');

  // ---- 10. 響應式（手機視圖）----
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(2500);
  const mobile = await page.evaluate(() => {
    const bn = document.querySelector('.bottom-nav');
    const topTabs = document.querySelector('.topbar .tabs');
    const legend = document.querySelector('#legend');
    const bnRect = bn ? bn.getBoundingClientRect() : null;
    const lgRect = legend ? legend.getBoundingClientRect() : null;
    return {
      bottomVisible: bn ? getComputedStyle(bn).display !== 'none' : false,
      topHidden: topTabs ? getComputedStyle(topTabs).display === 'none' : false,
      legendCollapsed: legend.classList.contains('collapsed'),
      legendAboveNav: !!(bnRect && lgRect) && lgRect.bottom <= bnRect.top + 1,
      legendVisible: !!(lgRect && lgRect.height > 0 && lgRect.top < window.innerHeight),
      legendBottom: lgRect ? Math.round(lgRect.bottom) : null,
      navTop: bnRect ? Math.round(bnRect.top) : null
    };
  });
  check('手機版顯示底部導航欄', mobile.bottomVisible, '');
  check('手機版隱藏頂部 Tab', mobile.topHidden, '');
  check('手機版圖例預設折疊', mobile.legendCollapsed, '');
  check('手機版圖例顯示在底部導航欄之上', mobile.legendVisible && mobile.legendAboveNav,
    `legendBottom=${mobile.legendBottom} navTop=${mobile.navTop}`);

  /* 手機版子分頁列改為對齊底部導覽的「水質數據」，箭嘴改朝下指向它 */
  await page.click('#bottom-nav .tab[data-tab="water"]');
  await page.waitForTimeout(3000);
  const geoM = await readSubTabGeo(page);
  /* 390px 這種窄螢幕上，三個子分頁（約 371px）本身已佔滿可用寬度，
     硬要對齊「水質數據」的 x=90 就會超出畫面，因此允許夾住後貼齊左緣 ——
     此時改由箭嘴維繫「子分頁隸屬於誰」的線索。要擋的是「既沒對齊、
     又不是夾住後的位置」這種說不出理由的漂移。 */
  const mAligned = !!geoM && Math.abs(geoM.navLeft - geoM.anchorLeft) <= 2;
  const mClampedFlush = !!geoM && geoM.navLeft <= 12;
  check('手機版子分頁列對齊「水質數據」；寬度不足時貼齊左緣且不超出畫面',
    (mAligned || mClampedFlush) && !!geoM && !geoM.overflowsViewport,
    `navLeft=${geoM && geoM.navLeft} anchorLeft=${geoM && geoM.anchorLeft} aligned=${mAligned} clamped=${mClampedFlush} overflow=${geoM && geoM.overflowsViewport}`);
  check('手機版子分頁箭嘴向下指向「水質數據」按鈕',
    !!geoM && Math.abs(geoM.caretCenter - geoM.anchorCenter) <= 2
      && Math.abs(geoM.caretTip - geoM.refEdge) <= 3,
    `caret=${geoM && geoM.caretCenter} anchor=${geoM && geoM.anchorCenter} tip=${geoM && geoM.caretTip} ref=${geoM && geoM.refEdge}`);
  check('手機版子分頁列不超出視窗，且三個子分頁無需橫向捲動',
    !!geoM && !geoM.overflowsViewport && !geoM.chipsScroll,
    `left=${geoM && geoM.navLeft} right=${geoM && geoM.navRight} vw=${geoM && geoM.vw} scroll=${geoM && geoM.chipsScroll}`);

  /* 較寬的手機／小平板（仍走底部導覽）有足夠空間，此時必須真的對齊 ——
     否則上面的「允許貼齊左緣」會讓這條規則形同虛設。 */
  await page.setViewportSize({ width: 600, height: 844 });
  await page.waitForTimeout(1200);
  const geoW = await readSubTabGeo(page);
  check('寬螢幕手機（600px）子分頁列確實對齊「水質數據」',
    !!geoW && Math.abs(geoW.navLeft - geoW.anchorLeft) <= 2,
    `navLeft=${geoW && geoW.navLeft} anchorLeft=${geoW && geoW.anchorLeft} vw=${geoW && geoW.vw}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);

  await page.screenshot({ path: path.join(OUT, 'mobile.png') });

  // ---- 11. 無嚴重錯誤 ----
  const fatal = pageErrors.filter((e) => !/ResizeObserver/.test(e));
  check('沒有未捕捉的 JS 錯誤', fatal.length === 0, fatal.slice(0, 3).join(' | '));

  // 只計非 API 資源的失敗；政府 API 的暫時性失敗會由應用程式自動重試
  const failedReq = consoleMsgs.filter((l) =>
    l.startsWith('[reqfail]') && !/portal\.csdi\.gov\.hk|dashboard\.data\.gov\.hk/.test(l));
  check('沒有失敗的靜態資源請求', failedReq.length === 0, failedReq.slice(0, 4).join(' | '));

  const apiRetries = consoleMsgs.filter((l) =>
    l.startsWith('[reqfail]') && /portal\.csdi\.gov\.hk|dashboard\.data\.gov\.hk/.test(l)).length;
  console.log(`ℹ️  政府 API 暫時性失敗（已自動重試）：${apiRetries} 次`);

  // ---- 截圖 ----
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: path.join(OUT, 'desktop.png') });

  // 各 Tab 截圖
  for (const id of ['water', 'recycle', 'noise', 'cnp']) {
    await page.click(`.tab[data-tab="${id}"]`);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(OUT, `tab-${id}.png`) });
  }

  console.log('\n===== 主控台紀錄摘要 =====');
  consoleMsgs.filter((l) => /效能|空氣|錯誤/.test(l)).forEach((l) => console.log(l));

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n===== 結果：${results.length - failed.length}/${results.length} 通過 =====`);
  if (failed.length) {
    console.log('失敗項目：');
    failed.forEach((f) => console.log('  - ' + f.name + (f.detail ? ' :: ' + f.detail : '')));
    process.exit(1);
  }
})().catch((e) => { console.error('驗證腳本錯誤：', e); process.exit(2); });
