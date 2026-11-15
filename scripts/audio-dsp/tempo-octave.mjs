// Tempo octave errors on the Beatport EDM Key Dataset (Faraldo et al., Zenodo
// 1101082, CC BY-SA 4.0): where tempo.mjs + combineTempo land on half or
// double the labelled BPM, and what the cheap fixes do about it.
//
//   node scripts/audio-dsp/tempo-octave.mjs <dataset dir> <cache dir> [--out file]
//
// <dataset dir> holds the unzipped audio/ and meta/ folders (original_metadata.zip
// unzips to meta/). Same windows as beatport-eval.mjs and key-fit.mjs: the
// middle 30 s, its first two 10 s, decoded at 16 kHz by ffmpeg once into
// <cache dir> (the same files key-fit.mjs and skey-eval.mjs write).
//
// Scored as beatport-eval.mjs: within ±1 BPM of Beatport's BPM, overall and at
// confidence ≥0.3 (the bar the page shows tempo at); octave = within 4% of ×2
// or ×½. Rows:
//   shipped            measureWindows' tempo, as a record gets it
//   +genre (oracle)    the octave settled by ontology/tempo.mjs resolveOctave
//                      with Beatport's own genre: the most a genre/sound-ID prior
//                      could give (the page has the sound ID's genres instead)
//   +genre, all        the same, also on readings not flagged octave-ambiguous
//                      (×2 and ×½ both offered)
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempo } from '../../core/audio/dsp/tempo.mjs';
import { combineTempo } from '../../core/audio/dsp/combine.mjs';
import { resolveOctave } from '../../core/ontology/tempo.mjs';

const SR = 16000;

/** Beatport's genre → the ontology slug whose tempo range stands in for it (null: tempo says nothing). */
const BEATPORT_GENRE = {
  'Electronica / Downtempo': null, 'Hard Dance': 'hard-house', 'Electro House': 'electro-house',
  'Minimal / Deep Tech': 'minimal-house', 'Techno': 'techno', 'Progressive House': 'progressive-house',
  'Tech House': 'tech-house', 'Hip-Hop / R&B': 'hip-hop', 'Breaks': 'breakbeat', 'Deep House': 'deep-house',
  'Trance': 'trance', 'Psy-Trance': 'psytrance', 'House': 'house', 'Dubstep': 'dubstep', 'Drum & Bass': 'drum-and-bass',
  "Funky / Groove / Jackin' House": 'house', 'Big Room': 'electro-house',
};
const [ds, cache] = process.argv.slice(2);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const out = arg('--out', null);
if (!ds || !cache) { console.error('usage: tempo-octave.mjs <dataset dir> <cache dir>'); process.exit(1); }
mkdirSync(cache, { recursive: true });

const idOf = f => basename(f, extname(f)).split(' ')[0];
const walk = d => readdirSync(d, { withFileTypes: true }).filter(e => !e.name.startsWith('.') && e.name !== '__MACOSX')
  .flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
function cached(f, id) {
  const dst = join(cache, id + '.f32');
  if (!existsSync(dst)) {
    const r = spawnSync('ffmpeg', ['-v', 'quiet', '-i', f, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 64 << 20 });
    if (r.status !== 0 || !r.stdout?.length) return null;
    const s = new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.byteLength));
    if (s.length < 30 * SR) return null;
    const t0 = Math.floor(s.length / 2 - 15 * SR);
    writeFileSync(dst, Buffer.from(s.slice(t0, t0 + 20 * SR).buffer));
  }
  if (!statSync(dst).size) return null;
  const b = readFileSync(dst);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

const metas = new Map(walk(join(ds, 'meta')).filter(f => f.endsWith('.json')).map(f => [idOf(f), f]));
const rows = [];
for (const f of walk(join(ds, 'audio')).filter(f => f.endsWith('.mp3')).sort()) {
  const id = idOf(f), mf = metas.get(id);
  if (!mf) continue;
  let meta; try { meta = JSON.parse(readFileSync(mf, 'utf8').replace(/:\s*nan\b/gi, ': null')); } catch { continue; }
  const ref = Number(meta?.bpm) || null;
  if (!ref) continue;
  const s = cached(f, id);
  if (!s) continue;
  const ws = [s.subarray(0, 10 * SR), s.subarray(10 * SR)].map(w => tempo(w));
  rows.push({ id, ref, genre: meta.genres?.[0]?.name ?? null, ws, c: combineTempo(ws) });
}

const ok = (a, b) => Math.abs(a - b) <= 1;
const w4 = (a, b) => Math.abs(a - b) / b <= 0.04;
const octave = (a, b) => !w4(a, b) && [2, 0.5].some(k => w4(a, b * k));
function score(name, pick) {
  const s = { n: 0, exact: 0, octave: 0, nc: 0, exactC: 0, octaveC: 0 };
  for (const r of rows) {
    const a = pick(r); if (!a) continue;
    s.n++; if (ok(a.bpm, r.ref)) s.exact++; if (octave(a.bpm, r.ref)) s.octave++;
    if (a.conf >= 0.3) { s.nc++; if (ok(a.bpm, r.ref)) s.exactC++; if (octave(a.bpm, r.ref)) s.octaveC++; }
  }
  const p = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '–';
  console.log(`${name.padEnd(22)} n=${s.n} ±1 BPM ${p(s.exact, s.n)} octave ${s.octave} | conf ≥0.3: n=${s.nc} ±1 BPM ${p(s.exactC, s.nc)} octave ${s.octaveC}`);
  return s;
}
const shipped = r => r.c && { bpm: r.c.bpm, conf: r.c.bpmConf };
const byGenre = (all) => r => {
  if (!r.c) return null;
  const slug = BEATPORT_GENRE[r.genre];
  if (!slug) return shipped(r);
  if (r.c.octaveAmbiguous && r.c.bpmAlt) return { bpm: resolveOctave(r.c.bpm, r.c.bpmAlt, [[slug, 1]]).bpm, conf: r.c.bpmConf };
  if (!all) return shipped(r);
  let b = r.c.bpm;
  for (const alt of [r.c.bpm * 2, r.c.bpm / 2]) b = resolveOctave(b, alt, [[slug, 1]]).bpm;
  return { bpm: b, conf: r.c.bpmConf };
};

console.log(`tracks with a Beatport BPM: ${rows.length}`);
score('shipped', shipped);
score('+genre (oracle)', byGenre(false));
score('+genre, all (oracle)', byGenre(true));

// The octave errors, by genre, and whether they were flagged.
const errs = rows.filter(r => r.c && octave(r.c.bpm, r.ref));
const g = new Map();
for (const r of errs) { const e = g.get(r.genre) ?? { n: 0, flagged: 0, up: 0 }; e.n++; if (r.c.octaveAmbiguous) e.flagged++; if (r.c.bpm > r.ref) e.up++; g.set(r.genre, e); }
console.log(`octave errors: ${errs.length}, flagged ${errs.filter(r => r.c.octaveAmbiguous).length}, at conf ≥0.3 ${errs.filter(r => r.c.bpmConf >= 0.3).length}`);
for (const [k, v] of [...g].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${String(k).padEnd(32)} ${v.n} (flagged ${v.flagged}, measured double ${v.up})`);
if (out) writeFileSync(out, JSON.stringify(rows));
