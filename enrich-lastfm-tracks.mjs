// Track-level Last.fm tags — Task 6 of the v3 plan.
//
// enrich-lastfm.mjs asks Last.fm what an *artist* is tagged with. This asks
// what a *recording* is tagged with, which is the one question that actually
// fixes the defect §4.1 is about: a diverse artist currently hands the same
// cloud to everything they ever made, and no amount of reweighting artist
// tags can separate their ambient record from their jungle one.
//
// Track tags are much thinner than artist tags — plenty of records have none
// at all — so this does not replace the artist fetch and must never be run
// instead of it. It is a deeper pass over the tracks where a better answer
// would actually change something, which is why it is prioritised rather than
// exhaustive (§28): a library of ten thousand tracks is roughly half a day at
// Last.fm's rate limit, and the tracks worth spending it on are the ones you
// play a lot and the engine is least sure about.
//
// Resumable and interruptible: stop it whenever, and what it did keeps.
import { readFileSync, existsSync } from 'node:fs';
import { env } from './env.mjs';
import { Cache, sleep, retry, worthReasking } from './cache.mjs';
import { fetchListening } from './listening.mjs';
import { tagParams, extractTags, TAG_ENDPOINT } from './core/sources/lastfm.mjs';
import { indexCaches, buildRegistry, profileTrack } from './core/engine.mjs';
import { CONFIDENCE } from './core/analysis/classify.mjs';

const LIMIT = Number(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] ?? 1500);

if (!env.LASTFM_API_KEY) {
  console.error('No LASTFM_API_KEY in .env — nothing to do.');
  process.exit(0);
}

const lib = JSON.parse(readFileSync('library.json', 'utf8'));
const readIf = f => existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;

// Everything the engine already knows, so "uncertain" below means uncertain
// after reading every cache this listener has — not merely unfetched.
const idx = indexCaches({
  lastfm: readIf('tags-lastfm.json'),
  discogs: readIf('tags-discogs.json'),
  shared: readIf('docs/tags.json'),
  mbids: readIf('mbid.json'),
});
const registry = buildRegistry(idx.present);

// One entry per distinct track: a track filed in six playlists is one record
// and is worth exactly one fetch.
const tracks = new Map();
for (const p of lib.playlists ?? []) for (const t of p.tracks ?? []) if (t?.id) tracks.set(t.id, t);
for (const t of lib.liked ?? []) if (t?.id) tracks.set(t.id, t);

const cache = new Cache('tags-lastfm-tracks.json');

/* ---------- §28: analyse high-use + uncertain first, defer rare + certain ----------
 * Both halves are needed. Uncertainty alone spends the whole budget on
 * obscure one-off tracks nobody plays; play count alone re-asks about tracks
 * three sources already agree on. */
const UNCERTAINTY = {
  [CONFIDENCE.INSUFFICIENT_DATA]: 1.0,
  [CONFIDENCE.AMBIGUOUS]: 0.9,
  [CONFIDENCE.LIKELY]: 0.45,
  [CONFIDENCE.HIGH]: 0.05,
};

let weights = new Map();
try { ({ weights } = await fetchListening(lib)); }
catch { /* no Spotify auth here, or offline — uncertainty alone still orders it */ }

const candidates = [];
for (const [id, t] of tracks) {
  if (!worthReasking(cache.get(id))) continue;
  const { profile } = profileTrack(t, idx, { registry });
  const uncertainty = UNCERTAINTY[profile.genre.confidence] ?? 0.5;
  // Listening weight is unbounded and relative (see listeningWeights), so it
  // is folded in as a multiplier on a floor of 1 rather than added to a 0-1
  // uncertainty it would otherwise swamp.
  const played = weights.get(t.artists?.[0]?.name) ?? 0;
  candidates.push({ id, track: t, score: uncertainty * (1 + played), confidence: profile.genre.confidence });
}
candidates.sort((a, b) => b.score - a.score);
const todo = candidates.slice(0, LIMIT);

const bands = {};
for (const c of candidates) bands[c.confidence] = (bands[c.confidence] ?? 0) + 1;
console.error(`tracks: ${tracks.size} | already fetched: ${cache.size} | worth asking: ${candidates.length}`);
console.error(`  by current confidence: ${Object.entries(bands).map(([k, n]) => `${k} ${n}`).join(', ')}`);
console.error(`fetching the top ${todo.length} (--limit=N to change)\n`);

let done = 0, withTags = 0;
for (const { id, track } of todo) {
  const artist = track.artists?.[0]?.name ?? '';
  const title = track.name ?? '';
  try {
    const json = await retry(() => fetch(TAG_ENDPOINT + '?' + new URLSearchParams(
      tagParams({ entityType: 'track', artist, title, apiKey: env.LASTFM_API_KEY })
    )).then(r => r.json()));
    const tags = extractTags(json);
    cache.set(id, { artist, title, tags, checkedAt: Date.now() });
    if (tags.length) withTags++;
  } catch (e) {
    // Recorded rather than dropped, so worthReasking() retries it next run
    // instead of the run silently covering less than it reports.
    cache.set(id, { artist, title, tags: [], error: String(e.message).slice(0, 80), checkedAt: Date.now() });
  }
  if (++done % 100 === 0) console.error(`  ${done}/${todo.length}  (${withTags} with tags)`);
  await sleep(200);                      // ~5 req/s, Last.fm's documented ceiling
}
cache.flush();
console.error(`\ndone. ${withTags}/${todo.length} tracks came back with tags; cache now holds ${cache.size}.`);
console.error('Track tags outrank artist tags on specificity alone — nothing else needs changing.');
