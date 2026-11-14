// Gather the raw material for the neighbour bridge, politely and resumably.
//
// The transports are injected, which is what lets one orchestrator serve both
// environments and be tested with no network at all:
//
//   deezer(url)      -> parsed JSON. On the page this is JSONP through a
//                       sandboxed frame (Deezer sends no CORS header); in Node
//                       it is plain fetch.
//   json(url, init)  -> parsed JSON, for the CORS-open sources (Wikidata,
//                       ListenBrainz).
//
// Two rules from README's "a tag gap that was never answered is not an answer"
// carry over unchanged:
//
//  - Only an answer is cached. A request that failed, timed out or hit a quota
//    leaves the entry as it was, so the next run asks again rather than
//    freezing "nothing here" for weeks.
//  - A real "nothing" is an answer, and is cached like one — but with the same
//    TTL as everything else, because Deezer's and ListenBrainz's catalogues
//    grow.
// Named imports only: the browser bundler (bundler.mjs) reads `import { … }`
// and nothing else.
import { errorKind, artistFromIsrc, relatedFrom, isrcUrl, relatedUrl } from '../sources/deezer.mjs';
import { similarFrom, similarUrl } from '../sources/listenbrainz.mjs';
import { BATCH as WD_BATCH, mbidRequest, mbidsFrom, isSpotifyId } from '../sources/wikidata.mjs';

export const BRIDGE_FETCH_VERSION = '1.0.0';

/** How long an answer is trusted before it is asked again. */
export const TTL_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Milliseconds between requests, per source. Deezer's published limit is 50
 * requests per 5 seconds; 130ms is about 7.7 a second, comfortably under it.
 * ListenBrainz and Wikidata publish no fixed number, so they get less, and one
 * retry after `retry` ms: measured from a browser, ListenBrainz occasionally
 * answers a burst with an error that carries no CORS header, and the same
 * request a moment later is fine.
 */
export const PACE = { deezer: 130, listenbrainz: 400, wikidata: 1000, retry: 2000 };

/** After a Deezer quota answer, wait this long once, then give up for the run. */
export const QUOTA_WAIT_MS = 6000;

const fresh = (at, now) => Number.isFinite(at) && now - at < TTL_MS;

/**
 * @param {Map<string, {name: string, isrc: string|null}>} artists  from `sourceArtists()`,
 *        most important first
 * @param {object} io
 * @param {(url: string) => Promise<any>} io.deezer
 * @param {(url: string, init?: object) => Promise<any>} io.json
 * @param {object} [io.cache]      previous raw entries; copied, never mutated
 * @param {(ms: number) => Promise<void>} [io.sleep]
 * @param {(p: {stage: string, done: number, total: number}) => void} [io.onProgress]
 * @param {number} [io.now]
 * @param {object} [io.pace]
 * @returns {Promise<{raw: object, stats: object}>}
 */
export async function gatherBridge(artists, { deezer, json, cache = null, onProgress = null,
                                              sleep = ms => new Promise(r => setTimeout(r, ms)),
                                              now = Date.now(), pace = PACE } = {}) {
  const raw = {};
  for (const [sid, e] of Object.entries(cache ?? {})) raw[sid] = { ...e };
  const entry = sid => (raw[sid] ??= {});
  const ids = [...(artists ?? new Map()).keys()];
  const stats = { asked: ids.length, wikidata: 0, deezer: 0, listenbrainz: 0,
                  failed: 0, quota: false, fromCache: 0 };
  const progress = (stage, done, total) => { try { onProgress?.({ stage, done, total }); } catch { /* a UI callback must not stop the run */ } };
  const twice = async (url, init) => {
    try { return await json(url, init); }
    catch { await sleep(pace.retry ?? 0); return json(url, init); }
  };

  /* 1. Spotify id -> MBID, 300 at a time. ListenBrainz needs it. */
  // Only real Spotify ids: anything else could never match, and asking about
  // nothing is still a request.
  const needMbid = ids.filter(sid => isSpotifyId(sid) && !fresh(raw[sid]?.mbidAt, now));
  for (let i = 0; i < needMbid.length; i += WD_BATCH) {
    const batch = needMbid.slice(i, i + WD_BATCH);
    progress('wikidata', i, needMbid.length);
    try {
      const req = mbidRequest(batch);
      const out = mbidsFrom(await twice(req.url, req.init));
      if (out.answered) {
        for (const sid of batch) Object.assign(entry(sid), { mbid: out.mbids.get(sid) ?? null, mbidAt: now });
        stats.wikidata += batch.length;
      } else stats.failed++;
    } catch { stats.failed++; }
    if (i + WD_BATCH < needMbid.length) await sleep(pace.wikidata);
  }

  /* 2 and 3 run side by side: they are different hosts with separate limits. */
  const deezerRun = (async () => {
    const todo = ids.filter(sid => !fresh(raw[sid]?.deezerAt, now));
    stats.fromCache += ids.length - todo.length;
    const ask = async url => {
      let out = await deezer(url);
      if (errorKind(out) === 'quota') {
        await sleep(QUOTA_WAIT_MS);
        out = await deezer(url);
        if (errorKind(out) === 'quota') { stats.quota = true; return null; }
      }
      return out;
    };
    for (let i = 0; i < todo.length; i++) {
      if (stats.quota) break;
      progress('deezer', i, todo.length);
      const sid = todo[i];
      const { name, isrc } = artists.get(sid) ?? {};
      if (!isrc) continue;                       // no recording to reach them by: not an answer
      try {
        const hit = artistFromIsrc(await ask(isrcUrl(isrc)), name);
        await sleep(pace.deezer);
        if (!hit.answered) { stats.failed++; continue; }
        if (!hit.artist) {
          Object.assign(entry(sid), { deezerId: null, deezer: [], deezerAt: now });
          stats.deezer++;
          continue;
        }
        const rel = relatedFrom(await ask(relatedUrl(hit.artist.id)));
        await sleep(pace.deezer);
        if (!rel.answered) { stats.failed++; continue; }
        Object.assign(entry(sid), { deezerId: hit.artist.id, deezer: rel.related, deezerAt: now });
        stats.deezer++;
      } catch { stats.failed++; }
    }
    progress('deezer', todo.length, todo.length);
  })();

  const lbRun = (async () => {
    const todo = ids.filter(sid => raw[sid]?.mbid && !fresh(raw[sid]?.lbAt, now));
    for (let i = 0; i < todo.length; i++) {
      progress('listenbrainz', i, todo.length);
      const sid = todo[i];
      try {
        const out = similarFrom(await twice(similarUrl(raw[sid].mbid)));
        if (out.answered) {
          Object.assign(entry(sid), { listenbrainz: out.similar, lbAt: now });
          stats.listenbrainz++;
        } else stats.failed++;
      } catch { stats.failed++; }
      await sleep(pace.listenbrainz);
    }
    progress('listenbrainz', todo.length, todo.length);
  })();

  await Promise.all([deezerRun, lbRun]);
  return { raw, stats };
}
