// Measure the DSP (WP-D1 tempo, WP-D2 key, combined per window as WP-D4 does)
// against a public, independently labelled set: the Beatport EDM Key Dataset
// (Faraldo et al., Zenodo record 1101082, CC BY-SA 4.0). 1,486 two-minute EDM
// previews with expert key annotations; each track's Beatport metadata gives
// its BPM.
//
// Why this and not Rekordbox: the owner has no Rekordbox library, and
// CLAUDE.md says the core can't lean on one anyway. This is the same number for
// everybody and can be re-run by anyone.
//
//   node scripts/audio-dsp/beatport-eval.mjs <mp3 dir> <meta dir> <keys dir> [--limit n] [--out file]
//
// Download the dataset yourself (audio.zip, original_metadata.zip, keys.zip);
// nothing from it is committed. Audio is decoded by ffmpeg (on PATH) to 16 kHz
// mono float32 in memory and dropped after each track.
//
// Per track it mimics a Deezer preview: the middle 30 s of the clip, cut into
// the two 10 s windows WP-A1 downloads (start, centre), run through
// core/audio/dsp/combine.mjs measureWindows() — exactly the dsp a record gets.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { measureWindows } from '../../core/audio/dsp/combine.mjs';
import { toCamelot, relation } from '../../core/audio/dsp/key.mjs';

const SR = 16000;
const [mp3Dir, metaDir, keysDir] = process.argv.slice(2);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const limit = Number(arg('--limit', Infinity));
const out = arg('--out', null);
if (!mp3Dir || !metaDir || !keysDir) { console.error('usage: beatport-eval.mjs <mp3 dir> <meta dir> <keys dir>'); process.exit(1); }

const idOf = f => basename(f, extname(f)).split(' ')[0];
const byId = dir => new Map(readdirSync(dir).filter(f => !f.startsWith('.')).map(f => [idOf(f), join(dir, f)]));
const metas = byId(metaDir), keys = byId(keysDir);

/** "D minor", "Eb major", "F# minor" -> { tonic, mode }, or null (ambiguous / multiple / none). */
export function parseKey(s) {
  const m = /^\s*([A-G])([#b]?)\s+(major|minor)\s*$/i.exec(String(s ?? ''));
  if (!m) return null;
  return { tonic: m[1].toUpperCase() + m[2], mode: m[3].toLowerCase() };
}

function decode(path) {
  const r = spawnSync('ffmpeg', ['-v', 'quiet', '-i', path, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 64 << 20 });
  if (r.status !== 0 || !r.stdout?.length) return null;
  const b = r.stdout;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

const rows = [];
const files = readdirSync(mp3Dir).filter(f => f.endsWith('.mp3')).sort().slice(0, limit);
let skipped = { noMeta: 0, noBpm: 0, keyAmbiguous: 0, decode: 0, short: 0 };
for (const f of files) {
  const id = idOf(f);
  let meta = null;
  // The metadata (and so the BPM) exists for about half the tracks; key
  // annotations for all of them. A track without metadata still scores key.
  try { meta = JSON.parse(readFileSync(metas.get(id), 'utf8').replace(/:\s*nan\b/gi, ': null')); } catch { meta = null; }
  if (!meta) skipped.noMeta++;
  const samples = decode(join(mp3Dir, f));
  if (!samples) { skipped.decode++; continue; }
  if (samples.length < 30 * SR) { skipped.short++; continue; }
  const t0 = Math.floor(samples.length / 2 - 15 * SR);
  const w1 = samples.slice(t0, t0 + 10 * SR), w2 = samples.slice(t0 + 10 * SR, t0 + 20 * SR);
  const dsp = measureWindows([w1, w2]);
  const refBpm = Number(meta?.bpm) || null;
  const refKey = keys.has(id) ? parseKey(readFileSync(keys.get(id), 'utf8').split('\n')[0]) : null;
  if (meta && !refBpm) skipped.noBpm++;
  if (!refKey) skipped.keyAmbiguous++;
  rows.push({ id, refBpm, refCamelot: refKey ? toCamelot(refKey.tonic, refKey.mode) : null, dsp });
}

// --- tempo ---
const tr = rows.filter(r => r.refBpm && r.dsp?.bpm);
const ok = (a, b) => Math.abs(a - b) <= 1;
const within4 = (a, b) => Math.abs(a - b) / b <= 0.04;
const octave = (a, b) => [2, 0.5].some(k => within4(a, b * k));
const t = { n: tr.length, noAnswer: rows.filter(r => r.refBpm && !r.dsp?.bpm).length, exact: 0, w4: 0, octave: 0, octaveFlagged: 0, altHit: 0 };
const tByConf = new Map();
for (const r of tr) {
  const e = ok(r.dsp.bpm, r.refBpm), o = !within4(r.dsp.bpm, r.refBpm) && octave(r.dsp.bpm, r.refBpm);
  if (e) t.exact++; if (within4(r.dsp.bpm, r.refBpm)) t.w4++;
  if (o) { t.octave++; if (r.dsp.octaveAmbiguous) t.octaveFlagged++; }
  if (!e && r.dsp.bpmAlt != null && ok(r.dsp.bpmAlt, r.refBpm)) t.altHit++;
  const band = r.dsp.bpmConf >= 0.6 ? 'high' : r.dsp.bpmConf >= 0.3 ? 'mid' : 'low';
  const b = tByConf.get(band) ?? { n: 0, exact: 0 }; b.n++; if (e) b.exact++; tByConf.set(band, b);
}

// --- key ---
const kr = rows.filter(r => r.refCamelot && r.dsp?.camelot);
const k = { n: kr.length, noAnswer: rows.filter(r => r.refCamelot && !r.dsp?.camelot).length, exact: 0, fifth: 0, relative: 0, parallel: 0, other: 0, mirex: 0 };
const kByConf = new Map();
for (const r of kr) {
  const rel = r.dsp.camelot === r.refCamelot ? 'same' : relation(r.dsp.camelot, r.refCamelot);
  if (rel === 'same') { k.exact++; k.mirex += 1; }
  else if (/fifth/.test(rel ?? '')) { k.fifth++; k.mirex += 0.5; }
  else if (rel === 'relative') { k.relative++; k.mirex += 0.3; }
  else if (rel === 'parallel') { k.parallel++; k.mirex += 0.2; }
  else k.other++;
  const band = r.dsp.keyConf >= 0.6 ? 'high' : r.dsp.keyConf >= 0.3 ? 'mid' : 'low';
  const b = kByConf.get(band) ?? { n: 0, exact: 0 }; b.n++; if (rel === 'same') b.exact++; kByConf.set(band, b);
}

const pc = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '–';
const ci = (a, n) => { if (!n) return ''; const p = a / n, h = 1.96 * Math.sqrt(p * (1 - p) / n); return ` (±${(100 * h).toFixed(1)})`; };
console.log(`Tracks: ${files.length} read, ${rows.length} measured. Skipped: ${JSON.stringify(skipped)}`);
console.log(`TEMPO  n=${t.n}  within ±1 BPM ${pc(t.exact, t.n)}${ci(t.exact, t.n)}  within 4% ${pc(t.w4, t.n)}  octave errors ${t.octave} (${t.octaveFlagged} flagged)  right tempo as the alternate ${t.altHit}  no answer ${t.noAnswer}`);
console.log(`       by confidence: ${[...tByConf].map(([b, v]) => `${b} ${pc(v.exact, v.n)} of ${v.n}`).join(', ')}`);
console.log(`KEY    n=${k.n}  exact ${pc(k.exact, k.n)}${ci(k.exact, k.n)}  MIREX ${pc(k.mirex, k.n)}  fifth ${k.fifth}  relative ${k.relative}  parallel ${k.parallel}  other ${k.other}  no answer ${k.noAnswer}`);
console.log(`       by confidence: ${[...kByConf].map(([b, v]) => `${b} ${pc(v.exact, v.n)} of ${v.n}`).join(', ')}`);
if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
