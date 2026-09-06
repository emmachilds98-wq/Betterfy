// Two questions, one model:
//   1. Is anything filed somewhere that fits another playlist much better?
//   2. Where should the 850 unfiled liked songs go — and what has no home at all?
import { readFileSync, writeFileSync } from 'node:fs';
import { buildProfiles, rank, topTags, trackVec, applyIdf, cosine, findMisfiled, findDrift } from './profile.mjs';
import { loadTags } from './tagstore.mjs';
import { fetchListening } from './listening.mjs';

const lib = JSON.parse(readFileSync('library.json', 'utf8'));
const cfg = JSON.parse(readFileSync('playlists.config.json', 'utf8'));
const tags = loadTags();

// Only genre/mood playlists are filing destinations; event, DJ-set, era and
// context playlists are Emma's own and never receive automatic suggestions.
const targets = new Set(Object.entries(cfg.playlists).filter(([, v]) => v.target).map(([id]) => id));
const axisOf = id => cfg.playlists[id]?.axis ?? null;
const { profiles, idf } = buildProfiles(lib, tags, targets, axisOf);
console.error(`modelled ${profiles.size} destination playlists`);

// Best-effort — a track flagged as misfiled but actually in heavy rotation
// right now is more likely a deliberate keep than a mistake; annotated, not
// used to change the confidence tier itself, since that's the one number
// these reports have direct tests against.
const { recentlyActive } = await fetchListening(lib).catch(() => ({ recentlyActive: new Set() }));

// coverage check — how much of the library has any tag signal at all
let withTags = 0, total = 0;
for (const p of lib.playlists) for (const t of p.tracks) { total++; if (trackVec(t, tags).size) withTags++; }
console.error(`tag coverage: ${withTags}/${total} placements (${(100*withTags/total).toFixed(1)}%)\n`);

// ---------- 1. possible misfiles ----------
// Shared with the browser build via profile.mjs, so the two cannot drift
// into different answers about the same library.
const misfiled = findMisfiled(lib, tags, targets, profiles, idf, axisOf).map(m => ({
  id: m.track.id, artist: m.track.artists?.[0]?.name, title: m.track.name,
  current: m.playlistName, currentPlaylistId: m.playlistId, currentScore: +m.ownScore.toFixed(3),
  confidence: m.confidence,
  playedRecently: recentlyActive.has(m.track.artists?.[0]?.name),
  suggest: m.suggest.map(b => ({ id: b.id, name: b.name, score: +b.score.toFixed(3) })),
  tags: topTags(m.track, tags, idf),
}));

// ---------- 2. the unfiled backlog ----------
const filed = new Set();
for (const p of lib.playlists) for (const t of p.tracks) filed.add(t.id);
const unfiled = lib.liked.filter(t => t?.id && !filed.has(t.id));

const placed = [], homeless = [];
for (const t of unfiled) {
  const best = rank(t, tags, profiles, idf, { top: 3 });
  const row = {
    id: t.id, artist: t.artists?.[0]?.name, title: t.name,
    added: (t.added_at ?? '').slice(0, 10),
    suggest: best.map(b => ({ name: b.name, score: +b.score.toFixed(3) })),
    tags: topTags(t, tags, idf),
  };
  (best.length && best[0].score >= 0.30 ? placed : homeless).push(row);
}
placed.sort((a, b) => b.suggest[0].score - a.suggest[0].score);

// ---------- 3. clusters among the homeless: candidate NEW playlists ----------
// Greedy agglomeration on tag vectors. A cluster of 6+ tracks that fits no
// existing playlist is the signal that a genuinely new category is missing.
const vecs = homeless.map(h => ({
  h, v: applyIdf(trackVec(lib.liked.find(t => t.id === h.id) ?? {}, tags), idf),
})).filter(x => x.v.size >= 3);

const clusters = [];
const used = new Set();
for (const seed of vecs) {
  if (used.has(seed.h.id)) continue;
  const members = vecs.filter(x => !used.has(x.h.id) && cosine(seed.v, x.v) > 0.45);
  if (members.length >= 6) {
    members.forEach(m => used.add(m.h.id));
    const tally = new Map();
    for (const m of members) for (const tg of m.h.tags) tally.set(tg, (tally.get(tg) ?? 0) + 1);
    clusters.push({
      size: members.length,
      tags: [...tally].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k),
      tracks: members.slice(0, 8).map(m => `${m.h.artist} — ${m.h.title}`),
    });
  }
}
clusters.sort((a, b) => b.size - a.size);

// ---------- 4. playlists whose recent additions have drifted from the rest ----------
const drift = findDrift(lib, tags, targets, idf);

// ---------- report ----------
const byConf = { high:0, medium:0, low:0 };
for (const m of misfiled) byConf[m.confidence]++;
console.log(`=== POSSIBLE MISFILES: ${misfiled.length} — high ${byConf.high}, medium ${byConf.medium}, low ${byConf.low} ===`);
for (const m of misfiled.slice(0, 20))
  console.log(`  ${m.artist} — ${m.title}${m.playedRecently ? '  [you play this a lot]' : ''}\n     in ${m.current} (${m.currentScore})  ->  ${m.suggest.map(s=>`${s.name} (${s.score})`).join(' / ')}\n     tags: ${m.tags.join(', ')}`);

console.log(`\n\n=== DRIFTING PLAYLISTS: ${drift.length} ===`);
for (const d of drift)
  console.log(`  ${d.playlistName} — recent ${d.recentTags.join(', ')} vs older ${d.olderTags.join(', ')} (similarity ${d.similarity.toFixed(2)})`);

console.log(`\n\n=== UNFILED BACKLOG: ${unfiled.length} ===`);
console.log(`  confident home:  ${placed.length}`);
console.log(`  no good home:    ${homeless.length}`);
console.log('\n  top 15 confident placements:');
for (const p of placed.slice(0, 15))
  console.log(`    ${p.artist} — ${p.title}\n       -> ${p.suggest.map(s=>`${s.name} (${s.score})`).join(' / ')}`);

console.log(`\n\n=== CANDIDATE NEW PLAYLISTS: ${clusters.length} ===`);
for (const c of clusters)
  console.log(`  ${c.size} tracks — ${c.tags.join(', ')}\n     e.g. ${c.tracks.slice(0,4).join('; ')}`);

writeFileSync('report-misfile.json', JSON.stringify({ misfiled, placed, homeless, clusters, drift }, null, 2));
console.log('\nwrote report-misfile.json');
