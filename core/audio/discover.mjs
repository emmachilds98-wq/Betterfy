// @bundle engine BetterfyDiscover 180
// Discover by sound (docs/archive/SOUND-EVERYWHERE-PLAN.md, S4).
//
// Two things Discover could not do before:
//
//  1. Rank by how a pick *sounds*. Candidates are heard the same way library
//     tracks are (ISRC → Deezer preview → the model), and each is scored by how
//     close it sits to the seed: the seed playlist's heard tracks, or for
//     "Everything I listen to" the heard tracks of the artists you actually
//     play. The score is calibrated against the seed itself: 1 means "as close
//     to the seed as its own tracks are to each other", 0 means "no closer than
//     an arbitrary track from elsewhere in your library". So it reads the same
//     on a tight jungle playlist and a loose "Sunday" one.
//
//  2. Work without a Last.fm key (CLAUDE.md: a feature counts only if every
//     account can use it from its Spotify library alone). The keyless path
//     asks Deezer's "fans also like" and ListenBrainz's listening-session
//     neighbours about your most-played artists — the same lookups, reached
//     through the same ISRC route and cached under the same key as the Engine
//     screen's neighbour bridge (core/intrinsic/bridge-fetch.mjs) — and keeps
//     the neighbours that are *not* in your library.
//
// Rules (docs/archive/HANDOFF.md §4, SMARTER-GENRES-PLAN §3): everything here is a
// nearest-neighbour lookup or a count over this account's own heard tracks.
// Nothing is trained, nothing is pooled across accounts, and no Spotify
// content goes into a model: the audio is Deezer's preview, as for every other
// heard track. Pure: no fetches, no DOM; the page hands in what it has.

import { nearest } from './match.mjs';
import { audioIndex } from '../intrinsic/audio.mjs';
import { sourceArtists } from '../intrinsic/bridge.mjs';
import { normName } from '../sources/deezer.mjs';

export const DISCOVER_SOUND_VERSION = '1.1.0';

export const DISCOVER_SOUND = Object.freeze({
  /** Sound-alikes a fit is averaged over. */
  k: 5,
  /** Fewer heard seed tracks than this and sound can't judge the seed. */
  minSeed: 5,
  /** Seed tracks kept (spread evenly), so a 2,000-track seed costs what 400 do. */
  maxSeed: 400,
  /** Tracks sampled to calibrate the seed's own closeness and the baseline. */
  sample: 80,
  /** How much the sound fit counts against the similar-artist order (0..1). */
  weight: 0.6,
  /** What an unheard candidate counts as: neither pushed up nor buried. */
  neutral: 0.5,
});

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** n items spaced evenly through list (first included), in list order. */
const spread = (list, n) => {
  if (n >= list.length) return list;
  if (n <= 0) return [];
  const step = list.length / n;
  return Array.from({ length: n }, (_, i) => list[Math.floor(i * step)]);
};

/** Candidate records → the same unit-embedding index the library uses. */
export const candidateIndex = records => audioIndex(records);

/** Mean of the top-k cosines of `emb` against `rows` ([id, emb]), and the ids nearest first. */
function topK(emb, rows, k, skip = null) {
  const top = [];
  for (const [id, e] of rows) {
    if (id === skip || e.length !== emb.length) continue;
    const sim = dot(emb, e);
    if (top.length < k) { top.push([id, sim]); top.sort((a, b) => b[1] - a[1]); }
    else if (sim > top[k - 1][1]) { top[k - 1] = [id, sim]; top.sort((a, b) => b[1] - a[1]); }
  }
  if (!top.length) return null;
  return { sim: top.reduce((s, x) => s + x[1], 0) / top.length, near: top.map(x => x[0]) };
}

/**
 * The heard tracks that stand for "everything I listen to": library tracks by
 * the artists you play, most played first. A track counts at its most-played
 * artist. Tracks no listening weight reaches are left out, so the seed is what
 * you play, not what you once filed.
 *
 * @param {Iterable<object>} tracks       library tracks ({ id, artists: [{ name }] })
 * @param {(t: object) => number} weightOf listening weight of a track
 * @param {Map} index                     the library's audio index
 * @returns {string[]} heard track ids
 */
export function weightedSeedIds(tracks, weightOf, index, { limit = DISCOVER_SOUND.maxSeed } = {}) {
  const seen = new Set(), rows = [];
  let i = 0;
  for (const t of tracks ?? []) {
    i++;
    if (!t?.id || seen.has(t.id) || !index?.has(t.id)) continue;
    seen.add(t.id);
    const w = Number(weightOf?.(t)) || 0;
    if (w > 0) rows.push([t.id, w, i]);
  }
  rows.sort((a, b) => b[1] - a[1] || a[2] - b[2]);
  return rows.slice(0, limit).map(r => r[0]);
}

/**
 * What the seed sounds like, calibrated.
 *
 * @param {Iterable<string|{id: string}>} ids  the seed's tracks
 * @param {Map<string, {emb: Float32Array}>} index  the library's audio index
 * @returns {{ ok: false, n: number }
 *          | { ok: true, n: number, rows: Array<[string, Float32Array]>, self: number, base: number|null }}
 *   `n` is how many seed tracks have been heard. `self` is the typical
 *   closeness of a seed track to the rest of the seed; `base` is the typical
 *   closeness of a heard library track outside the seed to it (null when
 *   everything heard is in the seed).
 */
export function seedSound(ids, index, { k = DISCOVER_SOUND.k, minSeed = DISCOVER_SOUND.minSeed,
                                        maxSeed = DISCOVER_SOUND.maxSeed, sample = DISCOVER_SOUND.sample } = {}) {
  const inSeed = new Set(), rows = [];
  for (const x of ids ?? []) {
    const id = typeof x === 'string' ? x : x?.id;
    if (!id || inSeed.has(id)) continue;
    const row = index?.get(id);
    if (!row?.emb) continue;
    inSeed.add(id);
    rows.push([id, row.emb]);
  }
  const n = rows.length;
  if (n < minSeed) return { ok: false, n };
  const kept = spread(rows, maxSeed);

  const selfSims = spread(kept, sample).map(([id, emb]) => topK(emb, kept, k, id)?.sim).filter(Number.isFinite);
  const others = [];
  for (const [id, row] of index) if (!inSeed.has(id) && row?.emb) others.push(row.emb);
  const baseSims = spread(others, sample).map(emb => topK(emb, kept, k)?.sim).filter(Number.isFinite);

  return { ok: true, n, rows: kept, self: +median(selfSims).toFixed(4),
           base: baseSims.length ? +median(baseSims).toFixed(4) : null };
}

/** Raw closeness → 0..1 against the seed's own calibration. */
export function calibrate(sim, seed) {
  if (!Number.isFinite(sim) || !seed?.ok) return null;
  const { self, base } = seed;
  // Too little spread to tell inside from outside: judge against a fixed
  // window just under the seed's own closeness instead of dividing by ~0.
  if (base == null || self - base < 0.02) return +clamp01((sim - (self - 0.1)) / 0.1).toFixed(3);
  return +clamp01((sim - base) / (self - base)).toFixed(3);
}

/**
 * How well one heard candidate fits the seed.
 * @returns {{ fit: number, sim: number, near: string[] } | null}  `near`: the seed tracks it sounds most like
 */
export function soundFit(emb, seed, { k = DISCOVER_SOUND.k } = {}) {
  if (!emb || !seed?.ok) return null;
  const t = topK(emb, seed.rows, k);
  if (!t) return null;
  return { fit: calibrate(t.sim, seed), sim: +t.sim.toFixed(4), near: t.near.slice(0, 3) };
}

/** soundFit for every heard candidate. @returns {Map<string, ReturnType<typeof soundFit>>} */
export function soundFits(candIndex, seed, o = {}) {
  const out = new Map();
  if (!seed?.ok) return out;
  for (const [id, row] of candIndex ?? []) {
    const f = soundFit(row?.emb, seed, o);
    if (f) out.set(id, f);
  }
  return out;
}

/**
 * Re-rank picks by sound. Positions before `from` (the cards already seen)
 * stay where they are; the rest are ordered by a blend of where the
 * similar-artist order put them and how well they fit the seed's sound.
 * With no fit for any of them, the order is returned unchanged.
 *
 * @template T
 * @param {T[]} list
 * @param {Map<string, {fit: number}>} fits
 * @param {{ from?: number, weight?: number, neutral?: number, idOf?: (x: T) => string }} [o]
 * @returns {T[]} a new array
 */
export function rerank(list, fits, { from = 0, weight = DISCOVER_SOUND.weight, neutral = DISCOVER_SOUND.neutral,
                                     idOf = x => x?.id } = {}) {
  const arr = [...(list ?? [])];
  const at = Math.max(0, Math.min(arr.length, Math.floor(from) || 0));
  const head = arr.slice(0, at), tail = arr.slice(at);
  const fitOf = x => { const f = fits?.get?.(idOf(x))?.fit; return Number.isFinite(f) ? f : null; };
  if (!tail.some(x => fitOf(x) != null)) return arr;
  const n = tail.length;
  const scored = tail.map((x, i) => {
    const prior = n > 1 ? 1 - i / (n - 1) : 1;
    const f = fitOf(x);
    return { x, i, s: (1 - weight) * prior + weight * (f ?? neutral) };
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return [...head, ...scored.map(r => r.x)];
}

/**
 * Which genre playlists a heard candidate sounds like it belongs in: the
 * filed tracks it sounds most like vote for the playlists they sit in,
 * weighted by how alike they sound. What a pick with no tags can still be
 * offered, and what the File screen does for a heard track.
 *
 * @param {Float32Array} emb
 * @param {Map} index  the library's audio index
 * @param {{ playlists: Map<string, {name: string}>, of: Map<string, string[]> }} membership  match.genreMembership
 * @returns {Array<{ id: string, name: string, score: number, votes: number, via: 'sound' }>}
 */
export function soundPlace(emb, index, membership, { k = 15, limit = 3, minNeighbours = 5, minVotes = 2 } = {}) {
  if (!emb || !index?.size || !membership?.of?.size) return [];
  const nn = nearest(emb, index, { k, filter: id => membership.of.has(id) });
  if (nn.length < minNeighbours) return [];
  const votes = new Map();
  let total = 0;
  for (const n of nn) {
    const w = Math.max(0, n.sim);
    if (!w) continue;
    total += w;
    for (const pid of membership.of.get(n.id) ?? []) {
      const v = votes.get(pid) ?? { w: 0, n: 0 };
      v.w += w; v.n++;
      votes.set(pid, v);
    }
  }
  if (!total) return [];
  return [...votes].filter(([, v]) => v.n >= minVotes)
    .sort((a, b) => b[1].w - a[1].w || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([id, v]) => ({ id, name: membership.playlists.get(id)?.name ?? id,
                         score: +(v.w / total).toFixed(3), votes: v.n, via: 'sound' }));
}

/** How close a pick must sound to the seed playlist for that playlist to lead its picks, and to be offered at all.
 *  The same cut-offs as the card's own fit line (web/app/discover-engine.js discFitHTML): "Sounds right at
 *  home in X" and "Close to X's sound". */
export const SEED_FIT = Object.freeze({ lead: 0.75, offer: 0.45 });

/**
 * Make a pick's playlist picks agree with its fit line. On a playlist's radio the card says how close
 * the pick sounds to that playlist; the picks come from the genre playlists the filed tracks vote for,
 * which never include a mood or activity playlist like "on the road". So a card could say "Sounds right
 * at home in X" and then offer Y. Here the seed playlist leads when the pick sounds at home in it, and
 * is one tap away (second) when it is merely close. Below that the picks are returned as they were.
 *
 * @param {Array<{id: string}>} picks   the pick's playlist picks, best first
 * @param {{fit: number}|null} fit      soundFit() for this pick against the seed
 * @param {{id: string, name: string, axis?: string|null}|null} seed  the seed playlist; null for "Everything I listen to"
 * @returns {Array<object>} a new array, at most `limit` long
 */
export function seedPicks(picks, fit, seed, { limit = 3, lead = SEED_FIT.lead, offer = SEED_FIT.offer } = {}) {
  const list = [...(picks ?? [])];
  const f = fit?.fit;
  if (!seed?.id || !Number.isFinite(f) || f < offer) return list;
  const others = list.filter(p => p?.id !== seed.id);
  const own = { id: seed.id, name: seed.name ?? seed.id, axis: seed.axis ?? null, score: +clamp01(f).toFixed(3),
                via: 'seed', evidence: { sound: +clamp01(f).toFixed(3) } };
  const at = f >= lead ? 0 : Math.min(1, others.length);
  return [...others.slice(0, at), own, ...others.slice(at)].slice(0, Math.max(1, limit));
}

/* ---------- the keyless candidate path ---------- */

/**
 * Who to ask about: the first-billed artists of the seed's tracks, most played
 * first, each with one ISRC to reach them on Deezer by (bridge.sourceArtists).
 *
 * @param {Iterable<object>} tracks
 * @param {{ weightOf?: (t: object) => number, limit?: number }} [o]
 * @returns {{ artists: Map<string, {name: string, isrc: string|null}>, seeds: Array<{id: string, name: string, w: number}> }}
 *   `artists` is what gatherBridge() takes; `seeds` weights them like rankSeeds (0.35..1).
 */
export function seedArtists(tracks, { weightOf = () => 1, limit = 25 } = {}) {
  const list = [...(tracks ?? [])].filter(t => t?.id && !t.is_local);
  const w = new Map(list.map((t, i) => [t, [Number(weightOf(t)) || 0, i]]));
  list.sort((a, b) => w.get(b)[0] - w.get(a)[0] || w.get(a)[1] - w.get(b)[1]);
  const all = sourceArtists(list);
  // An artist's weight: its best track's, or how many of the seed's tracks are its.
  const best = new Map(), count = new Map();
  for (const t of list) {
    const a = (t.artists ?? []).find(x => x?.id);
    if (!a) continue;
    best.set(a.id, Math.max(best.get(a.id) ?? 0, w.get(t)[0]));
    count.set(a.id, (count.get(a.id) ?? 0) + 1);
  }
  const ids = [...all.keys()].slice(0, Math.max(0, limit));
  const raw = id => best.get(id) || count.get(id) || 0;
  const most = Math.max(0, ...ids.map(raw)) || 1;
  const artists = new Map(ids.map(id => [id, all.get(id)]));
  const seeds = ids.map(id => ({ id, name: all.get(id).name, w: +(0.35 + 0.65 * raw(id) / most).toFixed(4) }));
  return { artists, seeds };
}

/**
 * Artists near the seeds that are not in the library, best first.
 *
 * `raw[spotifyArtistId]` is what gatherBridge() stores. Deezer's list is
 * ranked (first = 1, last = 1/n); ListenBrainz gives a score, scaled so its
 * best = 1. A neighbour several seeds share, or both sources name, adds up —
 * agreement is the signal.
 *
 * @param {object} raw
 * @param {Array<{id: string, name: string, w: number}>} seeds
 * @param {{ isOwned?: (name: string) => boolean, limit?: number }} [o]
 * @returns {Array<{ name: string, score: number, via: string[], sources: string[], deezerId: number|null, mbid: string|null }>}
 */
export function bridgeCandidates(raw, seeds, { isOwned = () => false, limit = 60 } = {}) {
  const seedNames = new Set((seeds ?? []).map(s => normName(s.name)));
  const cand = new Map();
  const bump = (name, x, seed, src, ids) => {
    const key = normName(name);
    if (!key || !(x > 0) || seedNames.has(key) || isOwned(name)) return;
    const c = cand.get(key) ?? { name: String(name), score: 0, via: [], sources: [], deezerId: null, mbid: null };
    c.score += x * (seed.w ?? 1);
    if (!c.via.includes(seed.name) && c.via.length < 3) c.via.push(seed.name);
    if (!c.sources.includes(src)) c.sources.push(src);
    if (ids.deezerId != null && c.deezerId == null) c.deezerId = Number(ids.deezerId);
    if (ids.mbid && !c.mbid) c.mbid = String(ids.mbid);
    cand.set(key, c);
  };
  for (const s of seeds ?? []) {
    const e = raw?.[s.id];
    if (!e) continue;
    if (Array.isArray(e.deezer)) e.deezer.forEach((r, i, all) =>
      bump(r?.name, 1 - i / all.length, s, 'deezer', { deezerId: r?.id }));
    if (Array.isArray(e.listenbrainz)) {
      const top = Math.max(0, ...e.listenbrainz.map(r => Number(r?.score) || 0));
      if (top > 0) for (const r of e.listenbrainz) bump(r?.name, (Number(r?.score) || 0) / top, s, 'listenbrainz', { mbid: r?.mbid });
    }
  }
  return [...cand.values()]
    .map(c => ({ ...c, score: +c.score.toFixed(4) }))
    .sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, limit);
}

/**
 * One track by this artist from a Spotify search answer: the first whose
 * credits name the artist (by normalised name, so a same-titled track by
 * somebody else is not taken) and that the listener doesn't already own.
 */
export function pickTrack(items, artistName, { isOwnedTrack = () => false } = {}) {
  const want = normName(artistName);
  if (!want) return null;
  for (const t of items ?? []) {
    if (!t?.id || !(t.artists ?? []).some(a => normName(a?.name) === want)) continue;
    if (isOwnedTrack(t)) continue;
    return t;
  }
  return null;
}
