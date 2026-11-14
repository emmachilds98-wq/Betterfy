// ListenBrainz similar artists, from real listening sessions.
//
// Keyless and CORS-open (checked: `access-control-allow-origin: *`), so the page
// can call it directly. It is keyed by MusicBrainz id, which is why Wikidata
// comes first: Wikidata maps a Spotify artist id to an MBID exactly, 300 at a
// time, where MusicBrainz itself would want one request a second per artist.
//
// Measured on the owner's library (docs/SMARTER-GENRES-PLAN.md §2.1): 90% of
// scene artists with an MBID had at least one neighbour in the library. One
// MBID per request — a comma list is a 400 (checked).
import { defineProvider } from './provider.mjs';

export const LISTENBRAINZ = defineProvider({
  id: 'listenbrainz-similar',
  version: '1.0.0',
  capabilities: ['similarity'],
  entityTypes: ['artist'],
  reliability: 0.5,
  // Built from listening sessions, which is different evidence from Deezer's
  // "fans also like", even where the two agree.
  independenceGroup: 'listenbrainz',
  optional: true,
  requires: 'nothing — public, keyless',
});

export const ENDPOINT = 'https://labs.api.listenbrainz.org/similar-artists/json';

/** The algorithm the site's own similar-artists page uses; the one measured. */
export const ALGORITHM = 'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';

/** Kept per artist. The list is score-ordered and long; the tail is weak. */
export const SIMILAR_LIMIT = 40;

const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isMbid = s => MBID_RE.test(String(s ?? ''));

export const similarUrl = mbid =>
  `${ENDPOINT}?${new URLSearchParams({ artist_mbids: mbid, algorithm: ALGORITHM })}`;

/**
 * @returns {{answered: true, similar: {mbid: string, name: string, score: number}[]}
 *          |{answered: false}}
 */
export function similarFrom(json, { limit = SIMILAR_LIMIT } = {}) {
  if (!Array.isArray(json)) return { answered: false };
  const similar = json
    .filter(a => a && isMbid(a.artist_mbid) && a.name && Number.isFinite(Number(a.score)))
    .map(a => ({ mbid: String(a.artist_mbid).toLowerCase(), name: String(a.name), score: Number(a.score) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { answered: true, similar };
}
