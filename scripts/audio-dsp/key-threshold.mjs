// Pick the key confidence threshold on the dev half and report it on the
// held-out half.   node key-threshold.mjs <rowsA.json> <rowsB.json>
// (rows come from beatport-eval.mjs --out). A = dev (it was also the half the v3
// weights were fitted on, so its confidences are a little optimistic); B = held out.
// Bar for showing a key: exact >= 60% AND MIREX >= 70% over the tracks shown.
import { readFileSync } from 'node:fs';
import { relation } from '../../core/audio/dsp/key.mjs';

const [fa, fb] = process.argv.slice(2);
const load = f => JSON.parse(readFileSync(f, 'utf8')).filter(r => r.refCamelot && r.dsp?.camelot);
const A = load(fa), B = load(fb);
const score = r => {
  if (r.dsp.camelot === r.refCamelot) return [1, 1];
  const rel = relation(r.dsp.camelot, r.refCamelot);
  return [0, /fifth/.test(rel ?? '') ? 0.5 : rel === 'relative' ? 0.3 : rel === 'parallel' ? 0.2 : 0];
};
export function at(rows, t) {
  const s = rows.filter(r => (r.dsp.keyConf ?? 0) >= t);
  let e = 0, m = 0; for (const r of s) { const [a, b] = score(r); e += a; m += b; }
  return { n: s.length, cov: s.length / rows.length, exact: s.length ? e / s.length : 0, mirex: s.length ? m / s.length : 0 };
}
const pct = x => `${(100 * x).toFixed(1)}%`;
console.log('thr   | dev A: n  cov   exact  mirex | held-out B: n  cov   exact  mirex');
let pick = null;
for (let t = 0; t <= 0.95; t += 0.05) {
  const a = at(A, t), b = at(B, t);
  const clears = a.exact >= 0.6 && a.mirex >= 0.7;
  if (clears && !pick) pick = t;
  console.log(`${t.toFixed(2)}  | ${String(a.n).padStart(4)} ${pct(a.cov).padStart(6)} ${pct(a.exact).padStart(6)} ${pct(a.mirex).padStart(6)} | ${String(b.n).padStart(4)} ${pct(b.cov).padStart(6)} ${pct(b.exact).padStart(6)} ${pct(b.mirex).padStart(6)} ${clears ? ' <- dev clears' : ''}`);
}
console.log(pick == null ? 'no threshold clears the bar on the dev half' : `lowest dev-clearing threshold: ${pick.toFixed(2)}`);
