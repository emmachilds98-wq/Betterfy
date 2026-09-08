// Identity glue: resolve a Spotify artist id to a MusicBrainz artist id (MBID)
// via the exact Spotify URL MusicBrainz volunteers attach to an artist page —
// not a name search, so there is no fuzzy matching to get wrong. This exists
// for one reason: Last.fm's artist.gettoptags is normally queried by name with
// autocorrect on, and a same-named act (there is more than one "Horizon" in
// electronic music) can autocorrect onto the wrong artist and return a
// confident, wrong tag set — worse than no tags at all, because it actively
// misfiles every track by the real artist. Last.fm also accepts an `mbid=`
// parameter instead of a name, which sidesteps that entirely when we have one.
//
// Keyless and free, but MusicBrainz's usage policy asks for an identifiable
// User-Agent and about 1 request/second — this module is gated on
// MUSICBRAINZ_CONTACT being set (see .env.example) so nothing ever sends a
// generic, policy-violating UA, and is silently skipped otherwise, the same
// "off unless configured" shape as Discogs and App Check elsewhere here.
//
// Node-only: the lookup needs a custom User-Agent header, which a browser
// fetch cannot set (the same limitation the README already notes for
// MUSICBRAINZ_CONTACT). Browser listeners keep the name+autocorrect path
// unchanged — this is a bonus for the local pipeline, never something the
// core model depends on.
//
// UNVERIFIED against a live response: this environment's network policy has
// no route to musicbrainz.org, so the parsers below are written from MB's
// documented ws/2 JSON shape rather than a fetched sample. extractArtistMbid()
// and extractGenresAndTags() are both deliberately defensive — they try the
// shapes MB's docs describe and return null/empty on anything else — so a
// shape mismatch degrades to "nothing found" (identity resolution falls back
// to the name-based Last.fm lookup; genres/tags just contribute nothing)
// rather than breaking the run. Confirm the real shapes once
// MUSICBRAINZ_CONTACT is set and adjust either function if they differ.
import { retry, sleep } from './cache.mjs';

const UA_VERSION = 'Betterfy/1.0';

/**
 * Dig an artist MBID out of a MusicBrainz `/ws/2/url` search response for one
 * resource URL. MB's relationships come back either as a flat `relations`
 * array on the url hit, or nested under `relation-list[].relations` — tried
 * in that order, first artist relation wins.
 */
export function extractArtistMbid(json) {
  const hit = json?.urls?.[0];
  if (!hit) return null;
  const flat = hit.relations ?? [];
  const nested = (hit['relation-list'] ?? []).flatMap(l => l.relations ?? []);
  for (const rel of [...flat, ...nested])
    if (rel?.artist?.id) return rel.artist.id;
  return null;
}

/**
 * Resolve one Spotify artist id to an MBID, or null if MusicBrainz has no
 * artist linked to that exact Spotify URL. Never throws — a network hiccup
 * or an unexpected response shape is indistinguishable from "not found" here,
 * and the caller already treats "no MBID" as a normal, common case.
 */
export async function resolveMbid(spotifyArtistId, contact) {
  const url = 'https://musicbrainz.org/ws/2/url?' + new URLSearchParams({
    query: `url:"https://open.spotify.com/artist/${spotifyArtistId}"`, fmt: 'json',
  });
  try {
    // Only one retry, not the usual four: a dropped MB lookup just falls back
    // to the name+autocorrect path below, so it isn't worth the same backoff
    // budget as the Last.fm fetch this is only ever a courtesy ahead of.
    const json = await retry(() => fetch(url, {
      headers: { 'User-Agent': `${UA_VERSION} ( ${contact} )` },
    }).then(r => r.json()), 2);
    return extractArtistMbid(json);
  } catch { return null; }
}

/**
 * Resolve MBIDs for a batch of [spotifyId, name] pairs, respecting
 * MusicBrainz's ~1 req/s courtesy limit. Silently a no-op with no contact
 * string configured — the feature simply isn't there, same as Discogs with no
 * token — so callers can always call this and get an empty map back.
 * @returns {Promise<Map<string,string>>} spotifyId -> mbid, gaps omitted.
 */
export async function resolveMbids(pairs, contact) {
  const out = new Map();
  if (!contact) return out;
  for (const [id] of pairs) {
    const mbid = await resolveMbid(id, contact);
    if (mbid) out.set(id, mbid);
    await sleep(1000);
  }
  return out;
}

/**
 * Pull an artist's `genres` and community `tags` out of a MusicBrainz artist
 * lookup response, folded into one tally the way trackVec() expects: MB's
 * per-tag `count` is how many users applied it, a small integer (often 1-5),
 * nothing like Last.fm's 0-100 relative scale — rescaled the same way
 * Discogs' release count already is, so the two sources land on one scale
 * rather than one drowning out the other in an average.
 */
export function extractGenresAndTags(json) {
  const entries = [...(json?.genres ?? []), ...(json?.tags ?? [])];
  const tally = new Map();
  for (const e of entries) {
    if (!e?.name || !Number.isFinite(e.count)) continue;
    const name = e.name.toLowerCase();
    tally.set(name, Math.max(tally.get(name) ?? 0, e.count));
  }
  const ranked = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const most = ranked[0]?.[1] || 1;
  return ranked.map(([name, n]) => [name, Math.round(100 * n / most)]);
}

/**
 * Fetch genres/tags for an artist MusicBrainz identity resolution has
 * already found an id for — no second identity lookup, just one more field
 * on the same entity. Never throws; an unreachable server or an artist with
 * neither genres nor tags both come back as "nothing here".
 */
export async function fetchArtistGenres(mbid, contact) {
  const url = `https://musicbrainz.org/ws/2/artist/${mbid}?` + new URLSearchParams({
    inc: 'genres+tags', fmt: 'json',
  });
  try {
    const json = await retry(() => fetch(url, {
      headers: { 'User-Agent': `${UA_VERSION} ( ${contact} )` },
    }).then(r => r.json()), 2);
    return extractGenresAndTags(json);
  } catch { return []; }
}
