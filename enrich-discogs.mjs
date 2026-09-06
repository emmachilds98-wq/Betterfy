// Fallback tag source for artists Last.fm has nothing on. Not a replacement —
// Last.fm's crowd tags are the backbone (enrich-lastfm.mjs) — this only ever
// fills an artist that comes back with zero tags, using Discogs' release
// search: each hit carries its own `style` array (Jungle, Deep House, Electro
// — genre is far coarser and mostly unused), so tallying style across an
// artist's releases approximates the release-level nuance a single flat
// artist bio never gives Last.fm either.
import { readFileSync } from 'node:fs';
import { env } from './env.mjs';
import { Cache, sleep, retry } from './cache.mjs';

if (!env.DISCOGS_TOKEN) {
  console.error('No DISCOGS_TOKEN in .env — Discogs enrichment is optional, skipping.');
  process.exit(0);
}

const lib = JSON.parse(readFileSync('library.json', 'utf8'));
const artists = new Map();
const add = t => { for (const a of t?.artists ?? []) if (a.id) artists.set(a.id, a.name); };
for (const p of lib.playlists) p.tracks.forEach(add);
lib.liked.forEach(add);

// Only the gap Last.fm left open — this never overrides a real Last.fm tag.
const lastfm = new Cache('tags-lastfm.json');
const empty = [...artists].filter(([id]) => !lastfm.get(id)?.tags?.length);

const cache = new Cache('tags-discogs.json');
const todo = empty.filter(([id]) => !cache.has(id));
console.error(`artists with no Last.fm tags: ${empty.length} | cached: ${cache.size} | to fetch: ${todo.length}`);

let done = 0, filled = 0;
for (const [id, name] of todo) {
  try {
    const r = await retry(() => fetch('https://api.discogs.com/database/search?' + new URLSearchParams({
      artist: name, type: 'release', per_page: '50', token: env.DISCOGS_TOKEN,
    }), { headers: { 'User-Agent': 'Betterfy/1.0 +https://github.com/emmachilds98-wq/Betterfy' } })
      .then(x => x.json()));

    // Tally how many of this artist's releases carry each style, the same
    // "count = how many sources said so" shape Last.fm tags already use, so
    // profile.mjs needs no change to consume either source.
    const tally = new Map();
    for (const hit of r.results ?? [])
      for (const style of hit.style ?? [])
        tally.set(style.toLowerCase(), (tally.get(style.toLowerCase()) ?? 0) + 1);

    const tags = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 10);
    cache.set(id, { name, tags, source: 'discogs' });
    if (tags.length) filled++;
  } catch (e) {
    cache.set(id, { name, tags: [], source: 'discogs', error: String(e.message).slice(0, 80) });
  }
  if (++done % 100 === 0) console.error(`  ${done}/${todo.length}  (${filled} filled so far)`);
  await sleep(1100);                     // 60 req/min with a token — stay under it
}
cache.flush();
console.error(`done. cached ${cache.size} artists, filled ${filled} of ${todo.length} this run`);
