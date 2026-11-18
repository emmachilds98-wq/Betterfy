// @bundle engine BetterfyTempoRange 216
// Does a playlist's own tempo range help place a heard track? (docs/BUILD-7-PLAN.md E3)
//
// The same held-out folds, sound path, scored twice: as File places a heard
// track today, and with the tempo-range penalty (core/intrinsic/tempo.mjs) on.
// Same tracks, same spaces, so the difference is the range and nothing else.
// Counts only; nothing leaves the account.
//
// The bar (set before measuring): +1 point top-1 overall, or +3 tracks on the
// account's five weakest playlists. Past it the Score run says so; the penalty
// itself stays off until the shipped measurement (test/temporange.test.mjs) and
// this run both clear it.
import { placementAccuracy } from './loo.mjs';

export const TEMPO_SCORE_VERSION = '1.0.0';
export const TEMPO_BAR_POINTS = 1;
export const TEMPO_BAR_WEAKEST = 3;

/**
 * @param {object} lib
 * @param {object} opts  what placementAccuracy takes (targets, isMirror, genreGraph, audio, soundWeights, limit)
 * @returns {{ version, scored, off: number, on: number, points: number, weakest: number, pass: boolean }|null}
 */
export function tempoRangeAccuracy(lib, opts = {}) {
  if (!opts.audio) return null;
  const run = tempoRange => placementAccuracy(lib, { ...opts, collect: true, tempoRange })?.withAudio;
  const off = run(false), on = run(true);
  if (!off?.rows?.length || !on?.rows?.length) return null;
  const hit = r => (r && r.truth.includes(r.scores[0]?.[0]) ? 1 : 0);
  const after = new Map(on.rows.map(r => [r.id, r]));
  const per = new Map();
  let a = 0, b = 0;
  for (const r of off.rows) {
    const h0 = hit(r), h1 = hit(after.get(r.id));
    a += h0; b += h1;
    for (const pid of r.truth) {
      const p = per.get(pid) ?? { n: 0, off: 0, on: 0 };
      p.n++; p.off += h0; p.on += h1; per.set(pid, p);
    }
  }
  const n = off.rows.length;
  const weak = [...per.values()].filter(p => p.n >= 8).sort((x, y) => x.off / x.n - y.off / y.n).slice(0, 5);
  const weakest = weak.reduce((s, p) => s + p.on - p.off, 0);
  const points = +((b - a) / n * 100).toFixed(2);
  return { version: TEMPO_SCORE_VERSION, scored: n, off: +(a / n).toFixed(4), on: +(b / n).toFixed(4), points, weakest,
           pass: points >= TEMPO_BAR_POINTS || weakest >= TEMPO_BAR_WEAKEST };
}
