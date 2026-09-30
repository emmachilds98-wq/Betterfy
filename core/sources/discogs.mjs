// Discogs adapter.
//
// v1 uses Discogs only as a fallback, consulted when Last.fm has nothing or
// almost nothing (tagstore.mjs). §7 says explicitly not to: Discogs is a
// *release-level* catalogue maintained by people who care about pressings,
// and its `style` array is often the more precise answer even when Last.fm
// also has one. Under the evidence model it no longer has to be either — both
// sources contribute at their own specificity and the classifier weighs them.
//
// Discogs `genre` is very coarse ("Electronic") and `style` is the useful
// field ("Tech House", "Jungle"); both are mapped, since a coarse genre is
// still real evidence for a parent node.
import { defineProvider } from './provider.mjs';
import { normaliseValues } from '../evidence/normalise.mjs';
import { linkConfidence } from '../identity/track-identity.mjs';

export const DISCOGS = defineProvider({
  id: 'discogs',
  version: '3.0.0',
  capabilities: ['genre', 'era', 'identity'],
  entityTypes: ['release', 'release-group', 'artist'],
  // Editor-curated rather than crowd-tagged: narrower, cleaner, and biased
  // toward what was pressed rather than what was streamed.
  reliability: 0.8,
  independenceGroup: 'discogs',
  optional: true,
  requires: 'a free Discogs token',
});

export const MAX_STYLES = 10;

/**
 * Tally style and genre across a release search result, the shape v1 already
 * produces — how many of an artist's releases carry each style. A tally is a
 * count of independent editors saying the same thing, which is exactly the
 * "count = how many sources said so" shape Last.fm counts have, so both
 * normalise through the same path.
 * @returns {{styles: [string, number][], genres: [string, number][], years: number[]}}
 */
export function extractStyles(json, { max = MAX_STYLES } = {}) {
  const styles = new Map(), genres = new Map(), years = [];
  for (const hit of json?.results ?? []) {
    for (const s of hit?.style ?? []) {
      const k = String(s).toLowerCase();
      styles.set(k, (styles.get(k) ?? 0) + 1);
    }
    for (const g of hit?.genre ?? []) {
      const k = String(g).toLowerCase();
      genres.set(k, (genres.get(k) ?? 0) + 1);
    }
    const y = Number(hit?.year);
    if (Number.isFinite(y) && y > 1900) years.push(y);
  }
  const top = m => [...m].sort((a, b) => b[1] - a[1]).slice(0, max);
  return { styles: top(styles), genres: top(genres), years };
}

/**
 * One Discogs response -> evidence.
 *
 * `entityType` is the caller's honest description of what was searched. A
 * search by artist name returns that artist's releases, so the evidence is
 * about the *artist*, not about one release — claiming otherwise would let a
 * broad discography borrow release-level specificity it has not earned. A
 * lookup of the specific release a track came from is release-level, and that
 * is where Discogs is genuinely strong.
 */
export function toEvidence(json, { entityType = 'artist', entityId = null,
                                   matchedBy = 'name-exact', retrievedAt = Date.now() } = {}) {
  const { styles, genres } = extractStyles(json);
  const ctx = {
    source: DISCOGS.id, entityType, entityId,
    identityConfidence: linkConfidence(matchedBy),
    retrievedAt,
    provenance: { matchedBy, adapter: DISCOGS.version },
  };
  return [
    ...normaliseValues(styles, { ...ctx, provenance: { ...ctx.provenance, field: 'style' } }),
    // Discogs' own `genre` is a handful of buckets. Real, but so coarse that
    // counting it at full strength beside `style` would drag every electronic
    // record back toward the root of the tree.
    ...normaliseValues(genres, { ...ctx, sourceReliability: 0.5, provenance: { ...ctx.provenance, field: 'genre' } }),
  ];
}

export const SEARCH_ENDPOINT = 'https://api.discogs.com/database/search';
export const USER_AGENT = 'Betterfy/1.0 +https://github.com/emmachilds98-wq/Betterfy';

/** Search parameters for one artist's releases, or one specific release. */
export function searchParams({ artist, release = null, token }) {
  const p = { type: 'release', per_page: '50', token };
  if (artist) p.artist = artist;
  if (release) p.release_title = release;
  return p;
}

export async function fetchReleases(params, fetchImpl = fetch) {
  const res = await fetchImpl(SEARCH_ENDPOINT + '?' + new URLSearchParams(params),
    { headers: { 'User-Agent': USER_AGENT } });
  return res.json();
}
