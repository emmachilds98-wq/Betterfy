import { readFileSync } from 'node:fs';
const lib = JSON.parse(readFileSync('library.json', 'utf8'));

const filed = new Map();               // track id -> [playlist names]
for (const p of lib.playlists)
  for (const t of p.tracks)
    filed.set(t.id, [...(filed.get(t.id) ?? []), p.name]);

const liked = lib.liked.filter(t => t?.id);
const unfiled = liked.filter(t => !filed.has(t.id));

console.log('=== SCALE ===');
console.log(`filed tracks (unique): ${filed.size}`);
console.log(`liked songs:           ${liked.length}`);
console.log(`LIKED BUT UNFILED:     ${unfiled.length}   <-- the backlog`);

console.log('\n=== UNFILED BACKLOG BY AGE ===');
const byYear = {};
for (const t of unfiled) byYear[(t.added_at ?? '?').slice(0, 4)] = (byYear[(t.added_at ?? '?').slice(0, 4)] ?? 0) + 1;
for (const [y, n] of Object.entries(byYear).sort()) console.log(`  ${y}: ${n}`);

console.log('\n=== 20 OLDEST UNFILED ===');
for (const t of [...unfiled].sort((a, b) => (a.added_at ?? '').localeCompare(b.added_at ?? '')).slice(0, 20))
  console.log(`  ${(t.added_at ?? '').slice(0,10)}  ${t.artists.map(a=>a.name).join(', ')} — ${t.name}`);

console.log('\n=== CROSS-FILING (tracks in 4+ playlists) ===');
const multi = [...filed.entries()].filter(([, ps]) => ps.length >= 4);
console.log(`  ${multi.length} tracks sit in 4+ playlists`);

console.log('\n=== PLAYLISTS WITH NO UNIQUE CONTENT (fully contained in others) ===');
for (const p of lib.playlists) {
  if (!p.tracks.length) continue;
  const uniq = p.tracks.filter(t => (filed.get(t.id) ?? []).length === 1).length;
  if (uniq === 0) console.log(`  ${p.name} (${p.tracks.length} tracks, 0 unique)`);
}

console.log('\n=== INTERNAL DUPLICATES ===');
for (const p of lib.playlists) {
  const seen = new Set(), dupes = new Set();
  for (const t of p.tracks) { if (seen.has(t.id)) dupes.add(t.id); seen.add(t.id); }
  if (dupes.size) console.log(`  ${p.name}: ${dupes.size} duplicated`);
}

console.log('\n=== ARTIST-GENRE COVERAGE (Spotify artist tags on your top artists) ===');
const g = {};
for (const a of lib.top_artists.long_term) for (const x of a.genres ?? []) g[x] = (g[x] ?? 0) + 1;
const top = Object.entries(g).sort((a,b) => b[1]-a[1]);
console.log(`  ${top.length} distinct genre tags across ${lib.top_artists.long_term.length} artists`);
console.log('  top 25: ' + top.slice(0,25).map(([k,v]) => `${k}(${v})`).join(', '));
const noGenre = lib.top_artists.long_term.filter(a => !a.genres?.length).length;
console.log(`  artists with NO genre tag at all: ${noGenre}/${lib.top_artists.long_term.length}`);
