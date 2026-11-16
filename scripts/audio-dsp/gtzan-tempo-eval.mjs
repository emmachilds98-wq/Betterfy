// Tempo on non-EDM music: GTZAN (Tzanetakis & Cook 2002; 1,000 30 s clips,
// 10 genres) against the public beat annotations (ISMIR2019 set as released
// with Beat This!, Zenodo 13922116, beat_this_annotations.zip). Checks that
// combine.mjs's SLOW_FOLD, fitted on EDM, doesn't break slow music.
//
//   node scripts/audio-dsp/gtzan-tempo-eval.mjs <genres dir> <beats dir> --out rows.jsonl [--shard i/n]
//   node scripts/audio-dsp/gtzan-tempo-eval.mjs --beatport <cache dir> <features.jsonl> [--half B] --out rows.jsonl [--shard i/n]
//   node scripts/audio-dsp/gtzan-tempo-eval.mjs --report rows.jsonl [more.jsonl ...]
//
// <genres dir> holds blues/blues.00000.wav ...; <beats dir> holds
// gtzan_blues_00000.beats (time, beat-in-bar). Reference tempo: 60 / median
// inter-beat interval over the clip. The clip is a 30 s preview already, so
// the two 10 s windows a record gets are 0–10 s and 10–20 s (as
// beatport-eval.mjs cuts the middle 30 s). --beatport makes the same rows from
// keytempo-features.mjs's cached Beatport windows. Nothing from either
// dataset is committed.
//
// --report prints, per genre, ±1 BPM with octave errors both ways (×2 / ÷2)
// for the D1+combine tempo with no fold, the ungated SLOW_FOLD, and the
// shipped gated fold (PULSE_FOLD), plus fixed/broke against no fold.
import { readdirSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempo, bandAutocorrelations, FPS } from '../../core/audio/dsp/tempo.mjs';
import { combineTempo } from '../../core/audio/dsp/combine.mjs';
import { melFrames } from '../../core/audio/mel.mjs';

const SR = 16000;
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const r4 = x => Math.round(x * 1e4) / 1e4;
const out = arg('--out', null);
const [shard, shards] = String(arg('--shard', '0/1')).split('/').map(Number);

/** Tempo stats for { ref, est } pairs: ±1 BPM, octave errors both ways (within 4%). */
export function tempoStats(pairs) {
  const s = { n: pairs.length, ok: 0, x2: 0, half: 0, none: 0 };
  for (const { ref, est } of pairs) {
    if (!est) { s.none++; continue; }
    if (Math.abs(est - ref) <= 1) s.ok++;
    else if (Math.abs(est - 2 * ref) / (2 * ref) <= 0.04) s.x2++;
    else if (Math.abs(est - ref / 2) / (ref / 2) <= 0.04) s.half++;
  }
  return s;
}
const pct = (a, n) => n ? (100 * a / n).toFixed(1) : '–';
const ci = (a, n) => n ? (196 * Math.sqrt((a / n) * (1 - a / n) / n)).toFixed(1) : '–';

const windowsOf = s => [s.subarray(0, 10 * SR), s.subarray(10 * SR, 20 * SR)].map(w => {
  const acfs = bandAutocorrelations(melFrames(w));
  return { t: tempo(w), acf: acfs ? acfs.map(a => a ? Array.from(a.slice(0, Math.round(3 * FPS) + 1), r4) : null) : null };
});

const mode = process.argv[2];
if (mode === '--report') {
  const rows = process.argv.slice(3).flatMap(f => readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)));
  const RULES = { current: { slowFold: 0 }, fold: { pulseFold: -Infinity }, gated: {} };   // gated = shipped default
  const est = (r, k) => combineTempo(r.windows.map(w => w.t), RULES[k])?.bpm ?? null;
  const genres = [...new Set(rows.map(r => r.genre))].sort();
  const cell = s => `${pct(s.ok, s.n)}% ±${ci(s.ok, s.n)} (${s.x2}/${s.half})`.padEnd(24);
  console.log(`${'genre'.padEnd(34)}    n   ${'no fold (x2/÷2)'.padEnd(24)}${'ungated fold'.padEnd(24)}${'gated fold (shipped)'.padEnd(24)}fixed/broke: ungated, gated`);
  for (const g of [...genres, 'ALL']) {
    const rs = rows.filter(r => g === 'ALL' || r.genre === g);
    const st = k => tempoStats(rs.map(r => ({ ref: r.ref, est: est(r, k) })));
    const fb = k => { const m = rs.filter(r => est(r, 'current') !== est(r, k));
      return `${m.filter(r => Math.abs(est(r, k) - r.ref) <= 1).length}/${m.filter(r => Math.abs(est(r, 'current') - r.ref) <= 1).length}`; };
    console.log(`${String(g).slice(0, 34).padEnd(34)} ${String(rs.length).padStart(4)}   ${cell(st('current'))}${cell(st('fold'))}${cell(st('gated'))}${fb('fold')}, ${fb('gated')}`);
  }
} else if (mode === '--beatport') {
  const [cache, feats] = process.argv.slice(3);
  const half = arg('--half', null);
  const rows = readFileSync(feats, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.bpm && (!half || r.half === half));
  for (let i = shard; i < rows.length; i += shards) {
    const r = rows[i], f = join(cache, r.id + '.f32');
    if (!existsSync(f)) continue;
    const b = readFileSync(f), s = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    const row = { id: r.id, genre: `beatport ${r.half}: ${r.genre}`, ref: r.bpm, windows: windowsOf(s) };
    if (out) appendFileSync(out, JSON.stringify(row) + '\n');
  }
} else {
  const [genresDir, beatsDir] = process.argv.slice(2);
  const files = readdirSync(genresDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()
    .flatMap(g => readdirSync(join(genresDir, g)).filter(f => /\.(wav|au)$/.test(f)).sort().map(f => ({ g, f })));
  for (let i = shard; i < files.length; i += shards) {
    const { g, f } = files[i];
    const num = f.split('.')[1];
    const bf = join(beatsDir, `gtzan_${g}_${num}.beats`);
    if (!existsSync(bf)) continue;
    const beats = readFileSync(bf, 'utf8').split('\n').map(l => parseFloat(l)).filter(Number.isFinite);
    if (beats.length < 4) continue;
    const ibi = beats.slice(1).map((t, k) => t - beats[k]).sort((a, b) => a - b);
    const ref = 60 / ibi[ibi.length >> 1];
    const r = spawnSync('ffmpeg', ['-v', 'quiet', '-i', join(genresDir, g, f), '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 64 << 20 });
    if (r.status !== 0) continue;
    const s = new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.byteLength));
    if (s.length < 20 * SR) continue;
    const row = { id: `${g}.${num}`, genre: g, ref: r4(ref), windows: windowsOf(s) };
    if (out) appendFileSync(out, JSON.stringify(row) + '\n');
  }
}
