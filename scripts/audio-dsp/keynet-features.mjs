// Features for training and measuring the learned key model (key v4).
//
//   node scripts/audio-dsp/keynet-features.mjs <mp3 dir> <keys dir> <out dir> [--shard i/n] [--train-only]
//
// --train-only puts every track in training (used for the GiantSteps Key
// dataset, 604 tracks, no overlap with Beatport EDM Key by track id).
//
// Beatport EDM Key Dataset (Zenodo 1101082, CC BY-SA 4.0), split with
// beatport-eval.mjs's halfOf: half B is held out and gets exactly what the
// page hears and what beatport-eval measures (the middle 30 s, as two 10 s
// windows). Half A (training) gets every 20 s stretch of the 2-minute clip at
// a 10 s hop, as extra examples of the same track.
//
// Per track: <id>.f32 (segments × frames × KS_BINS, from keyspec.mjs) and a
// line in meta-<shard>.jsonl with the label (class = mode·12 + tonic pc,
// major 0–11, minor 12–23) and, for comparison and the ensemble, the shipped
// DSP key's answer, confidence and its 24 probabilities on the middle 30 s.
import { readdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { keySpec, KS_BINS } from '../../core/audio/dsp/keyspec.mjs';
import { chromagram, rankKeys, toCamelot, CAMELOT, pitchClass } from '../../core/audio/dsp/key.mjs';
import { measureWindows } from '../../core/audio/dsp/combine.mjs';

// Same as beatport-eval.mjs (importing it would run it).
function parseKey(s) {
  const m = /^\s*([A-G])([#b]?)\s+(major|minor)\s*$/i.exec(String(s ?? ''));
  return m ? { tonic: m[1].toUpperCase() + m[2], mode: m[3].toLowerCase() } : null;
}
function halfOf(id, seed = 1) {
  let h = 2166136261 ^ seed;
  for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) % 2 === 0 ? 'A' : 'B';
}

const SR = 16000;
const [mp3Dir, keysDir, outDir] = process.argv.slice(2);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const [si, sn] = String(arg('--shard', '0/1')).split('/').map(Number);
mkdirSync(outDir, { recursive: true });
const metaFile = join(outDir, `meta-${si}.jsonl`);
const done = new Set(existsSync(metaFile) ? readFileSync(metaFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).id) : []);

const idOf = f => basename(f, extname(f)).split(' ')[0];
const keys = new Map(readdirSync(keysDir).filter(f => !f.startsWith('.')).map(f => [idOf(f), join(keysDir, f)]));
const classOf = camelot => { const k = CAMELOT[camelot]; return (k.mode === 'minor' ? 12 : 0) + pitchClass(k.tonic); };

function decode(path) {
  const r = spawnSync('ffmpeg', ['-v', 'quiet', '-i', path, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 64 << 20 });
  if (r.status !== 0 || !r.stdout?.length) return null;
  const b = r.stdout;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

const files = readdirSync(mp3Dir).filter(f => f.endsWith('.mp3')).sort().filter((_, i) => i % sn === si);
let n = 0;
for (const f of files) {
  const id = idOf(f);
  if (done.has(id)) continue;
  const ref = keys.has(id) ? parseKey(readFileSync(keys.get(id), 'utf8').split('\n')[0]) : null;
  if (!ref) continue;
  const x = decode(join(mp3Dir, f));
  if (!x || x.length < 30 * SR) continue;
  // --train-only: a second labelled set (GiantSteps Key) used only for training.
  const half = process.argv.includes('--train-only') ? 'A' : halfOf(id);
  const t0 = Math.floor(x.length / 2 - 15 * SR);
  const mid = [x.slice(t0, t0 + 10 * SR), x.slice(t0 + 10 * SR, t0 + 20 * SR)];
  const starts = half === 'B' ? [t0] : [];
  if (half === 'A') for (let s = 0; s + 20 * SR <= x.length; s += 10 * SR) starts.push(s);
  const specs = [];
  for (const s of starts) {
    const sp = keySpec([x.slice(s, s + 10 * SR), x.slice(s + 10 * SR, s + 20 * SR)]);
    if (sp) specs.push(sp);
  }
  if (!specs.length) continue;
  const frames = Math.min(...specs.map(s => s.frames));
  const buf = new Float32Array(specs.length * frames * KS_BINS);
  specs.forEach((s, i) => buf.set(s.data.subarray(0, frames * KS_BINS), i * frames * KS_BINS));
  writeFileSync(join(outDir, `${id}.f32`), Buffer.from(buf.buffer));
  const probs = new Array(24).fill(0);
  for (const r of rankKeys(chromagram(mid).chroma)) probs[classOf(r.camelot)] = +r.p.toFixed(5);
  const d = measureWindows(mid);
  const label = classOf(toCamelot(ref.tonic, ref.mode));
  appendFileSync(metaFile, JSON.stringify({ id, half, label, segs: specs.length, frames,
    dsp: d?.camelot ? { cls: classOf(d.camelot), conf: d.keyConf } : null, probs }) + '\n');
  if (++n % 50 === 0) console.error(`shard ${si}: ${n}`);
}
console.error(`shard ${si}: done ${n}`);
