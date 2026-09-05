// Duplicate analysis, split by Emma's rule:
//   WITHIN one playlist  -> a genuine mistake, safe to offer for removal
//   ACROSS playlists     -> intentional cross-filing, never auto-touched
// Distinct versions (remix / VIP / extended / live) are never merged either way.
import { readFileSync, writeFileSync } from 'node:fs';
import { trackKey, versionOf } from './norm.mjs';

const lib = JSON.parse(readFileSync('library.json', 'utf8'));

// ---------- 1. within-playlist duplicates: removal candidates ----------
const withinRows = [];
for (const p of lib.playlists) {
  const groups = new Map();
  for (const t of p.tracks) {
    if (!t?.id) continue;
    const k = trackKey(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  for (const [, rows] of groups) {
    if (rows.length < 2) continue;
    // keep the earliest release, drop the rest
    const sorted = [...rows].sort((a, b) => (a.released ?? '9999').localeCompare(b.released ?? '9999'));
    withinRows.push({
      playlist: p.name, playlistId: p.id,
      artist: sorted[0].artists?.[0]?.name, title: sorted[0].name,
      keep: { id: sorted[0].id, album: sorted[0].album, released: sorted[0].released },
      drop: sorted.slice(1).map(t => ({ id: t.id, album: t.album, released: t.released, name: t.name })),
    });
  }
}

// ---------- 2. cross-playlist presence: review only ----------
const where = new Map(), meta = new Map();
for (const p of lib.playlists)
  for (const t of p.tracks) {
    if (!t?.id) continue;
    meta.set(t.id, t);
    const k = trackKey(t);
    if (!where.has(k)) where.set(k, []);
    where.get(k).push({ playlist: p.name, id: t.id, album: t.album, released: t.released });
  }

const across = [...where.entries()]
  .filter(([, rows]) => new Set(rows.map(r => r.playlist)).size > 1)
  .map(([k, rows]) => {
    const t = meta.get(rows[0].id);
    return {
      artist: t.artists?.[0]?.name, title: t.name, version: versionOf(t.name) || null,
      playlists: [...new Set(rows.map(r => r.playlist))],
      releases: [...new Set(rows.map(r => r.album))],
      differentReleases: new Set(rows.map(r => r.id)).size > 1,
    };
  });

const dropCount = withinRows.reduce((s, r) => s + r.drop.length, 0);
console.log('=== WITHIN-PLAYLIST DUPLICATES (removal candidates) ===');
console.log(`${withinRows.length} cases across ${new Set(withinRows.map(r => r.playlist)).size} playlists, ${dropCount} tracks would be dropped\n`);
for (const r of withinRows) {
  console.log(`  ${r.playlist}`);
  console.log(`    ${r.artist} — ${r.title}`);
  console.log(`      keep  [${r.keep.album}] ${r.keep.released}`);
  for (const d of r.drop) console.log(`      drop  [${d.album}] ${d.released}`);
}

console.log('\n\n=== ACROSS PLAYLISTS (yours to choose — nothing auto-removed) ===');
console.log(`${across.length} tracks sit in more than one playlist`);
const many = across.filter(a => a.playlists.length >= 5).sort((a,b) => b.playlists.length - a.playlists.length);
console.log(`${many.length} of them are in 5+ playlists. Top 12:\n`);
for (const a of many.slice(0, 12))
  console.log(`  ${a.playlists.length}x  ${a.artist} — ${a.title}\n        ${a.playlists.join(' | ')}`);

writeFileSync('report-dupes.json', JSON.stringify({ within: withinRows, across }, null, 2));
console.log(`\nwrote report-dupes.json`);
