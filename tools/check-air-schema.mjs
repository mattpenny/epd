#!/usr/bin/env node
/**
 * Schema / matching guard for the air-quality layer.
 *
 * WHY THIS EXISTS: in Oct 2026 the CSDI AQMN dataset silently changed its
 * field names (Facility_Name/Address/Types_of_... -> NameEN/NameTC/
 * AddressEN/AddressTC/AqmsTypeEN/AqmsTypeTC). The page kept loading
 * "successfully" — it just showed "—" for every station name, matched
 * zero AQHI values, and drew every marker grey. Nothing errored.
 *
 * This check fails loudly instead:
 *   1. the WFS feed must return features with usable name fields
 *      (new schema OR the legacy one — the page supports both);
 *   2. every station's English name, minus the "Air Quality Monitoring
 *      Station" suffix, must have a matching entry in the official
 *      AQHI feed (dashboard.data.gov.hk), because that join is what
 *      colours the markers and fills the popups.
 *
 * Run by .github/workflows/data-schema-check.yml (weekly + manual).
 * A non-zero exit fails the workflow, which is what notifies the owner.
 */

const WFS_URL =
  'https://portal.csdi.gov.hk/server/services/common/' +
  'epd_rcd_1629267205214_40635/MapServer/WFSServer?service=WFS' +
  '&version=2.0.0&request=GetFeature&typeNames=csdi%3AAQMN' +
  '&outputFormat=GeoJSON&srsName=EPSG%3A4326&count=20000';
const AQHI_URL = 'https://dashboard.data.gov.hk/api/aqhi-individual?format=json';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'epd-schema-check' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function stationKey(nameEn) {
  return String(nameEn || '').replace(/\s*Air Quality Monitoring Station\s*$/i, '').trim();
}

const geo = await getJson(WFS_URL);
const features = geo && geo.features;
if (!Array.isArray(features) || features.length === 0) {
  console.error('FAIL: AQMN WFS returned no features');
  process.exit(1);
}

const aqhi = await getJson(AQHI_URL);
if (!Array.isArray(aqhi) || aqhi.length === 0) {
  console.error('FAIL: AQHI feed returned no stations');
  process.exit(1);
}
const aqhiStations = new Set(aqhi.map((a) => String(a.station).trim()));

let named = 0;
const unmatched = [];
for (const f of features) {
  const p = (f && f.properties) || {};
  const nameEn = p.NameEN || p.Facility_Name || '';
  const nameTc = p.NameTC || p['設施名稱'] || '';
  if (nameEn || nameTc) named++;
  const key = stationKey(nameEn);
  if (!key || !aqhiStations.has(key)) unmatched.push(nameEn || '(no English name)');
}

console.log(`Stations: ${features.length}, with names: ${named}, AQHI entries: ${aqhi.length}`);
if (named < features.length) {
  console.error(`FAIL: ${features.length - named} station(s) have no name field in either schema — the dataset schema may have changed again.`);
  process.exit(1);
}
if (unmatched.length) {
  console.error(`FAIL: ${unmatched.length} station(s) do not match any AQHI station:`, unmatched);
  process.exit(1);
}
console.log('OK: all stations named and matched to AQHI.');
