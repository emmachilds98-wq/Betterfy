// MusicBrainz adapter — identity first, tags second (§7).
//
// v1 already resolves a Spotify artist id to an MBID through the exact
// Spotify URL volunteers attach to artist pages (musicbrainz.mjs at the repo
// root), and that module stays where it is: enrich-lastfm.mjs depends on it
// and the point of this phase is to add a layer, not to move working code out
// from under the scripts that use it. This adapter wraps it and extends the
// same trick to recordings, which is what actually unlocks track-level
// identity: an ISRC lookup returns a recording MBID with no name matching
// anywhere in the chain.
//
// Everything here is gated on MUSICBRAINZ_CONTACT, exactly as v1 is — the
// lookup needs an identifying User-Agent, which is both MusicBrainz's stated
// policy and something a browser fetch cannot set. Absent, this provider is
// simply not in the registry and nothing downstream changes.
import { defineProvider } from './provider.mjs';
import { normaliseValues } from '../evidence/normalise.mjs';
import { linkConfidence } from '../identity/track-identity.mjs';
import { resolveMbid, extractArtistMbid } from '../../musicbrainz.mjs';

export { resolveMbid, extractArtistMbid };

export const MUSICBRAINZ = defineProvider({
  id: 'musicbrainz',
  version: '3.0.0',
  capabilities: ['identity', 'genre', 'era'],
  entityTypes: ['recording', 'release', 'release-group', 'artist'],
  // Editorial, identifier-first, and conservative about genre: it has fewer
  // opinions than Last.fm and is right more often when it has one.
  reliability: 0.85,
  independenceGroup: 'musicbrainz',
  optional: true,
  requires: 'a contact string (MUSICBRAINZ_CONTACT), no key',
});

export const WS_BASE = 'https://musicbrainz.org/ws/2';
const ua = contact => `Betterfy/1.0 ( ${contact} )`;

/**
 * Pull the recording identity out of an ISRC lookup response.
 *
 * Written from MusicBrainz's documented ws/2 JSON shape and, like the v1
 * module it sits beside, deliberately defensive: an unexpected shape returns
 * null ("not found"), which every caller already treats as the ordinary case,
 * rather than throwing into the middle of an enrichment run.
 */
export function extractRecordingFromIsrc(json) {
  const rec = json?.recordings?.[0] ?? json?.isrc?.recordings?.[0] ?? null;
  if (!rec?.id) return null;
  const release = rec.releases?.[0] ?? null;
  return {
    recordingMbid: rec.id,
    title: rec.title ?? null,
    releaseMbid: release?.id ?? null,
    releaseGroupMbid: release?.['release-group']?.id ?? null,
    year: /^\d{4}/.test(String(release?.date ?? '')) ? Number(String(release.date).slice(0, 4)) : null,
  };
}

/**
 * Resolve one ISRC to a recording identity, or null. Never throws, for the
 * same reason resolveMbid() does not: a failed identity lookup degrades the
 * confidence of everything downstream, it does not break the run (§38).
 */
export async function resolveByIsrc(isrc, contact, fetchImpl = fetch) {
  if (!isrc || !contact) return null;
  const url = `${WS_BASE}/isrc/${encodeURIComponent(isrc)}?`
    + new URLSearchParams({ fmt: 'json', inc: 'releases+release-groups' });
  try {
    const json = await fetchImpl(url, { headers: { 'User-Agent': ua(contact) } }).then(r => r.json());
    return extractRecordingFromIsrc(json);
  } catch { return null; }
}

/** MusicBrainz genres/tags on an entity -> evidence. Both keys are tried. */
export function toEvidence(json, { entityType = 'recording', entityId = null,
                                   matchedBy = 'mbid-recording', retrievedAt = Date.now() } = {}) {
  const list = [...(json?.genres ?? []), ...(json?.tags ?? [])]
    .filter(t => t?.name)
    .map(t => [String(t.name).toLowerCase(), Number(t.count ?? 1)]);
  return normaliseValues(list, {
    source: MUSICBRAINZ.id, entityType, entityId,
    identityConfidence: linkConfidence(matchedBy),
    retrievedAt,
    provenance: { matchedBy, adapter: MUSICBRAINZ.version },
  });
}
