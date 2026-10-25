// Fallback tag source for whatever Last.fm, MusicBrainz and Discogs all still
// left thin. iTunes' Search API needs no key or signup at all, and returns
// one genre per artist — coarser than Last.fm (one flat genre, not a ranked
// cloud), worth having as a last resort rather than nothing.
//
// Its rate limit is informal and undocumented — roughly 20 requests/minute
// per IP is the widely reported figure — paced conservatively below, which
// makes this the slowest of the enrich scripts for a large gap. It only
// ever runs against what every earlier source left open, so by the time
// this runs the gap should already be small.
import { readFileSync } from 'node:fs';
import { Cache, sleep, retry, worthReasking, combinedTagCount, REASK_TAG_FLOOR } from './cache.mjs';
import { fetchListening } from './listening.mjs';
import { byListening } from './profile.mjs';

const lib = JSON.parse(readFileSync('library.json', 'utf8'));
const artists = new Map();
const add = t => { for (const a of t?.artists ?? []) if (a.id) artists.set(a.id, a.name); };
for (const p of lib.playlists) p.tracks.forEach(add);
lib.liked.forEach(add);

const priors = [new Cache('tags-lastfm.json'), new Cache('tags-musicbrainz.json'), new Cache('tags-discogs.json')];
const cache = new Cache('tags-itunes.json');
const stillThin = [...artists].filter(([id]) => combinedTagCount(id, priors) < REASK_TAG_FLOOR);
let todo = stillThin.filter(([id]) => worthReasking(cache.get(id)));

// Same reasoning as every other enrich script: whatever this run doesn't
// finish should at least have covered what you actually listen to first.
try {
  const { weights } = await fetchListening(lib);
  todo = byListening(todo, weights);
} catch { /* no Spotify auth available here, or offline — library order is fine */ }

console.error(`artists: ${artists.size} | still thin after Last.fm/MusicBrainz/Discogs: ${stillThin.length} `
  + `| cached: ${cache.size} | to fetch: ${todo.length}`);
if (todo.length > 200) console.error(`  iTunes' rate limit is informal and slow — this can take a while for a gap this size`);

const GENRE_COUNT = 55; // one coarse genre, no ranking within it to preserve

let done = 0, filled = 0;
for (const [id, name] of todo) {
  try {
    const r = await retry(() => fetch('https://itunes.apple.com/search?' + new URLSearchParams({
      term: name, entity: 'musicArtist', limit: '1',
    })).then(x => x.json()));
    const genre = r.results?.[0]?.primaryGenreName;
    const tags = genre ? [[genre.toLowerCase(), GENRE_COUNT]] : [];
    cache.set(id, { name, tags, checkedAt: Date.now() });
    if (tags.length) filled++;
  } catch (e) {
    cache.set(id, { name, tags: [], error: String(e.message).slice(0, 80), checkedAt: Date.now() });
  }
  if (++done % 100 === 0) { console.error(`  ${done}/${todo.length}  (${filled} filled so far)`); cache.flush(); }
  await sleep(3500); // ~17/min, safely under iTunes' informal ~20/min ceiling
}
cache.flush();
console.error(`done. cached ${cache.size} artists, filled ${filled} of ${todo.length} this run`);
