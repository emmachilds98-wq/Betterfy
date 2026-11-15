// @bundle engine order=170 global=BetterfyMisfit
// Tidy by sound: filed tracks whose sound strongly disagrees with their playlist.
//
// "Sounds like jungle, sits in House." For each heard track filed in exactly
// one genre playlist, look at the heard tracks it sounds most like (itself
// held out, match.mjs `filedNeighbours`) and ask which of your genre
// playlists they sit in. When almost none sit in its own playlist and most
// sit in one other, it is offered as a move, checked against what `identify`
// names it: a track the sound ID places in its own playlist's genre is never
// flagged, and only one whose ID also backs the destination can be "sure".
//
// The same neighbours measure it on held-out tracks (`misfitAccuracy`): a
// correctly filed track is pretended to sit in another playlist, and the
// question is whether it is caught and sent home. Correctly filed tracks that
// are flagged anyway give the false-alarm rate. A track's own playlist never
// enters its own neighbours, so pretending costs no rebuild.
//
// Nearest-neighbour lookups and counts on the account's own heard tracks
// only (SMARTER-GENRES-PLAN.md §3, R3). Nothing is trained, nothing leaves
// the device. With nothing heard, every function returns an empty answer.

import { filedNeighbours, genreMembership } from './match.mjs';
import { identify, genreLevel } from './identify.mjs';
import { lineageOf } from '../ontology/index.mjs';
import { audioIndex } from '../intrinsic/audio.mjs';

export const MISFIT_VERSION = '1.0.0';

/**
 * k            sound-alikes looked at per track
 * minHeard     a playlist with fewer heard members can't be judged by sound,
 *              either as the track's home or as its destination
 * curMax       its own playlist holds at most this share of its sound-alikes
 * likely       the destination holds at least this share to be offered
 * sure         … and at least this, with the sound ID backing it, to be "sure"
 */
export const MISFIT = Object.freeze({ k: 12, minHeard: 5, curMax: 0.15, likely: 0.5, sure: 0.7 });

/** Heard members per genre playlist. */
export function heardPerPlaylist(index, membership) {
  const n = new Map();
  for (const id of index?.keys() ?? []) for (const p of membership?.of?.get(id) ?? []) n.set(p, (n.get(p) ?? 0) + 1);
  return n;
}

/** Each genre playlist's share of a track's sound-alikes, weighted by similarity². */
export function neighbourShares(neighbours) {
  const mass = new Map();
  let total = 0;
  for (const nb of neighbours ?? []) {
    const w = Math.max(0, nb.sim) ** 2;
    if (!(w > 0) || !nb.playlists?.length) continue;
    total += w;
    for (const p of nb.playlists) mass.set(p, (mass.get(p) ?? 0) + w / nb.playlists.length);
  }
  if (!(total > 0)) return new Map();
  return new Map([...mass].map(([p, v]) => [p, v / total]));
}

/** Does a sound ID fall inside any of these playlist genres? null when it can't say. */
function idAgrees(id, concepts) {
  if (!id?.genre || !concepts?.length) return null;
  const leaf = id.path?.[id.path.length - 1]?.slug ?? id.genre.slug;
  const line = lineageOf(leaf);
  return concepts.some(c => genreLevel(c) === id.genre.slug || line.includes(c) || lineageOf(c).includes(leaf));
}

/**
 * The verdict on one track as if it sat in `current`. Null when it fits, or
 * when sound can't judge (not in exactly one genre playlist, too few heard).
 */
export function judge({ current, shares, heard, membership, id = null, opts = MISFIT }) {
  if (!Array.isArray(current) || current.length !== 1) return null;
  const from = current[0];
  if ((heard.get(from) ?? 0) < opts.minHeard) return null;
  const curShare = shares.get(from) ?? 0;
  if (curShare > opts.curMax) return null;
  const best = [...shares].filter(([p]) => p !== from && (heard.get(p) ?? 0) >= opts.minHeard)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0];
  if (!best || best[1] < opts.likely) return null;
  const [to, toShare] = best;
  const fromAgrees = idAgrees(id, membership.playlists.get(from)?.concepts);
  if (fromAgrees === true) return null;             // the sound ID says it belongs where it is
  const toAgrees = idAgrees(id, membership.playlists.get(to)?.concepts);
  const band = toShare >= opts.sure && toAgrees !== false ? 'sure' : 'likely';
  return { from, to, curShare: +curShare.toFixed(3), toShare: +toShare.toFixed(3), band,
           idBacks: toAgrees === true };
}

function bandOrder(b) { return b === 'sure' ? 0 : 1; }

/**
 * Filed tracks that sound like they belong in another of your genre playlists.
 * @param {{ index: Map, membership: {playlists: Map, of: Map}, tags?: (id: string) => string[],
 *           skip?: (id: string, to: string) => boolean, opts?: object }} o
 * @returns {Array<{ id, from, fromName, to, toName, curShare, toShare, band, idBacks,
 *                   sound: string|null, bpm: number|null, near: {to: number, from: number, k: number}, why: string[] }>}
 */
export function soundMisfits({ index, membership, tags = null, skip = null, opts = MISFIT } = {}) {
  if (!index?.size || !membership?.of) return [];
  const heard = heardPerPlaylist(index, membership);
  const out = [];
  for (const [tid, row] of index) {
    const current = membership.of.get(tid);
    if (current?.length !== 1 || (heard.get(current[0]) ?? 0) < opts.minHeard) continue;
    const neighbours = filedNeighbours(tid, index, membership, { k: opts.k });
    const shares = neighbourShares(neighbours);
    // Cheap check first: the ID is only worked out for tracks that might be flagged.
    if ((shares.get(current[0]) ?? 0) > opts.curMax) continue;
    const id = identify(row.rec, { neighbours, tags: tags?.(tid) ?? [] });
    const v = judge({ current, shares, heard, membership, id, opts });
    if (!v || skip?.(tid, v.to)) continue;
    const nameOf = p => membership.playlists.get(p)?.name ?? p;
    const inTo = neighbours.filter(n => n.playlists.includes(v.to)).length;
    const inFrom = neighbours.filter(n => n.playlists.includes(v.from)).length;
    const sound = id?.genre ? (id.sub?.name ?? id.genre.name) : null;
    const bpm = id?.bpm && id.bpm.conf >= 0.3 ? Math.round(id.bpm.value) : null;
    const why = [`${inTo} of the ${neighbours.length} tracks it sounds most like are in ${nameOf(v.to)}, ${inFrom} in ${nameOf(v.from)}`];
    if (sound) why.push(v.idBacks ? `it sounds like ${sound}, which fits ${nameOf(v.to)}` : `it sounds like ${sound}`);
    out.push({ id: tid, ...v, fromName: nameOf(v.from), toName: nameOf(v.to), sound, bpm,
               near: { to: inTo, from: inFrom, k: neighbours.length }, why });
  }
  return out.sort((a, b) => bandOrder(a.band) - bandOrder(b.band) || (b.toShare - b.curShare) - (a.toShare - a.curShare)
                             || a.id.localeCompare(b.id));
}

// Deterministic per-id choice, so a re-run measures the same thing.
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

/**
 * How well it finds misfiled tracks, on tracks you filed yourself, held out.
 *
 *   caught      planted misplacements flagged and sent back to their own playlist
 *   flagged     planted misplacements flagged at all
 *   falseAlarm  correctly filed tracks flagged anyway (an upper bound: some
 *               of them are real misfiles, which is the point of the screen)
 *   sure        the same three for the "sure" band alone
 *
 * Only tracks in exactly one genre playlist with enough heard members are
 * scored, and only playlists with enough heard members are planted into.
 */
export function misfitAccuracy({ index, membership, opts = MISFIT, limit = 600 } = {}) {
  if (!index?.size || !membership?.of) return null;
  const heard = heardPerPlaylist(index, membership);
  const judgeable = [...heard].filter(([, n]) => n >= opts.minHeard).map(([p]) => p).sort();
  if (judgeable.length < 2) return null;
  const ids = [...index.keys()].filter(id => {
    const cur = membership.of.get(id);
    return cur?.length === 1 && (heard.get(cur[0]) ?? 0) >= opts.minHeard;
  }).sort().slice(0, limit);
  const t = { scored: 0, caught: 0, flagged: 0, falseAlarm: 0, sure: { n: 0, caught: 0, falseAlarm: 0 } };
  for (const tid of ids) {
    const home = membership.of.get(tid)[0];
    const neighbours = filedNeighbours(tid, index, membership, { k: opts.k });
    const shares = neighbourShares(neighbours);
    const id = identify(index.get(tid).rec, { neighbours });
    t.scored++;
    const real = judge({ current: [home], shares, heard, membership, id, opts });
    if (real) { t.falseAlarm++; if (real.band === 'sure') t.sure.falseAlarm++; }
    const others = judgeable.filter(p => p !== home);
    const planted = others[hash(tid) % others.length];
    const v = judge({ current: [planted], shares, heard, membership, id, opts });
    if (v) {
      t.flagged++;
      if (v.to === home) t.caught++;
      if (v.band === 'sure') { t.sure.n++; if (v.to === home) t.sure.caught++; }
    }
  }
  const rate = (a, n) => (n ? +(a / n).toFixed(4) : null);
  return { scored: t.scored, caught: rate(t.caught, t.scored), flagged: rate(t.flagged, t.scored),
           falseAlarm: rate(t.falseAlarm, t.scored),
           sure: { caught: rate(t.sure.caught, t.scored), precision: rate(t.sure.caught, t.sure.n),
                   falseAlarm: rate(t.sure.falseAlarm, t.scored) },
           version: MISFIT_VERSION };
}

/**
 * Both, from a library and its heard records, for the page (run in the engine
 * worker). `records` may be the engine's `{ records, feedback }`; a track's
 * "not that playlist" verdicts in `feedback` keep it from being offered there.
 */
export function soundMisfitsFor(lib, records, { targets = null, isMirror = null, measure = true, limit = 600 } = {}) {
  const wrapped = records && !Array.isArray(records) && !(records instanceof Map) && 'records' in records;
  const recs = wrapped ? records.records : records;
  const feedback = wrapped ? records.feedback ?? {} : {};
  const index = audioIndex(recs);
  if (!index.size) return { rows: [], accuracy: null, heard: 0, version: MISFIT_VERSION };
  const membership = genreMembership(lib, { targets, isMirror });
  const skip = (id, to) => (feedback[id]?.rejected ?? []).includes(to);
  return { rows: soundMisfits({ index, membership, skip }),
           accuracy: measure ? misfitAccuracy({ index, membership, limit }) : null,
           heard: index.size, version: MISFIT_VERSION };
}
