// Fetch Last.fm artist tags for every artist in the library. Resumable.
import { readFileSync } from 'node:fs';
import { env } from './env.mjs';
import { Cache, sleep, retry, worthReasking } from './cache.mjs';
import { fetchListening } from './listening.mjs';
import { byListening } from './profile.mjs';
import { resolveMbid } from './musicbrainz.mjs';

const lib = JSON.parse(readFileSync('library.json', 'utf8'));
const artists = new Map();
const add = t => { for (const a of t?.artists ?? []) if (a.id) artists.set(a.id, a.name); };
for (const p of lib.playlists) p.tracks.forEach(add);
lib.liked.forEach(add);

const cache = new Cache('tags-lastfm.json');
let todo = [...artists].filter(([id]) => worthReasking(cache.get(id)));

// Identity glue, ahead of the Last.fm fetch itself: resolving to a MusicBrainz
// id first means the tags below can be asked for by mbid= instead of a name
// autocorrect might match onto the wrong, same-named artist. Off entirely with
// no MUSICBRAINZ_CONTACT configured (see .env.example) — nothing here changes
// for anyone who hasn't set one. A "not found" answer is worth trying again
// later too, since MusicBrainz volunteers add Spotify links to entries over
// time; a found one never changes.
const MBID_STALE_MS = 1000 * 60 * 60 * 24 * 180; // ~6 months
const mbidCache = new Cache('mbid.json');
const needsMbidLookup = id => {
  const e = mbidCache.get(id);
  return !e || (!e.mbid && Date.now() - (e.checkedAt ?? 0) > MBID_STALE_MS);
};
if (env.MUSICBRAINZ_CONTACT) {
  const lookups = todo.filter(([id]) => needsMbidLookup(id));
  if (lookups.length) console.error(`resolving MusicBrainz ids for ${lookups.length} artist(s)…`);
  for (const [id, name] of lookups) {
    const mbid = await resolveMbid(id, env.MUSICBRAINZ_CONTACT);
    mbidCache.set(id, { mbid, checkedAt: Date.now() });
    await sleep(1000); // MusicBrainz's courtesy limit is ~1 req/s
  }
  mbidCache.flush();
} else {
  console.error('No MUSICBRAINZ_CONTACT in .env — identity resolution is optional, skipping.');
}

// Whatever this run doesn't finish should at least have covered what you
// actually listen to — a 20-minute fetch interrupted partway still leaves
// the artists behind your real suggestions tagged first.
try {
  const { weights } = await fetchListening(lib);
  todo = byListening(todo, weights);
} catch { /* no Spotify auth available here, or offline — library order is fine */ }

console.error(`artists: ${artists.size} | cached: ${cache.size} | to fetch: ${todo.length}`);

let done = 0, empty = 0, viaMbid = 0;
for (const [id, name] of todo) {
  const mbid = mbidCache.get(id)?.mbid;
  try {
    // mbid= is an exact identity match — no autocorrect, no same-named-artist
    // risk — so it's used whenever MusicBrainz resolved one; name+autocorrect
    // is the fallback for everyone else, exactly as before.
    const params = mbid
      ? { method: 'artist.gettoptags', mbid, api_key: env.LASTFM_API_KEY, format: 'json' }
      : { method: 'artist.gettoptags', artist: name, autocorrect: '1', api_key: env.LASTFM_API_KEY, format: 'json' };
    const r = await retry(() => fetch('https://ws.audioscrobbler.com/2.0/?' + new URLSearchParams(params))
      .then(x => x.json()));

    // Keep tag weights: Last.fm counts are 0-100 relative to the top tag.
    const tags = (r.toptags?.tag ?? [])
      .filter(t => Number(t.count) >= 10)
      .slice(0, 15)
      .map(t => [t.name.toLowerCase(), Number(t.count)]);

    cache.set(id, { name, tags, checkedAt: Date.now() });
    if (!tags.length) empty++;
    if (mbid) viaMbid++;
  } catch (e) {
    cache.set(id, { name, tags: [], error: String(e.message).slice(0, 80), checkedAt: Date.now() });
  }
  if (++done % 250 === 0) console.error(`  ${done}/${todo.length}  (${empty} with no tags)`);
  await sleep(200);                      // ~5 req/s, Last.fm's documented ceiling
}
cache.flush();
console.error(`done. cached ${cache.size} artists, ${empty} returned no tags`
  + (viaMbid ? ` (${viaMbid} matched by MusicBrainz id, not name)` : ''));
