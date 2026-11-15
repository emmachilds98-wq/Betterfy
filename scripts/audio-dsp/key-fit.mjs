// Reproduce key.mjs v2's numbers on the Beatport EDM Key Dataset (Faraldo et
// al., Zenodo 1101082, CC BY-SA 4.0): the dev/held-out split, the PROFILES.edm
// fit, and exact/MIREX accuracy on each half through combineKey (as records do).
//
//   node scripts/audio-dsp/key-fit.mjs <dataset dir> <cache dir>
//
// <dataset dir> holds the unzipped audio/ and keys/ folders. Each track's
// middle 30 s is decoded by ffmpeg (on PATH) once into <cache dir>; the first
// 20 s of that are the two 10 s windows a record gets (as beatport-eval.mjs).
// Split: FNV-1a hash of the track id, even = dev (fit and tuning), odd = held out.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromagram, key, toCamelot, relation, CAMELOT } from '../../core/audio/dsp/key.mjs';
import { combineKey } from '../../core/audio/dsp/combine.mjs';

const SR = 16000;
const [ds, cache] = process.argv.slice(2);
if (!ds || !cache) { console.error('usage: key-fit.mjs <dataset dir> <cache dir>'); process.exit(1); }
mkdirSync(cache, { recursive: true });
const idOf = f => basename(f, extname(f)).split(' ')[0];
const walk = d => readdirSync(d, { withFileTypes: true }).filter(e => !e.name.startsWith('.') && e.name !== '__MACOSX')
  .flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
const parse = s => { const m = /^\s*([A-G])([#b]?)\s+(major|minor)\s*$/i.exec(String(s ?? '')); return m ? toCamelot(m[1].toUpperCase() + m[2], m[3].toLowerCase()) : null; };
const hash = s => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; };

const keyFiles = new Map(walk(join(ds, 'keys')).filter(f => f.endsWith('.txt')).map(f => [idOf(f), f]));
const tracks = [];
for (const f of walk(join(ds, 'audio')).filter(f => f.endsWith('.mp3')).sort()) {
  const id = idOf(f), kf = keyFiles.get(id), cam = kf ? parse(readFileSync(kf, 'utf8').split('\n')[0]) : null;
  if (!cam) continue;                                   // ambiguous, multiple or missing keys
  const dst = join(cache, id + '.f32');
  if (!existsSync(dst)) {
    const r = spawnSync('ffmpeg', ['-v', 'quiet', '-i', f, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 64 << 20 });
    if (r.status !== 0 || !r.stdout?.length) continue;
    const s = new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.byteLength));
    if (s.length < 30 * SR) continue;
    const t0 = Math.floor(s.length / 2 - 15 * SR);
    writeFileSync(dst, Buffer.from(s.slice(t0, t0 + 20 * SR).buffer));
  }
  tracks.push({ id, cam, dev: hash(id) % 2 === 0 });
}
const load = id => { const b = readFileSync(join(cache, id + '.f32')); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

// Fit: mean tonic-aligned chroma per mode over the dev half (v1 peak weighting; see chromagram()).
const acc = { major: new Float64Array(12), minor: new Float64Array(12) }, cnt = { major: 0, minor: 0 };
for (const t of tracks.filter(t => t.dev)) {
  const { chroma } = chromagram(load(t.id), { weighting: 'height' });
  const sum = chroma.reduce((a, x) => a + x, 0); if (!(sum > 0)) continue;
  const K = CAMELOT[t.cam];
  for (let i = 0; i < 12; i++) acc[K.mode][i] += chroma[(i + K.pc) % 12] / sum;
  cnt[K.mode]++;
}
const fmt = a => '[' + Array.from(a, x => (x).toFixed(4)).join(', ') + ']';
console.log(`fitted (dev: ${cnt.major} major, ${cnt.minor} minor)\n  EDM_MAJOR ${fmt(acc.major.map(x => x / cnt.major))}\n  EDM_MINOR ${fmt(acc.minor.map(x => x / cnt.minor))}`);

// Evaluate the shipped key() on each half.
for (const dev of [true, false]) {
  const k = { n: 0, exact: 0, mirex: 0, parallel: 0 }, bands = {};
  for (const t of tracks.filter(t => t.dev === dev)) {
    const s = load(t.id);
    const c = combineKey([s.subarray(0, 10 * SR), s.subarray(10 * SR)].map(w => key(w)));
    if (!c) continue;
    k.n++;
    const rel = c.camelot === t.cam ? 'same' : relation(c.camelot, t.cam);
    k.mirex += { same: 1, 'fifth-up': 0.5, 'fifth-down': 0.5, relative: 0.3, parallel: 0.2 }[rel] ?? 0;
    if (rel === 'same') k.exact++; if (rel === 'parallel') k.parallel++;
    const b = c.keyConf >= 0.6 ? 'high' : c.keyConf >= 0.3 ? 'mid' : 'low';
    (bands[b] ??= { n: 0, exact: 0 }).n++; if (rel === 'same') bands[b].exact++;
  }
  const p = (a, b) => `${(100 * a / b).toFixed(1)}%`;
  console.log(`${dev ? 'dev     ' : 'held-out'} n=${k.n} exact ${p(k.exact, k.n)} MIREX ${p(k.mirex, k.n)} parallel ${k.parallel} | ` +
    ['high', 'mid', 'low'].filter(b => bands[b]).map(b => `${b} ${p(bands[b].exact, bands[b].n)} of ${bands[b].n}`).join(', '));
}
