// @bundle engine BetterfyOrder 170
// DJ order: a playlist ordered so each next track can be mixed into the last.
//
// Shuffle's spaced shuffle keeps artists apart and knows nothing about sound.
// This orders the heard tracks of a playlist the way a DJ would sequence them:
// each step is a tempo you can beatmatch (straight, or half/double time, within
// match.mjs's MIX_TOLERANCE), between two tracks that sound alike, without the
// same artist twice running, and optionally along an energy arc (a steady
// build, or warm-up → peak → cool-down).
//
// Everything here is a lookup over the account's own heard tracks
// (SMARTER-GENRES-PLAN.md §3, R3): tempo and energy measured from Deezer
// previews in the listener's browser, and cosine similarity between their
// audio embeddings. Nothing is trained, nothing leaves the device, nothing is
// pooled across accounts. Tracks that haven't been heard (or whose tempo
// reading is too unsure to mix on) are handed back untouched as `rest`, for
// the caller to place as it always did.
//
// Greedy with a bounded candidate set: tempos are folded onto one octave
// (log2 mod 1, so 87 and 174 sit together, which is what half/double time
// mixing means) and kept in a circular list sorted by that fold; each step
// scores only the nearest unused tracks around the current one. A 12,000-track
// library therefore costs n × CANDIDATES dot products, not n².

import { tempoOf, tempoRelation, MIX_TOLERANCE, MIX_MIN_CONF } from './match.mjs';
import { audioIndex } from '../intrinsic/audio.mjs';

export const ORDER_VERSION = '1.0.0';

/** Energy shapes a mix can follow. 'flat' ignores energy. */
export const ARCS = Object.freeze(['flat', 'build', 'peak']);
/** Fewer heard tracks than this and a mix isn't worth offering. */
export const MIN_MIX = 8;
/** How many unused tracks, nearest in tempo, each step considers. */
export const CANDIDATES = 32;
/** What each part of a step costs. Tempo dominates: a step you can't beatmatch is a bad step. */
export const WEIGHTS = Object.freeze({ tempo: 1, sound: 1.6, energy: 1.2, artist: 1, octave: 0.15 });

const LOG_TOL = t => Math.log2(1 + t);
const fold = bpm => { const l = Math.log2(bpm); return l - Math.floor(l); };
const circ = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 1 - d); };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const firstArtist = t => t?.artists?.[0]?.name ?? t?.artist ?? '';

/** A small seeded generator, so a given seed always gives the same mix. */
function rng(seed) {
  let s = (Math.floor(seed) >>> 0) || 1;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** The sound index a mix reads (`audioIndex` rows: unit embedding + record). */
export function mixIndex(records) {
  return audioIndex(records);
}

/**
 * Where the energy should be at fraction `x` (0..1) of the way through, as a
 * percentile of this mix's own energy; null for 'flat' (energy not used).
 */
export function energyTarget(arc, x) {
  const p = Math.max(0, Math.min(1, x));
  if (arc === 'build') return 0.1 + 0.85 * p;
  if (arc === 'peak') return p < 0.7 ? 0.2 + 0.8 * (p / 0.7) : 1 - 0.6 * ((p - 0.7) / 0.3);
  return null;
}

/** Per slot 0..n-1, the energy percentile the arc asks for there (see mixOrder). */
export function quantileTargets(arc, n) {
  const raw = Array.from({ length: n }, (_, k) => energyTarget(arc, n > 1 ? k / (n - 1) : 0));
  if (raw[0] === null) return null;
  const by = raw.map((v, k) => [v, k]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = new Array(n);
  by.forEach(([, k], r) => { out[k] = n > 1 ? r / (n - 1) : 0.5; });
  return out;
}

/** A heard track's tempo when it is sure enough to mix on, else null. */
function mixTempo(row) {
  const t = tempoOf(row?.rec);
  return t && t.conf >= MIX_MIN_CONF ? t : null;
}

/**
 * Split tracks into those a mix can place (heard, with a usable tempo) and the
 * rest, keeping input order and dropping repeated ids.
 * @returns {{ heard: object[], rest: object[] }}
 */
export function mixable(tracks, index) {
  const heard = [], rest = [], seen = new Set();
  for (const t of tracks ?? []) {
    if (!t?.id || seen.has(t.id)) { if (t && !t.id) rest.push(t); continue; }
    seen.add(t.id);
    const row = index?.get(t.id);
    if (row?.emb && mixTempo(row)) heard.push(t); else rest.push(t);
  }
  return { heard, rest };
}

/**
 * One transition, a → b: can it be beatmatched ('same' / 'double' / 'half' and
 * the pitch change as a fraction, or rel null), and how alike they sound.
 */
export function stepOf(a, b, index, { tolerance = MIX_TOLERANCE } = {}) {
  const ra = index?.get(a?.id ?? a), rb = index?.get(b?.id ?? b);
  const ta = mixTempo(ra), tb = mixTempo(rb);
  const sim = ra?.emb && rb?.emb && ra.emb.length === rb.emb.length ? +dot(ra.emb, rb.emb).toFixed(4) : null;
  if (!ta || !tb) return { rel: null, diff: null, sim };
  const r = tempoRelation(ta.bpm, tb.bpm, tolerance) ?? (tb.alt ? tempoRelation(ta.bpm, tb.alt, tolerance) : null);
  return { rel: r?.rel ?? null, diff: r?.diff ?? null, sim };
}

/** Energy percentile per id among `ids` (0 = calmest); ids without energy are left out. */
function energyRanks(ids, index) {
  const have = ids.map(id => [id, index.get(id)?.rec?.dsp?.energy]).filter(([, e]) => Number.isFinite(e));
  have.sort((a, b) => a[1] - b[1]);
  const out = new Map(), n = have.length;
  have.forEach(([id], i) => out.set(id, n > 1 ? i / (n - 1) : 0.5));
  return out;
}

/**
 * Order a playlist's heard tracks into a mix.
 *
 * @param {object[]} tracks  playlist tracks ({ id, artists, ... })
 * @param {Map} index        from `mixIndex` / the sound space's `audio.index`
 * @param {{ arc?: 'flat'|'build'|'peak', seed?: number, tolerance?: number,
 *           artistOf?: (t: object) => string, candidates?: number }} [o]
 * @returns {{ order: object[], rest: object[], steps: Array<{rel: string|null, diff: number|null, sim: number|null}> }}
 *   `order` is the mix (heard tracks only), `rest` the tracks it could not
 *   place, in input order; `steps[i]` is the move from order[i] to order[i+1].
 */
export function mixOrder(tracks, index, { arc = 'flat', seed = 1, tolerance = MIX_TOLERANCE,
                                           artistOf = firstArtist, candidates = CANDIDATES } = {}) {
  const { heard, rest } = mixable(tracks, index);
  const n = heard.length;
  if (!n) return { order: [], rest, steps: [] };

  const rand = rng(seed);
  const tol = LOG_TOL(tolerance);
  const node = heard.map(t => {
    const row = index.get(t.id), tp = mixTempo(row);
    return { t, emb: row.emb, bpm: tp.bpm, f: fold(tp.bpm), artist: artistOf(t) ?? '' };
  });
  const ranks = arc === 'flat' ? null : energyRanks(heard.map(t => t.id), index);
  const useEnergy = !!ranks?.size;
  // The arc's targets, quantile-matched to this mix's energy: the k-th slot wants
  // the energy percentile that its target holds among all targets. A build then
  // asks for each track in turn instead of skipping the calmest and stranding
  // them at the end, and a peak uses every energy level exactly as often as
  // the library has it.
  const want = useEnergy ? quantileTargets(arc, n) : null;

  // The circular list, sorted by folded tempo: prev/next skip used tracks in O(1).
  const ring = node.map((_, i) => i).sort((a, b) => node[a].f - node[b].f || a - b);
  const pos = new Int32Array(n), next = new Int32Array(n), prev = new Int32Array(n);
  ring.forEach((k, i) => { pos[k] = i; next[i] = (i + 1) % n; prev[i] = (i - 1 + n) % n; });
  let left = n;
  const remove = i => { next[prev[i]] = next[i]; prev[next[i]] = prev[i]; left--; };

  // Where to start: the calmest end for an arc (a set warms up), anywhere for a flat mix.
  let start;
  if (useEnergy) {
    const calm = node.map((_, i) => i).filter(i => (ranks.get(node[i].t.id) ?? 1) <= 0.2);
    const from = calm.length ? calm : node.map((_, i) => i);
    start = from[Math.floor(rand() * from.length)];
  } else start = Math.floor(rand() * n);

  const out = [start];
  remove(pos[start]);
  const recent = [node[start].artist];

  while (left > 0) {
    const cur = node[out[out.length - 1]];
    const target = useEnergy ? want[out.length] : null;
    // Gather the nearest unused tracks by folded tempo, walking both ways round the ring.
    // The current track is already unlinked, but its own prev/next still point at live neighbours.
    const cand = [], seen = new Set(), here = pos[out[out.length - 1]];
    const room = Math.min(candidates, left);
    let a = next[here], b = prev[here];
    while (cand.length < room && seen.size < left) {
      const da = circ(node[ring[a]].f, cur.f), db = circ(node[ring[b]].f, cur.f);
      // Past four tolerances nothing near is mixable: a few candidates are enough to bridge.
      if (cand.length >= 4 && Math.min(da, db) > 4 * tol) break;
      const take = da <= db ? a : b;
      if (take === a) a = next[a]; else b = prev[b];
      if (!seen.has(take)) { seen.add(take); cand.push(take); }
    }
    let best = -1, bestCost = Infinity;
    for (const ri of cand) {
      const c = node[ring[ri]];
      const d = circ(c.f, cur.f) / tol;
      let cost = WEIGHTS.tempo * (d <= 1 ? 0.4 * d : 1 + 2 * Math.min(d - 1, 3));
      if (d <= 1 && Math.abs(Math.log2(c.bpm / cur.bpm)) > 0.5) cost += WEIGHTS.octave;
      cost += WEIGHTS.sound * (1 - dot(cur.emb, c.emb));
      if (target !== null) {
        const e = ranks.get(c.t.id);
        if (e !== undefined) cost += WEIGHTS.energy * Math.abs(e - target);
      }
      if (c.artist) {
        if (c.artist === recent[recent.length - 1]) cost += WEIGHTS.artist;
        else if (recent.includes(c.artist)) cost += 0.3 * WEIGHTS.artist;
      }
      if (cost < bestCost - 1e-12 || (Math.abs(cost - bestCost) <= 1e-12 && rand() < 0.5)) { bestCost = cost; best = ri; }
    }
    const k = ring[best];
    out.push(k);
    remove(best);
    recent.push(node[k].artist);
    if (recent.length > 3) recent.shift();
  }

  const order = out.map(i => node[i].t);
  const steps = [];
  for (let i = 1; i < order.length; i++) steps.push(stepOf(order[i - 1], order[i], index, { tolerance }));
  return { order, rest, steps };
}

/**
 * How well an order mixes: the share of moves you can beatmatch, the mean
 * pitch change on those, how alike neighbours sound, the tempo range, and the
 * energy along the way (percentiles, resampled to `points`) for a sparkline.
 * Only consecutive heard pairs count; unheard tracks break a run, they don't fail it.
 */
export function mixStats(order, index, { tolerance = MIX_TOLERANCE, points = 24 } = {}) {
  const ids = (order ?? []).map(t => t?.id ?? t);
  let moves = 0, mixed = 0, shift = 0, simSum = 0, simN = 0, lo = Infinity, hi = -Infinity;
  for (let i = 0; i < ids.length; i++) {
    const t = mixTempo(index?.get(ids[i]));
    if (t) { lo = Math.min(lo, t.bpm); hi = Math.max(hi, t.bpm); }
    if (!i) continue;
    const s = stepOf(ids[i - 1], ids[i], index, { tolerance });
    if (!mixTempo(index?.get(ids[i - 1])) || !t) continue;
    moves++;
    if (s.rel) { mixed++; shift += s.diff; }
    if (s.sim !== null) { simSum += s.sim; simN++; }
  }
  const heardIds = ids.filter(id => mixTempo(index?.get(id)));
  const ranks = energyRanks(heardIds, index);
  const seq = heardIds.map(id => ranks.get(id)).filter(e => e !== undefined);
  const energy = [];
  if (seq.length >= 2) {
    const m = Math.min(points, seq.length);
    for (let j = 0; j < m; j++) {
      const a = Math.floor(j * seq.length / m), b = Math.max(a + 1, Math.floor((j + 1) * seq.length / m));
      const part = seq.slice(a, b);
      energy.push(+(part.reduce((x, y) => x + y, 0) / part.length).toFixed(3));
    }
  }
  return {
    moves, mixed,
    share: moves ? +(mixed / moves).toFixed(3) : null,
    shift: mixed ? +(shift / mixed).toFixed(4) : null,
    sim: simN ? +(simSum / simN).toFixed(3) : null,
    bpm: Number.isFinite(lo) ? [+lo.toFixed(1), +hi.toFixed(1)] : null,
    energy,
  };
}
