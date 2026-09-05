import { readFileSync } from 'node:fs';
import { api, paged } from './spotify.mjs';
const snap = JSON.parse(readFileSync('library.json', 'utf8'));

const live = await paged('/me/playlists?limit=50');
const me = await api('/me');
const mine = live.filter(p => p.owner?.id === me.id);

console.log(`playlists at snapshot: ${snap.playlists.length}`);
console.log(`playlists live now:    ${mine.length}`);

const snapNames = new Set(snap.playlists.map(p => p.name));
const added = mine.filter(p => !snapNames.has(p.name));
console.log(`new playlists created by the tool: ${added.length}` + (added.length ? ' -> ' + added.map(p=>p.name).join(', ') : ''));

// compare live track counts against the snapshot for every playlist
let drift = 0;
for (const p of mine) {
  const s = snap.playlists.find(x => x.id === p.id);
  if (!s) continue;
  const now = p.items?.total ?? p.tracks?.total;
  if (now !== s.total) { console.log(`  DRIFT ${p.name}: snapshot ${s.total} -> now ${now}`); drift++; }
}
console.log(drift ? `\n${drift} playlists changed` : '\nno playlist changed size — library is exactly as found');

const liked = await api('/me/tracks?limit=1');
console.log(`liked songs: snapshot ${snap.liked.length} -> now ${liked.total}`);
