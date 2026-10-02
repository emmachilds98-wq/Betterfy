// Build the space once, not once per page load.
//
// The measurement in docs/THINKING-ENGINE-PLAN.md §12 is what makes this a
// requirement rather than an optimisation: building the space for a mid-sized
// library takes one to four seconds and hundreds of megabytes. Placing against
// it afterwards costs about 5 ms, which is a responsive list — so the whole
// problem is the build, and the whole answer is to do it once per snapshot and
// keep the result.
//
// Two rules make a cache safe to trust, and both are about knowing when to throw
// it away:
//
//   - **Version it.** A cache written by a different engine version describes a
//     different computation. Reviving it would produce answers no code in the
//     repo can reproduce, which is worse than recomputing.
//   - **Fingerprint the library.** A cache is only valid for the library it was
//     built from. Filing three tracks changes the graph, and an engine quietly
//     serving yesterday's answers is a bug nobody can see.
//
// Deliberately plain JSON rather than a compact binary form: this has to survive
// `structuredClone` into IndexedDB and a round trip through `JSON.stringify` in
// Node, and a format anybody can read in a debugger is worth more than the bytes
// a clever one would save.
import { SPACE_VERSION } from './space.mjs';
import { COOCCURRENCE_VERSION } from './cooccurrence.mjs';
import { FEATURES_VERSION } from './features.mjs';

export const PERSIST_VERSION = '4.0.0';

/** Every version that, if changed, invalidates a cache. */
export const ENGINE_STAMP = `${PERSIST_VERSION}/${SPACE_VERSION}/${COOCCURRENCE_VERSION}/${FEATURES_VERSION}`;

/**
 * A cheap, order-independent fingerprint of what the engine actually reads.
 *
 * Playlist ids and their track ids, because those are what the graph and every
 * bucket definition are computed from. Deliberately not a hash of the whole
 * library: `captured_at` changes on every snapshot and `popularity` drifts on
 * its own, and invalidating the cache for either would mean never using it.
 *
 * FNV-1a over a sorted projection — stable across runs, which a hash of object
 * iteration order would not be.
 */
export function fingerprint(lib) {
  const parts = [];
  for (const p of lib?.playlists ?? []) {
    if (!p?.id) continue;
    const ids = (p.tracks ?? []).map(t => t?.id).filter(Boolean).sort();
    parts.push(`${p.id}:${ids.length}:${ids.join(',')}`);
  }
  parts.sort();
  const s = parts.join('|');

  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}-${parts.length}-${s.length}`;
}

const mapToArray = m => [...(m ?? new Map()).entries()];
const arrayToMap = a => new Map(a ?? []);

/** A space as plain JSON. */
export function serialiseSpace(space, lib) {
  return {
    stamp: ENGINE_STAMP,
    fingerprint: fingerprint(lib),
    builtAt: Date.now(),
    graph: {
      ppmi: mapToArray(space.graph.ppmi).map(([a, row]) => [a, mapToArray(row)]),
      df: mapToArray(space.graph.df),
      playlists: space.graph.playlists,
      artists: space.graph.artists,
      pairsConsidered: space.graph.pairsConsidered,
      wideSkipped: space.graph.wideSkipped,
      version: space.graph.version,
    },
    registrants: {
      span: mapToArray(space.registrants.span),
      playlists: space.registrants.playlists,
      version: space.registrants.version,
    },
    baseline: {
      albumType: mapToArray(space.baseline.albumType),
      era: mapToArray(space.baseline.era),
      n: space.baseline.n,
    },
    bonus: { byTrack: mapToArray(space.bonus?.byTrack), size: space.bonus?.size ?? 0,
             version: space.bonus?.version ?? null },
    destinations: mapToArray(space.destinations).map(([id, d]) => [id, {
      id: d.id, name: d.name, n: d.n,
      centroid: mapToArray(d.centroid),
      centroidNorm: d.centroidNorm,
      artists: [...d.artists],
      artistCounts: mapToArray(d.artistCounts),
      registrantCounts: mapToArray(d.registrantCounts),
      trackIds: [...d.trackIds],
      bonusProfile: d.bonusProfile ? {
        n: d.bonusProfile.n, bpmCount: d.bonusProfile.bpmCount,
        bpm: d.bonusProfile.bpm, keys: mapToArray(d.bonusProfile.keys),
        keyCount: d.bonusProfile.keyCount,
      } : null,
      profile: {
        id: d.profile.id, n: d.profile.n,
        minutes: d.profile.minutes, albumTracks: d.profile.albumTracks,
        popularity: d.profile.popularity,
        albumType: mapToArray(d.profile.albumType),
        era: mapToArray(d.profile.era),
        registrant: mapToArray(d.profile.registrant),
        version: d.profile.version,
      },
    }]),
    version: space.version,
  };
}

/**
 * Rebuild a space from JSON, or return null if the cache must not be used.
 *
 * Null rather than throwing, and null rather than a partial revival: every
 * caller's correct response to a stale cache is the same — build a fresh one —
 * and giving them a second failure mode to handle would only invite one of them
 * to handle it wrongly.
 */
export function reviveSpace(json, lib) {
  if (!json || typeof json !== 'object') return null;
  if (json.stamp !== ENGINE_STAMP) return null;
  if (lib !== undefined && json.fingerprint !== fingerprint(lib)) return null;
  if (!Array.isArray(json.destinations)) return null;

  try {
    return {
      graph: {
        ppmi: new Map((json.graph?.ppmi ?? []).map(([a, row]) => [a, arrayToMap(row)])),
        df: arrayToMap(json.graph?.df),
        playlists: json.graph?.playlists ?? 0,
        artists: json.graph?.artists ?? 0,
        pairsConsidered: json.graph?.pairsConsidered ?? 0,
        wideSkipped: json.graph?.wideSkipped ?? 0,
        version: json.graph?.version ?? null,
      },
      registrants: {
        span: arrayToMap(json.registrants?.span),
        playlists: json.registrants?.playlists ?? 0,
        version: json.registrants?.version ?? null,
      },
      baseline: {
        albumType: arrayToMap(json.baseline?.albumType),
        era: arrayToMap(json.baseline?.era),
        n: json.baseline?.n ?? 0,
      },
      bonus: { byTrack: arrayToMap(json.bonus?.byTrack), size: json.bonus?.size ?? 0,
               version: json.bonus?.version ?? null },
      destinations: new Map((json.destinations ?? []).map(([id, d]) => [id, {
        id: d.id, name: d.name, n: d.n,
        centroid: arrayToMap(d.centroid),
        centroidNorm: d.centroidNorm,
        artists: new Set(d.artists ?? []),
        artistCounts: arrayToMap(d.artistCounts),
        registrantCounts: arrayToMap(d.registrantCounts),
        trackIds: new Set(d.trackIds ?? []),
        bonusProfile: d.bonusProfile ? {
          ...d.bonusProfile, keys: arrayToMap(d.bonusProfile.keys),
        } : null,
        profile: {
          ...d.profile,
          albumType: arrayToMap(d.profile?.albumType),
          era: arrayToMap(d.profile?.era),
          registrant: arrayToMap(d.profile?.registrant),
        },
      }])),
      version: json.version ?? null,
      revived: true,
    };
  } catch {
    // A malformed cache is the same situation as a stale one.
    return null;
  }
}
