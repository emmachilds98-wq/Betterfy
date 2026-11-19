// Deezer preview lookup and partial download (WP-A1).
//
// Spotify gives the ISRC; Deezer's `track/isrc:` answers with a 30-second
// preview MP3 for that exact recording. ISRC or nothing: phase 0 saw a name
// match pick the wrong track 1 time in 19 (docs/AUDIO-ANALYSIS-PLAN.md §0).
//
// Nothing here owns a transport. `jsonp` is injected (the page passes its
// existing deezerJsonp; Deezer's API sends no CORS header) and so is `fetch`
// (the preview CDN *is* CORS-open). Tests pass fakes; there is no network in
// CI.
//
// Rules this file holds (build plan §0):
//  - never cache a preview URL: it is signed and expires ~15 minutes after
//    lookup, so look up and download in the same pass;
//  - a failed request is FAILED, which record.mjs refuses to cache, never a
//    catalogue "miss";
//  - only two ~10 s windows are downloaded (phase 0: 31% less data, same
//    top-1 82% of the time, embedding cosine median 0.988).
import { MISS } from './record.mjs';
import { isrcUrl, errorKind } from '../sources/deezer.mjs';

export const FETCH_VERSION = '1.0.0';
/** One window: ~10 s of a 128 kbps preview. */
export const WINDOW_BYTES = 165000;
/** Deezer duration vs Spotify duration: more apart than this is another recording. */
export const IDENTITY_TOLERANCE_MS = 3000;

const normIsrc = s => String(s ?? '').replace(/-/g, '').toUpperCase();

/**
 * Look a track up on Deezer by ISRC.
 * @param {string} isrc
 * @param {{ jsonp: (url: string) => Promise<object>, spotifyDurationMs?: number }} deps
 * @returns {Promise<{ deezerId: number, previewUrl: string, durationMs: number, readable: boolean }
 *                  | { miss: string, detail?: string }>}
 */
export async function lookup(isrc, { jsonp, spotifyDurationMs } = {}) {
  if (!isrc) return { miss: MISS.NO_ISRC };
  let json;
  try { json = await jsonp(isrcUrl(isrc)); }
  catch (e) { return { miss: MISS.FAILED, detail: String(e?.message ?? e) }; }
  const err = errorKind(json);
  if (err === 'none') return { miss: MISS.NOT_ON_DEEZER };
  if (err) return { miss: MISS.FAILED, detail: err };          // quota or error: ask again later
  if (!json || typeof json !== 'object' || !json.id) return { miss: MISS.FAILED, detail: 'malformed' };
  if (json.isrc && normIsrc(json.isrc) !== normIsrc(isrc)) return { miss: MISS.IDENTITY, detail: 'isrc' };
  const durationMs = Number(json.duration) * 1000;
  if (spotifyDurationMs != null && !identityOk(durationMs, spotifyDurationMs)) return { miss: MISS.IDENTITY, detail: 'duration' };
  const readable = json.readable !== false;
  if (!readable || !json.preview) return { miss: MISS.NO_PREVIEW, detail: readable ? 'no preview' : 'not readable' };
  return { deezerId: json.id, previewUrl: json.preview, durationMs, readable };
}

/** Deezer reports whole seconds, so ±3 s is the tolerance (§4.1). */
export function identityOk(deezerDurationMs, spotifyDurationMs) {
  if (!Number.isFinite(deezerDurationMs) || !Number.isFinite(spotifyDurationMs) || deezerDurationMs <= 0) return false;
  return Math.abs(deezerDurationMs - spotifyDurationMs) <= IDENTITY_TOLERANCE_MS;
}

/**
 * The two byte ranges to download: one at the start, one centred.
 * Returns [[start, length], ...] — the shape AudioRecord's `source.windows` keeps.
 * A file too small for two separate windows comes back as one range covering it.
 */
export function windows(byteLength) {
  const n = Math.max(0, Math.floor(byteLength));
  if (n <= 2 * WINDOW_BYTES) return n > 0 ? [[0, n]] : [];
  const mid = Math.floor(n / 2 - WINDOW_BYTES / 2);
  return [[0, WINDOW_BYTES], [mid, WINDOW_BYTES]];
}

/**
 * Download byte ranges of a preview. Expects 206 Partial Content; a server
 * that ignores Range and answers 200 sends the whole file, which is sliced
 * here instead (and the result says so, in `.sliced`).
 *
 * @param {string} url
 * @param {Array<[number, number]>} ranges
 * @param {{ fetch: typeof fetch }} deps
 * @returns {Promise<ArrayBuffer[] & { sliced: boolean }>}  rejects on a network or HTTP failure
 */
export async function fetchWindows(url, ranges, { fetch }) {
  const out = []; let sliced = false, whole = null;
  for (const [start, len] of ranges) {
    if (whole) { out.push(whole.slice(start, start + len)); continue; }
    const r = await fetch(url, { headers: { Range: `bytes=${start}-${start + len - 1}` } });
    if (r.status === 206) { out.push(await r.arrayBuffer()); continue; }
    if (r.status === 200) {
      whole = await r.arrayBuffer(); sliced = true;
      out.push(whole.slice(start, start + len));
      continue;
    }
    throw new Error(`preview answered ${r.status}`);
  }
  return Object.assign(out, { sliced });
}

/** Total size from a `Content-Range: bytes 0-164999/479827` header, or null. */
export function totalFromContentRange(h) {
  const m = /\/(\d+)\s*$/.exec(String(h ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * Lookup's preview -> the two windows, in one pass (the URL is never kept).
 * The first request also tells us the file size, which places the centred
 * window; a server that sends the whole file costs one request.
 *
 * @returns {Promise<{ buffers: ArrayBuffer[], windows: Array<[number, number]>, total: number|null, sliced: boolean }
 *                  | { miss: 'FAILED', detail: string }>}
 */
export async function fetchPreview(url, { fetch }) {
  try {
    const r = await fetch(url, { headers: { Range: `bytes=0-${WINDOW_BYTES - 1}` } });
    if (r.status === 200) {
      const whole = await r.arrayBuffer();
      const w = windows(whole.byteLength);
      return { buffers: w.map(([s, l]) => whole.slice(s, s + l)), windows: w, total: whole.byteLength, sliced: true };
    }
    if (r.status !== 206) return { miss: MISS.FAILED, detail: `preview answered ${r.status}` };
    const first = await r.arrayBuffer();
    const total = totalFromContentRange(r.headers?.get?.('content-range'));
    if (!total || total <= first.byteLength) return { buffers: [first], windows: [[0, first.byteLength]], total: total ?? first.byteLength, sliced: false };
    const w = windows(total);
    if (w.length < 2) {
      const rest = await fetchWindows(url, [[first.byteLength, total - first.byteLength]], { fetch });
      const all = new Uint8Array(total); all.set(new Uint8Array(first)); all.set(new Uint8Array(rest[0]), first.byteLength);
      return { buffers: [all.buffer], windows: [[0, total]], total, sliced: rest.sliced };
    }
    const second = await fetchWindows(url, [w[1]], { fetch });
    return { buffers: [first, second[0]], windows: [[0, first.byteLength], w[1]], total, sliced: second.sliced };
  } catch (e) {
    return { miss: MISS.FAILED, detail: String(e?.message ?? e) };
  }
}

/** Stands in for a preview URL when the answer comes from the cache; never a real, signed URL. */
export const CACHED_PREVIEW = 'preview-cache:';

/**
 * One download per record for all top-ups (SOUND-ENGINE-PLAN L3). The four
 * top-ups (tempo/key, CLAP, Beat This, key v4) each looked a record up and
 * downloaded its preview again; this wraps `lookup` and `fetchPreview` so the
 * second and later ask for the same ISRC in a run is answered from the raw
 * (still compressed) windows kept briefly in memory. Only the audio bytes and
 * Deezer's id are kept, never the signed URL, and callers get fresh copies
 * because decoding detaches the buffer it is given. `max` records are kept
 * (oldest out first); `max` 0 passes everything straight through. Make one
 * per run and `clear()` it when the run ends.
 *
 * @param {{ lookup: Function, fetchPreview: Function, max?: number }} deps
 */
export function createPreviewCache({ lookup, fetchPreview, max = 64 }) {
  const kept = new Map();   // isrc -> { found (no url), got }
  const urls = new Map();   // the url of a lookup just answered -> { isrc, found }
  const stats = { lookups: 0, downloads: 0, hits: 0 };
  const copy = got => ({ ...got, buffers: got.buffers.map(b => b.slice(0)) });
  return {
    stats,
    clear() { kept.clear(); urls.clear(); },
    async lookup(isrc, o) {
      const e = max > 0 ? kept.get(isrc) : null;
      if (e) { kept.delete(isrc); kept.set(isrc, e); stats.hits++; return { ...e.found, previewUrl: CACHED_PREVIEW + isrc }; }
      stats.lookups++;
      const r = await lookup(isrc, o);
      if (max > 0 && r && !r.miss && r.previewUrl) urls.set(r.previewUrl, { isrc, found: r });
      return r;
    },
    async fetchPreview(url) {
      if (typeof url === 'string' && url.startsWith(CACHED_PREVIEW)) {
        const e = kept.get(url.slice(CACHED_PREVIEW.length));
        return e ? copy(e.got) : { miss: MISS.FAILED, detail: 'cache' };
      }
      const got = await fetchPreview(url);
      stats.downloads++;
      const k = urls.get(url); urls.delete(url);
      if (max > 0 && k && got && !got.miss && Array.isArray(got.buffers)) {
        const { previewUrl, ...found } = k.found;
        kept.set(k.isrc, { found, got: copy(got) });
        while (kept.size > max) kept.delete(kept.keys().next().value);
      }
      return got;
    },
  };
}
