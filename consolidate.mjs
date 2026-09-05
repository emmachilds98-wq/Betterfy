// Maintain one playlist holding every unique track in the library.
// Dry run by default; pass --apply to actually write.
import { readFileSync } from 'node:fs';
import { api } from './spotify.mjs';
import { findOrCreate, append } from './write.mjs';

const APPLY = process.argv.includes('--apply');
const NAME = 'Everything Emma';

const lib = JSON.parse(readFileSync('library.json', 'utf8'));
const uniq = new Map();
for (const p of lib.playlists) for (const t of p.tracks) if (t.id) uniq.set(t.id, t);
for (const t of lib.liked) if (t?.id) uniq.set(t.id, t);

// Skip the consolidated playlist itself if it already exists in the snapshot.
const self = lib.playlists.find(p => p.name === NAME);
if (self) for (const t of self.tracks) { /* keep — they're all in uniq anyway */ }

console.log(`unique tracks in library: ${uniq.size}`);
if (uniq.size > 10000) console.log(`!! over Spotify's 10,000 playlist cap by ${uniq.size - 10000}`);

const me = await api('/me');
const pl = await findOrCreate(me.id, NAME,
  'Every track from all playlists + liked songs. Maintained automatically.', APPLY);
if (pl.wouldCreate) {
  console.log(`playlist: WOULD CREATE "${NAME}" (does not exist yet)`);
  console.log(`to add:   ${uniq.size} tracks`);
  console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.');
  process.exit(0);
}
console.log(`playlist: ${pl.created ? 'CREATED' : 'exists'} ${pl.id} (currently ${pl.total} tracks)`);

// what's already in it
let existing = new Set();
if (!pl.created) {
  let page = await api(`/playlists/${pl.id}/items?limit=100&fields=next,items(item(id))`);
  while (page) {
    for (const i of page.items) if (i.item?.id) existing.add(i.item.id);
    if (!page.next) break;
    page = await api(page.next);
  }
}

const missing = [...uniq.keys()].filter(id => !existing.has(id));
console.log(`already present: ${existing.size}`);
console.log(`to add:         ${missing.length}`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.');
  for (const id of missing.slice(0, 10)) {
    const t = uniq.get(id);
    console.log(`   + ${t.artists.map(a => a.name).join(', ')} — ${t.name}`);
  }
  if (missing.length > 10) console.log(`   ... and ${missing.length - 10} more`);
} else {
  const n = await append(pl.id, missing.map(id => `spotify:track:${id}`));
  console.log(`\nadded ${n} tracks.`);
}
