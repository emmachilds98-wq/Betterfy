// What to ask Spotify, in what order, and when not to ask at all
// (docs/RELEASE-RADAR-PLAN.md §3, §5).
//
// There is no bulk "new releases for these artists" endpoint: it is requests
// per artist. Since February 2026 that is more than the plan assumed, because
// `/artists/{id}/albums` pages at most 10 items and its items no longer say
// which `include_groups` group they came from. So each artist is read as one
// request per group (album, single, appears_on), newest first, stopping at the
// first page that reaches back past the window: a group asked for alone comes
// back newest first, so one page usually answers it. Two passes: every
// artist's own releases (album, single) first, in listening order, so a sync
// interrupted half way has the main feed for the artists you play; then the
// features lane (appears_on), which is collapsed by default anyway.
//
// Cadence (§3, a declared prior until Phase 0 measures it):
//   last release within 90 days  -> re-check after 7 days
//   within 2 years               -> 30 days
//   older, or nothing found      -> 90 days
// Two refinements, both declared, both measured by simulate.mjs:
//   - each artist's interval is stretched by a fixed 0-25% (a hash of its id),
//     so a thousand artists first read on the same day do not all fall due on
//     the same day again (without it, day 30 of the simulation asked for ~2,300
//     requests in one go);
//   - the features lane (appears_on) waits twice as long as the main lane: it
//     is the collapsed strip, and it is a third of every re-check's cost.
// A group that failed is due again at once; a record of an older `shape` is
// treated as never read.
//
// Storage keys (IndexedDB `betterfy`/`kv` in the page, a JSON file for the CLI):
//   radar:artist:{id}    per-artist state, below
//   radar:release:{key}  one release (normalise.mjs)
//   radar:index          { shape, at, artists, releases, done, total, complete, stopped, cold }
import { DAY_MS } from './dates.mjs';
import { SHAPE, GROUPS } from './normalise.mjs';

export { SHAPE, GROUPS };

export const KEY = Object.freeze({
  artist: id => `radar:artist:${id}`,
  release: key => `radar:release:${key}`,
  index: 'radar:index',
  prefix: 'radar:',
  releasePrefix: 'radar:release:',
});

/** The main lane's groups and the features lane's, in the order the passes run. */
export const MAIN_GROUPS = Object.freeze(['album', 'single']);
export const FEATURE_GROUPS = Object.freeze(['appears_on']);

/** Spotify's page size for `/artists/{id}/albums` since February 2026 (was 50). */
export const PAGE_LIMIT = 10;
/** Never page one group further back than this in one sync. */
export const MAX_PAGES = 20;

export const CADENCE = Object.freeze([
  Object.freeze({ within: 90 * DAY_MS, after: 7 * DAY_MS }),
  Object.freeze({ within: 730 * DAY_MS, after: 30 * DAY_MS }),
  Object.freeze({ within: Infinity, after: 90 * DAY_MS }),
]);

/** The features lane's interval, as a multiple of the main lane's. */
export const FEATURES_SLOWER = 2;
/** The most an artist's interval is stretched to spread re-checks out. */
export const SPREAD = 0.25;

/** A stable number in [0, 1) from an artist id (FNV-1a). */
export function spreadOf(id) {
  let h = 0x811c9dc5;
  for (const c of String(id ?? '')) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h / 4294967296;
}

/** How long after a check to check again, from the artist's newest release. */
export function recheckAfter(lastReleaseTs, now, { id = null, group = 'album' } = {}) {
  const age = Number.isFinite(lastReleaseTs) ? now - lastReleaseTs : Infinity;
  const base = CADENCE.find(c => age <= c.within).after;
  return base * (FEATURE_GROUPS.includes(group) ? FEATURES_SLOWER : 1) * (1 + SPREAD * (id == null ? 0 : spreadOf(id)));
}

/** A fresh per-artist state. */
export const newArtistState = a => ({ shape: SHAPE, id: a.id, name: a.name ?? '', checked: {},
  lastReleaseTs: null, releaseKeys: [], errors: {} });

/** Is this artist's `group` due for a check at `now`? */
export function isDue(state, group, now) {
  if (!state || state.shape !== SHAPE) return true;
  if (state.errors?.[group]) return true;
  const at = state.checked?.[group];
  if (!Number.isFinite(at)) return true;
  return now - at >= recheckAfter(state.lastReleaseTs, now, { id: state.id, group });
}

/**
 * The list requests to make, in order: `[{ artistId, name, group }]`.
 * `artists` is artistSet()'s order (most listened first); `states` a Map of
 * artist id -> stored state. `groups` narrows the groups (e.g. main lane only).
 */
export function planTasks(artists, states, now, { groups = GROUPS } = {}) {
  const want = g => groups.includes(g);
  const out = [];
  for (const pass of [MAIN_GROUPS, FEATURE_GROUPS])
    for (const a of artists) for (const g of pass)
      if (want(g) && isDue(states.get(a.id), g, now)) out.push({ artistId: a.id, name: a.name, group: g });
  return out;
}

/** Seconds per request the page actually sustains: `sp()`'s floor gap is 250ms, plus the round trip. */
export const SEC_PER_REQUEST = 0.35;

/**
 * An honest time estimate before a sync starts: one request per due group
 * (most fit in one page), plus a share of track-list reads. `detailRate` is
 * the expected `/albums/{id}` reads per artist on a cold sync, measured on the
 * simulated library (simulate.mjs) until Phase 0 replaces it with a real one.
 */
export function estimate(tasks, { detailRate = 0.5, artists = null, secPerRequest = SEC_PER_REQUEST } = {}) {
  const n = artists ?? new Set(tasks.map(t => t.artistId)).size;
  const requests = Math.round(tasks.length * 1.04 + n * detailRate);
  return { requests, minutes: Math.max(1, Math.round(requests * secPerRequest / 60)) };
}
