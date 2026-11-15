// @bundle engine order=180 global=BetterfyPlProfile
// A playlist's sound profile, from the members listening has heard: its genre
// mix, BPM range, and whether it is really two genres that could be split.
//
// Each heard member is named by `identify` (genre › sub-genre › BPM), with one
// twist: the library votes come from sound-alikes filed in *other* genre
// playlists. Otherwise a House playlist half full of jungle would vouch for
// itself (every jungle track's sound-alikes are the other jungle tracks in
// House, filed as "house"), and the split it needs could never show.
//
// A playlist is flagged as two genres only when both halves agree:
//   - the names: two genres each hold a real share of the identified members,
//     and together nearly all of it; and
//   - the sound: the two groups sit apart, each member nearer its own group's
//     centre than the other's, by a margin.
// A sound-alike in another playlist only votes when it is about as close as
// the closest filed one (NEAR_GAP). A playlist whose name already says both ("Jungle & Breaks") is never flagged.
//
// Nearest-neighbour lookups and counts on the account's own heard tracks only
// (SMARTER-GENRES-PLAN.md §3, R3): nothing is trained, nothing leaves the
// device, nothing is pooled across accounts. With no records, nothing at all.

import { identify, genreLevel, TEMPO_CONF } from './identify.mjs';
import { nearest, genreMembership, playlistConcepts } from './match.mjs';
import { audioIndex } from '../intrinsic/audio.mjs';
import { conceptLabel } from '../recommend/gaps.mjs';

export const PLPROFILE_VERSION = '1.0.0';

/** Heard members a playlist needs before it gets a genre mix or a BPM range. */
export const MIN_HEARD = 3;
/** Heard members a playlist needs before it can be called two genres. */
export const SPLIT_MIN_HEARD = 8;
/** Each of the two genres needs at least this share of the identified members… */
export const SPLIT_MIN_SHARE = 0.25;
/** …and at least this many of them… */
export const SPLIT_MIN_TRACKS = 4;
/** …and the two together at least this share. */
export const SPLIT_MIN_PAIR = 0.7;
/** How much nearer, on average, a member is to its own group's centre than the other's (cosine). */
export const SPLIT_MIN_SEP = 0.04;
/** Share of each group that must sit nearer its own centre. */
export const SPLIT_MIN_CLEAN = 0.75;
/**
 * A sound-alike from another playlist only votes when it sounds nearly as much
 * like the track as its closest filed sound-alike does (within this much
 * cosine). Otherwise a techno track in your only Techno playlist, with its own
 * playlist left out, would be "named" by the least-unlike house tracks.
 */
export const NEAR_GAP = 0.1;
/** Sound-alikes read per track (before dropping the playlist being profiled). */
const POOL = 24;
/** Sound-alikes identify is given. */
const K = 12;

const nameOf = slug => conceptLabel(slug);

function quantile(sorted, f) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(f * (sorted.length - 1))))];
}

function sumOf(ids, index) {
  let sum = null, n = 0;
  for (const id of ids) {
    const e = index.get(id)?.emb;
    if (!e) continue;
    if (!sum) sum = new Float64Array(e.length);
    for (let i = 0; i < e.length; i++) sum[i] += e[i];
    n++;
  }
  return sum ? { sum, n } : null;
}

/** A unit vector along `sum` (minus `less`, when given), or null when it is zero. */
function unitOf(sum, less = null) {
  const v = new Float64Array(sum.length);
  let n = 0;
  for (let i = 0; i < sum.length; i++) { v[i] = sum[i] - (less ? less[i] : 0); n += v[i] * v[i]; }
  n = Math.sqrt(n);
  if (!(n > 1e-9)) return null;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

function cos(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * How far apart two groups of heard tracks sound: `sep` is the mean, over both
 * groups, of (cosine to own centre − cosine to the other's), and `clean` the
 * smaller of the two groups' shares that sit nearer their own centre.
 * Each member is measured against its own group's centre *without itself*, so
 * a small group isn't flattered by its own members.
 */
export function separation(idsA, idsB, index) {
  const A = sumOf(idsA, index), B = sumOf(idsB, index);
  if (!A || !B) return null;
  const ca = unitOf(A.sum), cb = unitOf(B.sum);
  if (!ca || !cb) return null;
  const side = (ids, own, other) => {
    let gap = 0, near = 0, n = 0;
    for (const id of ids) {
      const e = index.get(id)?.emb;
      if (!e) continue;
      const self = (own.n > 1 ? unitOf(own.sum, e) : null) ?? unitOf(own.sum);
      const d = cos(e, self) - cos(e, other);
      gap += d; if (d > 0) near++; n++;
    }
    return n ? { gap: gap / n, clean: near / n } : null;
  };
  const a = side(idsA, A, cb), b = side(idsB, B, ca);
  if (!a || !b) return null;
  return { sep: +((a.gap + b.gap) / 2).toFixed(4), clean: +Math.min(a.clean, b.clean).toFixed(3) };
}

/**
 * Works out every playlist's profile a few tracks at a time, so a page can do
 * it between frames. `step(n)` names up to n more heard tracks and returns
 * true once all are done; `result()` gives the profiles so far.
 *
 * @param {{ playlists?: object[] }} lib
 * @param {Map|Array} records  AudioRecords (a Map by id, or a list); or pass `index`
 * @param {{ index?: Map, targets?: string[]|null, isMirror?: Function|null,
 *           tagsOf?: (track: object) => string[], playlists?: string[]|null }} [o]
 *   `targets` are the genre playlists whose sound-alikes vote (as everywhere
 *   else); `playlists` limits which playlists get a profile (default: all).
 */
export function createProfiler(lib, records, { index = null, targets = null, isMirror = null, tagsOf = null, playlists = null } = {}) {
  const idx = index ?? audioIndex(records);
  const memb = genreMembership(lib, { targets, isMirror });
  const only = playlists ? new Set(playlists) : null;
  const lists = (lib?.playlists ?? []).filter(p => p?.id && (!only || only.has(p.id)));

  // Every heard member of a profiled playlist, once, with the playlists it is in.
  const work = new Map();
  for (const p of lists) for (const t of p.tracks ?? []) {
    if (!t?.id || !idx.has(t.id)) continue;
    const w = work.get(t.id) ?? { track: t, in: new Set() };
    w.in.add(p.id);
    work.set(t.id, w);
  }
  const queue = [...work.keys()];
  const named = new Map(); // `${trackId}|${playlistId}` → identify result
  let at = 0;

  function nameOne(id) {
    const { track, in: inLists } = work.get(id);
    const row = idx.get(id);
    const pool = nearest(row.emb, idx, { k: POOL, exclude: new Set([id]), filter: x => memb.of.has(x) });
    const floor = (pool[0]?.sim ?? 0) - NEAR_GAP;
    const tags = tagsOf ? [...new Set((tagsOf(track) ?? []).filter(Boolean))] : [];
    for (const pid of inLists) {
      const neighbours = [];
      for (const n of pool) {
        if (n.sim < floor) break;
        const pids = (memb.of.get(n.id) ?? []).filter(x => x !== pid);
        if (!pids.length) continue;
        neighbours.push({ ...n, playlists: pids,
          concepts: [...new Set(pids.flatMap(x => memb.playlists.get(x)?.concepts ?? []))] });
        if (neighbours.length >= K) break;
      }
      named.set(`${id}|${pid}`, identify(row.rec, { neighbours, tags }));
    }
  }

  function profileOf(p) {
    const ids = [...new Set((p.tracks ?? []).map(t => t?.id).filter(Boolean))];
    const heard = ids.filter(id => idx.has(id));
    const leaves = new Map(), genres = new Map(), bpms = [];
    let identified = 0, pending = 0;
    for (const id of heard) {
      const key = `${id}|${p.id}`;
      if (!named.has(key)) { pending++; continue; }
      const r = named.get(key);
      if (r?.bpm && r.bpm.conf >= TEMPO_CONF) bpms.push(r.bpm.value);
      if (!r?.genre) continue;
      identified++;
      const g = genres.get(r.genre.slug) ?? { slug: r.genre.slug, name: r.genre.name, n: 0, ids: [] };
      g.n++; g.ids.push(id);
      genres.set(r.genre.slug, g);
      const leaf = r.path[r.path.length - 1];
      const l = leaves.get(leaf.slug) ?? { slug: leaf.slug, name: leaf.name, n: 0 };
      l.n++;
      leaves.set(leaf.slug, l);
    }
    const share = (list, total) => [...list.values()].sort((a, b) => b.n - a.n || a.slug.localeCompare(b.slug))
      .map(x => ({ ...x, share: +(x.n / total).toFixed(3) }));
    const out = { id: p.id, heard: heard.length, members: ids.length, identified, pending,
                  genres: [], mix: [], bpm: null, bpmN: bpms.length, split: null };
    if (identified >= MIN_HEARD) {
      out.genres = share(genres, identified).map(({ ids: _ids, ...g }) => g);
      out.mix = share(leaves, identified);
    }
    if (bpms.length >= MIN_HEARD) {
      bpms.sort((a, b) => a - b);
      out.bpm = [Math.round(quantile(bpms, 0.1)), Math.round(quantile(bpms, 0.9))];
    }
    if (!pending) out.split = splitOf(p, heard.length, identified, genres);
    return out;
  }

  function splitOf(p, heard, identified, genres) {
    if (heard < SPLIT_MIN_HEARD || identified < SPLIT_MIN_TRACKS * 2) return null;
    const [a, b] = [...genres.values()].sort((x, y) => y.n - x.n || x.slug.localeCompare(y.slug));
    if (!a || !b) return null;
    const sa = a.n / identified, sb = b.n / identified;
    if (sb < SPLIT_MIN_SHARE || b.n < SPLIT_MIN_TRACKS || sa + sb < SPLIT_MIN_PAIR) return null;
    // Named for both on purpose: a mix, not a mistake.
    const says = new Set(playlistConcepts(p.name).map(genreLevel).filter(Boolean));
    if (says.has(a.slug) && says.has(b.slug)) return null;
    const sep = separation(a.ids, b.ids, idx);
    if (!sep || sep.sep < SPLIT_MIN_SEP || sep.clean < SPLIT_MIN_CLEAN) return null;
    // The half the name owns stays; the other half is what a new playlist would take.
    // With no genre in the name, the bigger half stays.
    const [keep, move] = says.has(b.slug) && !says.has(a.slug) ? [b, a] : [a, b];
    const part = g => ({ slug: g.slug, name: g.name, n: g.n, share: +(g.n / identified).toFixed(3), ids: g.ids.slice() });
    return { keep: part(keep), move: part(move), sep: sep.sep, clean: sep.clean };
  }

  return {
    get total() { return queue.length; },
    get done() { return at; },
    step(n = 50) {
      const end = Math.min(queue.length, at + Math.max(1, n));
      for (; at < end; at++) nameOne(queue[at]);
      return at >= queue.length;
    },
    /** @returns {Map<string, object>} playlist id → profile */
    result() {
      const out = new Map();
      for (const p of lists) out.set(p.id, profileOf(p));
      return out;
    },
  };
}

/** Every playlist's profile in one go (tests, the Score run). */
export function playlistProfiles(lib, records, opts = {}) {
  const pr = createProfiler(lib, records, opts);
  while (!pr.step(500));
  return pr.result();
}

/** A new playlist's name for the half a split moves out: "House — Jungle". */
export function splitName(playlistName, split) {
  return `${String(playlistName ?? '').trim() || 'Playlist'} — ${split?.move?.name ?? nameOf(split?.move?.slug) ?? 'split'}`;
}
