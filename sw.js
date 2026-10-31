/* ==========================================================================
   香港環保數據地圖 — Service Worker
   策略：
   - App Shell（HTML / manifest / icons / CDN 資源）：cache-first
   - 地圖圖塊（政府矢量地形圖、CartoDB、地名標籤）：cache-first，上限 400 張
     （100 張要同時容納淺色底圖＋標籤、深色底圖＋參考層四組圖磚並不足夠，
     深色圖磚經常被逐出，令每次切換深色模式都要重新慢速下載，2026-10-31 提升至 400）
   - 空間數據 API（CSDI / DATA.GOV.HK）：network-first，24 小時離線備援
   - 同源 data/*.json 快照（EV 可用情況／水質歷史）：network-first
     （v2 時它們會落入 App Shell 的 cache-first，令 GitHub Actions 已
     更新的快照被舊快取卡住，頁面永遠看不到新數據 —— v3 修正此點）
   - version.json：不攔截，由頁面以 no-store 直接抓取作版本比對
   ========================================================================== */
'use strict';

const VERSION = 'hk-env-map-v3';
const SHELL_CACHE = VERSION + '-shell';
const TILE_CACHE = VERSION + '-tiles';
const DATA_CACHE = VERSION + '-data';

const TILE_CACHE_LIMIT = 400;      // 最近 400 張圖塊（四組底圖圖磚並存所需）
const DATA_TTL = 24 * 60 * 60 * 1000;

/* App Shell 資源 */
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './assets/big-waster-3d.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js'
];

/* 圖塊來源 */
function isTile(url) {
  return /mapapi\.geodata\.gov\.hk\/.*\/xyz\//.test(url) ||
    /services\.arcgisonline\.com\/.*\/MapServer\/tile\//.test(url) ||
    /basemaps\.cartocdn\.com\//.test(url);
}

/* 同源數據快照（data/ev-availability.json、data/wq-history.json） */
function isLocalData(url) {
  try {
    const u = new URL(url);
    return u.origin === self.location.origin && /\/data\/[^/]+\.json$/.test(u.pathname);
  } catch (e) { return false; }
}

/* 版本檔：絕不可快取，否則版本檢查永遠比對到舊版本 */
function isVersionFile(url) {
  try {
    const u = new URL(url);
    return u.origin === self.location.origin && u.pathname.endsWith('/version.json');
  } catch (e) { return false; }
}

/* 空間數據 API */
function isDataApi(url) {
  return /portal\.csdi\.gov\.hk\/(server\/services|server\/rest)\//.test(url) ||
    /dashboard\.data\.gov\.hk\/api\//.test(url);
}

/* ---------------- 安裝：預快取 App Shell ---------------- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    // 逐項加入，個別失敗不影響整體安裝
    await Promise.all(SHELL_ASSETS.map(async (u) => {
      try { await c.add(new Request(u, { mode: 'cors' })); }
      catch (e) { console.warn('[SW] 預快取失敗：', u, e); }
    }));
    self.skipWaiting();
  })());
});

/* ---------------- 啟用：清除舊版本 ---------------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.indexOf(VERSION) !== 0)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* ---------------- 圖塊：cache-first + 數量上限 ----------------
   注意：寫入快取與修剪必須在回應之後以背景方式進行。
   若在回應前 await cache.put() 再掃描 cache.keys()，70 個並行圖塊
   會互相拖慢（甚至看似卡住），因此改為 fire-and-forget。 */
let trimScheduled = false;

async function trimTiles(cache) {
  try {
    const keys = await cache.keys();
    if (keys.length <= TILE_CACHE_LIMIT) return;
    const excess = keys.length - TILE_CACHE_LIMIT;
    for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
  } catch (e) { /* 忽略 */ }
}

function scheduleTrim(cache) {
  if (trimScheduled) return;
  trimScheduled = true;
  setTimeout(() => {
    trimScheduled = false;
    trimTiles(cache);
  }, 3000);
}

async function handleTile(request) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res && (res.ok || res.type === 'opaque')) {
      // 背景寫入，不阻塞圖塊顯示
      cache.put(request, res.clone())
        .then(() => scheduleTrim(cache))
        .catch(() => {});
    }
    return res;
  } catch (e) {
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

/* ---------------- 空間數據：network-first + 24h 離線備援 ---------------- */
async function handleData(request) {
  const cache = await caches.open(DATA_CACHE);
  const metaKey = new Request(request.url + '#sw-cached-at');
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      // 直接存入回應（不讀取 body，避免拖慢），時間戳另存一筆小記錄
      cache.put(request, res.clone()).catch(() => {});
      cache.put(metaKey, new Response(String(Date.now()))).catch(() => {});
    }
    return res;
  } catch (e) {
    const hit = await cache.match(request);
    if (hit) {
      const meta = await cache.match(metaKey);
      const at = meta ? Number(await meta.text()) : 0;
      if (!at || Date.now() - at <= DATA_TTL) return hit;
    }
    return new Response(JSON.stringify({ error: 'offline', features: [] }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/* ---------------- 導航請求：離線時回傳 index.html ---------------- */
async function handleNavigate(request) {
  try {
    return await fetch(request);
  } catch (e) {
    const cache = await caches.open(SHELL_CACHE);
    const hit = await cache.match('./index.html') || await cache.match('./');
    if (hit) return hit;
    return new Response('<h1>離線</h1><p>請連接網絡後重試。</p>', {
      status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
}

/* ---------------- fetch 分派 ---------------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = req.url;

  if (isVersionFile(url)) return;   // 不攔截：讓頁面的 no-store 請求直達網絡
  if (isTile(url)) { event.respondWith(handleTile(req)); return; }
  if (isDataApi(url) || isLocalData(url)) { event.respondWith(handleData(req)); return; }
  if (req.mode === 'navigate') { event.respondWith(handleNavigate(req)); return; }

  // App Shell 其餘資源：cache-first
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && res.ok && new URL(url).origin !== undefined) {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    } catch (e) {
      return new Response('', { status: 504 });
    }
  })());
});

/* 讓頁面可要求立即更新 */
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
