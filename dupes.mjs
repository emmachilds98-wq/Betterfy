// Duplicate analysis.
//
//   WITHIN one playlist -> a mistake, offered for removal
//   ACROSS playlists    -> deliberate cross-filing, surfaced but never touched
//
// Distinct versions (remix / VIP / extended / live) are never merged either way.
// The classification leans on ISRC: two entries sharing an ISRC are the SAME
// recording however differently the releases are labelled, and two with
// different ISRCs are different recordings however identical the titles look.
import { readFileSync, writeFileSync } from 'node:fs';
import { trackKey, versionOf } from './norm.mjs';

const lib = JSON.parse(readFileSync('library.json', 'utf8'));

const mmss = ms => ms == null ? '—'
  : `${Math.floor(ms / 60000)}:${String(Math.round(ms % 60000 / 1000)).padStart(2, '0')}`;

/** How two entries of the same song actually differ, in words. */
function describe(rows) {
  const isrcs = new Set(rows.map(r => r.isrc).filter(Boolean));
  const durs = rows.map(r => r.duration_ms).filter(x => x != null);
  const spread = durs.length > 1 ? Math.max(...durs) - Math.min(...durs) : 0;
  const types = new Set(rows.map(r => r.albumType).filter(Boolean));

  // Same recording, issued on more than one release.
  if (isrcs.size === 1 && rows.every(r => r.isrc)) {
    return {
      verdict: 'same-recording',
      why: types.size > 1
        ? `Identical recording, issued on a ${[...types].join(' and a ')}.`
        : 'Identical recording on two releases.',
    };
  }
  if (spread > 20000) {
    return {
      verdict: 'different-length',
      why: `Lengths differ by ${mmss(spread)} — likely an edit versus a longer cut.`,
    };
  }
  if (isrcs.size > 1) {
    return {
      verdict: 'different-recording',
      why: spread > 3000
        ? `Different recordings, ${mmss(spread)} apart in length.`
        : 'Different recordings of near-identical length — usually a remaster or re-issue.',
    };
  }
  return { verdict: 'unknown', why: 'Same title; no identifier to separate them.' };
}

const shape = t => ({
  id: t.id, album: t.album, albumType: t.albumType, released: t.released,
  duration_ms: t.duration_ms, dur: mmss(t.duration_ms), isrc: t.isrc,
  popularity: t.popularity, name: t.name,
});

// ---------- within a playlist ----------
const within = [];
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
    const shaped = rows.map(shape);
    const d = describe(shaped);
    // Default keep: the most popular copy, which is the one Spotify will
    // surface elsewhere anyway — a better bet than the earliest release.
    const keep = [...shaped].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))[0];
    within.push({
      playlist: p.name, playlistId: p.id,
      artist: rows[0].artists?.[0]?.name, title: rows[0].name,
      version: versionOf(rows[0].name) || null,
      verdict: d.verdict, why: d.why,
      keep, options: shaped,
      drop: shaped.filter(r => r.id !== keep.id),
    });
  }
}

// ---------- across playlists ----------
const where = new Map(), meta = new Map();
for (const p of lib.playlists)
  for (const t of p.tracks) {
    if (!t?.id) continue;
    meta.set(t.id, t);
    const k = trackKey(t);
    if (!where.has(k)) where.set(k, []);
    where.get(k).push({ playlist: p.name, playlistId: p.id, ...shape(t) });
  }

const cfg = JSON.parse(readFileSync('playlists.config.json', 'utf8'));
const across = [...where.entries()]
  .filter(([, rows]) => new Set(rows.map(r => r.playlist)).size > 1)
  .map(([, rows]) => {
    const t = meta.get(rows[0].id);
    const byPl = [...new Map(rows.map(r => [r.playlist, r])).values()];
    return {
      artist: t.artists?.[0]?.name, title: t.name, version: versionOf(t.name) || null,
      placements: byPl.map(r => ({
        playlist: r.playlist, playlistId: r.playlistId,
        axis: cfg.playlists[r.playlistId]?.axis ?? 'other',
        trackId: r.id, album: r.album, albumType: r.albumType, dur: r.dur, isrc: r.isrc,
      })),
      // Cross-filed AND holding different releases is the messy case: the same
      // song present as two different pressings in different playlists.
      mixedReleases: new Set(rows.map(r => r.id)).size > 1,
      mixedRecordings: new Set(rows.map(r => r.isrc).filter(Boolean)).size > 1,
    };
  })
  .sort((a, b) => b.placements.length - a.placements.length);

const by = {};
for (const w of within) by[w.verdict] = (by[w.verdict] ?? 0) + 1;
console.log('WITHIN-PLAYLIST', within.length, 'cases:', JSON.stringify(by));
console.log('  tracks that would be dropped:', within.reduce((s, r) => s + r.drop.length, 0));
console.log('\nACROSS-PLAYLIST', across.length, 'tracks in 2+ playlists');
console.log('  of which hold different pressings:', across.filter(a => a.mixedReleases).length);
console.log('  of which are different recordings:', across.filter(a => a.mixedRecordings).length);

console.log('\n--- sample of each verdict ---');
for (const v of ['same-recording', 'different-length', 'different-recording', 'unknown']) {
  const ex = within.filter(w => w.verdict === v).slice(0, 3);
  if (!ex.length) continue;
  console.log(`\n[${v}]`);
  for (const e of ex) {
    console.log(`  ${e.artist} — ${e.title}   (${e.playlist})`);
    console.log(`     ${e.why}`);
    for (const o of e.options)
      console.log(`       ${o.dur.padStart(5)}  ${String(o.albumType ?? '?').padEnd(11)} ${(o.released ?? '').slice(0,10)}  ${o.isrc ?? 'no isrc'}  ${o.album}`);
  }
}

writeFileSync('report-dupes.json', JSON.stringify({ within, across }, null, 2));
console.log('\nwrote report-dupes.json');
