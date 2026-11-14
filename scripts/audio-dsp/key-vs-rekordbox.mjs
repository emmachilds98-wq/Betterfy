// Measure core/audio/dsp/key.mjs against the owner's Rekordbox keys (WP-D2).
//
//   node scripts/audio-dsp/key-vs-rekordbox.mjs [options]
//
//   --rekordbox <file>  rekordbox.json from `node rekordbox.mjs <collection.xml> --write`
//                       (default ./rekordbox.json)
//   --library <file>    library.json from `npm run snapshot` (default ./library.json),
//                       for each track's ISRC and duration
//   --limit <n>         tracks to try, sampled evenly at random (default 200)
//   --seed <n>          sample seed, so a rerun hits the same tracks (default 1)
//   --out <file>        per-track results (default key-vs-rekordbox.results.json)
//
// Needs network (api.deezer.com and its preview CDN) and ffmpeg on PATH. It
// does not run in CI or in the build sandbox, which has neither the owner's
// files nor Deezer.
//
// What it does, per track: Spotify id -> ISRC (library.json) -> Deezer
// /track/isrc:<ISRC> -> identity check (duration within ±3 s, as WP-A1's
// identityOk) -> fetch the 30 s preview into memory -> ffmpeg decodes it from
// stdin to 16 kHz mono float32 on stdout -> key() -> compare with Rekordbox's
// Camelot code. Audio never touches disk and is dropped after each track;
// preview URLs are used once and never written out (AUDIO-BUILD-PLAN.md §0
// rule 4). ISRC or nothing: no name matching.
//
// It scores two inputs per track: the full preview, and the first and middle
// 10 s only, which is roughly what the shipped pipeline hears (WP-A1's two
// 165,000-byte windows). The second is the number that matters for WP-D4.
//
// Reading the result. Rekordbox is a reference, not ground truth: it analyses
// the whole file and can be wrong itself, and a 30 s preview can sit in a
// section in another key. So the report gives more than exact agreement:
//   exact        same Camelot code
//   compatible   exact, relative (8A/8B) or a fifth (8A/7A/9A): mixes cleanly
//   MIREX score  1 exact, 0.5 fifth, 0.3 relative, 0.2 parallel, 0 otherwise
//   by band      exact agreement per confidence band, i.e. whether
//                `confidence` means anything; if high-confidence answers are
//                no better than low ones, the confidence is noise
// with a 95% Wilson interval on exact agreement.
//
// Shipping rule (AUDIO-BUILD-PLAN.md §0 rule 7, WP-D1's bar): key() goes into
// records and the UI (WP-D4) only once this script has been run on the
// owner's library and its numbers are recorded in AUDIO-ANALYSIS-PLAN.md §0.
// Until then the module exists and is tested on synthetic audio only.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { key, relation, CAMELOT, KEY_VERSION } from '../../core/audio/dsp/key.mjs';
import { SAMPLE_RATE } from '../../core/audio/mel.mjs';

const MIREX = { same: 1, 'fifth-up': 0.5, 'fifth-down': 0.5, relative: 0.3, parallel: 0.2 };
const BANDS = [[0.7, 1.01, 'high (≥0.7)'], [0.4, 0.7, 'mid (0.4–0.7)'], [0, 0.4, 'low (<0.4)']];
const WINDOW_SECONDS = 10;

/** How our Camelot code relates to Rekordbox's: 'same' | 'relative' | 'fifth-up' | 'fifth-down' | 'parallel' | 'other' | 'none'. */
export function compare(ours, theirs) {
  if (!ours) return 'none';
  return relation(theirs, ours) ?? 'other';
}

/** 95% Wilson score interval for k successes in n. */
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/**
 * Summarise rows of { rekordbox, ours, confidence } (Camelot codes).
 * Rows where we gave no key count against exact agreement.
 */
export function summarise(rows) {
  const n = rows.length;
  const rel = rows.map(r => compare(r.ours, r.rekordbox));
  const count = name => rel.filter(x => x === name).length;
  const exact = count('same');
  const compatible = exact + count('relative') + count('fifth-up') + count('fifth-down');
  const mirex = rel.reduce((s, x) => s + (MIREX[x] ?? 0), 0);
  const bands = BANDS.map(([lo, hi, label]) => {
    const idx = rows.map((r, i) => i).filter(i => rows[i].confidence >= lo && rows[i].confidence < hi);
    const k = idx.filter(i => rel[i] === 'same').length;
    return { label, n: idx.length, exact: idx.length ? k / idx.length : null };
  });
  const byMode = ['A', 'B'].map(side => {
    const idx = rows.map((r, i) => i).filter(i => rows[i].rekordbox.endsWith(side));
    return { mode: side === 'A' ? 'minor' : 'major', n: idx.length,
             exact: idx.length ? idx.filter(i => rel[i] === 'same').length / idx.length : null };
  });
  const relations = Object.fromEntries(['same', 'relative', 'fifth-up', 'fifth-down', 'parallel', 'other', 'none'].map(k => [k, count(k)]));
  return { n, exact: n ? exact / n : null, exactCI: wilson(exact, n), compatible: n ? compatible / n : null,
           mirex: n ? mirex / n : null, relations, bands, byMode };
}

/** Deterministic Fisher–Yates with an LCG, so a rerun samples the same tracks. */
function shuffled(xs, seed) {
  const a = xs.slice(); let s = seed >>> 0 || 1;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Decode compressed audio bytes to 16 kHz mono float32 via ffmpeg pipes; nothing on disk. */
export function ffmpegDecode(bytes) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'f32le', '-ac', '1', '-ar', String(SAMPLE_RATE), 'pipe:1']);
    const chunks = [], err = [];
    p.stdout.on('data', c => chunks.push(c));
    p.stderr.on('data', c => err.push(c));
    p.on('error', reject);
    p.on('close', code => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().trim().slice(0, 200)}`));
      const buf = Buffer.concat(chunks);
      // Copy into an aligned buffer: a Node Buffer's byteOffset may not be a multiple of 4.
      const out = new Float32Array(buf.length >> 2);
      new Uint8Array(out.buffer).set(buf.subarray(0, out.length * 4));
      resolve(out);
    });
    p.stdin.on('error', () => {});               // ffmpeg may close stdin early on bad input
    p.stdin.end(Buffer.from(bytes));
  });
}

/** The first and middle WINDOW_SECONDS of a clip, joined: roughly what the shipped pipeline hears. */
export function twoWindows(samples, sampleRate = SAMPLE_RATE) {
  const w = WINDOW_SECONDS * sampleRate;
  if (samples.length <= 2 * w) return samples;
  const mid = Math.floor(samples.length / 2 - w / 2);
  const out = new Float32Array(2 * w);
  out.set(samples.subarray(0, w), 0);
  out.set(samples.subarray(mid, mid + w), w);
  return out;
}

/**
 * One track: ISRC -> Deezer -> decode -> key. Returns a result row or { miss }.
 * `fetch` and `decode` are injected so the flow can be exercised offline.
 */
export async function analyseTrack(track, rb, { fetch = globalThis.fetch, decode = ffmpegDecode } = {}) {
  if (!track?.isrc) return { miss: 'no-isrc' };
  let dz;
  try {
    const r = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(track.isrc)}`);
    dz = await r.json();
  } catch (e) { return { miss: 'lookup-failed', detail: String(e.message ?? e) }; }
  if (!dz || dz.error) return { miss: 'not-on-deezer' };
  if (dz.readable === false) return { miss: 'not-readable' };
  if (!dz.preview) return { miss: 'no-preview' };
  if (track.duration_ms && dz.duration && Math.abs(dz.duration * 1000 - track.duration_ms) > 3000) return { miss: 'duration-mismatch' };
  let samples;
  try {
    const res = await fetch(dz.preview);
    if (!res.ok) return { miss: 'preview-failed', detail: `HTTP ${res.status}` };
    samples = await decode(await res.arrayBuffer());
  } catch (e) { return { miss: 'decode-failed', detail: String(e.message ?? e) }; }
  const t = performance.now();
  const full = key(samples);
  const ms = performance.now() - t;
  const win = key(twoWindows(samples));
  return {
    id: track.id, rekordbox: rb.camelot, rekordboxKey: rb.key ?? null,
    full: { camelot: full.camelot, confidence: full.confidence, relation: compare(full.camelot, rb.camelot), tuningCents: full.tuningCents },
    windows: { camelot: win.camelot, confidence: win.confidence, relation: compare(win.camelot, rb.camelot) },
    seconds: Math.round(samples.length / SAMPLE_RATE * 10) / 10, ms: Math.round(ms),
  };
}

const pct = x => x == null ? '—' : `${(100 * x).toFixed(1)}%`;

export function report(label, s) {
  const lines = [
    `${label}: n=${s.n}`,
    `  exact ${pct(s.exact)} (95% CI ${pct(s.exactCI[0])}–${pct(s.exactCI[1])}) · Camelot-compatible ${pct(s.compatible)} · MIREX ${s.mirex == null ? '—' : s.mirex.toFixed(3)}`,
    `  relations: ${Object.entries(s.relations).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    `  by confidence: ${s.bands.map(b => `${b.label} n=${b.n} exact ${pct(b.exact)}`).join(' · ')}`,
    `  by Rekordbox mode: ${s.byMode.map(m => `${m.mode} n=${m.n} exact ${pct(m.exact)}`).join(' · ')}`,
  ];
  return lines.join('\n');
}

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

async function main() {
  const rbFile = arg('rekordbox', 'rekordbox.json'), libFile = arg('library', 'library.json');
  const limit = +arg('limit', 200), seed = +arg('seed', 1), outFile = arg('out', 'key-vs-rekordbox.results.json');
  for (const f of [rbFile, libFile]) if (!existsSync(f)) { console.error(`missing ${f} (see the header of this script)`); process.exit(1); }

  const rb = JSON.parse(readFileSync(rbFile, 'utf8'));
  const lib = JSON.parse(readFileSync(libFile, 'utf8'));
  const tracks = new Map();
  for (const t of [...(lib.playlists ?? []).flatMap(p => p.tracks ?? []), ...(lib.liked ?? [])]) if (t?.id && !tracks.has(t.id)) tracks.set(t.id, t);

  const withKey = Object.entries(rb).filter(([, v]) => v?.camelot && CAMELOT[v.camelot]);
  const sample = shuffled(withKey, seed).slice(0, limit);
  console.error(`rekordbox.json: ${withKey.length} tracks with a key; trying ${sample.length} (seed ${seed}), key.mjs ${KEY_VERSION}`);

  const rows = [], misses = {};
  for (const [i, [id, v]] of sample.entries()) {
    const t = tracks.get(id);
    const r = t ? await analyseTrack(t, v) : { miss: 'not-in-library' };
    if (r.miss) { misses[r.miss] = (misses[r.miss] ?? 0) + 1; }
    else rows.push(r);
    if ((i + 1) % 10 === 0) console.error(`  ${i + 1}/${sample.length}: ${rows.length} analysed`);
    await new Promise(res => setTimeout(res, 120));   // Deezer allows 50 requests per 5 s; stay well under
  }

  const full = summarise(rows.map(r => ({ rekordbox: r.rekordbox, ours: r.full.camelot, confidence: r.full.confidence })));
  const win = summarise(rows.map(r => ({ rekordbox: r.rekordbox, ours: r.windows.camelot, confidence: r.windows.confidence })));
  const msMedian = rows.map(r => r.ms).sort((a, b) => a - b)[rows.length >> 1] ?? null;

  console.log(`\nkey.mjs ${KEY_VERSION} vs Rekordbox, ${new Date().toISOString().slice(0, 10)}`);
  console.log(`tried ${sample.length}; analysed ${rows.length}; missed ${Object.entries(misses).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  console.log(report('full 30 s preview', full));
  console.log(report('two 10 s windows (as shipped)', win));
  console.log(`median key() time per preview: ${msMedian} ms`);
  console.log(`\nfor AUDIO-ANALYSIS-PLAN.md §0: key (key.mjs ${KEY_VERSION}) agrees exactly with Rekordbox on ${pct(win.exact)} of ${win.n} tracks `
    + `(two 10 s windows; 95% CI ${pct(win.exactCI[0])}–${pct(win.exactCI[1])}), Camelot-compatible ${pct(win.compatible)}; full preview ${pct(full.exact)} exact.`);

  // Per-track results: Spotify ids and keys only. No audio, no preview URLs.
  writeFileSync(outFile, JSON.stringify({ version: KEY_VERSION, seed, misses, full, windows: win, rows }, null, 2));
  console.error(`wrote ${outFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
