// Weight sensitivity — §9 and §26.
//
// "Actual numerical weights must be validated using the benchmark dataset."
// Every threshold in the classifier and every specificity in the weighting
// model is currently a declared prior: a number chosen by reasoning about
// what the evidence model ought to do. Reasoning is a fine way to pick a
// starting point and a terrible way to defend one.
//
// This sweeps each parameter through a plausible range, re-runs the
// benchmark, and reports the range over which the result does not change.
// Two useful things come out, and the second is the uncomfortable one:
//
//   sensitive   the benchmark moves when this parameter moves, so the
//               benchmark is actually constraining it.
//   flat        the benchmark does not move anywhere in the swept range. The
//               value is not validated — it is merely uncontradicted, which
//               is a different and much weaker claim.
//
// With twelve cases most parameters will read flat, and saying so plainly is
// the point. A flat result is a request for more benchmark rows, not a
// licence to trust the number.
import { THRESHOLDS } from '../analysis/classify.mjs';
import { SPECIFICITY } from '../evidence/weights.mjs';
import { runBenchmark } from './run.mjs';
import { run as runPlaylists } from './playlists.mjs';
import { THRESHOLDS as PLAYLIST_THRESHOLDS } from '../playlists/classify.mjs';

export const FIT_VERSION = '3.0.0';

/** Parameters worth sweeping, with the range a reasonable person might pick. */
export const SWEEPS = [
  { name: 'THRESHOLDS.MIN_TOTAL_WEIGHT', obj: () => THRESHOLDS, key: 'MIN_TOTAL_WEIGHT', from: 0.02, to: 0.40, step: 0.02 },
  { name: 'THRESHOLDS.MIN_LEADER_SHARE', obj: () => THRESHOLDS, key: 'MIN_LEADER_SHARE', from: 0.10, to: 0.60, step: 0.05 },
  { name: 'THRESHOLDS.AMBIGUOUS_RATIO', obj: () => THRESHOLDS, key: 'AMBIGUOUS_RATIO', from: 0.50, to: 0.98, step: 0.04 },
  { name: 'THRESHOLDS.HIGH_LEADER_SHARE', obj: () => THRESHOLDS, key: 'HIGH_LEADER_SHARE', from: 0.20, to: 0.80, step: 0.05 },
  { name: 'THRESHOLDS.HIGH_MARGIN_RATIO', obj: () => THRESHOLDS, key: 'HIGH_MARGIN_RATIO', from: 0.20, to: 0.90, step: 0.05 },
  { name: 'THRESHOLDS.HIGH_MIN_WEIGHT', obj: () => THRESHOLDS, key: 'HIGH_MIN_WEIGHT', from: 0.10, to: 1.20, step: 0.10 },
  { name: 'THRESHOLDS.SPECIFIC_ENOUGH', obj: () => THRESHOLDS, key: 'SPECIFIC_ENOUGH', from: 0.15, to: 0.90, step: 0.05 },
  // The single most consequential number in the engine: the gap between a
  // statement about a recording and a statement about the person who made it.
  { name: 'SPECIFICITY.artist', obj: () => SPECIFICITY, key: 'artist', from: 0.05, to: 1.00, step: 0.05 },
  { name: 'SPECIFICITY.release', obj: () => SPECIFICITY, key: 'release', from: 0.20, to: 1.00, step: 0.05 },
];

export const PLAYLIST_SWEEPS = [
  { name: 'PLAYLIST.EVENT_SPAN_DAYS', obj: () => PLAYLIST_THRESHOLDS, key: 'EVENT_SPAN_DAYS', from: 1, to: 30, step: 1 },
  { name: 'PLAYLIST.EVENT_SETTLED_DAYS', obj: () => PLAYLIST_THRESHOLDS, key: 'EVENT_SETTLED_DAYS', from: 5, to: 180, step: 5 },
  { name: 'PLAYLIST.ARTIST_CONCENTRATION', obj: () => PLAYLIST_THRESHOLDS, key: 'ARTIST_CONCENTRATION', from: 0.15, to: 0.95, step: 0.05 },
  { name: 'PLAYLIST.CONTENT_LIFT', obj: () => PLAYLIST_THRESHOLDS, key: 'CONTENT_LIFT', from: 1.0, to: 4.0, step: 0.2 },
  { name: 'PLAYLIST.MIXED_ENTROPY', obj: () => PLAYLIST_THRESHOLDS, key: 'MIXED_ENTROPY', from: 0.20, to: 1.00, step: 0.05 },
  { name: 'PLAYLIST.HYBRID_MARGIN', obj: () => PLAYLIST_THRESHOLDS, key: 'HYBRID_MARGIN', from: 0.40, to: 1.00, step: 0.05 },
];

const round = (x, dp = 4) => +x.toFixed(dp);

/**
 * Sweep one parameter and report where the benchmark still passes.
 *
 * The parameter is restored afterwards even if the run throws — a sensitivity
 * analysis that leaves the engine mistuned would be a spectacular own goal.
 */
export function sweep(spec, score) {
  const obj = spec.obj();
  const original = obj[spec.key];
  const points = [];
  try {
    for (let v = spec.from; v <= spec.to + 1e-9; v += spec.step) {
      obj[spec.key] = round(v);
      let passed = 0;
      try { passed = score(); } catch { passed = -1; }   // a value that breaks the run is a data point
      points.push({ value: round(v), passed });
    }
  } finally {
    obj[spec.key] = original;
  }

  const best = Math.max(...points.map(p => p.passed));
  const atBest = points.filter(p => p.passed === best);
  const worst = Math.min(...points.map(p => p.passed));
  // The contiguous run of best-scoring values containing the current setting.
  let lo = null, hi = null;
  for (const p of points) {
    if (p.passed === best) { if (lo === null) lo = p.value; hi = p.value; }
    else if (lo !== null && (original < lo || original > hi)) { lo = null; hi = null; }
    else if (lo !== null && original >= lo && original <= p.value) break;
  }
  return {
    name: spec.name,
    current: original,
    best,
    worst,
    // Flat means the benchmark never distinguished any value in the range.
    flat: best === worst,
    plateau: lo !== null ? [lo, hi] : null,
    plateauWidth: lo !== null ? round((hi - lo) / (spec.to - spec.from), 3) : 0,
    currentIsBest: points.find(p => Math.abs(p.value - original) < spec.step / 2)?.passed === best
      || atBest.some(p => Math.abs(p.value - original) <= spec.step),
    points,
  };
}

export function fit() {
  const trackScore = () => runBenchmark().passed;
  const playlistScore = () => runPlaylists().passed;
  return {
    tracks: SWEEPS.map(s => sweep(s, trackScore)),
    playlists: PLAYLIST_SWEEPS.map(s => sweep(s, playlistScore)),
    version: FIT_VERSION,
  };
}

function main() {
  const { tracks, playlists } = fit();
  const show = (title, rows, total) => {
    console.log(`\n=== ${title} (${total} cases) ===\n`);
    console.log('parameter'.padEnd(36) + 'current'.padStart(9) + 'best'.padStart(6)
      + 'worst'.padStart(7) + '  plateau'.padEnd(22) + 'verdict');
    console.log('-'.repeat(100));
    for (const r of rows) {
      const verdict = r.flat ? 'FLAT — not constrained by the benchmark'
        : !r.currentIsBest ? 'MOVE — a different value scores better'
        : r.plateauWidth > 0.5 ? 'weakly constrained'
        : 'constrained';
      console.log(r.name.padEnd(36)
        + String(r.current).padStart(9) + String(r.best).padStart(6) + String(r.worst).padStart(7)
        + ('  ' + (r.plateau ? `[${r.plateau[0]} .. ${r.plateau[1]}]` : '—')).padEnd(22)
        + verdict);
    }
  };
  show('TRACK CLASSIFIER', tracks, runBenchmark().cases);
  show('PLAYLIST CLASSIFIER', playlists, runPlaylists().cases);

  const flat = [...tracks, ...playlists].filter(r => r.flat).length;
  const move = [...tracks, ...playlists].filter(r => !r.flat && !r.currentIsBest);
  console.log(`\n${flat}/${tracks.length + playlists.length} parameters are FLAT: the benchmark never`);
  console.log('distinguished any value in the swept range, so those numbers are uncontradicted');
  console.log('rather than validated. That is a request for more benchmark rows (§26 asks for');
  console.log('~500 reviewed tracks; there are currently 12 synthetic cases), not a reason to');
  console.log('trust them.');
  if (move.length) {
    console.log(`\n${move.length} parameter(s) would score BETTER at a different value — worth a look:`);
    for (const r of move) console.log(`  ${r.name}: currently ${r.current}, best in [${r.plateau?.join(' .. ')}]`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
