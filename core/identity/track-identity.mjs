// Canonical track identity — §5 of the v3 plan.
//
// The rule this module exists to enforce: never merge two tracks because
// their title and artist strings match. v1's trackKey() is a string key and
// is correct for what it does (de-duplicating one person's library, where
// "Song - Radio Edit" and "Song" really are different records), but a string
// key cannot be handed to MusicBrainz or Discogs and cannot carry a
// confidence. This can.
//
// An identity is always *partial*. A brand-new listener with no Last.fm key,
// no MusicBrainz contact and no Discogs token still gets a TrackIdentity —
// Spotify id, ISRC where the album metadata carried one, artist ids, a parsed
// version — and every downstream layer is written to degrade with it rather
// than require it. That is the whole point of storing confidence instead of
// pretending.
import { norm, baseTitle, versionOf, trackKey } from '../../norm.mjs';

export const IDENTITY_VERSION = '3.0.0';

/* ---------- version handling ----------
 * "Track (Skrillex Remix)" and "Track" are different recordings and must
 * never share evidence. norm.mjs already extracts the version *label*; this
 * sorts it into a kind, because the kind is what changes how much a release's
 * evidence transfers. A remaster is the same recording (evidence transfers
 * fully); a remix is not (it does not). */
const VERSION_KINDS = [
  ['remix',        /\bremix\b|\brmx\b/],
  ['vip',          /\bvip\b/],
  ['bootleg',      /\bbootleg\b|\bflip\b|\brework\b|\bmashup\b/],
  ['live',         /\blive\b/],
  ['acoustic',     /\bacoustic\b|\bunplugged\b/],
  ['instrumental', /\binstrumental\b/],
  ['dub',          /\bdub\b/],
  ['edit',         /\bedit\b|\bradio\b/],
  ['extended',     /\bextended\b|\bclub mix\b|\blong\b/],
  ['mix',          /\bmix\b|\bversion\b/],
];

/** The kind of alternate version a title's suffix describes, or null. */
export function versionKind(title) {
  const label = versionOf(title);
  if (!label) return null;
  for (const [kind, re] of VERSION_KINDS) if (re.test(label)) return kind;
  return 'other';
}

// Which versions are the same *recording* as the plain release, for the
// purpose of transferring release-level evidence. A remaster is (norm.mjs
// already strips it before we get here); an extended mix or a radio edit is
// the same performance differently cut, so release evidence about the record
// still applies. A remix is a different record by a different producer.
const SAME_RECORDING = new Set([null, 'edit', 'extended', 'mix', 'other']);
export const isSameRecordingVersion = kind => SAME_RECORDING.has(kind);

/* ---------- identity confidence ----------
 * How sure we are that a provider's entity is *this* recording. Used as the
 * `identityConfidence` on every evidence record, so a tag fetched by exact
 * id outweighs one fetched by a name the provider autocorrected. These are
 * the numbers the benchmark tunes; they are declared here, once, so that
 * tuning them is a one-line change rather than an audit.
 */
export const LINK_CONFIDENCE = {
  'spotify-id':        1.00, // the id we asked with is the id we own
  'isrc':              0.98, // an ISRC is a recording identifier by definition
  'mbid-recording':    0.95,
  'artist-spotify-id': 0.95, // exact artist, but artist-level (specificity is weighted separately)
  'mbid-artist':       0.92,
  'discogs-id':        0.90,
  'mbid-release':      0.88,
  'name-exact':        0.70, // string match, no identifier — the v1 default
  'name-autocorrect':  0.55, // Last.fm autocorrect=1: a same-named act can win
  'name-fuzzy':        0.40,
  'user':              1.00, // the listener said so
};

/** Confidence that evidence matched this way is about the intended entity. */
export const linkConfidence = matchedBy => LINK_CONFIDENCE[matchedBy] ?? 0.4;

/* ---------- the identity itself ---------- */

/**
 * @typedef {object} TrackIdentity
 * @property {string|null} spotifyId
 * @property {string|null} isrc
 * @property {string|null} recordingMbid
 * @property {string|null} releaseMbid
 * @property {string|null} releaseGroupMbid
 * @property {string|null} discogsReleaseId
 * @property {string|null} discogsMasterId
 * @property {string} title              as Spotify spells it
 * @property {string} baseTitle          version suffix removed, normalised
 * @property {string|null} versionLabel  "skrillex remix", "radio edit", …
 * @property {string|null} versionKind   one of VERSION_KINDS, or null
 * @property {{spotifyId: string|null, name: string, mbid: string|null, position: number, primary: boolean}[]} artists
 * @property {{spotifyId: string|null, name: string|null, type: string|null, released: string|null, year: number|null}} album
 * @property {string} key                v1's trackKey(), kept for compatibility
 * @property {number} confidence         0-1, how well-resolved this identity is
 * @property {string} version            IDENTITY_VERSION it was built under
 */

// What each resolved identifier is worth to overall identity confidence.
// A Spotify id alone is a floor, not a ceiling: it identifies the row in the
// user's library perfectly and tells no external provider anything.
const RESOLVED_WEIGHT = {
  spotifyId: 0.30,
  isrc: 0.25,
  recordingMbid: 0.20,
  releaseMbid: 0.05,
  releaseGroupMbid: 0.05,
  discogsReleaseId: 0.05,
  discogsMasterId: 0.05,
  artistMbid: 0.05,
};

/** How well-resolved an identity is across providers, 0-1. */
export function identityConfidence(id) {
  let score = 0;
  for (const [field, w] of Object.entries(RESOLVED_WEIGHT)) {
    if (field === 'artistMbid') { if (id.artists?.some(a => a.mbid)) score += w; continue; }
    if (id[field]) score += w;
  }
  return Math.min(1, score);
}

/**
 * Build a TrackIdentity from a library track, optionally enriched with
 * whatever external ids have been resolved for it.
 *
 * `track` is the shape snapshot.mjs writes and the browser build holds:
 * `{ id, name, artists:[{id,name}], album, albumType, released, isrc, … }`.
 * Every external id is optional and absent by default — a listener who has
 * configured nothing gets a valid, usable, lower-confidence identity.
 *
 * @param {object} track
 * @param {{recordingMbid?: string, releaseMbid?: string, releaseGroupMbid?: string,
 *          discogsReleaseId?: string, discogsMasterId?: string,
 *          artistMbids?: Record<string,string>}} [resolved]
 * @returns {TrackIdentity}
 */
export function trackIdentity(track, resolved = {}) {
  const t = track ?? {};
  const artists = (t.artists ?? []).map((a, i) => ({
    spotifyId: a?.id ?? null,
    name: a?.name ?? '',
    mbid: (a?.id && resolved.artistMbids?.[a.id]) ?? a?.mbid ?? null,
    position: i,
    // Billing order decides, never following size — the same reasoning
    // trackVec() uses, so a well-tagged guest never outvotes the producer.
    primary: i === 0,
  }));

  const released = t.released ?? t.album_released ?? null;
  const year = /^\d{4}/.test(String(released ?? '')) ? Number(String(released).slice(0, 4)) : null;

  const id = {
    spotifyId: t.id ?? null,
    isrc: t.isrc ?? null,
    recordingMbid: resolved.recordingMbid ?? t.recordingMbid ?? null,
    releaseMbid: resolved.releaseMbid ?? null,
    releaseGroupMbid: resolved.releaseGroupMbid ?? null,
    discogsReleaseId: resolved.discogsReleaseId ?? null,
    discogsMasterId: resolved.discogsMasterId ?? null,
    title: t.name ?? '',
    baseTitle: baseTitle(t.name ?? ''),
    versionLabel: versionOf(t.name ?? '') || null,
    versionKind: versionKind(t.name ?? ''),
    artists,
    album: {
      spotifyId: t.albumId ?? null,
      name: t.album ?? null,
      type: t.albumType ?? null,
      released,
      year,
    },
    key: trackKey(t),
    version: IDENTITY_VERSION,
  };
  id.confidence = identityConfidence(id);
  return id;
}

/**
 * Whether two identities are the same recording, and on what grounds.
 *
 * Deliberately conservative, per §5: a shared ISRC or MBID is proof, a shared
 * Spotify id is proof, and matching strings are *not* — they return
 * `{ same: false }` with a `couldBe` note so a caller that wants to offer a
 * merge for review can, without anything merging on its own.
 *
 * @returns {{same: boolean, via: string|null, confidence: number, couldBe?: boolean}}
 */
export function sameRecording(a, b) {
  if (!a || !b) return { same: false, via: null, confidence: 0 };
  if (a.spotifyId && a.spotifyId === b.spotifyId) return { same: true, via: 'spotify-id', confidence: 1 };
  if (a.isrc && a.isrc === b.isrc) return { same: true, via: 'isrc', confidence: LINK_CONFIDENCE.isrc };
  if (a.recordingMbid && a.recordingMbid === b.recordingMbid)
    return { same: true, via: 'mbid-recording', confidence: LINK_CONFIDENCE['mbid-recording'] };

  // Same strings, no identifier. This is exactly the case v1 treats as one
  // record and v3 refuses to: it is a candidate for a human, not a merge.
  const couldBe = a.key === b.key
    && a.baseTitle === b.baseTitle
    && norm(a.artists?.[0]?.name ?? '') === norm(b.artists?.[0]?.name ?? '');
  return { same: false, via: null, confidence: 0, couldBe };
}
