// DSP + S-KEY key ensemble: fit the blend on the dev half (A), report on the
// held-out half (B).
//   node fit-ensemble.mjs <mp3 dir> <keys dir> <skeyA.json> <skeyB.json> [--cache dspprobs.json]
// skey*.json come from skey-probs.py. Per track it runs the shipped DSP on the
// same middle 30 s as beatport-eval.mjs (rankKeys over the pooled chroma, plus
// key()'s own confidence), then blends log-probabilities:
//     score(k) = w * ln pDSP(k) + (1 - w) * ln pSKEY(k)
// and sweeps a confidence threshold on the blend's top probability.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromagram, rankKeys, key as keyOf, toCamelot, relation, pitchClass } from '../../core/audio/dsp/key.mjs';

// Same split and key parsing as beatport-eval.mjs (importing it would run it).
function halfOf(id, seed = 1) {
  let h = 2166136261 ^ seed;
  for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) % 2 === 0 ? 'A' : 'B';
}
function parseKey(s) {
  const m = /^\s*([A-G])([#b]?)\s+(major|minor)\s*$/i.exec(String(s ?? ''));
  return m ? { tonic: m[1].toUpperCase() + m[2], mode: m[3].toLowerCase() } : null;
}

const [mp3Dir, keysDir, fa, fb] = process.argv.slice(2);
const cacheFile = process.argv.includes('--cache') ? process.argv[process.argv.indexOf('--cache') + 1] : null;
const SR = 16000;
const idOf = f => basename(f, extname(f)).split(' ')[0];
const keyFiles = new Map(readdirSync(keysDir).filter(f => !f.startsWith('.')).map(f => [idOf(f), join(keysDir, f)]));

function decode(path) {
  const r = spawnSync('ffmpeg', ['-v', 'quiet', '-i', path, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 64 << 20 });
  if (r.status !== 0 || !r.stdout?.length) return null;
  const b = r.stdout;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

let dsp = cacheFile && existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : null;
if (!dsp) {
  dsp = {};
  for (const f of readdirSync(mp3Dir).filter(f => f.endsWith('.mp3')).sort()) {
    const id = idOf(f);
    const s = decode(join(mp3Dir, f));
    if (!s || s.length < 30 * SR) continue;
    const t0 = Math.floor(s.length / 2 - 15 * SR);
    const parts = [s.slice(t0, t0 + 10 * SR), s.slice(t0 + 10 * SR, t0 + 20 * SR)];
    const k = keyOf(parts);
    const p = {};
    for (const r of rankKeys(chromagram(parts).chroma)) p[r.camelot] = r.p;
    dsp[id] = { conf: k.confidence, p };
  }
  if (cacheFile) writeFileSync(cacheFile, JSON.stringify(dsp));
}

const camOf = name => { const [t, m] = name.split(' '); return toCamelot(pitchClass(t), m.toLowerCase()); };
const skey = {};
for (const f of [fa, fb]) for (const [id, v] of Object.entries(JSON.parse(readFileSync(f, 'utf8')))) {
  const mx = Math.max(...v.logits); const e = v.logits.map(x => Math.exp(x - mx)); const z = e.reduce((a, b) => a + b, 0);
  skey[id] = Object.fromEntries(v.names.map((n, i) => [camOf(n), e[i] / z]));
}

const rows = { A: [], B: [] };
for (const id of Object.keys(dsp)) {
  if (!skey[id] || !keyFiles.has(id)) continue;
  const ref = parseKey(readFileSync(keyFiles.get(id), 'utf8').split('\n')[0]);
  if (!ref) continue;
  rows[halfOf(id)].push({ id, ref: toCamelot(ref.tonic, ref.mode), d: dsp[id], s: skey[id] });
}

function blend(r, w, T = 1) {
  const sc = {};
  let mx = -Infinity;
  for (const k of Object.keys(r.d.p)) { sc[k] = (w * Math.log(r.d.p[k] + 1e-9) + (1 - w) * Math.log(r.s[k] + 1e-9)) / T; mx = Math.max(mx, sc[k]); }
  let z = 0; for (const k in sc) { sc[k] = Math.exp(sc[k] - mx); z += sc[k]; }
  let best = null; for (const k in sc) { sc[k] /= z; if (!best || sc[k] > sc[best]) best = k; }
  return { cam: best, p: sc[best] };
}
const credit = (cam, ref) => {
  if (cam === ref) return [1, 1];
  const rel = relation(cam, ref);
  return [0, /fifth/.test(rel ?? '') ? 0.5 : rel === 'relative' ? 0.3 : rel === 'parallel' ? 0.2 : 0];
};
function stats(set, pick, conf, t) {
  let n = 0, e = 0, m = 0;
  for (const r of set) { const c = conf(r); if (c < t) continue; n++; const [a, b] = credit(pick(r), r.ref); e += a; m += b; }
  return { n, cov: n / set.length, exact: n ? e / n : 0, mirex: n ? m / n : 0 };
}
const pct = x => `${(100 * x).toFixed(1)}%`;
const line = (tag, a) => `${tag} n=${a.n} cov ${pct(a.cov)} exact ${pct(a.exact)} MIREX ${pct(a.mirex)}`;

console.log(`tracks with both: A ${rows.A.length}, B ${rows.B.length}`);
// Overall accuracy of each source and of a weight sweep, on dev A then B.
const dspPick = r => Object.entries(r.d.p).sort((a, b) => b[1] - a[1])[0][0];
const skPick = r => Object.entries(r.s).sort((a, b) => b[1] - a[1])[0][0];
for (const h of ['A', 'B']) {
  console.log(`-- ${h}${h === 'A' ? ' (dev)' : ' (held out)'}`);
  console.log(line('DSP    ', stats(rows[h], dspPick, r => 1, 0)));
  console.log(line('S-KEY  ', stats(rows[h], skPick, r => 1, 0)));
  for (const w of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) console.log(line(`blend w=${w}`, stats(rows[h], r => blend(r, w).cam, r => 1, 0)));
}
// Choose w on dev: best exact + MIREX.
let bestW = 0.5, bestS = -1;
for (let w = 0; w <= 1.0001; w += 0.05) {
  const a = stats(rows.A, r => blend(r, w).cam, r => 1, 0); const s = a.exact + a.mirex;
  if (s > bestS) { bestS = s; bestW = +w.toFixed(2); }
}
console.log(`dev-chosen w = ${bestW}`);
console.log('threshold sweep on the blend top probability (dev A | held-out B), also DSP-only conf for reference');
console.log('thr  | A cov exact mirex | B cov exact mirex || DSP conf: A cov exact mirex | B cov exact mirex');
for (let t = 0; t <= 0.95; t += 0.05) {
  const f = r => blend(r, bestW).p, p = r => blend(r, bestW).cam;
  const a = stats(rows.A, p, f, t), b = stats(rows.B, p, f, t);
  const da = stats(rows.A, dspPick, r => r.d.conf, t), db = stats(rows.B, dspPick, r => r.d.conf, t);
  console.log(`${t.toFixed(2)} | ${pct(a.cov)} ${pct(a.exact)} ${pct(a.mirex)} | ${pct(b.cov)} ${pct(b.exact)} ${pct(b.mirex)} || ${pct(da.cov)} ${pct(da.exact)} ${pct(da.mirex)} | ${pct(db.cov)} ${pct(db.exact)} ${pct(db.mirex)}`);
}

// Where the two sources agree on the key: how much of the set that is, and how right.
console.log('agreement (DSP pick == S-KEY pick), exact / MIREX over those tracks');
for (const h of ['A', 'B']) {
  const agree = rows[h].filter(r => dspPick(r) === skPick(r));
  console.log(line(`${h} agree`, stats(agree, dspPick, r => 1, 0)).replace(/cov [^ ]+ /, `cov ${pct(agree.length / (rows[h].length || 1))} `));
  const sureToo = agree.filter(r => r.d.conf >= 0.3);
  console.log(line(`${h} agree & DSP conf>=0.3`, stats(sureToo, dspPick, r => 1, 0)).replace(/cov [^ ]+ /, `cov ${pct(sureToo.length / (rows[h].length || 1))} `));
}
