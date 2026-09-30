// The same held-out protocol, applied to the tag engine.
//
// A gate is only a gate if both sides are measured the same way. It would be
// easy — and meaningless — to compare an honest k-fold number for the new engine
// against v1 scored on a library it had fully seen; v1 would look worse than it
// is, the new engine would look better than it is, and the decision would be
// made on an artefact.
//
// So this runs v1's own `buildProfiles`/`rank` through the identical fold
// assignment, over the identical truth sets, reporting the identical fields.
// Any difference in the numbers is then a difference between the engines rather
// than between two ways of asking.
import { buildProfiles, rank } from '../../profile.mjs';
import { mirrorPredicate } from '../playlists/mirror.mjs';
import { foldOf, truthOf, DEFAULT_FOLDS } from './loo.mjs';

export const BASELINE_VERSION = '4.0.0';

const rate = (n, d) => (d > 0 ? +(n / d).toFixed(4) : null);

/**
 * A copy of the library with a set of tracks removed from every playlist.
 *
 * v1 has no `skip` parameter — its centroids are built from whatever playlists
 * it is handed — so holding tracks out means handing it a library that does not
 * contain them. Shallow per-playlist copies; the track objects themselves are
 * shared, since nothing here mutates them.
 */
export function libraryWithout(lib, skip) {
  return {
    ...lib,
    playlists: (lib?.playlists ?? []).map(p => ({
      ...p,
      tracks: (p.tracks ?? []).filter(t => t?.id && !skip.has(t.id)),
    })),
  };
}

/**
 * Held-out placement accuracy for the tag engine.
 *
 * `targets` is the set of playlist ids that may receive a track. v1 normally
 * reads these from `playlists.config.json`, whose flags are generated from one
 * person's library; to keep the comparison about engines rather than about
 * configuration, the default here is the same structural rule the intrinsic
 * engine uses — every non-mirror playlist. Pass `targets` explicitly to score
 * v1 the way it actually ships.
 */
export function baselineAccuracy(lib, tags, { folds = DEFAULT_FOLDS, targets = null,
                                              axisOf = null, isMirror = null } = {}) {
  const mirror = mirrorPredicate(lib, { also: isMirror ?? undefined });
  const truth = truthOf(lib, { isMirror });

  const allowed = targets ?? new Set((lib?.playlists ?? [])
    .filter(p => p?.id && !mirror(p)).map(p => p.id));

  const byId = new Map();
  for (const p of lib?.playlists ?? []) {
    if (!p?.id || mirror(p)) continue;
    for (const t of p.tracks ?? []) if (t?.id && !byId.has(t.id)) byId.set(t.id, t);
  }

  const groups = new Map();
  for (const id of [...byId.keys()].sort()) {
    const f = foldOf(id, folds);
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(id);
  }

  let scored = 0, top1 = 0, top3 = 0, empty = 0;
  for (const [, members] of groups) {
    const skip = new Set(members);
    const held = libraryWithout(lib, skip);
    const { profiles, idf } = buildProfiles(held, tags, allowed, axisOf);

    for (const id of members) {
      const want = truth.get(id);
      if (!want?.size) continue;
      scored++;
      const ranked = rank(byId.get(id), tags, profiles, idf, { top: 3 });
      // v1 returns nothing when a track has no usable tag at all. That is not a
      // decision to abstain — it has no mechanism for one — it is simply the
      // absence of an answer, and it is counted as a miss because a filing tool
      // that returns nothing has not filed anything.
      if (!ranked.length) { empty++; continue; }
      if (want.has(ranked[0].id)) top1++;
      if (ranked.slice(0, 3).some(r => want.has(r.id))) top3++;
    }
  }

  return {
    engine: 'v1-tags',
    mode: `${folds}-fold`,
    scored,
    top1: rate(top1, scored),
    top3: rate(top3, scored),
    noAnswer: empty,
    version: BASELINE_VERSION,
  };
}
