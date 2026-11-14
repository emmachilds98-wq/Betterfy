// New playlists by sound (docs/AUDIO-BUILD-PLAN.md WP-H2).
//
// The tag half of this screen (gaps.mjs) can only see genres somebody has
// tagged. This half looks at how the account's own unfiled tracks *sound*
// against its own genre playlists, and proposes three things:
//
//  - **Pick one of these two.** Tracks that sound like two of your playlists
//    about equally. Grouped by the pair, so the question is asked once for a
//    pile of records, not once per track.
//  - **A hybrid playlist.** A tight group of tracks that sits *between* two
//    playlists: close to both, inside neither, closer to the midpoint than to
//    either. Named from the group's top two styles (core/sources/audio-vocab),
//    with how many of them change style mid-clip (core/audio/sections) as
//    supporting evidence.
//  - **New genre?** A tight group near none of your playlists. Left unnamed:
//    the model's style labels are weak on scene genres (29% top-1 in phase 0),
//    so naming it is the listener's job until WP-C3.
//
// Proposals only. Nothing here creates, moves or removes anything; the screen
// does that on a tap. Because they are suggestions to *create*, not filing
// changes, they are shown whatever WP-E2's gate says, and always say "by
// sound". Uses only this account's records and playlists — nothing pooled
// across accounts (docs/SMARTER-GENRES-PLAN.md §3).
//
// With no records every list is empty, and the screen renders what it did
// before this file existed.
import { audioIndex, buildAudioProfiles, MIN_AUDIO_MEMBERS } from '../intrinsic/audio.mjs';
import { styleHints } from '../sources/audio-vocab.mjs';
import { hybridOf, MIN_STYLE_P } from '../audio/sections.mjs';

export const AUDIO_GAPS_VERSION = '1.0.0';

// Every closeness below is measured in the account's own units, never as a raw
// cosine: how close two tracks of one genre sit depends on the model and on
// the library (EffNet embeddings are all fairly alike in absolute terms, and
// high-dimensional cosines bunch up).
//
//  - **fit** to a playlist: (cosine to its centre − `outside`) / (`inside` −
//    `outside`), where `inside` is the median cosine of its own members to
//    that centre and `outside` the median of the account's *other* genre
//    playlists' members. 1 sounds like a typical member, 0 like music from
//    another of your playlists.
//  - **neighbour** and **tightness** default to the account's own playlists:
//    two tracks are neighbours when they are as close as two members of a
//    typical playlist usually are (its lower quartile pair), and a group is
//    tight when its members sit as close to their centre as a typical
//    playlist's lower quartile does.
export const SOUND = Object.freeze({
  /** A track fitting both of its top two at least this well, and… */
  pickFit: 0.35,
  /** …with them closer than this, is a toss-up between them. */
  pickMargin: 0.15,
  /** Fewer tracks than this sharing one pair is not worth asking about on this screen. */
  minPick: 3,
  /** With learned probabilities: the top two within this, and together at least `pickMass`. */
  probMargin: 0.15,
  pickMass: 0.6,
  /** Cosine at which two tracks are neighbours; null = from the account's playlists. */
  neighbour: null,
  /** A group needs this many tracks to be a playlist anybody would want proposed. */
  minCluster: 8,
  /** Mean member cosine to the group's centre; null = from the account's playlists. */
  tightness: null,
  /** Hybrid: both of the two nearest playlists fit at least this well (group mean)… */
  nearFit: 0.35,
  /** …within this of each other… */
  hybridMargin: 0.3,
  /** …and clear of the third by this much. */
  hybridGap: 0.25,
  /** New genre: no playlist fits the group better than this. */
  orphanFit: 0.35,
  /** Groups are looked for among at most this many tracks, most played first (O(n²)). */
  maxTracks: 1200,
});

const idOf = t => (typeof t === 'string' ? t : t?.id) || null;

function dot(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

function unitSum(vs) {
  const out = new Float64Array(vs[0].length);
  for (const v of vs) for (let i = 0; i < out.length; i++) out[i] += v[i];
  let ss = 0;
  for (let i = 0; i < out.length; i++) ss += out[i] * out[i];
  if (!(ss > 0)) return null;
  const inv = 1 / Math.sqrt(ss);
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
}

function quantile(xs, q) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const at = (s.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at);
  return s[lo] + (s[hi] - s[lo]) * (at - lo);
}

const playedBy = (track, active) => !!active?.size && (track?.artists ?? []).some(a => a?.name && active.has(a.name));
const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
const r4 = x => +x.toFixed(4);

/** Learned output in any of the shapes the learner hands back → Map<playlistId, number>. */
function asMap(x) {
  if (!x) return null;
  if (x instanceof Map) return x;
  if (Array.isArray(x)) return new Map(x);
  if (typeof x === 'object') return new Map(Object.entries(x));
  return null;
}

/**
 * The account's genre playlists as sound: centre, and how close its own
 * members and everyone else's sit to it, for those with enough heard members.
 * Mirrors and non-genre playlists are not destinations.
 */
export function soundPlaylists({ lib, targets, index, isMirror = null, minMembers = MIN_AUDIO_MEMBERS } = {}) {
  const allowed = new Set(targets ?? []);
  const dests = (lib?.playlists ?? []).filter(p => p?.id && allowed.has(p.id) && !isMirror?.(p))
    .map(p => ({ id: p.id, name: p.name ?? p.id, tracks: p.tracks ?? [] }));
  const { profiles } = buildAudioProfiles(dests, index, { minMembers });
  const lists = [];
  for (const d of dests) {
    const prof = profiles.get(d.id);
    if (!prof?.centroid || prof.members < minMembers) continue;
    // At most 40 members each: 780 pairs, and plenty for a median.
    const some = [...prof.ids].sort().slice(0, 40);
    const own = some.map(id => dot(index.get(id).emb, prof.centroid));
    const pair = [];
    for (let i = 0; i < some.length; i++) for (let j = i + 1; j < some.length; j++)
      pair.push(dot(index.get(some[i]).emb, index.get(some[j]).emb));
    lists.push({ id: d.id, name: d.name, centroid: prof.centroid, members: prof.members, some,
                 inside: quantile(own, 0.5), coherence: quantile(own, 0.25), pair: quantile(pair, 0.25) });
  }
  for (const l of lists) {
    const others = lists.filter(x => x !== l).flatMap(x => x.some.filter(id => !l.some.includes(id)));
    l.outside = others.length ? quantile(others.map(id => dot(index.get(id).emb, l.centroid)), 0.5) : 0;
    l.scale = Math.max(l.inside - l.outside, 1e-3);
  }
  return lists.map(({ some, ...l }) => l);
}

/** The group's top styles, summed over members, as named hints with distinct concepts. */
function topStyles(ids, index, k = 2) {
  const sum = new Map();
  for (const id of ids) for (const [i, p] of index.get(id)?.styles ?? []) sum.set(i, (sum.get(i) ?? 0) + p);
  const ranked = [...sum].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([i, p]) => [i, p / ids.length]);
  const out = [], seen = new Set();
  for (const h of styleHints(ranked)) {
    // A style at a few percent is the model shrugging, not a name.
    if (h.p < MIN_STYLE_P) break;
    if (seen.has(h.concept)) continue;
    seen.add(h.concept);
    out.push({ name: h.name, concept: h.concept, p: r4(h.p) });
    if (out.length === k) break;
  }
  return out;
}

/**
 * Tight groups among these tracks. Deterministic: the track with the most
 * close neighbours seeds a group of itself and its unclaimed neighbours, which
 * is kept only if it is big and tight enough; then the next, and so on. Random
 * noise has almost no close neighbours, so it forms no group.
 */
export function tightGroups(ids, index, { neighbour, minCluster = SOUND.minCluster, tightness } = {}) {
  if (!Number.isFinite(neighbour) || !Number.isFinite(tightness)) return [];
  const embs = ids.map(id => index.get(id).emb);
  const near = ids.map(() => []);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    if (dot(embs[i], embs[j]) >= neighbour) { near[i].push(j); near[j].push(i); }
  }
  const order = ids.map((_, i) => i).sort((a, b) => near[b].length - near[a].length || (ids[a] < ids[b] ? -1 : 1));
  const taken = new Set();
  const groups = [];
  for (const seed of order) {
    if (taken.has(seed) || near[seed].length + 1 < minCluster) continue;
    const members = [seed, ...near[seed].filter(j => !taken.has(j))];
    if (members.length < minCluster) continue;
    const centre = unitSum(members.map(i => embs[i]));
    if (!centre) continue;
    const tight = mean(members.map(i => dot(embs[i], centre)));
    if (tight < tightness) continue;
    for (const i of members) taken.add(i);
    groups.push({ ids: members.map(i => ids[i]).sort(), tightness: r4(tight) });
  }
  return groups;
}

/**
 * Every proposal by sound for one account.
 *
 * @param {object} p
 * @param {object} p.lib
 * @param {Iterable<string>} p.targets     ids of the account's genre playlists
 * @param {Iterable<object>|Map|object} [p.records]  audio records (or pass `index`)
 * @param {Map} [p.index]                  from audioIndex, if already built
 * @param {(trackId: string) => Map|Array|object|null} [p.learned]
 *        per-playlist probabilities from the learner (WP-L1), when the caller has
 *        them; the toss-up test then reads those instead of raw closeness
 * @param {Set<string>} [p.active]         artist names Spotify says are being played
 * @param {Function} [p.isMirror]
 * @returns {{ pick: object[], hybrids: object[], orphans: object[], heard: number, version: string }}
 */
export function soundProposals({ lib, targets, records = null, index = null, learned = null, active = null,
                                 isMirror = null, mel = undefined, ...opts } = {}) {
  const o = { ...SOUND, ...opts };
  const empty = { pick: [], hybrids: [], orphans: [], heard: 0, version: AUDIO_GAPS_VERSION };
  const idx = index ?? audioIndex(records, { mel });
  if (!idx?.size) return empty;
  const lists = soundPlaylists({ lib, targets, index: idx, isMirror });
  if (lists.length < 2) return empty;
  const byList = new Map(lists.map(l => [l.id, l]));
  const fit = (emb, l) => (dot(emb, l.centroid) - l.outside) / l.scale;
  const groupOpts = { minCluster: o.minCluster,
    neighbour: o.neighbour ?? quantile(lists.map(l => l.pair), 0.5),
    tightness: o.tightness ?? quantile(lists.map(l => l.coherence), 0.5) };

  // The tracks with no genre playlist yet, exactly as gaps.mjs counts them.
  const allowed = new Set(targets ?? []);
  const homed = new Set();
  for (const p of lib?.playlists ?? []) if (allowed.has(p.id)) for (const t of p.tracks ?? []) if (t?.id) homed.add(t.id);
  const tracks = new Map();
  for (const t of lib?.liked ?? []) if (t?.id && !tracks.has(t.id)) tracks.set(t.id, t);
  for (const p of lib?.playlists ?? []) {
    if (!p?.id || isMirror?.(p)) continue;
    for (const t of p.tracks ?? []) if (t?.id && !tracks.has(t.id)) tracks.set(t.id, t);
  }
  const liked = new Set((lib?.liked ?? []).map(idOf));
  const rank = id => (playedBy(tracks.get(id), active) ? 0 : 2) + (liked.has(id) ? 0 : 1);
  const heard = [...tracks.keys()].filter(id => !homed.has(id) && idx.has(id))
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  if (!heard.length) return empty;

  const byFit = rows => rows.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const fitOf = new Map(heard.map(id => [id, byFit(lists.map(l => [l.id, fit(idx.get(id).emb, l)]))]));
  const played = ids => ids.filter(id => playedBy(tracks.get(id), active)).length;
  const artists = ids => [...new Set(ids.flatMap(id => (tracks.get(id)?.artists ?? []).slice(0, 1).map(a => a?.name).filter(Boolean)))].slice(0, 5);
  const pl = id => ({ id, name: byList.get(id).name });

  // Groups first: a pile of tracks that is its own thing should be proposed as
  // that, not asked about one pair at a time.
  const hybrids = [], orphans = [], grouped = new Set();
  for (const g of tightGroups(heard.slice(0, o.maxTracks), idx, groupOpts)) {
    const fits = byFit(lists.map(l => [l.id, mean(g.ids.map(id => fit(idx.get(id).emb, l)))]));
    const [[a, fa], [b, fb]] = fits, fc = fits[2]?.[1] ?? -Infinity;
    const ids = g.ids.slice().sort((x, y) => rank(x) - rank(y) || (x < y ? -1 : 1));
    const base = { size: ids.length, played: played(ids), liked: ids.filter(id => liked.has(id)).length,
                   tightness: g.tightness, ids, artists: artists(ids), styles: topStyles(ids, idx) };
    if (fa < o.orphanFit) {
      for (const id of ids) grouped.add(id);
      orphans.push({ kind: 'orphan', ...base, nearest: { ...pl(a), fit: r4(fa) } });
      continue;
    }
    // Between: both near, neither ahead, the third far behind, and the
    // midpoint of the two nearer than either.
    const mid = unitSum([byList.get(a).centroid, byList.get(b).centroid]);
    const toMid = mid ? mean(ids.map(id => dot(idx.get(id).emb, mid))) : -Infinity;
    const toA = mean(ids.map(id => dot(idx.get(id).emb, byList.get(a).centroid)));
    const toB = mean(ids.map(id => dot(idx.get(id).emb, byList.get(b).centroid)));
    if (fb >= o.nearFit && fa - fb <= o.hybridMargin && fb - fc >= o.hybridGap && toMid > Math.max(toA, toB)) {
      for (const id of ids) grouped.add(id);
      const mixed = ids.filter(id => hybridOf(idx.get(id).rec).hybrid).length;
      const name = base.styles.length >= 2 ? `${base.styles[0].name} / ${base.styles[1].name}`
        : `${byList.get(a).name} / ${byList.get(b).name}`;
      hybrids.push({ kind: 'hybrid', ...base, name, between: [{ ...pl(a), fit: r4(fa) }, { ...pl(b), fit: r4(fb) }], mixed });
    }
    // Otherwise it sits inside one playlist: filing's job, not a new playlist.
  }

  // Toss-ups, grouped by the pair.
  const pairs = new Map();
  for (const id of heard) {
    if (grouped.has(id)) continue;
    let pair = null;
    const probs = learned ? asMap(learned(id)) : null;
    if (probs?.size >= 2) {
      const top = [...probs].filter(([k, v]) => byList.has(k) && Number.isFinite(v))
        .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
      if (top.length >= 2 && top[0][1] - top[1][1] <= o.probMargin && top[0][1] + top[1][1] >= o.pickMass)
        pair = [top[0][0], top[1][0]];
    } else {
      const [[a, fa], [b, fb]] = fitOf.get(id);
      if (fb >= o.pickFit && fa - fb <= o.pickMargin) pair = [a, b];
    }
    if (!pair) continue;
    const key = pair.slice().sort().join('\u0000');
    if (!pairs.has(key)) pairs.set(key, { lists: pair.slice().sort(), ids: [] });
    pairs.get(key).ids.push(id);
  }
  const pick = [...pairs.values()].filter(p => p.ids.length >= o.minPick).map(p => ({
    kind: 'pick', between: p.lists.map(pl), size: p.ids.length, played: played(p.ids),
    liked: p.ids.filter(id => liked.has(id)).length, ids: p.ids, artists: artists(p.ids),
  }));

  const order = (x, y) => y.played - x.played || y.size - x.size || (x.ids[0] < y.ids[0] ? -1 : 1);
  return { pick: pick.sort(order), hybrids: hybrids.sort(order), orphans: orphans.sort(order),
           heard: heard.length, version: AUDIO_GAPS_VERSION };
}
