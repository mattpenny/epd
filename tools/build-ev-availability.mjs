/**
 * Build a compact, same-origin snapshot of the EPD EV-charger real-time
 * availability data.
 *
 * WHY THIS EXISTS
 * The official file (ev-charger.epd.gov.hk/.../evca_ver_1_0.json, ~3.8 MB) sends
 * NO Access-Control-Allow-Origin for any Origin value and answers preflight with
 * 405, so a static web page cannot fetch it directly — verified exhaustively.
 * This script performs the fetch outside the browser (Node, or a GitHub Action)
 * and writes a reduced file the page CAN read from its own origin.
 *
 * The output is keyed by coordinates, because the availability file's own
 * identifiers (carParkId: "PIS-00489" / "EPD_0485" / "990075") do not match the
 * CSDI dataset at all. Coordinates match 988/988 within 1 metre.
 *
 * The coordinate key format MUST match evCoordKey() in index.html.
 *
 * Usage:  node tools/build-ev-availability.mjs
 * Output: data/ev-availability.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data');
const OUT = path.join(OUT_DIR, 'ev-availability.json');

const SRC = 'https://ev-charger.epd.gov.hk/resource/ev_charger_avail/evca_ver_1_0.json';

/* must mirror evCoordKey() in index.html */
const coordKey = (lat, lng) => Number(lat).toFixed(5) + ',' + Number(lng).toFixed(5);

console.log('fetching', SRC);
const res = await fetch(SRC);
if (!res.ok) {
  console.error('upstream returned HTTP', res.status);
  process.exit(1);
}
const raw = await res.json();
const rows = Array.isArray(raw.data) ? raw.data : [];
console.log(`upstream records: ${rows.length}`);

/* Keep only what the popup shows, keyed by coordinate. The coordinate is also
   retained in the value so the client can verify a match rather than trust it. */
const byCoord = {};
let withNumber = 0;
for (const r of rows) {
  if (!r || !r.location) continue;
  const lat = Number(r.location.lat);
  const lng = Number(r.location.lng);
  if (!isFinite(lat) || !isFinite(lng)) continue;

  const total = (r.numOfCharger == null) ? null : Number(r.numOfCharger);
  const avail = (r.availableCharger == null) ? null : Number(r.availableCharger);
  if (avail != null) withNumber++;

  /* 官方只為部分位置提供實時數字；其餘 availableCharger 為 null，
     客戶端必須分辨「官方未提供」與「0 個可用」。 */
  byCoord[coordKey(lat, lng)] = {
    lat, lng,
    name: r.carParkEName || null,
    total,
    available: avail,
    updated: r.lastUpdateDate || null
  };
}

const out = {
  source: SRC,
  generatedAt: new Date().toISOString(),
  upstreamLastUpdate: raw.lastUpdateDate || null,
  note: 'Stationary charger counts plus official real-time availability. '
      + 'available === null means the official file publishes no live figure for that site.',
  count: Object.keys(byCoord).length,
  withAvailability: withNumber,
  byCoord
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));

const mb = (fs.statSync(OUT).size / 1048576).toFixed(2);
console.log(`wrote data/ev-availability.json  sites=${out.count}  withAvailability=${withNumber}  size=${mb}MB`);
console.log(`upstream lastUpdateDate: ${out.upstreamLastUpdate}`);
