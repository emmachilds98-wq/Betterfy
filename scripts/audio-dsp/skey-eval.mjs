// Measure S-KEY (core/audio/dsp/skey.mjs) on the Beatport EDM Key Dataset
// (Faraldo et al., Zenodo 1101082, CC BY-SA 4.0), on the same dev/held-out
// split and the same two 10 s windows as key-fit.mjs (key.mjs v2's numbers),
// and next to key v2 on the same tracks.
//
//   node scripts/audio-dsp/skey-eval.mjs <dataset dir> <cache dir> --ort <onnxruntime-node dir> --model <skey.onnx> [--rows file.jsonl]
//
// --rows keeps one line per measured track and is resumed from: a second run
// measures only the tracks not in it yet, then reports on all of them.
//
// <dataset dir> holds the unzipped audio/ and keys/ folders, as key-fit.mjs.
// onnxruntime-node is not a dependency of the repo: install it anywhere
// (`npm install onnxruntime-node` in a scratch folder) and pass that folder,
// or its node_modules/onnxruntime-node. The model is docs/models/skey-1.onnx
// or the file from huggingface.co/aaatmy/skey-onnx (the same bytes).
//
// Each track's middle 30 s is decoded by ffmpeg (on PATH) once per rate into
// <cache dir>: 16 kHz (the file key-fit.mjs writes, shared) and 22.05 kHz
// (S-KEY's own rate). The first 20 s are the two windows a record gets.
// Rows:
//   v2              key.mjs v2 per window, combined by combineKey (as a record)
//   skey-22k        S-KEY on each window decoded at 22.05 kHz, probabilities averaged
//   skey-16k→22k    S-KEY on the 16 kHz windows the page already has, resampled
//                   by skey.mjs resample() (no second decode)
//   ensemble        log p(S-KEY 16k→22k) + β · v2's correlation score, β fitted on dev
import { readdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, basename, extname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromagram, key, scoreKeys, toCamelot, relation } from '../../core/audio/dsp/key.mjs';
import { combineKey } from '../../core/audio/dsp/combine.mjs';
import { createSkey, skeyWindows, skeyAnswer, resample, SKEY_CAMELOT, SKEY_SAMPLE_RATE } from '../../core/audio/dsp/skey.mjs';

const SR = 16000;
const [ds, cache] = process.argv.slice(2);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const ortDir = arg('--ort'), modelPath = arg('--model'), rowsFile = arg('--rows', null);
const limit = Number(arg('--limit', Infinity));
if (!ds || !cache || !ortDir || !modelPath) { console.error('usage: skey-eval.mjs <dataset dir> <cache dir> --ort <dir> --model <skey.onnx>'); process.exit(1); }
mkdirSync(cache, { recursive: true });

const require = createRequire(import.meta.url);
const ortPath = existsSync(join(ortDir, 'node_modules', 'onnxruntime-node')) ? join(ortDir, 'node_modules', 'onnxruntime-node') : ortDir;
const ort = require(resolve(ortPath));

const idOf = f => basename(f, extname(f)).split(' ')[0];
const walk = d => readdirSync(d, { withFileTypes: true }).filter(e => !e.name.startsWith('.') && e.name !== '__MACOSX')
  .flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
const parse = s => { const m = /^\s*([A-G])([#b]?)\s+(major|minor)\s*$/i.exec(String(s ?? '')); return m ? toCamelot(m[1].toUpperCase() + m[2], m[3].toLowerCase()) : null; };
const hash = s => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; };

/** Middle 30 s → first 20 s of it at `rate`, cached as f32 (same cut as key-fit.mjs). */
function cached(f, id, rate, suffix) {
  const dst = join(cache, id + suffix + '.f32');
  if (!existsSync(dst)) {
    const r = spawnSync('ffmpeg', ['-v', 'quiet', '-i', f, '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'], { maxBuffer: 64 << 20 });
    if (r.status !== 0 || !r.stdout?.length) return null;
    const s = new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.byteLength));
    if (s.length < 30 * rate) return null;
    const t0 = Math.floor(s.length / 2 - 15 * rate);
    writeFileSync(dst, Buffer.from(s.slice(t0, t0 + 20 * rate).buffer));
  }
  if (!statSync(dst).size) return null;
  const b = readFileSync(dst);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

const keyFiles = new Map(walk(join(ds, 'keys')).filter(f => f.endsWith('.txt')).map(f => [idOf(f), f]));
const audioFiles = walk(join(ds, 'audio')).filter(f => f.endsWith('.mp3')).sort().slice(0, limit);
const skey = await createSkey({ ort, modelUrl: modelPath, sessionOptions: { executionProviders: ['cpu'], intraOpNumThreads: 1 } });

const rows = rowsFile && existsSync(rowsFile) ? readFileSync(rowsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const done = new Set(rows.map(r => r.id));
let n = 0;
for (const f of audioFiles) {
  const id = idOf(f), kf = keyFiles.get(id), cam = kf ? parse(readFileSync(kf, 'utf8').split('\n')[0]) : null;
  if (!cam || done.has(id)) continue;                   // ambiguous, multiple or missing keys; or measured already
  const s16 = cached(f, id, SR, ''), s22 = cached(f, id, SKEY_SAMPLE_RATE, '.22k');
  if (!s16 || !s22) continue;
  const w16 = [s16.subarray(0, 10 * SR), s16.subarray(10 * SR)];
  const w22 = [s22.subarray(0, 10 * SKEY_SAMPLE_RATE), s22.subarray(10 * SKEY_SAMPLE_RATE)];
  const v2 = combineKey(w16.map(w => key(w)));
  // v2's 24 correlation scores, mean over the two windows, in SKEY_LABELS order (for the ensemble).
  const v2s = new Float64Array(24);
  for (const w of w16) {
    const byCam = new Map(scoreKeys(chromagram(w).chroma).map(r => [r.camelot, r.score]));
    SKEY_CAMELOT.forEach((c, i) => { v2s[i] += (byCam.get(c) ?? 0) / w16.length; });
  }
  const sk22 = await skeyWindows(skey, w22);
  const sk16 = await skeyWindows(skey, w16.map(w => resample(w, SR, SKEY_SAMPLE_RATE)));
  const row = { id, cam, dev: hash(id) % 2 === 0,
    v2: v2 && { camelot: v2.camelot, conf: v2.keyConf },
    sk22: sk22 && { camelot: sk22.camelot, conf: sk22.keyConf, agree: sk22.keyAgree, p: Array.from(sk22.scores, x => +x.toFixed(5)) },
    sk16: sk16 && { camelot: sk16.camelot, conf: sk16.keyConf, agree: sk16.keyAgree, p: Array.from(sk16.scores, x => +x.toFixed(5)) },
    v2s: Array.from(v2s, x => +x.toFixed(5)) };
  rows.push(row);
  if (rowsFile) appendFileSync(rowsFile, JSON.stringify(row) + '\n');
  if (++n % 100 === 0) console.error(`${n} tracks`);
}

// ---- scoring ----
const W = { same: 1, 'fifth-up': 0.5, 'fifth-down': 0.5, relative: 0.3, parallel: 0.2 };
const THRESH = [0, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
function score(list, pick) {
  const k = { n: 0, exact: 0, mirex: 0, fifth: 0, relative: 0, parallel: 0, other: 0 };
  const at = THRESH.map(t => ({ t, n: 0, exact: 0, mirex: 0 }));
  for (const r of list) {
    const a = pick(r); if (!a) continue;
    const rel = a.camelot === r.cam ? 'same' : relation(a.camelot, r.cam);
    k.n++; k.mirex += W[rel] ?? 0;
    if (rel === 'same') k.exact++; else if (/fifth/.test(rel ?? '')) k.fifth++; else if (rel === 'relative') k.relative++; else if (rel === 'parallel') k.parallel++; else k.other++;
    for (const b of at) if (a.conf >= b.t) { b.n++; b.mirex += W[rel] ?? 0; if (rel === 'same') b.exact++; }
  }
  return { ...k, at };
}
const p = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '–';
const ci = (a, n) => { if (!n) return ''; const q = a / n; return `±${(196 * Math.sqrt(q * (1 - q) / n)).toFixed(1)}`; };
function report(name, s, total) {
  console.log(`  ${name.padEnd(14)} n=${s.n}  exact ${p(s.exact, s.n)} (${ci(s.exact, s.n)})  MIREX ${p(s.mirex, s.n)}  fifth ${s.fifth} relative ${s.relative} parallel ${s.parallel} other ${s.other}`);
  console.log(`  ${''.padEnd(14)} by confidence ≥t (exact / MIREX / coverage): ` +
    s.at.filter(b => b.t > 0).map(b => `${b.t}: ${p(b.exact, b.n)} / ${p(b.mirex, b.n)} / ${p(b.n, total)}`).join('  '));
}

// Ensemble: argmax of log p_skey + β · v2score; β fitted on dev (maximise MIREX), then looked at on held-out.
const ens = (r, beta) => {
  if (!r.sk16) return r.v2;
  let best = -Infinity, bi = 0;
  for (let i = 0; i < 24; i++) { const v = Math.log(Math.max(r.sk16.p[i], 1e-9)) + beta * r.v2s[i]; if (v > best) { best = v; bi = i; } }
  // Confidence: S-KEY's probability renormalised under the ensemble's tilt.
  let z = 0; for (let i = 0; i < 24; i++) z += Math.max(r.sk16.p[i], 1e-9) * Math.exp(beta * r.v2s[i]);
  return { camelot: SKEY_CAMELOT[bi], conf: Math.max(r.sk16.p[bi], 1e-9) * Math.exp(beta * r.v2s[bi]) / z };
};
const dev = rows.filter(r => r.dev), held = rows.filter(r => !r.dev);
let beta = 0, bestM = -1;
for (let b = 0; b <= 20; b += 0.5) { const m = score(dev, r => ens(r, b)).mirex; if (m > bestM) { bestM = m; beta = b; } }

for (const [name, list] of [['dev', dev], ['held-out', held]]) {
  console.log(`${name} (n=${list.length})`);
  report('v2', score(list, r => r.v2 && { camelot: r.v2.camelot, conf: r.v2.conf }), list.length);
  report('skey-22k', score(list, r => r.sk22), list.length);
  report('skey-16k→22k', score(list, r => r.sk16), list.length);
  report(`ensemble β=${beta}`, score(list, r => ens(r, beta)), list.length);
  const agree = list.filter(r => r.sk16 && r.v2 && r.sk16.camelot === r.v2.camelot);
  const ag = score(agree, r => r.sk16);
  console.log(`  S-KEY and v2 agree on ${p(agree.length, list.length)}: exact ${p(ag.exact, ag.n)} MIREX ${p(ag.mirex, ag.n)}`);
  const wa = score(list.filter(r => r.sk16?.agree), r => r.sk16);
  console.log(`  S-KEY's two windows agree on ${p(wa.n, list.length)}: exact ${p(wa.exact, wa.n)} MIREX ${p(wa.mirex, wa.n)}`);
}
