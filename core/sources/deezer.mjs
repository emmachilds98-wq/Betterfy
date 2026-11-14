// Deezer: an exact artist id from an ISRC, and that artist's "fans also like".
//
// Why Deezer at all, when Spotify has an artist id already: Spotify's own
// related-artists endpoint is gone, and Deezer's is keyless. Measured on the
// owner's library (docs/SMARTER-GENRES-PLAN.md §2.1): of 70 scene-genre artists
// Wikidata does not know at all, 68 were on Deezer and 57 had a related list —
// and the lists stayed inside the scene (Coco Bryce → Tim Reaper, LTJ Bukem).
//
// Identity is the part with the judgement in it. Searching Deezer by name is
// the Last.fm-autocorrect mistake again: a same-named artist wins and poisons
// every answer about the real one. So the artist is reached through a
// *recording*: the ISRC Spotify already gives identifies one track exactly, and
// that track's credits name the Deezer artist. The name is then checked against
// the Spotify credit, so an ISRC that Deezer has filed under a different
// billing (a remixer as main artist) is caught rather than trusted.
//
// Nothing here fetches. The page reaches Deezer through JSONP in a sandboxed
// frame (Deezer sends no CORS header — checked), Node with plain fetch; both
// hand the parsed JSON to the functions below.
import { defineProvider } from './provider.mjs';

export const DEEZER = defineProvider({
  id: 'deezer-related',
  version: '1.0.0',
  capabilities: ['identity', 'similarity'],
  entityTypes: ['artist'],
  // A prior. Phase 0 of the plan replaces it with the held-out number.
  reliability: 0.5,
  independenceGroup: 'deezer',
  optional: true,
  requires: 'nothing — public, keyless',
});

export const API = 'https://api.deezer.com';

/** How many related artists to keep. Deezer returns 20 by default; the tail is
 *  where the list drifts out of the scene, so more is not better. */
export const RELATED_LIMIT = 25;

export const isrcUrl = isrc => `${API}/track/isrc:${encodeURIComponent(String(isrc).replace(/-/g, '').toUpperCase())}`;
export const relatedUrl = (id, limit = RELATED_LIMIT) => `${API}/artist/${encodeURIComponent(id)}/related?limit=${limit}`;

/** Only these URLs may be fetched through the page's JSONP frame. A script tag
 *  runs whatever it is given, so the host is pinned rather than trusted. */
export const isDeezerApiUrl = url => /^https:\/\/api\.deezer\.com\/[a-z0-9/:._-]+(\?[a-z0-9=&_-]*)?$/i.test(String(url));

/**
 * What a Deezer error body means for the cache.
 *
 *  - `none`   code 800 "no data": a real answer that there is nothing. Cacheable.
 *  - `quota`  code 4: slow down and ask again. Never cached.
 *  - `error`  anything else: not an answer. Never cached — the README's rule that
 *             a request that failed must not be written down as "nothing here".
 */
export function errorKind(json) {
  const e = json?.error;
  if (!e) return null;
  const code = Number(e.code);
  if (code === 800) return 'none';
  if (code === 4) return 'quota';
  return 'error';
}

/** Lower-case, accents and punctuation off, a leading "the" dropped. Enough to
 *  see that "Ragga Twins" and "The Ragga Twins" are one act, and not so loose
 *  that two different names collapse into one. */
export function normName(s) {
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, 'and').replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');
}

/**
 * The Deezer artist behind a Spotify credit, from a `track/isrc:` answer.
 *
 * @param {object} json   the parsed response
 * @param {string} name   the Spotify artist's name, to check the credit against
 * @returns {{answered: true, artist: {id: number, name: string}|null}
 *          |{answered: false, retry: boolean}}
 */
export function artistFromIsrc(json, name) {
  const kind = errorKind(json);
  if (kind === 'none') return { answered: true, artist: null };
  if (kind) return { answered: false, retry: kind === 'quota' };
  if (!json || typeof json !== 'object' || json.id == null) return { answered: false, retry: false };

  const want = normName(name);
  const credits = [json.artist, ...(Array.isArray(json.contributors) ? json.contributors : [])]
    .filter(a => a && a.id != null && a.name);
  // The main artist first, then any contributor, but only ever one whose name
  // matches the credit we asked about. No match is an answer — "Deezer has the
  // recording but not under this artist" — not a reason to take the nearest.
  const hit = want ? credits.find(a => normName(a.name) === want) : null;
  return { answered: true, artist: hit ? { id: Number(hit.id), name: String(hit.name) } : null };
}

/**
 * An artist's related artists, in Deezer's own order (most related first).
 *
 * @returns {{answered: true, related: {id: number, name: string}[]}
 *          |{answered: false, retry: boolean}}
 */
export function relatedFrom(json, { limit = RELATED_LIMIT } = {}) {
  const kind = errorKind(json);
  if (kind === 'none') return { answered: true, related: [] };
  if (kind) return { answered: false, retry: kind === 'quota' };
  if (!json || !Array.isArray(json.data)) return { answered: false, retry: false };
  const related = json.data
    .filter(a => a && a.id != null && a.name)
    .slice(0, limit)
    .map(a => ({ id: Number(a.id), name: String(a.name) }));
  return { answered: true, related };
}
