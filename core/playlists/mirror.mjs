// Playlists that are a record of everything, not a filing decision.
//
// A playlist holding (nearly) your whole library is not a place you filed
// anything — it is a copy of the library wearing a playlist's clothes.
// Betterfy makes one itself ("All Songs"), and listeners make their own:
// "Remember Everything", "Archive", "The Lot". Left in, one does four kinds
// of damage at once, all of them silent:
//
//   1. every track reads as FILED, so nothing is ever offered a home
//   2. every track's blast radius gains one, so the review queue thinks a
//      wrong answer spreads further than it does
//   3. it is a superset of every other playlist, so it buries every real
//      relationship under "contains"
//   4. it is a centroid of everything you own, so it wins every filing
//      comparison it is allowed into
//
// The whole engine's plumbing already accepts an `isMirror` predicate — and
// nothing ever passed one, so the default `() => false` meant all four were
// happening on any real library.
//
// Detected by SHAPE, not by name. v1's browser build matches the exact string
// "All Songs — Betterfy", which catches the one Betterfy makes and misses
// every one a listener made themselves — the same failure as axes.mjs's venue
// regex, one layer down. A playlist that holds nearly everything you own
// cannot be telling you where anything belongs, whatever it is called and
// whatever language it is called it in.
export const MIRROR_VERSION = '3.0.0';

/* Declared priors, not fitted — there is no benchmark for this yet, and this
 * comment is the honest label on them.
 *
 * COVERAGE is deliberately high. The cost of a false positive is a real
 * bucket silently stopping taking suggestions; the cost of a false negative
 * is the four failures above. At 0.9 a playlist has to hold nine of every ten
 * distinct tracks you own, which no genre bucket does in a library with more
 * than one genre in it — and in a library with only one, a playlist holding
 * 90% of everything still cannot discriminate between anywhere. */
export const MIRROR_COVERAGE = 0.9;
/* Below this, "holds 90% of the library" is an accident of a small library
 * rather than a fact about the playlist. */
export const MIRROR_MIN_LIBRARY = 50;

/** Every distinct track id in the library — playlists and liked songs. */
export function libraryTrackIds(lib) {
  const ids = new Set();
  for (const p of lib?.playlists ?? []) for (const t of p.tracks ?? []) if (t?.id) ids.add(t.id);
  for (const t of lib?.liked ?? []) if (t?.id) ids.add(t.id);
  return ids;
}

/**
 * Which playlists are records of everything.
 *
 * @param {object} lib
 * @param {{coverage?: number, minLibrary?: number, also?: (p: object) => boolean}} [opts]
 *        `also` marks extra playlists a caller already knows are mirrors — the
 *        app remembers its own All Songs by id, which is better evidence than
 *        any threshold and should not have to clear one.
 * @returns {{ids: Set<string>, rows: {id, name, covers, share}[], library: number}}
 */
export function mirrorsOf(lib, { coverage = MIRROR_COVERAGE, minLibrary = MIRROR_MIN_LIBRARY,
                                 also = null } = {}) {
  const all = libraryTrackIds(lib);
  const rows = [], ids = new Set();

  for (const p of lib?.playlists ?? []) {
    if (!p?.id) continue;
    const own = new Set();
    for (const t of p.tracks ?? []) if (t?.id) own.add(t.id);
    const share = all.size ? own.size / all.size : 0;
    const known = !!also?.(p);
    // A caller's own knowledge is not subject to the size floor: an app that
    // built the playlist knows what it is even in a library of twelve tracks.
    if (!known && (all.size < minLibrary || share < coverage)) continue;
    ids.add(p.id);
    rows.push({ id: p.id, name: p.name ?? '', covers: own.size,
                share: +share.toFixed(4), by: known ? 'caller' : 'coverage' });
  }

  rows.sort((a, b) => b.share - a.share);
  return { ids, rows, library: all.size, version: MIRROR_VERSION };
}

/**
 * A predicate for the `isMirror` hook the rest of the engine already takes.
 *
 * Matches on id, which is the only stable handle — two playlists can share a
 * name and a renamed playlist is still the same playlist.
 */
export function mirrorPredicate(lib, opts = {}) {
  const { ids } = mirrorsOf(lib, opts);
  return p => !!p?.id && ids.has(p.id);
}
