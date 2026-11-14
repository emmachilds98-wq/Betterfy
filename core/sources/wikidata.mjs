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

/* ---------- genres (P136), for artists nothing else has tagged ---------- */

/** The query for one batch: each artist's genres, by English label. */
export function genreQuery(spotifyIds) {
  const vals = [...new Set(spotifyIds)].filter(isSpotifyId).map(s => `"${s}"`).join(' ');
  return `SELECT ?s ?gl WHERE { VALUES ?s { ${vals} } ?a wdt:P1902 ?s . ?a wdt:P136 ?g . `
    + `?g rdfs:label ?gl FILTER(lang(?gl) = "en") }`;
}

export const genreRequest = spotifyIds => ({
  url: ENDPOINT,
  init: {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/sparql-results+json' },
    body: new URLSearchParams({ query: genreQuery(spotifyIds), format: 'json' }).toString(),
  },
});

/**
 * Spotify id -> genre labels, in the order Wikidata gave them, no repeats.
 * @returns {{answered: true, genres: Map<string, string[]>}|{answered: false}}
 */
export function genresFrom(json) {
  const rows = json?.results?.bindings;
  if (!Array.isArray(rows)) return { answered: false };
  const genres = new Map();
  for (const b of rows) {
    const s = b?.s?.value, g = String(b?.gl?.value ?? '').trim();
    if (!isSpotifyId(s) || !g) continue;
    if (!genres.has(s)) genres.set(s, []);
    if (!genres.get(s).includes(g)) genres.get(s).push(g);
  }
  return { answered: true, genres };
}

/**
 * Wikidata labels as tags in the shape the rest of the app reads: [[tag, 0-100]].
 *
 * Wikidata names a genre as an encyclopaedia would ("house music", "rock
 * music", "hip-hop"); Last.fm's crowd as listeners do ("house", "rock"). The
 * " music" suffix is dropped so the two spell the same genre the same way, and
 * the shipped spelling merges handle the rest. Wikidata gives no strengths, so
 * the first-listed genre leads and the rest step down from it.
 */
const SUFFIX_EXCEPTIONS = { 'electronic dance': 'edm' };

export function genreTags(labels, { max = 6 } = {}) {
  const seen = new Set(), out = [];
  for (const raw of labels ?? []) {
    // "house music" is house and "heavy metal music" is heavy metal; the one
    // name that does not survive losing the word is "electronic dance music",
    // which crowds call EDM. Measured live on 600 of the owner's artists: 92%
    // of the labels this produces are genres the vocabulary reads.
    const stripped = String(raw).toLowerCase().trim().replace(/\s+music$/, '');
    const t = SUFFIX_EXCEPTIONS[stripped] ?? stripped;
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push([t, Math.max(40, 100 - out.length * 15)]);
    if (out.length >= max) break;
  }
  return out;
}
