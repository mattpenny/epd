/* 穩定截圖：等圖塊全部載入完成後再截圖 */
const { chromium } = require('C:/Users/sfcheang/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core');
const path = require('path');
const CHROME = 'C:/Users/sfcheang/AppData/Local/ms-playwright/chromium-1246/chrome-win64/chrome.exe';
const OUT = 'C:/EPD/.verify';

async function waitTiles(page, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = await page.evaluate(() => {
      const mapEl = document.querySelector('#map');
      const r = mapEl.getBoundingClientRect();
      const tiles = [...document.querySelectorAll('img.leaflet-tile')].filter((el) => {
        const tr = el.getBoundingClientRect();
        return tr.bottom > r.top && tr.top < r.bottom && tr.right > r.left && tr.left < r.right;
      });
      const pending = tiles.filter((t) => !(t.complete && t.naturalWidth > 0)).length;
      return { total: tiles.length, pending };
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
  await page.goto('http://127.0.0.1:8777/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.leaflet-container');
  await page.waitForTimeout(4000);

  const shots = [
    { tab: 'air', theme: 'light', file: 'shot-air-light.png' },
    { tab: 'beach', theme: 'light', file: 'shot-beach-light.png' },
    { tab: 'recycle', theme: 'light', file: 'shot-recycle-light.png' },
    { tab: 'noise', theme: 'light', file: 'shot-noise-light.png' },
    { tab: 'air', theme: 'dark', file: 'shot-air-dark.png' }
  ];

  let theme = 'light';
  for (const s of shots) {
    if (s.theme !== theme) {
      await page.click('#theme-btn');
      theme = s.theme;
      await page.waitForTimeout(1500);
    }
    await page.click(`.tab[data-tab="${s.tab}"]`);
    await page.waitForTimeout(2500);
    const st = await waitTiles(page, 20000);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, s.file) });
    console.log('shot', s.file, st ? `${st.total} tiles, 0 pending` : 'timeout');
  }

  // 噪音 + L10 影像子圖層
  await page.click('.tab[data-tab="noise"]');
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    const cb = document.querySelector('input[data-sub="l10"]');
    if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(9000);
  await page.screenshot({ path: path.join(OUT, 'shot-noise-l10.png') });
  console.log('shot noise+l10');

  // 手機版（切回淺色以檢視一般情況）
  if (theme !== 'light') { await page.click('#theme-btn'); theme = 'light'; await page.waitForTimeout(1500); }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(4000);
  await waitTiles(page, 15000);
  await page.click('.bottom-nav .tab[data-tab="air"]');
  await page.waitForTimeout(2500);
  await waitTiles(page, 15000);
  await page.screenshot({ path: path.join(OUT, 'shot-mobile-air.png') });
  console.log('shot mobile');

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
