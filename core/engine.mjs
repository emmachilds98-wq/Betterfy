// The v3 engine's front door.
//
// Everything below this line is composable and testable on its own; this is
// the piece that knows how to point it at an actual Spotify library. It is
// deliberately thin, and deliberately reads the caches v1 already writes —
// `tags-lastfm.json`, `tags-discogs.json`, the shipped `docs/tags.json` —
// so that v3 produces profiles for an existing library with no new network
// calls at all. That is what makes the benchmark comparison in
// core/benchmark/ meaningful rather than a comparison of two different
// amounts of data.
//
// Nothing here is wired into the shipping app yet, by design (§32: one phase
// at a time, §41.2: preserve existing working functionality). v1 still
// answers every question the UI asks. This runs beside it.
import { EvidenceSet } from './evidence/evidence.mjs';
import { trackIdentity } from './identity/track-identity.mjs';
import { ProviderRegistry } from './sources/provider.mjs';
import { LASTFM, toEvidence as lastfmEvidence } from './sources/lastfm.mjs';
import { DISCOGS, toEvidence as discogsEvidence } from './sources/discogs.mjs';
import { SPOTIFY, toEvidence as spotifyEvidence } from './sources/spotify.mjs';
import { MUSICBRAINZ } from './sources/musicbrainz.mjs';
import { SHARED_TABLE, cacheToEvidence, SCALES } from './sources/legacy.mjs';
import { musicProfile, musicDNA } from './analysis/music-dna.mjs';

export const ENGINE_VERSION = '3.0.0';

/**
 * Build the provider registry for whatever this listener actually has.
 *
 * Spotify is always present; everything else appears only if there is data
 * from it. A registry is therefore an honest statement of coverage, and the
 * confidence numbers that come out the far end reflect it without any
 * "is Discogs enabled" branch existing anywhere downstream (§38: a missing
 * provider reduces confidence, it does not break classification).
 */
export function buildRegistry({ lastfm = false, discogs = false, shared = false, musicbrainz = false } = {}) {
  const reg = new ProviderRegistry([SPOTIFY]);
  if (lastfm) reg.register(LASTFM);
  if (discogs) reg.register(DISCOGS);
  if (shared) reg.register(SHARED_TABLE);
  if (musicbrainz) reg.register(MUSICBRAINZ);
  return reg;
}

/**
 * Index the v1 caches once, per artist, so a library pass is a lookup rather
 * than a re-normalisation per track. Artist clouds are shared by every track
 * that artist appears on, which is exactly the property v3 is careful about
 * downstream and exactly the property that makes caching them here free.
 *
 * @param {{lastfm?: object, discogs?: object, shared?: object, mbids?: object, now?: number}} caches
 */
export function indexCaches({ lastfm = null, discogs = null, shared = null, mbids = null, now = Date.now() } = {}) {
  return {
    lastfm: lastfm ? cacheToEvidence(lastfm, { source: LASTFM.id, scale: SCALES.lastfm, mbids, now }) : new Map(),
    discogs: discogs ? cacheToEvidence(discogs, { source: DISCOGS.id, matchedBy: 'name-exact', scale: SCALES.discogs, now }) : new Map(),
    shared: shared ? cacheToEvidence(shared, { source: SHARED_TABLE.id, scale: SCALES.shared, now }) : new Map(),
    present: { lastfm: !!lastfm, discogs: !!discogs, shared: !!shared, musicbrainz: !!mbids },
  };
}

/**
 * Everything known about one library track, as an EvidenceSet.
 *
 * `trackTags` is the optional track-level Last.fm cache that
 * enrich-lastfm-tracks.mjs writes — the one genuinely new question v3 asks.
 * When it has an answer for this recording, it arrives as track-level
 * evidence and outranks the artist cloud on specificity alone; when it does
 * not, nothing about the result changes shape, it is just less certain.
 *
 * @param {object} track   a library track, as snapshot.mjs writes them
 * @param {ReturnType<typeof indexCaches>} idx
 * @param {{trackTags?: object, resolved?: object, now?: number}} [opts]
 */
export function buildEvidence(track, idx, { trackTags = null, resolved = {}, now = Date.now() } = {}) {
  const identity = trackIdentity(track, {
    ...resolved,
    artistMbids: resolved.artistMbids ?? idx?.mbids ?? undefined,
  });
  const set = new EvidenceSet(identity);

  set.add(...spotifyEvidence(track, { retrievedAt: now }));

  const entry = trackTags?.[track.id];
  if (entry?.tags?.length) {
    set.add(...lastfmEvidence({ toptags: { tag: entry.tags.map(([name, count]) => ({ name, count })) } }, {
      entityType: 'track',
      entityId: track.id,
      // Track lookups are addressed by artist+title, which Last.fm does not
      // autocorrect the way it does a bare artist name — but it is still a
      // string match, and saying otherwise here would inflate every number
      // downstream.
      matchedBy: entry.mbid ? 'mbid-recording' : 'name-exact',
      retrievedAt: entry.checkedAt ?? now,
    }));
  }

  // Artist-level evidence, from every cache that has some. Contextual, not
  // canonical (§4.1) — which is enforced by SPECIFICITY['artist'], not here.
  for (const a of track.artists ?? []) {
    if (!a?.id) continue;
    for (const cache of ['lastfm', 'discogs', 'shared']) {
      const records = idx?.[cache]?.get(a.id);
      if (records?.length) set.add(...records);
    }
  }
  return set;
}

/**
 * Profile one track. The whole pipeline, in the order §4.5 requires:
 * raw sources -> identity -> normalisation -> ontology -> deterministic
 * scoring -> confidence. No AI anywhere in it.
 */
export function profileTrack(track, idx, { registry = null, trackTags = null, resolved = {}, now = Date.now() } = {}) {
  const set = buildEvidence(track, idx, { trackTags, resolved, now });
  const profile = musicProfile(set, { registry, now });
  return { set, profile, dna: musicDNA(profile) };
}

/**
 * Profile a whole library. Returns a Map keyed by Spotify track id, one entry
 * per distinct track — a track filed in six playlists is one piece of music
 * and gets one profile, which is the point of a track-level engine.
 */
export function profileLibrary(lib, idx, { registry = null, trackTags = null, now = Date.now() } = {}) {
  const out = new Map();
  const consider = t => {
    if (!t?.id || out.has(t.id)) return;
    out.set(t.id, profileTrack(t, idx, { registry, trackTags, now }));
  };
  for (const p of lib?.playlists ?? []) for (const t of p.tracks ?? []) consider(t);
  for (const t of lib?.liked ?? []) consider(t);
  return out;
}

/**
 * What a library pass learned about itself: coverage, confidence bands and
 * the unmapped concepts worth adding to the ontology. This is the §35 review
 * queue's raw material and the number a classifier change is judged on.
 */
export function libraryReport(profiles) {
  const bands = {}, unknown = new Map();
  let withGenre = 0, total = 0;
  for (const { profile } of profiles.values()) {
    total++;
    bands[profile.genre.confidence] = (bands[profile.genre.confidence] ?? 0) + 1;
    if (profile.genre.primary) withGenre++;
    for (const u of profile.unknown) unknown.set(u.raw, (unknown.get(u.raw) ?? 0) + u.count);
  }
  return {
    tracks: total,
    classified: withGenre,
    coverage: total ? +(withGenre / total).toFixed(3) : 0,
    bands,
    unknownConcepts: [...unknown].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([raw, count]) => ({ raw, count })),
  };
}
