// Fetch Last.fm artist tags for every artist in the library. Resumable.
import { readFileSync } from 'node:fs';
import { env } from './env.mjs';
import { Cache, sleep, retry } from './cache.mjs';
import { fetchListening } from './listening.mjs';
import { byListening } from './profile.mjs';

const lib = JSON.parse(readFileSync('library.json', 'utf8'));
const artists = new Map();
const add = t => { for (const a of t?.artists ?? []) if (a.id) artists.set(a.id, a.name); };
for (const p of lib.playlists) p.tracks.forEach(add);
lib.liked.forEach(add);

const cache = new Cache('tags-lastfm.json');
let todo = [...artists].filter(([id]) => !cache.has(id));

// Whatever this run doesn't finish should at least have covered what you
// actually listen to — a 20-minute fetch interrupted partway still leaves
// the artists behind your real suggestions tagged first.
try {
  const { weights } = await fetchListening(lib);
  todo = byListening(todo, weights);
} catch { /* no Spotify auth available here, or offline — library order is fine */ }

console.error(`artists: ${artists.size} | cached: ${cache.size} | to fetch: ${todo.length}`);

let done = 0, empty = 0;
for (const [id, name] of todo) {
  try {
    const r = await retry(() => fetch('https://ws.audioscrobbler.com/2.0/?' + new URLSearchParams({
      method: 'artist.gettoptags', artist: name, autocorrect: '1',
      api_key: env.LASTFM_API_KEY, format: 'json',
    })).then(x => x.json()));

    // Keep tag weights: Last.fm counts are 0-100 relative to the top tag.
    const tags = (r.toptags?.tag ?? [])
      .filter(t => Number(t.count) >= 10)
      .slice(0, 15)
      .map(t => [t.name.toLowerCase(), Number(t.count)]);

    cache.set(id, { name, tags });
    if (!tags.length) empty++;
  } catch (e) {
    cache.set(id, { name, tags: [], error: String(e.message).slice(0, 80) });
  }
  if (++done % 250 === 0) console.error(`  ${done}/${todo.length}  (${empty} with no tags)`);
  await sleep(200);                      // ~5 req/s, Last.fm's documented ceiling
}
cache.flush();
console.error(`done. cached ${cache.size} artists, ${empty} returned no tags`);
