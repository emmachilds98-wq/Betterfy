// Gaps — genres this account plays but has no genre playlist for, and genre
// playlists that are really two genres. docs/SMARTER-GENRES-PLAN.md §5.
//
// The question is the owner's, word for word: "make new playlists where I'm not
// covering genres". Two halves, both proposals and nothing more — the screen
// that shows them creates a playlist only on a tap, and never moves or removes
// a track from one that exists.
//
//  - **Uncovered genres.** Every track outside the genre playlists gets a genre
//    from its artist's tags, read through the ontology, rolled up to the level
//    people name playlists at, most specific first, so forty bassline tracks
//    become "Bassline" rather than disappearing into "UK Garage". A genre a
//    playlist names is covered. One that only sits *under* a playlist's genre
//    (donk under a "House" playlist) is still proposed when there is enough of
//    it — marked as such, after the genres nothing covers.
//  - **Two genres in one playlist.** A genre playlist whose tracks split into
//    two genres, neither inside the other, each a real share of it.
//
// Ranked by listening, as CLAUDE.md asks: a gap in what you are playing right
// now comes before a gap in what you liked four years ago. Spotify's top
// artists and recently-played are the one listening signal every account has.
//
// Works for any account with tags for its artists — the shared table, Last.fm
// if they have a key, Discogs if they have a token. Artists with no genre at all
// are counted and said, not guessed at; the unnamed clusters on the same screen
// are where those go.
import { resolveConcept, lineageOf } from '../ontology/index.mjs';
import { conceptsIn } from '../playlists/name.mjs';

export const GAPS_VERSION = '1.0.0';

/** Fewer tracks than this is not a playlist anybody needs proposing. */
export const MIN_GAP = 12;

/** Each half of a split must be at least this share of the playlist, and this many tracks. */
export const SPLIT = { minShare: 0.25, minTracks: 10 };

/** How many of an artist's tags are read for a genre, strongest first. */
const TAGS_READ = 8;

const SMALL = new Set(['and', 'of', 'the']);
const UPPER = new Map([['uk', 'UK'], ['us', 'US'], ['edm', 'EDM'], ['ebm', 'EBM'], ['idm', 'IDM'],
                       ['rnb', 'R&B'], ['dnb', 'DnB'], ['nrg', 'NRG'], ['lo', 'Lo'], ['fi', 'Fi']]);

/** A concept id as a playlist name: 'drum-and-bass' → 'Drum & Bass', 'uk-garage' → 'UK Garage'. */
export function conceptLabel(concept) {
  return String(concept ?? '').split('-').filter(Boolean).map((w, i) => {
    if (w === 'and') return '&';
    if (UPPER.has(w)) return UPPER.get(w);
    if (i > 0 && SMALL.has(w)) return w;
    return w[0].toUpperCase() + w.slice(1);
  }).join(' ').replace(/\bLo Fi\b/, 'Lo-Fi').replace(/\bHip Hop\b/, 'Hip-Hop');
}

/**
 * The genre an artist is tagged with most strongly: the first of their tags,
 * strongest first, that the ontology reads as a genre. Null for an artist with
 * no genre in their tags — a "british, 90s, chill" artist has none, and is
 * left unnamed rather than given one.
 *
 * @param {Array<[string, number]>} tags   [[tag, count], …], strongest first
 */
export function artistGenre(tags) {
  // Sorted here rather than trusted: a listener's own tag corrections are
  // appended at the end of a cloud, at whatever count they were given.
  const strongest = (tags ?? []).filter(Array.isArray).slice().sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0));
  for (const [t] of strongest.slice(0, TAGS_READ)) {
    const r = resolveConcept(String(t));
    if (r.facet === 'genre' && r.concept) return r.concept;
  }
  return null;
}

/** artistGenre over an account's tag lookup, worked out once per artist. */
export function genreLookup(tagsOf) {
  const memo = new Map();
  return id => {
    if (!memo.has(id)) memo.set(id, artistGenre(tagsOf(id)));
    return memo.get(id);
  };
}

/** A track's genre: its first-billed artist's, else the next credit that has one.
 *  `tagsOf` may be a genreLookup() result's source; pass `lookup` to reuse one. */
export function trackGenre(track, tagsOf, lookup = null) {
  const genreOf = lookup ?? (id => artistGenre(tagsOf(id)));
  for (const a of track?.artists ?? []) {
    if (!a?.id) continue;
    const g = genreOf(a.id);
    if (g) return g;
  }
  return null;
}

/** The genres a playlist's name says it is. "D&B Rollers" → drum-and-bass. */
export function playlistGenres(name) {
  return conceptsIn(name).filter(c => c.facet === 'genre' && c.concept).map(c => c.concept);
}

/** Every distinct track the account has, liked and filed, mirrors aside. */
function libraryTracks(lib, isMirror) {
  const seen = new Map();
  for (const t of lib?.liked ?? []) if (t?.id && !seen.has(t.id)) seen.set(t.id, t);
  for (const p of lib?.playlists ?? []) {
    if (!p?.id || isMirror?.(p)) continue;
    for (const t of p.tracks ?? []) if (t?.id && !seen.has(t.id)) seen.set(t.id, t);
  }
  return seen;
}

const playedBy = (track, active) => !!active?.size && (track.artists ?? []).some(a => a?.name && active.has(a.name));

/**
 * Genres the account has music in and no genre playlist for — counted over the
 * tracks that are in none of its genre playlists (liked and unfiled, or only in
 * mood, event and other playlists).
 *
 * @param {object} p
 * @param {object} p.lib
 * @param {Iterable<string>} p.targets     ids of the account's genre playlists
 * @param {(artistId: string) => Array<[string, number]>} p.tagsOf
 * @param {Set<string>} [p.active]         artist names Spotify says are being played
 * @param {Function} [p.isMirror]
 * @param {number} [p.minTracks]
 * @returns {{ gaps: object[], covered: string[], tracks: number, homeless: number, untagged: number,
 *             version: string }}
 */
export function uncoveredGenres({ lib, targets, tagsOf, active = null, isMirror = null, minTracks = MIN_GAP } = {}) {
  const genrePlaylists = new Set(targets ?? []);
  const lookup = genreLookup(tagsOf);
  const covered = new Set();
  for (const p of lib?.playlists ?? []) if (genrePlaylists.has(p.id)) for (const c of playlistGenres(p.name)) covered.add(c);
  // The nearest genre playlist above a genre, if any. A broad "House" playlist
  // *could* take donk — and treating that as covered is exactly the lumping that
  // started this work, so such a genre is still proposed when there is enough of
  // it, marked as sitting inside that playlist's genre and ranked after genres
  // nothing covers at all.
  const coveredBy = concept => lineageOf(concept).slice(1).find(c => covered.has(c)) ?? null;

  const tracks = libraryTracks(lib, isMirror);
  const liked = new Set((lib?.liked ?? []).map(t => t?.id));
  // A track already in one of the genre playlists has a home. Whether that
  // playlist is really two genres is splitCandidates()' question; counting the
  // same tracks here too proposed "UK Garage" and "split Bass into UK Garage
  // and Dubstep" for one pile of records.
  const homed = new Set();
  for (const p of lib?.playlists ?? []) if (genrePlaylists.has(p.id)) for (const t of p.tracks ?? []) if (t?.id) homed.add(t.id);
  // concept -> ids of uncovered tracks at or below it
  const under = new Map();
  let untagged = 0;
  const genreOf = new Map();
  let homeless = 0;
  for (const t of tracks.values()) {
    if (homed.has(t.id)) continue;
    homeless++;
    const g = trackGenre(t, tagsOf, lookup);
    if (!g) { untagged++; continue; }
    genreOf.set(t.id, g);
    for (const c of lineageOf(g)) {
      // A genre a playlist names outright is covered, and so is everything
      // above it: those tracks already have a playlist of exactly their genre.
      if (covered.has(c)) break;
      if (!under.has(c)) under.set(c, []);
      under.get(c).push(t.id);
    }
  }

  // Most specific first: a genre is proposed for the tracks its more specific
  // proposals have not already claimed, and only if that is still enough.
  const depth = c => lineageOf(c).length;
  const candidates = [...under].filter(([, ids]) => ids.length >= minTracks)
    .sort((a, b) => depth(b[0]) - depth(a[0]) || b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  const claimed = new Set();
  const gaps = [];
  for (const [concept, ids] of candidates) {
    const mine = ids.filter(id => !claimed.has(id));
    if (mine.length < minTracks) continue;
    for (const id of mine) claimed.add(id);
    const rows = mine.map(id => tracks.get(id));
    const played = rows.filter(t => playedBy(t, active)).length;
    // The tracks a person would want first: what they are playing, then what
    // they liked, then the rest — and within each, the exact genre before ones
    // that only sit under it.
    const order = t => (playedBy(t, active) ? 0 : 2) + (liked.has(t.id) ? 0 : 1);
    const ranked = rows.slice().sort((a, b) => order(a) - order(b)
      || (genreOf.get(a.id) === concept ? 0 : 1) - (genreOf.get(b.id) === concept ? 0 : 1)
      || String(a.name ?? '').localeCompare(String(b.name ?? '')));
    const within = coveredBy(concept);
    gaps.push({
      concept, label: conceptLabel(concept), size: mine.length, played,
      within, withinLabel: within ? conceptLabel(within) : null,
      liked: rows.filter(t => liked.has(t.id)).length,
      ids: ranked.map(t => t.id),
      artists: [...new Set(ranked.flatMap(t => (t.artists ?? []).slice(0, 1).map(a => a?.name).filter(Boolean)))].slice(0, 5),
    });
  }
  gaps.sort((a, b) => b.played - a.played || (a.within ? 1 : 0) - (b.within ? 1 : 0)
    || b.size - a.size || (a.concept < b.concept ? -1 : 1));
  return { gaps, covered: [...covered].sort(), tracks: tracks.size, homeless, untagged, version: GAPS_VERSION };
}

/**
 * Genre playlists that are really two genres.
 *
 * Two kinds of pair count:
 *  - side by side: neither genre is inside the other (UKG and grime);
 *  - one inside the other, split as "the inner one" and "the rest of the outer
 *    one" (bassline, and the rest of UK garage) — the case the owner's library
 *    is full of, and one a sibling-only rule can never see.
 * Each half must be at least `minShare` of the playlist and `minTracks` tracks.
 * Top-level genres ("Electronic") are never a half: "electronic, and the rest"
 * is not a playlist anybody wants proposed. The most balanced pair wins, then
 * the most specific.
 *
 * The playlist's own name decides the wording, not whether it is offered: a
 * "Jungle" playlist that is 40% other drum & bass is as worth knowing about as
 * a "Bass" playlist that is UKG and bassline.
 */
export function splitCandidates({ lib, targets, tagsOf, isMirror = null, ...opts } = {}) {
  const { minShare, minTracks } = { ...SPLIT, ...opts };
  const genrePlaylists = new Set(targets ?? []);
  const lookup = genreLookup(tagsOf);
  const out = [];
  for (const p of lib?.playlists ?? []) {
    if (!genrePlaylists.has(p.id) || isMirror?.(p)) continue;
    let total = 0;
    // concept -> ids of this playlist's tracks at or below it
    const rolled = new Map();
    for (const t of p.tracks ?? []) {
      if (!t?.id) continue;
      total++;
      const g = trackGenre(t, tagsOf, lookup);
      if (!g) continue;
      for (const c of lineageOf(g)) {
        if (!rolled.has(c)) rolled.set(c, new Set());
        rolled.get(c).add(t.id);
      }
    }
    if (total < 2 * minTracks) continue;
    const enough = n => n >= minTracks && n / total >= minShare;
    const nodes = [...rolled].filter(([c, set]) => lineageOf(c).length > 1 && enough(set.size));

    let best = null;
    for (let i = 0; i < nodes.length; i++) for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const [a, sa] = nodes[i], [b, sb] = nodes[j];
      const bInA = lineageOf(b).includes(a), aInB = lineageOf(a).includes(b);
      if (aInB) continue;                       // handled when the roles are swapped
      if (!bInA && a > b) continue;             // a side-by-side pair, counted once
      const outer = bInA ? [...sa].filter(id => !sb.has(id)) : [...sa];
      const inner = [...sb];
      if (!enough(outer.length) || !enough(inner.length)) continue;
      const score = Math.min(outer.length, inner.length);
      const deep = lineageOf(a).length + lineageOf(b).length;
      if (!best || score > best.score || (score === best.score && deep > best.deep))
        best = { score, deep, nested: bInA, parts: [[a, outer], [b, inner]] };
    }
    if (!best) continue;
    const own = playlistGenres(p.name);
    out.push({
      playlistId: p.id, name: p.name ?? p.id, total, nested: best.nested,
      named: own.find(c => best.parts.some(([g]) => lineageOf(g).includes(c))) ?? null,
      parts: best.parts.map(([concept, ids], k) => ({
        concept, label: conceptLabel(concept),
        // The outer half of a nested pair is "the rest of" it, and says so.
        rest: best.nested && k === 0,
        size: ids.length, share: +(ids.length / total).toFixed(3), ids,
      })),
    });
  }
  out.sort((a, b) => Math.min(...b.parts.map(x => x.size)) - Math.min(...a.parts.map(x => x.size)));
  return { splits: out, version: GAPS_VERSION };
}
