// @bundle engine BetterfyFill 185
// Smart "Fill this playlist" (docs/BUILD-6-PLAN.md §4.1 row F2, §5.1 M4).
//
// For one playlist, rank the account's liked-but-unfiled tracks by how well
// they fit it. Nothing new is learned for this: every signal is one the app
// already computes, read from the playlist's side instead of the track's.
//
//   graph   the File engine's artist graph (core/intrinsic/space.mjs): who
//           you file together, including the track's own artists, against
//           the playlist's centroid, evened for wide playlists (graphN)
//   tag     the tag engine's IDF-weighted tag cosine (profile.mjs), against
//           the playlist's tag centroid. Absent with no tags at all
//   sound   Discover's calibrated sound fit (core/audio/discover.mjs) to the
//           playlist's heard members. Absent until listening has heard some
//   shape   the File engine's record shape (label, era, length, release type)
//
// A component is weighed in for a playlist only when that playlist can be
// judged on it (it has a tag centroid, enough heard members), and then for
// every candidate alike: a candidate the component can't read gets no credit
// (sound: the neutral middle, as Discover does), so "unknown" never outranks a
// real match. With no tags and nothing heard, the graph and shape decide.
//
// The gate is `fillRecall`: hide a fold (~20%) of every playlist's tracks,
// rebuild everything without them, mix them into a pool of decoys from the
// library (the other hidden tracks and the liked tracks you never filed), and
// count how many of a playlist's own hidden tracks come back in its top 10.
// The page shows the feature only when that clears FILL.bar on this account.
//
// Rules (SMARTER-GENRES-PLAN §3): counts, cosines and nearest-neighbour
// lookups over this account's own library. Nothing is trained, nothing leaves
// the device, nothing is pooled across accounts.
import { buildSpace, WEIGHTS, combine, graphNormalised, MIN_DEFINITION_TRACKS } from '../intrinsic/space.mjs';
import { trackVector, cosine as graphCosine, norm } from '../intrinsic/cooccurrence.mjs';
import { shapeScores } from '../intrinsic/features.mjs';
import { audioIndex } from '../intrinsic/audio.mjs';
import { buildProfiles, trackVec, applyIdf, cosine as tagCosine, tagGate, gateTags } from '../../profile.mjs';
import { seedSound, soundFit, DISCOVER_SOUND } from '../audio/discover.mjs';
import { foldOf, DEFAULT_FOLDS } from '../validate/loo.mjs';
import { mirrorPredicate } from '../playlists/mirror.mjs';

export const FILL_VERSION = '1.0.0';

export const FILL = Object.freeze({
  /** Suggestions shown, and the k of recall@k. */
  k: 10,
  /** A playlist needs this many tracks to be measured (and to be offered a fill). */
  minTracks: 10,
  /** Candidates per measured playlist: its hidden tracks plus decoys. 10 of 500 is the ~2% a random pick scores. */
  pool: 500,
  /** recall@10 the account must reach before the page shows the feature. */
  bar: 0.4,
  /** Relative weights of the four signals (priors; the measure is what judges them). */
  weights: Object.freeze({ graph: 1.0, tag: 1.0, sound: 1.0, shape: 0.25 }),
  /** How many leaders are re-read against every other playlist (0: off). */
  home: 40,
  /** How hard a better home elsewhere pulls a leader down: score × (fit here ÷ best fit anywhere)^power. */
  homePower: 1,
});

/** The record-shape parts of the File engine, at its own relative weights. */
const SHAPE_WEIGHTS = Object.freeze({ registrant: WEIGHTS.registrant, minutes: WEIGHTS.minutes, era: WEIGHTS.era,
  albumType: WEIGHTS.albumType, albumTracks: WEIGHTS.albumTracks, popularity: WEIGHTS.popularity });

/** Tags as profile.mjs reads them: artist id -> { tags: [[tag, count]] }. Accepts the bare docs/tags.json shape too. */
function tagTable(tags) {
  if (!tags || typeof tags !== 'object') return null;
  const out = {};
  let n = 0;
  for (const [id, e] of Object.entries(tags)) {
    const list = Array.isArray(e) ? e : e?.tags;
    if (!Array.isArray(list) || !list.length) continue;
    // docs/tags.json stores 0-10 counts; the page expands them by ten on load (boot.js), and so does this.
    out[id] = Array.isArray(e) ? { tags: list.map(([t, c]) => [t, c * 10]) } : e;
    n++;
  }
  return n ? gateTags(out, tagGate(out)) : null;
}

/** `audio` in any shape buildSpace takes (records, { records }, { index }) -> an audio index, or null. */
function indexOf(audio) {
  if (!audio) return null;
  if (audio instanceof Map && [...audio.values()][0]?.emb) return audio;
  if (audio.index instanceof Map) return audio.index;
  const recs = typeof audio === 'object' && !Array.isArray(audio) && !(audio instanceof Map) && 'records' in audio ? audio.records : audio;
  try { const idx = audioIndex(recs); return idx.size ? idx : null; } catch { return null; }
}

/** A copy of the library with `skip` taken out of every playlist (the tag engine has no `skip`). */
const without = (lib, skip) => (skip?.size ? { ...lib, playlists: (lib?.playlists ?? []).map(p =>
  ({ ...p, tracks: (p.tracks ?? []).filter(t => t?.id && !skip.has(t.id)) })) } : lib);

/**
 * Everything the ranking needs, built once per library (and per held-out fold).
 *
 * @param {object} lib   { playlists: [{ id, name, tracks }], liked }
 * @param {object} [o]
 * @param {object} [o.tags]      artist id -> tags; null/absent is fine (no tag signal)
 * @param {*}      [o.audio]     heard records, as buildSpace takes them; absent is fine
 * @param {Function} [o.isMirror]
 * @param {Set<string>} [o.skip] track ids to treat as never filed (the measure's hidden fold)
 */
export function fillModel(lib, { tags = null, audio = null, isMirror = null, skip = null } = {}) {
  const space = buildSpace(lib, { skip, isMirror });
  const table = tagTable(tags);
  const prof = table ? buildProfiles(without(lib, skip), table, null) : null;
  return { space, tags: table, profiles: prof?.profiles ?? null, idf: prof?.idf ?? null,
           index: indexOf(audio), skip: skip ?? null, seeds: new Map(), cand: new Map() };
}

/** Per-candidate pieces that don't depend on the playlist, worked out once. */
function candidate(model, t) {
  let c = model.cand.get(t.id);
  if (c) return c;
  const vec = trackVector(t, model.space.graph);
  let tv = null;
  if (model.tags) { const flat = trackVec(t, model.tags); if (flat.size) tv = applyIdf(flat, model.idf); }
  c = { vec, vecNorm: norm(vec), tv, emb: model.index?.get(t.id)?.emb ?? null };
  model.cand.set(t.id, c);
  return c;
}

/** The playlist's sound seed (its heard members, without the hidden fold), once per playlist. */
function seedOf(model, d) {
  if (!model.index) return null;
  if (!model.seeds.has(d.id)) model.seeds.set(d.id, seedSound([...d.trackIds], model.index));
  const s = model.seeds.get(d.id);
  return s?.ok ? s : null;
}

/**
 * Rank candidates for one playlist, best first.
 *
 * @param {object} model       from fillModel
 * @param {string} playlistId
 * @param {object[]} candidates  Spotify track objects ({ id, artists: [{ id, name }], album, ... })
 * @param {{ weights?: object, limit?: number }} [o]
 * @returns {{ declined: string|null, used: string[], results: Array<{ id: string, score: number,
 *            parts: object, why: string, shared: number }> }}
 */
export function fillRank(model, playlistId, candidates, { weights = FILL.weights, limit = Infinity,
                                                         home = FILL.home, homePower = FILL.homePower } = {}) {
  const d = model?.space?.destinations?.get(playlistId);
  if (!d) return { declined: 'NO_DEFINITION', used: [], results: [] };
  const judge = judgeFor(model, d, weights);
  const out = [];
  const seen = new Set();
  for (const t of candidates ?? []) {
    if (!t?.id || seen.has(t.id) || d.trackIds.has(t.id)) continue;
    seen.add(t.id);
    const { score, parts, heard } = judge.score(t);
    // Nothing says it fits: not a suggestion (and never a lucky tie in the measure).
    if (!(score > 0)) continue;
    const shared = (t.artists ?? []).filter(a => a?.id && d.artists.has(a.id));
    out.push({ id: t.id, score, fit: score, parts: roundParts(parts), why: whyOf(parts, judge.w, shared, d, heard),
               shared: shared.length, t });
  }
  const order = (a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  out.sort(order);
  // Home: the leaders are re-read against every other playlist, so a track that
  // fits here but fits somewhere else far better (it is "really" a Techno track
  // that also scores on House) gives way to one whose best home is this one.
  // The same comparison File makes for a track, made for the top few only.
  if (home > 0 && homePower > 0 && model.space.destinations.size > 1) {
    const head = out.slice(0, home);
    for (const r of head) {
      let best = r.fit;
      for (const q of model.space.destinations.values()) {
        if (q.id === d.id || q.trackIds.has(r.id)) continue;
        const s = judgeFor(model, q, weights).score(r.t).score;
        if (s > best) best = s;
      }
      r.home = best > 0 ? +(r.fit / best).toFixed(4) : 1;
      r.score = r.fit * Math.pow(r.home, homePower);
    }
    head.sort(order);
    out.splice(0, head.length, ...head);
  }
  for (const r of out) { r.score = +r.score.toFixed(6); delete r.t; }
  return { declined: null, used: Object.keys(judge.w), results: out.slice(0, limit) };
}

/** A scorer for one playlist: which signals it can be judged on, the same set for every candidate. Cached per model. */
function judgeFor(model, d, weights) {
  const key = d.id;
  const hit = model.judges?.get(key);
  if (hit && hit.weights === weights) return hit;
  const tagP = model.profiles?.get(d.id) ?? null;
  const seed = seedOf(model, d);
  const w = {};
  for (const k of ['graph', 'shape', ...(tagP ? ['tag'] : []), ...(seed ? ['sound'] : [])]) if (weights[k] > 0) w[k] = weights[k];
  const memo = new Map();
  const judge = { weights, w, score(t) {
    let m = memo.get(t.id);
    if (m) return m;
    const c = candidate(model, t);
    const g = c.vec.size && d.centroid.size ? graphCosine(c.vec, d.centroid, c.vecNorm, d.centroidNorm) : 0;
    const parts = { graph: graphNormalised(g, d) ?? 0 };
    if ('shape' in w) { const sh = combine(shapeScores(t, d.profile, { registrants: model.space.registrants }), SHAPE_WEIGHTS); parts.shape = sh.judged ? sh.score : 0; }
    if (tagP) parts.tag = c.tv ? Math.max(0, tagCosine(c.tv, tagP.vec)) : 0;
    if (seed) { const f = c.emb ? soundFit(c.emb, seed)?.fit : null; parts.sound = Number.isFinite(f) ? f : DISCOVER_SOUND.neutral; }
    let num = 0, den = 0;
    for (const [k, x] of Object.entries(w)) { num += x * (parts[k] ?? 0); den += x; }
    m = { score: den ? num / den : 0, parts, heard: !!c.emb };
    memo.set(t.id, m);
    return m;
  } };
  (model.judges ??= new Map()).set(key, judge);
  return judge;
}

const roundParts = p => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, +v.toFixed(4)]));

/** One short reason, from whichever signal carried the most weight. */
function whyOf(parts, w, shared, d, heard) {
  if (shared.length) {
    const a = shared[0], n = d.artistCounts.get(a.id)?.n ?? 0;
    return `${n} by ${d.artistCounts.get(a.id)?.name ?? a.name ?? 'this artist'} here`;
  }
  let best = null, bestV = 0;
  for (const k of ['graph', 'tag', 'sound']) {
    if (!(k in w) || (k === 'sound' && !heard)) continue;
    const v = w[k] * parts[k];
    if (v > bestV) { best = k; bestV = v; }
  }
  return best === 'graph' ? 'artists you file with these' : best === 'tag' ? 'same genre tags'
    : best === 'sound' ? 'sounds like it' : 'similar records';
}

/** Stable pseudo-random order for decoys: same library, same pool, every run. */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

/**
 * The gate: Fill recall@10 on this account's own playlists.
 *
 * For every playlist with at least FILL.minTracks tracks, the tracks in one
 * fold (foldOf, ~1 in `folds`) are hidden from the whole library before the
 * graph, tag centroids and sound seeds are built. Each playlist's hidden tracks
 * are then ranked among up to FILL.pool candidates: themselves, plus decoys
 * drawn (deterministically) from the other hidden tracks and the liked tracks
 * filed nowhere. recall@10 for a playlist is hidden tracks in its top 10 over
 * min(10, hidden); the account's number is the mean over playlists. `random` is
 * what a shuffled pool would score on the same playlists.
 *
 * @returns {{ recall: number|null, random: number|null, playlists: number, hidden: number,
 *            pool: number, k: number, bar: number, pass: boolean|null, used: object, version: string }}
 */
export function fillRecall(lib, { tags = null, audio = null, isMirror = null, folds = DEFAULT_FOLDS, fold = 0,
                                  k = FILL.k, pool = FILL.pool, minTracks = FILL.minTracks,
                                  weights = FILL.weights, home = FILL.home, homePower = FILL.homePower,
                                  perPlaylist = false } = {}) {
  const mirror = mirrorPredicate(lib, { also: isMirror ?? undefined });
  const playlists = (lib?.playlists ?? []).filter(p => p?.id && !mirror(p));
  const filed = new Map();
  for (const p of playlists) for (const t of p.tracks ?? []) if (t?.id && !filed.has(t.id)) filed.set(t.id, t);
  const hidden = new Set([...filed.keys()].filter(id => foldOf(id, folds) === fold));
  const eligible = playlists.filter(p => {
    const ids = new Set((p.tracks ?? []).map(t => t?.id).filter(Boolean));
    let left = 0, gone = 0;
    for (const id of ids) hidden.has(id) ? gone++ : left++;
    return ids.size >= minTracks && gone > 0 && left >= MIN_DEFINITION_TRACKS;
  });
  const empty = { recall: null, random: null, playlists: 0, hidden: 0, pool: 0, k, bar: FILL.bar, pass: null,
                  used: {}, version: FILL_VERSION };
  if (!eligible.length) return empty;

  const model = fillModel(lib, { tags, audio, isMirror, skip: hidden });
  // Every candidate has been taken out of the model: the other hidden tracks, and liked tracks filed nowhere.
  const others = new Map();
  for (const id of hidden) others.set(id, filed.get(id));
  for (const t of lib?.liked ?? []) if (t?.id && !filed.has(t.id) && !others.has(t.id)) others.set(t.id, t);
  const otherIds = [...others.keys()];

  let sumR = 0, sumRand = 0, n = 0, hiddenN = 0, poolN = 0;
  const used = {}, rows = [];
  for (const p of eligible) {
    const pos = new Set((p.tracks ?? []).map(t => t?.id).filter(id => id && hidden.has(id)));
    const decoys = otherIds.filter(id => !pos.has(id))
      .sort((a, b) => (hash(p.id + a) - hash(p.id + b)) || (a < b ? -1 : 1))
      .slice(0, Math.max(0, pool - pos.size));
    const cands = [...pos, ...decoys].map(id => others.get(id));
    const r = fillRank(model, p.id, cands, { weights, limit: k, home, homePower });
    if (r.declined) continue;
    const hits = r.results.filter(x => pos.has(x.id)).length;
    const cap = Math.min(k, pos.size);
    const rec = hits / cap;
    const rand = Math.min(1, (Math.min(k, cands.length) * pos.size / cands.length) / cap);
    sumR += rec; sumRand += rand; n++; hiddenN += pos.size; poolN += cands.length;
    const key = r.used.slice().sort().join('+');
    used[key] = (used[key] ?? 0) + 1;
    if (perPlaylist) rows.push({ id: p.id, name: p.name ?? null, hidden: pos.size, pool: cands.length, hits, recall: +rec.toFixed(4) });
  }
  if (!n) return empty;
  const recall = +(sumR / n).toFixed(4);
  return { recall, random: +(sumRand / n).toFixed(4), playlists: n, hidden: hiddenN, pool: Math.round(poolN / n),
           k, bar: FILL.bar, pass: recall >= FILL.bar, used, version: FILL_VERSION, ...(perPlaylist ? { rows } : {}) };
}

/**
 * Whether the page shows the feature, from a stored measure. Off until measured,
 * off below the bar; `force` is the owner's flag to look at it anyway.
 */
export function fillGate(measure, { force = false } = {}) {
  const r = measure?.recall;
  if (force) return { on: true, measured: Number.isFinite(r), recall: Number.isFinite(r) ? r : null, forced: true };
  if (!Number.isFinite(r)) return { on: false, measured: false, recall: null };
  return { on: r >= FILL.bar, measured: true, recall: r };
}
