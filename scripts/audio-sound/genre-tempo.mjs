// Tempo per genre, and what a genre-aware octave would change
// (docs/SOUND-ENGINE-PLAN.md §2.3).
//
// Beatport EDM Key Dataset (Zenodo 1101082): each track's Beatport metadata
// names its genre and BPM. Per track this hears the middle 30 s as the two
// 10 s windows the page downloads, through core/audio/dsp/combine.mjs
// measureWindows() (exactly the dsp a record gets), then asks:
//
//   strict     within ±1 BPM of Beatport's number (Beatport writes about half of
//              its drum & bass at 85-90, so this marks a right 174 as wrong);
//   family     within ±1 BPM of Beatport's number, or of twice or half of it;
//   in range   the reading lands inside the genre's DJ working range
//              (core/ontology/tempo.mjs TEMPO): what a listener expects to see;
//   folded     the same after a genre-aware fold: when the reading is outside
//              the range and ×2 or ×½ lands inside it, take that. This is what
//              the page could do once a track's genre is known (it is in a
//              drum & bass playlist, or identify() names it), and only then.
//
//   node scripts/audio-sound/genre-tempo.mjs <mp3 dir> <meta dir> [--out rows.json]
//
// Nothing from the dataset is committed; ffmpeg must be on PATH.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { measureWindows } from '../../core/audio/dsp/combine.mjs';
import { tempoRangeOf } from '../../core/ontology/tempo.mjs';

const SR = 16000;
const [mp3Dir, metaDir] = process.argv.slice(2);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
if (!mp3Dir || !metaDir) { console.error('usage: genre-tempo.mjs <mp3 dir> <meta dir> [--out rows.json]'); process.exit(1); }

// Beatport genre -> the ontology slug whose DJ range applies.
const SLUG = {
  'Drum & Bass': 'drum-and-bass', 'Dubstep': 'dubstep', 'Hip-Hop / R&B': 'hip-hop', 'Breaks': 'breakbeat',
  'Electronica / Downtempo': 'downtempo', 'House': 'house', 'Techno': 'techno', 'Deep House': 'deep-house',
  'Tech House': 'tech-house', 'Progressive House': 'progressive-house', 'Electro House': 'electro-house',
  'Trance': 'trance', 'Psy-Trance': 'psytrance', 'Hard Dance': 'hard-house', 'Minimal / Deep Tech': 'minimal-techno',
};

const idOf = f => basename(f, extname(f)).split(' ')[0];
const metas = new Map(readdirSync(metaDir).filter(f => !f.startsWith('.')).map(f => [idOf(f), join(metaDir, f)]));
function decode(path) {
  const r = spawnSync('ffmpeg', ['-v', 'quiet', '-i', path, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 64 << 20 });
  if (r.status !== 0 || !r.stdout?.length) return null;
  const b = r.stdout; return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

const rows = [];
for (const f of readdirSync(mp3Dir).filter(f => f.endsWith('.mp3')).sort()) {
  let meta; try { meta = JSON.parse(readFileSync(metas.get(idOf(f)), 'utf8').replace(/:\s*nan\b/gi, ': null')); } catch { continue; }
  const genre = meta?.genres?.[0]?.name, ref = Number(meta?.bpm) || null;
  if (!genre || !ref || !SLUG[genre]) continue;
  const s = decode(join(mp3Dir, f));
  if (!s || s.length < 30 * SR) continue;
  const t0 = Math.floor(s.length / 2 - 15 * SR);
  const dsp = measureWindows([s.slice(t0, t0 + 10 * SR), s.slice(t0 + 10 * SR, t0 + 20 * SR)]);
  if (!dsp?.bpm) { rows.push({ id: idOf(f), genre, ref, bpm: null }); continue; }
  rows.push({ id: idOf(f), genre, ref, bpm: dsp.bpm, conf: dsp.bpmConf, amb: dsp.octaveAmbiguous, alt: dsp.bpmAlt ?? null });
}
if (arg('--out')) writeFileSync(arg('--out'), JSON.stringify(rows));

const near = (a, b) => Math.abs(a - b) <= 1;
const inRange = (bpm, [lo, hi]) => bpm >= lo - 1 && bpm <= hi + 1;
function fold(bpm, range) {
  if (!range || inRange(bpm, range)) return bpm;
  for (const k of [2, 0.5]) if (inRange(bpm * k, range)) return bpm * k;
  return bpm;
}
const pc = (a, n) => (n ? `${((100 * a) / n).toFixed(0)}%` : '–');
const by = new Map();
for (const r of rows) {
  const g = by.get(r.genre) ?? { n: 0, none: 0, strict: 0, family: 0, inRange: 0, folded: 0, foldedFamily: 0, flagged: 0, refHalf: 0 };
  g.n++;
  const range = tempoRangeOf(SLUG[r.genre]);
  if (range && r.ref < range[0] - 1) g.refHalf++;
  if (!r.bpm) { g.none++; by.set(r.genre, g); continue; }
  if (near(r.bpm, r.ref)) g.strict++;
  const fam = [1, 2, 0.5].some(k => near(r.bpm, r.ref * k));
  if (fam) g.family++;
  if (r.amb) g.flagged++;
  if (range && inRange(r.bpm, range)) g.inRange++;
  const fb = fold(r.bpm, range);
  if (range && inRange(fb, range)) g.folded++;
  if ([1, 2, 0.5].some(k => near(fb, r.ref * k))) g.foldedFamily++;
  by.set(r.genre, g);
}
console.log(`${rows.length} tracks with a Beatport genre and BPM, middle 30 s as two 10 s windows`);
console.log('genre | n | Beatport writes it below the DJ range | strict ±1 | right up to ×2 | DSP flagged unsure | in DJ range: as read -> genre-folded | right up to ×2 after fold');
const T = { n: 0, none: 0, strict: 0, family: 0, inRange: 0, folded: 0, foldedFamily: 0, flagged: 0, refHalf: 0 };
for (const [genre, g] of [...by].sort((a, b) => b[1].n - a[1].n)) {
  for (const k of Object.keys(T)) T[k] += g[k];
  console.log(`${genre} | ${g.n} | ${g.refHalf} | ${pc(g.strict, g.n)} | ${pc(g.family, g.n)} | ${g.flagged} | ${pc(g.inRange, g.n)} -> ${pc(g.folded, g.n)} | ${pc(g.foldedFamily, g.n)}`);
}
console.log(`all | ${T.n} | ${T.refHalf} | ${pc(T.strict, T.n)} | ${pc(T.family, T.n)} | ${T.flagged} | ${pc(T.inRange, T.n)} -> ${pc(T.folded, T.n)} | ${pc(T.foldedFamily, T.n)}`);
