// The v1 tag caches, read as evidence.
//
// This is the adapter that makes v3 mean anything today. Every existing
// listener — and every new one, from the tag table the page ships with —
// already has artist tag clouds sitting in `tags-lastfm.json`,
// `tags-discogs.json` or `docs/tags.json`. Read through here they become a
// proper EvidenceSet with provenance and confidence, and classifyTrack() can
// be run and benchmarked against v1's answers *without a single new network
// request* (§32 Phase 0, Task 11).
//
// It is also the honest floor of what v3 knows before any track-level
// enrichment has run: artist-level evidence, matched by name, of unrecorded
// age. Every one of those caveats is expressed in the records rather than
// assumed away, which is why the same track scores lower here than it will
// once a track-level answer exists.
import { defineProvider } from './provider.mjs';
import { normaliseValues } from '../evidence/normalise.mjs';
import { linkConfidence } from '../identity/track-identity.mjs';
import { LASTFM } from './lastfm.mjs';
import { DISCOGS } from './discogs.mjs';

/**
 * The shipped table (docs/tags.json) is Last.fm data at one remove: fetched by
 * other listeners' keys, validated and folded in by merge-tags.mjs. Same
 * crowd, so the same independence group — it must never corroborate a live
 * Last.fm answer, because it *is* one.
 */
export const SHARED_TABLE = defineProvider({
  id: 'shared-tags',
  version: '3.0.0',
  capabilities: ['genre', 'mood', 'context', 'era', 'descriptor'],
  entityTypes: ['artist'],
  // One notch below a live Last.fm fetch: the same data, of unknown age, and
  // contributed rather than fetched.
  reliability: 0.65,
  independenceGroup: 'lastfm',
  optional: false,
  requires: 'nothing — it ships with the page',
});

/** v1 cache scales. docs/tags.json stores 0-10; the local caches store 0-100. */
export const SCALES = { lastfm: 100, discogs: 100, shared: 10 };

/**
 * One v1 cache entry -> evidence about that artist.
 *
 * @param {{tags?: [string, number][], checkedAt?: number, error?: string}} entry
 * @param {object} ctx
 * @param {string} ctx.artistId       Spotify artist id
 * @param {string} ctx.source         which provider this cache belongs to
 * @param {string} [ctx.matchedBy]    how v1 addressed the request
 * @param {number} [ctx.now]          used when the entry has no checkedAt
 */
export function entryToEvidence(entry, { artistId, source, matchedBy = 'name-autocorrect', now = Date.now() } = {}) {
  if (!entry?.tags?.length) return [];
  return normaliseValues(entry.tags, {
    source,
    entityType: 'artist',
    entityId: artistId,
    identityConfidence: linkConfidence(matchedBy),
    // v1 wrote checkedAt on every entry it fetched; the shipped table has no
    // timestamp at all, and pretending it is fresh would let stale data outrank
    // a live answer about the same artist. Absent means old.
    retrievedAt: entry.checkedAt ?? (now - 1000 * 60 * 60 * 24 * 365),
    provenance: { matchedBy, via: 'v1-cache' },
  });
}

/**
 * The whole of a v1 cache, as evidence keyed by Spotify artist id.
 *
 * @param {Record<string, {tags?: [string, number][]}>} cache
 * @param {{source: string, matchedBy?: string, scale?: number, mbids?: Record<string,string>, now?: number}} opts
 *   `mbids` is v1's mbid.json: an artist we resolved an MBID for was asked by
 *   mbid, not by name, and that answer is materially more trustworthy.
 * @returns {Map<string, Readonly<import('../evidence/evidence.mjs').Evidence>[]>}
 */
export function cacheToEvidence(cache, { source = LASTFM.id, matchedBy = 'name-autocorrect',
                                         scale = SCALES.lastfm, mbids = null, now = Date.now() } = {}) {
  const out = new Map();
  for (const [artistId, entry] of Object.entries(cache ?? {})) {
    const tags = normaliseScale(entry?.tags, scale);
    if (!tags.length) continue;
    const how = mbids?.[artistId] ? 'mbid-artist' : matchedBy;
    const records = entryToEvidence({ ...entry, tags }, { artistId, source, matchedBy: how, now });
    if (records.length) out.set(artistId, records);
  }
  return out;
}

/**
 * Put a cache's counts on the 0-100 scale the rest of the engine reads.
 *
 * merge-tags.mjs already warns what getting this backwards costs: the shipped
 * table stores 0-10 and the page multiplies by ten on load, so reading it raw
 * would make every shipped artist a tenth as confident as a locally fetched
 * one. Since normaliseValues() scores each value against the strongest in its
 * own list this is nearly a no-op today — but "nearly" is not a reason to
 * leave a scale mismatch in the data.
 */
export function normaliseScale(tags, scale = SCALES.lastfm) {
  const f = SCALES.lastfm / (scale || SCALES.lastfm);
  return (tags ?? []).filter(t => Array.isArray(t)).map(([name, count]) => [name, Number(count) * f]);
}

/** Which provider declaration a v1 cache file corresponds to. */
export const PROVIDER_OF_CACHE = {
  'tags-lastfm.json': LASTFM,
  'tags-discogs.json': DISCOGS,
  'docs/tags.json': SHARED_TABLE,
};
