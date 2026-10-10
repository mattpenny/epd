/**
 * Which beach-name filters return zero rows or fail intermittently?
 * Trailing spaces in the official beach names are a known trap.
 * Usage: node tools/check-beach-names.mjs
 */
const G = 'https://portal.csdi.gov.hk/server/rest/services/common/epd_rcd_1631501467099_56497/MapServer/0/query';
const H = 'https://portal.csdi.gov.hk/server/rest/services/common/epd_rcd_1631502008200_88073/MapServer/0/query';

const count = async (where, tries = 5) => {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${H}?where=${encodeURIComponent(where)}&returnCountOnly=true&f=json`);
      const t = await r.text();
      if (t.trim().startsWith('{')) return JSON.parse(t).count;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 300 * (i + 1)));
  }
  return 'FLAKY';
};

const g = await (await fetch(`${G}?where=1%3D1&outFields=Beach&returnGeometry=false&f=json`)).json();
const names = g.features.map((f) => f.attributes.Beach);

console.log('grading names with whitespace anomalies:');
let anomalies = 0;
names.forEach((n) => {
  if (n !== n.trim() || /\s{2,}/.test(n)) { anomalies++; console.log(`  [${n}] len=${n.length}`); }
});
console.log(`  (${anomalies} of ${names.length} names have leading/trailing/double spaces)`);

const yr = new Date().getFullYear();
const years = [];
for (let y = yr; y > yr - 10; y--) years.push(y);
const win = years.map((y) => `Sampling_Date__DD_MM_YYYY_ LIKE '%/${y}'`).join(' OR ');

console.log('\nquerying each beach name exactly as the app does:');
const bad = [];
for (const n of names) {
  const where = `Beach_Name = '${n.replace(/'/g, "''")}' AND (${win})`;
  const c = await count(where);
  if (c === 0 || c === 'FLAKY') bad.push({ name: n, count: c });
}
console.log(`  zero-or-flaky: ${bad.length}`);
bad.forEach((b) => console.log(`    [${b.name}] -> ${b.count}`));

/* retry the flaky/zero ones using the trimmed name to see if whitespace is the cause */
console.log('\nretrying the bad ones with a trimmed name:');
for (const b of bad) {
  const t = b.name.trim();
  const where = `Beach_Name = '${t.replace(/'/g, "''")}' AND (${win})`;
  console.log(`  [${b.name}] -> trimmed [${t}] count=${await count(where)}`);
}
