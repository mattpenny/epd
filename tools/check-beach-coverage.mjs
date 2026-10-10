/**
 * Which beaches exist in the current grading layer but have no historical
 * samples in the window the app queries? Those legitimately render an empty
 * popup; anything else would indicate a silent fetch failure.
 *
 * Usage: node tools/check-beach-coverage.mjs
 */
const HIST = 'https://portal.csdi.gov.hk/server/rest/services/common/epd_rcd_1631502008200_88073/MapServer/0/query';
const GRADE = 'https://portal.csdi.gov.hk/server/rest/services/common/epd_rcd_1631501467099_56497/MapServer/0/query';

const getJson = async (url, tries = 6) => {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      const t = await r.text();
      if (t.trim().startsWith('{')) return JSON.parse(t);
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 300 * (i + 1)));
  }
  throw new Error('flaky: ' + url.slice(0, 80));
};

const nowYear = new Date().getFullYear();
const years = [];
for (let y = nowYear; y > nowYear - 10; y--) years.push(y);
const where = years.map((y) => `Sampling_Date__DD_MM_YYYY_ LIKE '%/${y}'`).join(' OR ');

const hist = await getJson(`${HIST}?where=${encodeURIComponent(where)}&outFields=Beach_Name&returnGeometry=false&returnDistinctValues=true&f=json`);
const histNames = hist.features.map((f) => String(f.attributes.Beach_Name).trim());

const grade = await getJson(`${GRADE}?where=1%3D1&outFields=Beach&returnGeometry=false&f=json`);
const gradeNames = grade.features.map((f) => String(f.attributes.Beach).trim());

console.log(`window years          : ${years[years.length - 1]}–${years[0]}`);
console.log(`historical beaches    : ${histNames.length}`);
console.log(`grading layer beaches : ${gradeNames.length}`);

const missing = gradeNames.filter((n) => !histNames.includes(n));
const extra = histNames.filter((n) => !gradeNames.includes(n));
console.log(`\nin grading but NO history (${missing.length}) — popup legitimately empty:`);
missing.forEach((m) => console.log('  - ' + m));
console.log(`\nin history but not in grading (${extra.length}) — not shown on this layer:`);
extra.forEach((m) => console.log('  - ' + m));

/* confirm each missing beach really has zero rows in the window */
console.log('\nrow counts for the missing beaches:');
for (const name of missing) {
  const w = `Beach_Name = '${name.replace(/'/g, "''")}' AND (${where})`;
  const c = await getJson(`${HIST}?where=${encodeURIComponent(w)}&returnCountOnly=true&f=json`);
  console.log(`  ${name.padEnd(34)} count=${c.count}`);
}
