// E3 (docs/BUILD-7-PLAN.md): a playlist's own tempo range, learned from the
// tracks the account has heard in it, and a bounded penalty for a track whose
// tempo is far outside it.
//
// Per account, nothing fitted: the range is the middle half (IQR) of the
// heard members' confident tempos, octave-aware (87 and 174 are the same
// place on the circle of tempos). A playlist only gets a range when it has
// enough heard members and they are tight (drum & bass at 170-176, house at
// 124-128); a mixed playlist says nothing and is untouched.
//
// The penalty is multiplicative and capped (MAX_PENALTY), so tempo can only
// nudge a score down, never veto a playlist, and a track with no confident
// tempo is never touched.

import { tempoOf, MIX_MIN_CONF, MIX_TOLERANCE } from '../audio/match.mjs';

export const TEMPO_RANGE_VERSION = '1.0.0';
/** Heard members with a confident tempo a playlist needs before it learns a range. */
export const RANGE_MIN_MEMBERS = 12;
/** The middle half of the members must fit in this many BPM (at their own octave). */
export const RANGE_MAX_IQR = 10;
/** The most a score can be lowered (a fraction), however far off the tempo is. */
export const MAX_PENALTY = 0.3;
/** Octaves outside the range (log2) at which the penalty reaches its cap (~15%). */
export const FULL_AT = 0.2;

const RANGE_CACHE = new WeakMap();

const phaseOf = bpm => { const p = Math.log2(bpm); return p - Math.floor(p); };
/** Quantile of a sorted array, linear between ranks. */
function q(sorted, p) {
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/**
 * The range of a list of tempos (BPM), octave-folded, or null when there are
 * too few or the middle half is too wide. `{ lo, hi, center, n, iqr }`, in BPM
 * at the octave most members were measured in (a 174 playlist reads 170-176).
 * @param {number[]} bpms
 */
export function tempoRange(bpms, { minMembers = RANGE_MIN_MEMBERS, maxIqr = RANGE_MAX_IQR } = {}) {
  const v = (bpms ?? []).filter(b => Number.isFinite(b) && b > 0);
  const n = v.length;
  if (n < minMembers) return null;
  // Phases on the one-octave circle, sorted. Try every cut of the circle and
  // keep the one where the middle half is tightest, so a playlist at 126-134
  // is not split at the arbitrary place an octave happens to start.
  const ph = v.map(phaseOf).sort((a, b) => a - b);
  let best = null;
  const rot = new Array(n);
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) rot[i] = k + i < n ? ph[k + i] : ph[k + i - n] + 1;
    const lo = q(rot, 0.25), hi = q(rot, 0.75);
    if (!best || hi - lo < best.hi - best.lo - 1e-12) best = { lo, hi };
  }
  const mid = (best.lo + best.hi) / 2;
  // The octave most members were measured in: the one nearest the raw median.
  const scale = 2 ** Math.round(Math.log2(median(v)) - mid);
  const lo = 2 ** best.lo * scale, hi = 2 ** best.hi * scale;
  if (hi - lo > maxIqr) return null;
  return { lo: +lo.toFixed(1), hi: +hi.toFixed(1), center: +(2 ** mid * scale).toFixed(1), n, iqr: +(hi - lo).toFixed(1) };
}

/**
 * A playlist's range from its audio profile (`ids`) and the sound index,
 * worked out once per profile. Confident readings only (bpmConf >= MIX_MIN_CONF).
 */
export function profileTempoRange(profile, index) {
  if (!profile?.ids || !(index instanceof Map)) return null;
  if (RANGE_CACHE.has(profile)) return RANGE_CACHE.get(profile);
  const bpms = [];
  for (const id of profile.ids) {
    const t = tempoOf(index.get(id)?.rec);
    if (t && t.conf >= MIX_MIN_CONF) bpms.push(t.bpm);
  }
  const r = tempoRange(bpms);
  RANGE_CACHE.set(profile, r);
  return r;
}

/**
 * How much to lower a score (0 to MAX_PENALTY) for a track at `bpm` in a
 * playlist with `range`: 0 inside the range widened by the mixing tolerance
 * (or at its octave), growing with the distance outside it, capped.
 */
export function tempoPenalty(bpm, range) {
  if (!range || !(bpm > 0)) return 0;
  const pad = Math.log2(1 + MIX_TOLERANCE);
  const lo = Math.log2(range.lo) - pad, hi = Math.log2(range.hi) + pad;
  const x = Math.log2(bpm);
  let d = Infinity;
  for (let k = -3; k <= 3; k++) {
    const y = x + k;
    d = Math.min(d, y < lo ? lo - y : y > hi ? y - hi : 0);
  }
  return +(MAX_PENALTY * Math.min(1, d / FULL_AT)).toFixed(4);
}
