// Compare core/audio/dsp/tempo.mjs with Rekordbox on the owner's own files.
//
// WP-D1 ships only with a measured number. Nothing shows or uses tempo.mjs's
// BPM (WP-D4 waits on this) until this script has run on the owner's library
// and the summary it prints is recorded in docs/AUDIO-ANALYSIS-PLAN.md §0.
// The synthetic tests prove the arithmetic, not the accuracy on real music.
//
// Usage (from the repo root, on the machine that has the music):
//
//   node scripts/audio-dsp/tempo-vs-rekordbox.mjs rekordbox.json "D:\Music" [options]
//
//   rekordbox.json   as written by `node rekordbox.mjs <collection.xml> --write`:
//                    { "<spotifyTrackId>": { bpm, key, camelot, match, rbName, rbArtist }, ... }
//   audio dir        searched recursively for mp3 m4a aac mp4 flac wav aif aiff ogg opus
//                    (decoded with ffmpeg, which must be on PATH) and .f32 (raw
//                    16 kHz mono float32 little-endian, read directly).
//
// Each file is paired with a rekordbox.json entry by, in order:
//   1. its base name being the Spotify track id ("4uLU6hMCjMI75M1A2tKUQC.mp3");
//   2. --map map.json, { "<path relative to the audio dir>": "<spotifyTrackId>" };
//   3. "Artist - Title" in the file name, or else the file's artist/title tags
//      (ffprobe), against the entry's rbArtist/rbName, normalised by norm.mjs.
//      Only a name that matches exactly one entry counts.
//
// Options:
//   --seconds N   analyse N seconds (default 30, the length of a Deezer
//                 preview, which is what the app will actually hear); 0 = whole file
//   --at middle|start|<sec>   where the excerpt starts (default middle)
//   --min 60 --max 200        tempo range passed to tempo()
//   --limit N     stop after N matched files
//   --out file.json  per-track numbers (ids, names, BPMs; never audio)
//
// Audio is decoded into memory for one analysis and dropped; nothing is
// written except --out. Rekordbox can itself be an octave off (its range
// setting decides 87 vs 174), so octave disagreements are counted apart from
// plain misses rather than blamed on either side.

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { tempo } from '../../core/audio/dsp/tempo.mjs';
import { SAMPLE_RATE } from '../../core/audio/mel.mjs';
import { norm } from '../../norm.mjs';

const { values: opt, positionals: [rbPath, audioDir] } = parseArgs({
  allowPositionals: true,
  options: {
    map: { type: 'string' }, seconds: { type: 'string', default: '30' }, at: { type: 'string', default: 'middle' },
    min: { type: 'string', default: '60' }, max: { type: 'string', default: '200' },
    limit: { type: 'string' }, out: { type: 'string' },
  },
});
if (!rbPath || !audioDir || !existsSync(rbPath) || !existsSync(audioDir)) {
  console.error('Usage: node scripts/audio-dsp/tempo-vs-rekordbox.mjs <rekordbox.json> <audio-dir> [--map map.json] [--seconds 30] [--at middle] [--out results.json]');
  process.exit(1);
}
const SECONDS = +opt.seconds, MIN = +opt.min, MAX = +opt.max, LIMIT = opt.limit ? +opt.limit : Infinity;

const AUDIO = new Set(['.mp3', '.m4a', '.aac', '.mp4', '.flac', '.wav', '.aif', '.aiff', '.ogg', '.opus', '.f32']);
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const hasFfprobe = spawnSync('ffprobe', ['-version']).status === 0;

/* ---------- reference ---------- */
const rb = JSON.parse(readFileSync(rbPath, 'utf8'));
const byName = new Map(); // norm(artist) | norm(title) -> [id]
for (const [id, e] of Object.entries(rb)) {
  if (!e?.bpm || !e.rbName) continue;
  const artists = String(e.rbArtist ?? '').split(/\s*(?:,|&|feat\.?|ft\.?|vs\.?)\s*/i);
  for (const a of new Set([e.rbArtist ?? '', artists[0]])) {
    const k = norm(a) + '|' + norm(e.rbName);
    byName.set(k, [...(byName.get(k) ?? []), id]);
  }
}
const uniqueByName = (artist, title) => {
  const ids = [...new Set(byName.get(norm(artist) + '|' + norm(title)) ?? [])];
  return ids.length === 1 ? ids[0] : null;
};
const map = opt.map ? JSON.parse(readFileSync(opt.map, 'utf8')) : {};

/* ---------- files ---------- */
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) yield* walk(p);
    else if (AUDIO.has(extname(name).toLowerCase())) yield p;
  }
}

function probe(file) {
  if (!hasFfprobe) return {};
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:format_tags=artist,title', '-of', 'json', file], { encoding: 'utf8' });
  if (r.status !== 0) return {};
  try {
    const f = JSON.parse(r.stdout).format ?? {};
    const tags = Object.fromEntries(Object.entries(f.tags ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { duration: f.duration ? +f.duration : null, artist: tags.artist, title: tags.title };
  } catch { return {}; }
}

function matchFile(file, info) {
  const stem = basename(file, extname(file));
  if (rb[stem]?.bpm) return { id: stem, how: 'id' };
  const rel = relative(audioDir, file).split('\\').join('/');
  const mapped = map[rel] ?? map[basename(file)];
  if (mapped && rb[mapped]?.bpm) return { id: mapped, how: 'map' };
  const dash = stem.match(/^(.+?)\s+-\s+(.+)$/);
  const fromName = dash && uniqueByName(dash[1], dash[2]);
  if (fromName) return { id: fromName, how: 'filename' };
  const fromTags = info.artist && info.title && uniqueByName(info.artist, info.title);
  if (fromTags) return { id: fromTags, how: 'tags' };
  return null;
}

function startOf(duration) {
  if (!SECONDS || !duration) return 0;
  if (opt.at === 'start') return 0;
  if (opt.at === 'middle') return Math.max(0, duration / 2 - SECONDS / 2);
  return Math.max(0, Math.min(+opt.at, duration - SECONDS));
}

/** 16 kHz mono Float32Array, or a reason string. */
function decode(file, info) {
  if (extname(file).toLowerCase() === '.f32') {
    const buf = readFileSync(file);
    const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
    const s0 = Math.round(startOf(all.length / SAMPLE_RATE) * SAMPLE_RATE);
    return Float32Array.from(SECONDS ? all.subarray(s0, s0 + SECONDS * SAMPLE_RATE) : all);
  }
  if (!hasFfmpeg) return 'no ffmpeg on PATH';
  const ss = startOf(info.duration);
  const args = ['-v', 'error', ...(ss ? ['-ss', ss.toFixed(2)] : []), ...(SECONDS ? ['-t', String(SECONDS)] : []),
    '-i', file, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1'];
  const r = spawnSync('ffmpeg', args, { maxBuffer: 1 << 30 });
  if (r.status !== 0 || !r.stdout?.length) return 'decode failed';
  const b = r.stdout;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.byteLength & ~3)));
}

/* ---------- compare ---------- */
const within = (a, b, pct) => Math.abs(a - b) <= b * pct;
function classify(est, ref) {
  if (est == null) return 'none';
  if (Math.abs(est - ref) <= 1) return 'exact';
  if (within(est, ref, 0.04)) return 'near';                                   // within 4%, off by > 1 BPM
  if (within(est, ref * 2, 0.04) || within(est, ref / 2, 0.04)) return 'octave';
  if ([3, 1 / 3, 1.5, 2 / 3].some(f => within(est, ref * f, 0.04))) return 'third';
  return 'other';
}

const rows = [], skipped = {};
const skip = why => { skipped[why] = (skipped[why] ?? 0) + 1; };
let analysisMs = 0;
for (const file of walk(audioDir)) {
  if (rows.length >= LIMIT) break;
  const info = extname(file).toLowerCase() === '.f32' ? {} : probe(file);
  const m = matchFile(file, info);
  if (!m) { skip('no rekordbox.json entry for the file'); continue; }
  const samples = decode(file, info);
  if (typeof samples === 'string') { skip(samples); continue; }
  const t0 = performance.now();
  const r = tempo(samples, { min: MIN, max: MAX });
  analysisMs += performance.now() - t0;
  const ref = rb[m.id].bpm;
  const listed = [r.bpm, ...r.alternates.map(a => a.bpm)].some(b => b != null && Math.abs(b - ref) <= 1);
  rows.push({ id: m.id, how: m.how, file: relative(audioDir, file), artist: rb[m.id].rbArtist, title: rb[m.id].rbName,
    rekordbox: ref, bpm: r.bpm, confidence: r.confidence, octaveAmbiguous: r.octaveAmbiguous,
    alternates: r.alternates, class: classify(r.bpm, ref), listed });
  process.stdout.write(`\r  ${rows.length} analysed`);
}
process.stdout.write('\n');

/* ---------- report ---------- */
const n = rows.length;
const pct = (k, of = n) => of ? `${k}/${of} (${(100 * k / of).toFixed(1)}%)` : '0/0';
const count = (f, set = rows) => set.filter(f).length;
console.log(`\ntempo.mjs vs Rekordbox — ${n} tracks, ${SECONDS ? `${SECONDS} s from the ${opt.at}` : 'whole files'}, range ${MIN}–${MAX}`);
console.log(`  matched by: ${['id', 'map', 'filename', 'tags'].map(h => `${h} ${count(r => r.how === h)}`).join(', ')}`);
for (const [why, k] of Object.entries(skipped)) console.log(`  skipped: ${k} — ${why}`);
if (!n) process.exit(0);

const exact = count(r => r.class === 'exact');
const acc1 = count(r => r.class === 'exact' || r.class === 'near');
const octave = rows.filter(r => r.class === 'octave');
const flagged = rows.filter(r => r.octaveAmbiguous);
const unflagged = rows.filter(r => r.bpm != null && !r.octaveAmbiguous);
console.log(`\n  within ±1 BPM (the bar)        ${pct(exact)}`);
console.log(`  within 4% (MIREX Acc1)         ${pct(acc1)}`);
console.log(`  right up to ×2/×½ (Acc2-ish)   ${pct(acc1 + octave.length)}`);
console.log(`  octave disagreements           ${pct(octave.length)}, of which flagged octaveAmbiguous ${pct(count(r => r.octaveAmbiguous, octave), octave.length)}`);
console.log(`  3:2 / ×3 errors                ${pct(count(r => r.class === 'third'))}`);
console.log(`  other misses                   ${pct(count(r => r.class === 'other'))}`);
console.log(`  no answer (bpm null)           ${pct(count(r => r.class === 'none'))}`);
console.log(`  flagged octaveAmbiguous        ${pct(flagged.length)}; Rekordbox's tempo listed among bpm+alternates ${pct(count(r => r.listed, flagged), flagged.length)}`);
console.log(`  NOT flagged: within ±1 BPM     ${pct(count(r => r.class === 'exact', unflagged), unflagged.length)}   <- what a display without "unsure" would get right`);
console.log(`  Rekordbox's tempo anywhere in bpm+alternates ${pct(count(r => r.listed))}`);

const byConf = [...rows].filter(r => r.bpm != null).sort((a, b) => a.confidence - b.confidence);
console.log('\n  by confidence quartile (within ±1 BPM):');
for (let q = 0; q < 4; q++) {
  const part = byConf.slice(Math.floor(q * byConf.length / 4), Math.floor((q + 1) * byConf.length / 4));
  if (!part.length) continue;
  console.log(`    ${part[0].confidence.toFixed(2)}–${part.at(-1).confidence.toFixed(2)}: ${pct(count(r => r.class === 'exact', part), part.length)}`);
}
console.log(`\n  speed: ${(analysisMs / n).toFixed(1)} ms per track for tempo() (decode excluded)`);

console.log('\n  worst disagreements:');
for (const r of rows.filter(r => r.class !== 'exact').sort((a, b) => b.confidence - a.confidence).slice(0, 15))
  console.log(`    rb ${String(r.rekordbox).padStart(6)}  ours ${String(r.bpm).padStart(6)}${r.octaveAmbiguous ? ' (unsure)' : '         '} conf ${r.confidence.toFixed(2)} ${r.class.padEnd(6)} ${r.artist} — ${r.title}`);

console.log(`\nFor AUDIO-ANALYSIS-PLAN.md §0: tempo.mjs vs Rekordbox on ${n} of the owner's tracks (${SECONDS ? `${SECONDS} s excerpts` : 'whole files'}): ` +
  `±1 BPM ${(100 * exact / n).toFixed(0)}%, within 4% ${(100 * acc1 / n).toFixed(0)}%, up to octave ${(100 * (acc1 + octave.length) / n).toFixed(0)}%; ` +
  `flagged unsure ${(100 * flagged.length / n).toFixed(0)}%, unflagged answers ±1 BPM ${unflagged.length ? (100 * count(r => r.class === 'exact', unflagged) / unflagged.length).toFixed(0) : '—'}%.`);

if (opt.out) {
  writeFileSync(opt.out, JSON.stringify({ seconds: SECONDS, at: opt.at, min: MIN, max: MAX, rows }, null, 2));
  console.log(`wrote ${opt.out}`);
}
