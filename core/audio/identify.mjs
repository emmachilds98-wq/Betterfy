// @bundle engine order=160 global=BetterfyIdentify
// What a heard track is: genre, sub-genre and tempo, with how sure, and why.
//
// Four sources, each a vote over the genre ontology (core/ontology/genres.mjs):
//   model    the audio model's Discogs styles (core/sources/audio-vocab.mjs).
//            Good at families, weak on scene genres: 29% top-1 on them in
//            phase 0 (AUDIO-ANALYSIS-PLAN.md §0). Hears donk as "hard house".
//   library  the heard tracks it sounds most like that you have already filed
//            in a genre playlist, and what those playlists' names say
//            (match.mjs `filedNeighbours`). This is what knows your scenes:
//            if it sounds like the twelve tracks in your "Donk" playlist, it
//            is donk, whatever the model calls it. Leads by default.
//   tags     the artist's tag genres, at a discount: an artist is not a track.
//   tempo    not a vote but a check (core/ontology/tempo.mjs): a genre whose
//            working range excludes a confidently measured tempo is marked
//            down, and a "87 or 174?" reading is settled by the genres heard.
//
// The votes are added up the hierarchy (a vote for jungle is a vote for drum
// & bass), the genre is the best-supported top-level genre (inside electronic,
// its children: house, techno, drum & bass…), and the path goes down while
// a child holds at least SPECIFIC of its parent's support. So a track the
// sources agree is "drum & bass" but split on which kind says "Drum & Bass",
// not a coin-flip sub-genre.
//
// Nearest-neighbour lookups and counts on the account's own library only
// (SMARTER-GENRES-PLAN.md §3, R3). Nothing is trained.

import { styleHints } from '../sources/audio-vocab.mjs';
import { GENRE_INDEX, lineageOf } from '../ontology/index.mjs';
import { tempoFit, resolveOctave } from '../ontology/tempo.mjs';
import { hybridOf } from './sections.mjs';
import { tempoOf, filedNeighbours, genreMembership } from './match.mjs';
import { audioIndex } from '../intrinsic/audio.mjs';
import { conceptLabel } from '../recommend/gaps.mjs';

export const IDENTIFY_VERSION = '1.0.0';

/** How much each source's (normalised) vote counts. */
export const SOURCES = Object.freeze({ model: 1.0, library: 1.6, tags: 0.5 });
/** A child genre is named only when it holds at least this share of its parent's support. */
export const SPECIFIC = 0.5;
/** Tempo at or above this confidence is used to check genres. */
export const TEMPO_CONF = 0.3;
/** Worst a tempo mismatch can do to a genre's support: it keeps this share. */
export const TEMPO_FLOOR = 0.35;
/** Below this share of all support, the genre is not named at all. */
export const MIN_GENRE = 0.25;

const ROOT_FAMILY = 'electronic';

/** The level a person calls "the genre": electronic's children, or a root elsewhere. */
export function genreLevel(slug) {
  const line = lineageOf(slug);
  if (!line.length) return null;
  const root = line[line.length - 1];
  if (root === ROOT_FAMILY) return line.length >= 2 ? line[line.length - 2] : root;
  return root;
}

const nameOf = slug => conceptLabel(slug);

function normalised(votes) {
  let sum = 0;
  for (const v of votes.values()) sum += v;
  if (!(sum > 0)) return new Map();
  return new Map([...votes].map(([k, v]) => [k, v / sum]));
}

function add(map, k, v) { if (k && v > 0) map.set(k, (map.get(k) ?? 0) + v); }

/** Each source's vote, normalised to sum to 1 (empty when it has nothing to say). */
function votesOf(record, { neighbours, tags }) {
  const model = new Map();
  for (const h of styleHints(record?.styles ?? [])) {
    if (GENRE_INDEX.has(h.concept)) add(model, h.concept, h.p * h.reliability);
  }
  const library = new Map();
  for (const n of neighbours ?? []) {
    const cs = (n.concepts ?? []).filter(c => GENRE_INDEX.has(c));
    const w = Math.max(0, n.sim) ** 2;
    for (const c of cs) add(library, c, w / cs.length);
  }
  const tag = new Map();
  for (const c of (tags ?? []).filter(c => GENRE_INDEX.has(c))) add(tag, c, 1);
  return { model: normalised(model), library: normalised(library), tags: normalised(tag) };
}

/**
 * @param {object} record  an AudioRecord (a miss gives null)
 * @param {{ neighbours?: Array<{sim: number, concepts: string[], playlists?: string[]}>,
 *           tags?: string[], playlistName?: (id: string) => string, weights?: object }} [o]
 * @returns {null | {
 *   genre: { slug: string, name: string, conf: number },
 *   path: Array<{ slug: string, name: string, share: number }>,
 *   sub: { slug: string, name: string, share: number } | null,
 *   bpm: { value: number, conf: number, from: 'tracker'|'genre', fit: number|null } | null,
 *   blend: [string, string] | null,
 *   support: { model: number, library: number, tags: number },
 *   why: string[], version: string }}
 */
export function identify(record, { neighbours = [], tags = [], playlistName = null, weights = SOURCES } = {}) {
  if (!record || record.miss) return null;
  const votes = votesOf(record, { neighbours, tags });

  // One weighted vote per concept.
  const flat = new Map();
  for (const [src, w] of Object.entries(weights)) for (const [c, v] of votes[src] ?? []) add(flat, c, w * v);

  // Tempo: settle the octave with the genres heard, then check each genre against it.
  const t = tempoOf(record);
  let bpm = null;
  if (t) {
    const octave = resolveOctave(t.bpm, t.alt, [...flat]);
    bpm = { value: +octave.bpm.toFixed(1), conf: t.conf, from: octave.from, fit: null };
    if (t.conf >= TEMPO_CONF) {
      for (const [c, v] of flat) {
        const f = tempoFit(bpm.value, c);
        if (f) flat.set(c, v * (TEMPO_FLOOR + (1 - TEMPO_FLOOR) * f.fit));
      }
    }
  }

  // Up the hierarchy: a vote for a sub-genre is a vote for everything above it.
  const tree = new Map();
  let total = 0;
  for (const [c, v] of flat) { total += v; for (const a of lineageOf(c)) add(tree, a, v); }
  if (!(total > 0)) return bpm ? { genre: null, path: [], sub: null, bpm, blend: null,
                                   support: { model: 0, library: 0, tags: 0 }, why: [], version: IDENTIFY_VERSION } : null;

  // The genre: the best-supported genre-level node.
  const level = new Map();
  for (const c of flat.keys()) { const g = genreLevel(c); if (g && !level.has(g)) level.set(g, tree.get(g) ?? 0); }
  const [gSlug, gMass] = [...level].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const conf = gMass / total;
  if (conf < MIN_GENRE) {
    return { genre: null, path: [], sub: null, bpm, blend: null,
             support: { model: 0, library: 0, tags: 0 }, why: ['The sources disagree too much to name a genre.'],
             version: IDENTIFY_VERSION };
  }

  // Down while a child holds enough of its parent.
  const path = [{ slug: gSlug, name: nameOf(gSlug), share: +conf.toFixed(3) }];
  for (let at = gSlug; ;) {
    const kids = (GENRE_INDEX.get(at)?.children ?? []).map(k => [k, tree.get(k) ?? 0]).filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (!kids.length) break;
    const [k, v] = kids[0], share = v / (tree.get(at) ?? 1);
    if (share < SPECIFIC) break;
    path.push({ slug: k, name: nameOf(k), share: +share.toFixed(3) });
    at = k;
  }
  if (bpm && t.conf >= TEMPO_CONF) bpm.fit = tempoFit(bpm.value, path[path.length - 1].slug)?.fit ?? null;

  // How much each source backs the genre chosen.
  const backs = src => { let s = 0; for (const [c, v] of votes[src] ?? []) if (lineageOf(c).includes(gSlug)) s += v; return +s.toFixed(3); };
  const support = { model: backs('model'), library: backs('library'), tags: backs('tags') };

  // Two genres in one clip (sections, or a near-tie at the top).
  let blend = null;
  const h = hybridOf(record);
  if (h.hybrid) {
    const named = h.styles.map(i => styleHints([[i, 1]])[0]?.concept).filter(Boolean).map(genreLevel);
    if (named.length === 2 && named[0] && named[1] && named[0] !== named[1]) blend = [nameOf(named[0]), nameOf(named[1])];
  }

  const why = [];
  if (support.library > 0) {
    const near = (neighbours ?? []).filter(n => (n.concepts ?? []).some(c => lineageOf(c).includes(gSlug)));
    const counts = new Map();
    for (const n of near) for (const p of n.playlists ?? []) counts.set(p, (counts.get(p) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1])[0];
    const label = top && playlistName ? playlistName(top[0]) : null;
    why.push(`${near.length} of the ${neighbours.length} tracks it sounds most like${label ? `, mostly in ${label},` : ''} are ${nameOf(gSlug)}`);
  }
  if (support.model > 0) {
    const heard = styleHints(record.styles ?? []).filter(x => lineageOf(x.concept).includes(gSlug)).slice(0, 2).map(x => x.name);
    if (heard.length) why.push(`the sound model hears ${heard.join(', ')}`);
  }
  if (support.tags > 0) why.push(`the artist is tagged ${nameOf(gSlug)}`);
  if (bpm?.fit != null) why.push(bpm.fit >= 0.8 ? `${Math.round(bpm.value)} BPM fits` : `${Math.round(bpm.value)} BPM is unusual for it`);

  return { genre: { slug: gSlug, name: nameOf(gSlug), conf: +conf.toFixed(3) }, path,
           sub: path.length > 1 ? path[path.length - 1] : null, bpm, blend, support, why, version: IDENTIFY_VERSION };
}

/**
 * How well `identify` names the genres of tracks you have already filed, with
 * each held out from its own neighbours. Only tracks in a genre playlist whose
 * name the ontology reads are scored (a "Bangers" playlist says nothing).
 *
 *   genre     the genre named is the genre-level node of one of its playlists
 *   specific  the most specific name is that playlist's genre, or inside it
 *   modelOnly the same two with the sound model alone (no library votes)
 *   tempo     share whose settled tempo fits one of its playlists' genres
 *
 * @param {{ index: Map, membership: {playlists: Map, of: Map}, k?: number, limit?: number }} o
 */
export function identifyAccuracy({ index, membership, k = 12, limit = 600 } = {}) {
  const ids = [...(index?.keys() ?? [])].filter(id => {
    const pids = membership?.of?.get(id) ?? [];
    return pids.some(p => membership.playlists.get(p)?.concepts?.length);
  }).sort().slice(0, limit);
  const tally = { scored: 0, genre: 0, specific: 0, model: { genre: 0, specific: 0 }, tempo: 0, tempoJudged: 0 };
  const byGenre = new Map();
  const judge = (res, truth) => {
    if (!res?.genre) return { genre: false, specific: false };
    const leaf = res.path[res.path.length - 1].slug;
    return { genre: truth.some(c => genreLevel(c) === res.genre.slug),
             specific: truth.some(c => leaf === c || lineageOf(leaf).includes(c)) };
  };
  for (const id of ids) {
    const row = index.get(id);
    const truth = [...new Set((membership.of.get(id) ?? []).flatMap(p => membership.playlists.get(p)?.concepts ?? []))];
    const res = identify(row.rec, { neighbours: filedNeighbours(id, index, membership, { k }) });
    const full = judge(res, truth);
    const alone = judge(identify(row.rec, {}), truth);
    tally.scored++;
    if (full.genre) tally.genre++;
    if (full.specific) tally.specific++;
    if (alone.genre) tally.model.genre++;
    if (alone.specific) tally.model.specific++;
    if (res?.bpm && res.bpm.conf >= TEMPO_CONF) {
      const fits = truth.map(c => tempoFit(res.bpm.value, c)?.fit).filter(f => f != null);
      if (fits.length) { tally.tempoJudged++; if (Math.max(...fits) >= 0.8) tally.tempo++; }
    }
    const g = genreLevel(truth[0]);
    const b = byGenre.get(g) ?? { slug: g, name: nameOf(g), n: 0, right: 0 };
    b.n++; if (full.genre) b.right++;
    byGenre.set(g, b);
  }
  const rate = (a, n) => (n ? +(a / n).toFixed(4) : null);
  return {
    scored: tally.scored,
    genre: rate(tally.genre, tally.scored), specific: rate(tally.specific, tally.scored),
    modelOnly: { genre: rate(tally.model.genre, tally.scored), specific: rate(tally.model.specific, tally.scored) },
    tempo: rate(tally.tempo, tally.tempoJudged), tempoJudged: tally.tempoJudged,
    byGenre: [...byGenre.values()].sort((a, b) => b.n - a.n).slice(0, 8),
    version: IDENTIFY_VERSION,
  };
}

/**
 * `identifyAccuracy` from a library and its heard records, for the Score run.
 * Null with nothing heard. `records` may be the engine's `{ records, feedback }`.
 */
export function identifyAccuracyFor(lib, records, { targets = null, isMirror = null, limit = 600, k = 12 } = {}) {
  const recs = records && !Array.isArray(records) && !(records instanceof Map) && 'records' in records ? records.records : records;
  const index = audioIndex(recs);
  if (!index.size) return null;
  const membership = genreMembership(lib, { targets, isMirror });
  const out = identifyAccuracy({ index, membership, k, limit });
  return out.scored ? out : null;
}
