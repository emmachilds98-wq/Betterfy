// Wikidata: a Spotify artist id to a MusicBrainz id, exactly, in batches.
//
// Wikidata item properties P1902 (Spotify artist id) and P434 (MusicBrainz
// artist id) sit on the same item, so one SPARQL query turns up to 300 Spotify
// ids into MBIDs with no name matching anywhere. CORS-open (checked).
//
// Measured on the owner's library (docs/SMARTER-GENRES-PLAN.md §2.1): 1,992 of
// 4,866 artists found, 1,950 with an MBID. Weak on scene producers — which is
// why Deezer, reached by ISRC, is the other half of the bridge.
import { defineProvider } from './provider.mjs';

export const WIKIDATA = defineProvider({
  id: 'wikidata-identity',
  version: '1.0.0',
  capabilities: ['identity'],
  entityTypes: ['artist'],
  reliability: 0.9,
  independenceGroup: 'wikidata',
  optional: true,
  requires: 'nothing — public, keyless',
});

export const ENDPOINT = 'https://query.wikidata.org/sparql';

/** Ids per query. Measured: 300 answers in a second or two and stays well inside
 *  the endpoint's limits; much larger batches start timing out. */
export const BATCH = 300;

const SPOTIFY_ID_RE = /^[0-9A-Za-z]{22}$/;
export const isSpotifyId = s => SPOTIFY_ID_RE.test(String(s ?? ''));

/** The query for one batch. Ids are validated first: they are spliced into the
 *  query text, and anything that is not a 22-character base-62 id is dropped
 *  rather than escaped. */
export function mbidQuery(spotifyIds) {
  const vals = [...new Set(spotifyIds)].filter(isSpotifyId).map(s => `"${s}"`).join(' ');
  return `SELECT ?s ?mbid WHERE { VALUES ?s { ${vals} } ?a wdt:P1902 ?s . ?a wdt:P434 ?mbid . }`;
}

/** The POST body for one batch. A form body keeps it a simple CORS request. */
export const mbidRequest = spotifyIds => ({
  url: ENDPOINT,
  init: {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/sparql-results+json' },
    body: new URLSearchParams({ query: mbidQuery(spotifyIds), format: 'json' }).toString(),
  },
});

/**
 * Spotify id -> MBID from a SPARQL answer.
 *
 * An item can carry two MBIDs (a merge nobody cleaned up). The first in
 * sorted order wins, so the answer is the same every time it is asked.
 *
 * @returns {{answered: true, mbids: Map<string, string>}|{answered: false}}
 */
export function mbidsFrom(json) {
  const rows = json?.results?.bindings;
  if (!Array.isArray(rows)) return { answered: false };
  const all = new Map();
  for (const b of rows) {
    const s = b?.s?.value, m = String(b?.mbid?.value ?? '').toLowerCase();
    if (!isSpotifyId(s) || !/^[0-9a-f-]{36}$/.test(m)) continue;
    if (!all.has(s)) all.set(s, []);
    all.get(s).push(m);
  }
  const mbids = new Map();
  for (const [s, list] of all) mbids.set(s, list.sort()[0]);
  return { answered: true, mbids };
}
