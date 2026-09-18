// Spotify adapter — identity and era, and deliberately nothing else.
//
// Spotify's audio-feature endpoints are dead (403/404, verified against a
// real app registration — see the README). There is no tempo, energy or
// valence to read here for anyone, and §7's instruction not to treat Spotify
// metadata as audio-analysis truth is easy to follow because there is no such
// metadata left to mistake for it.
//
// What Spotify does supply, for every account, with nothing to configure, is
// the one thing the whole identity chain hangs off: the track id, the ISRC on
// its album metadata, artist ids in billing order, and a release date. That
// makes it the only non-optional provider in the registry.
import { defineProvider } from './provider.mjs';
import { evidence } from '../evidence/evidence.mjs';
import { eraOfYear } from '../ontology/index.mjs';

export const SPOTIFY = defineProvider({
  id: 'spotify',
  version: '3.0.0',
  capabilities: ['identity', 'era'],
  entityTypes: ['track', 'album', 'artist'],
  reliability: 0.95,   // for what it actually asserts: ids and dates
  independenceGroup: 'spotify',
  optional: false,
  requires: 'nothing — every account has this',
});

/**
 * The era evidence a library track carries on its own, from its release date.
 *
 * Worth stating why this is evidence rather than a fact: a release date is
 * the date of *that pressing*. A 1994 jungle record reissued on a 2019
 * compilation carries 2019, and the listener filing it by era means 1994. So
 * it is strong, track-level, exactly-identified evidence — and still only
 * evidence, which a compilation's own tags or a Discogs master year can
 * outweigh.
 */
export function toEvidence(track, { retrievedAt = Date.now() } = {}) {
  const released = track?.released ?? null;
  const year = /^\d{4}/.test(String(released ?? '')) ? Number(String(released).slice(0, 4)) : null;
  const era = eraOfYear(year);
  if (!era) return [];
  return [evidence({
    source: SPOTIFY.id,
    entityType: 'track',
    entityId: track.id ?? null,
    field: 'era',
    rawValue: released,
    concept: era,
    facet: 'era',
    sourceConfidence: 0.9,
    identityConfidence: 1,       // the id we asked with is the id we own
    retrievedAt,
    provenance: { matchedBy: 'spotify-id', adapter: SPOTIFY.version,
                  note: 'release date of this pressing, not necessarily of the recording' },
  })];
}
