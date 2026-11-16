// Per-track features for the key/tempo experiments on the Beatport EDM Key
// Dataset (Faraldo et al., Zenodo 1101082, CC BY-SA 4.0). Feeds
// scripts/audio-dsp/keytempo-lab.mjs, which fits on half A and reports half B.
//
//   node scripts/audio-dsp/keytempo-features.mjs <dataset dir> <cache dir> <out.jsonl> [--shard i/n]
//
// <dataset dir> holds the unzipped audio/, keys/ and meta/ (original_metadata)
// folders. Each track's middle 30 s is decoded by ffmpeg once into <cache dir>
// (first 20 s kept: the two 10 s windows a record gets, as beatport-eval.mjs
// and key-fit.mjs cut them; the cache files are interchangeable with
// key-fit.mjs's). Nothing from the dataset is committed.
//
// Per track (one JSON line): id, half (beatport-eval.mjs halfOf), Camelot
// reference, Beatport BPM and genre, the shipped dsp (measureWindows), the
// shipped chroma, band chromas, a bass-note histogram, and per-window tempo
// candidates with the band autocorrelation values the octave experiments need.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromagram, toCamelot } from '../../core/audio/dsp/key.mjs';
import { tempo, bandAutocorrelations, FPS } from '../../core/audio/dsp/tempo.mjs';
import { measureWindows } from '../../core/audio/dsp/combine.mjs';
import { melFrames } from '../../core/audio/mel.mjs';

const SR = 16000;
const [ds, cache, outFile] = process.argv.slice(2);
if (!ds || !cache || !outFile) { console.error('usage: keytempo-features.mjs <dataset dir> <cache dir> <out.jsonl> [--shard i/n]'); process.exit(1); }
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const [shard, shards] = String(arg('--shard', '0/1')).split('/').map(Number);
mkdirSync(cache, { recursive: true });

export function halfOf(id, seed = 1) {   // same split as beatport-eval.mjs --half
  let h = 2166136261 ^ seed;
  for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) % 2 === 0 ? 'A' : 'B';
}
const idOf = f => basename(f, extname(f)).split(' ')[0];
const walk = d => existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter(e => !e.name.startsWith('.') && e.name !== '__MACOSX')
  .flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]) : [];
const parse = s => { const m = /^\s*([A-G])([#b]?)\s+(major|minor)\s*$/i.exec(String(s ?? '')); return m ? toCamelot(m[1].toUpperCase() + m[2], m[3].toLowerCase()) : null; };
const keyFiles = new Map(walk(join(ds, 'keys')).filter(f => f.endsWith('.txt')).map(f => [idOf(f), f]));
const metaFiles = new Map(walk(join(ds, 'meta')).filter(f => f.endsWith('.json')).map(f => [idOf(f), f]));

function load(id, mp3) {
  const dst = join(cache, id + '.f32');
  if (!existsSync(dst)) {
    const r = spawnSync('ffmpeg', ['-v', 'quiet', '-i', mp3, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 64 << 20 });
    if (r.status !== 0 || !r.stdout?.length) return null;
    const s = new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.byteLength));
    if (s.length < 30 * SR) return null;
    const t0 = Math.floor(s.length / 2 - 15 * SR);
    writeFileSync(dst, Buffer.from(s.slice(t0, t0 + 20 * SR).buffer));
  }
  const b = readFileSync(dst);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

const BANDS = [30, 120, 350, 1000, 2500, 5000];   // Hz edges of the band chromas
const r4 = x => Math.round(x * 1e4) / 1e4;
const arr = a => Array.from(a, r4);

function keyFeatures(windows) {
  const base = chromagram(windows);
  const wide = chromagram(windows, { fMin: 30, fMax: 5000, keepPeaks: true });
  const band = BANDS.slice(1).map(() => new Float64Array(12));
  const nFrames = wide.frames;
  // Bass note per frame: the pitch class of the heaviest peak under 250 Hz.
  const bassBest = new Map();
  const { semis, weights, frames } = wide.peaks;
  for (let i = 0; i < semis.length; i++) {
    const note = Math.round(semis[i]), d = semis[i] - note;
    if (Math.abs(d) > 0.4) continue;
    const w = weights[i] * Math.cos(Math.PI * d) ** 2, pc = (((note + 9) % 12) + 12) % 12;
    const hz = 440 * 2 ** (semis[i] / 12);
    const b = BANDS.findIndex((e, j) => j < BANDS.length - 1 && hz >= e && hz < BANDS[j + 1]);
    if (b >= 0) band[b][pc] += w;
    if (hz < 250) { const cur = bassBest.get(frames[i]); if (!cur || cur.w < w) bassBest.set(frames[i], { w, pc }); }
  }
  const bass = new Float64Array(12);
  for (const { pc } of bassBest.values()) bass[pc] += 1;
  const perWindow = windows.map(w => arr(chromagram(w).chroma));
  return { chroma: arr(base.chroma), gridness: r4(base.gridness), tonalWeight: r4(base.tonalWeight),
           band: band.map(arr), bass: arr(bass), bassFrames: bassBest.size, frames: nFrames, perWindow };
}

// Per window: the tempo answer with its candidates, plus each band group's
// onset autocorrelation up to 3 s in whole mel frames (188 values), for the
// octave experiments.
function tempoFeatures(w) {
  const t = tempo(w);
  const acfs = bandAutocorrelations(melFrames(w));
  if (!acfs) return { t, acf: null };
  const lagMax = Math.round(3 * FPS);
  return { t, acf: acfs.map(a => a ? arr(a.slice(0, lagMax + 1)) : null) };
}

const mp3s = walk(join(ds, 'audio')).filter(f => f.endsWith('.mp3')).sort();
let done = 0;
for (let i = shard; i < mp3s.length; i += shards) {
  const f = mp3s[i], id = idOf(f);
  const kf = keyFiles.get(id), cam = kf ? parse(readFileSync(kf, 'utf8').split('\n')[0]) : null;
  let meta = null;
  try { meta = JSON.parse(readFileSync(metaFiles.get(id), 'utf8').replace(/:\s*nan\b/gi, ': null')); } catch { meta = null; }
  const bpm = Number(meta?.bpm) || null;
  if (!cam && !bpm) continue;
  const s = load(id, f);
  if (!s) continue;
  const windows = [s.subarray(0, 10 * SR), s.subarray(10 * SR, 20 * SR)];
  const dsp = measureWindows(windows);
  const row = { id, half: halfOf(id), cam, bpm, genre: meta?.genres?.[0]?.name ?? null, dsp,
                key: keyFeatures(windows), tempo: windows.map(tempoFeatures) };
  appendFileSync(outFile, JSON.stringify(row) + '\n');
  if (++done % 50 === 0) console.error(`shard ${shard}: ${done}`);
}
console.error(`shard ${shard}: done ${done}`);
