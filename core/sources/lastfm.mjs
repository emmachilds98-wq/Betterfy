// Last.fm adapter.
//
// v1 asks Last.fm one question: what is this *artist* tagged with. That is
// the single biggest source of the misfiling v3 exists to fix — a diverse
// artist hands the same cloud to every track they ever made (§4.1). Last.fm
// also has track.getTopTags and album.getTopTags, which are about the record
// rather than the person, and this adapter reads all three.
//
// Track tags are thinner than artist tags — many tracks have none at all —
// so this does not *replace* the artist question, it outranks it where it has
// an answer. That ordering is not expressed here: it falls out of entity
// specificity in weights.mjs, which is the whole point of the evidence model.
//
// Independence: all three endpoints are one crowd tagging one catalogue, so
// they share an independence group and cannot corroborate each other.
import { defineProvider } from './provider.mjs';
import { normaliseValues } from '../evidence/normalise.mjs';
import { linkConfidence } from '../identity/track-identity.mjs';

export const LASTFM = defineProvider({
  id: 'lastfm',
  version: '3.0.0',
  capabilities: ['genre', 'mood', 'context', 'era', 'descriptor'],
  entityTypes: ['track', 'album', 'artist'],
  // Crowd tags: wide coverage, real signal, and noisy in ways the junk filter
  // only partly catches. A coarse prior, to be re-fitted from the benchmark.
  reliability: 0.75,
  independenceGroup: 'lastfm',
  optional: true,
  requires: 'a free Last.fm API key',
});

// v1's floor, kept: below a count of 10 a Last.fm tag is one or two people.
export const MIN_TAG_COUNT = 10;
export const MAX_TAGS = 15;

/**
 * Last.fm's several tag responses all carry the same inner shape under
 * different keys: `toptags.tag`, `tags.tag`, sometimes a bare object rather
 * than an array when there is exactly one. Normalised here so the mapper
 * below never has to care which endpoint answered.
 * @returns {[string, number][]}
 */
export function extractTags(json, { minCount = MIN_TAG_COUNT, max = MAX_TAGS } = {}) {
  const node = json?.toptags?.tag ?? json?.tags?.tag ?? json?.toptags ?? null;
  const list = Array.isArray(node) ? node : node && typeof node === 'object' && node.name ? [node] : [];
  return list
    .filter(t => t?.name && Number(t.count) >= minCount)
    .slice(0, max)
    .map(t => [String(t.name).toLowerCase(), Number(t.count)]);
}

/**
 * One Last.fm tag response -> evidence records.
 *
 * `matchedBy` is how the request was addressed, and it matters more than
 * anything else here: `mbid` is an exact identity, `name` with autocorrect=1
 * can silently land on a different act with the same name and return a
 * confident, wrong cloud. That difference is carried into every record's
 * identityConfidence rather than being noted in a comment and forgotten.
 *
 * @param {object} json         the parsed Last.fm response
 * @param {object} ctx
 * @param {'track'|'album'|'artist'} ctx.entityType
 * @param {string|null} ctx.entityId
 * @param {'mbid-artist'|'mbid-recording'|'name-autocorrect'|'name-exact'} ctx.matchedBy
 * @param {number} [ctx.retrievedAt]
 */
export function toEvidence(json, { entityType, entityId = null, matchedBy = 'name-autocorrect',
                                   retrievedAt = Date.now(), minCount = MIN_TAG_COUNT } = {}) {
  return normaliseValues(extractTags(json, { minCount }), {
    source: LASTFM.id,
    entityType,
    entityId,
    identityConfidence: linkConfidence(matchedBy),
    sourceReliability: 1, // reliability is applied once, in evidenceWeight()
    retrievedAt,
    provenance: { matchedBy, adapter: LASTFM.version, endpoint: `${entityType}.gettoptags` },
  });
}

/**
 * The query parameters for one tag request. Pure, so the request this adapter
 * would make is testable without making it — and so the mbid-vs-name decision
 * is in one place rather than restated at each call site.
 */
export function tagParams({ entityType, artist, title, mbid, apiKey }) {
  const method = `${entityType}.gettoptags`;
  if (mbid) return { method, mbid, api_key: apiKey, format: 'json' };
  const p = { method, artist, autocorrect: '1', api_key: apiKey, format: 'json' };
  if (entityType === 'track') p.track = title;
  if (entityType === 'album') p.album = title;
  return p;
}

export const TAG_ENDPOINT = 'https://ws.audioscrobbler.com/2.0/';

/**
 * Fetch one tag list. Thin on purpose: retry, rate limiting and caching are
 * the caller's (the enrichment script's) business, because they are the same
 * for every provider and belong in one place rather than five.
 * @param {typeof fetch} [fetchImpl] injected in tests
 */
export async function fetchTags(params, fetchImpl = fetch) {
  const res = await fetchImpl(TAG_ENDPOINT + '?' + new URLSearchParams(params));
  return res.json();
}
