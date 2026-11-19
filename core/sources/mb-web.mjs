// @bundle engine BetterfyMbWeb 126
// MusicBrainz's artist genres, asked from the page (BUILD-8 W1, SOUND-ENGINE G3). A
// bonus source: the listener's own artists that already hold an MBID (Wikidata's
// exact Spotify-id link) and no tags at all. Probe, 2026-11-19: musicbrainz.org/ws/2
// answers a browser GET (access-control-allow-origin: *) but wants a User-Agent a page
// cannot set and allows 1 request/s, so the page asks ListenBrainz instead, which
// serves the same MusicBrainz tags, many MBIDs per GET, CORS-open, rate-limit headers
// exposed. Never by name. Pure here: what to ask. The queue and storage are web/app/keyless.js.
import { isMbid, tagsUrl, tagsFrom, TAGS_BATCH } from './listenbrainz.mjs';
export { isMbid, tagsUrl, tagsFrom, TAGS_BATCH };
export const MB_SPACING_MS = 1500;
export const MB_REST_MS = 10 * 60 * 1000;
/** Per visit, so a big library fills over several opens instead of one long one. */
export const MB_PER_RUN = 150;
export const STALE_MS = 90 * 24 * 60 * 60 * 1000;

/** MBIDs worth asking: have one, no tags yet, not asked (or asked empty long ago).
 *  `order` ids come most-listened first; the cap keeps a run short. */
export function mbTodo(order, { mbidOf, hasTags, cached = {}, now = Date.now(), cap = MB_PER_RUN } = {}) {
  const out = [];
  for (const id of order) {
    if (out.length >= cap) break;
    const mbid = mbidOf(id);
    if (!isMbid(mbid) || hasTags(id)) continue;
    const e = cached[id];
    if (e?.source === 'musicbrainz' && (e.tags?.length || now - (e.checkedAt ?? 0) < STALE_MS)) continue;
    out.push([id, mbid]);
  }
  return out;
}
