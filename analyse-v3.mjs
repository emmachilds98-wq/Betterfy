// v3 engine diagnostics — §31's successor to analyse.mjs, and the thing that
// makes every claim in docs/ENGINE-V3-ARCHITECTURE.md checkable against a
// real library rather than against fixtures.
//
// Reads what you already have — library.json plus whichever of
// tags-lastfm.json, tags-discogs.json, docs/tags.json, mbid.json and
// tags-lastfm-tracks.json exist — and runs the whole engine over it. No
// network, no new configuration, and nothing is written back to any of them.
//
// This is also the mechanism the architecture doc claims for building the
// benchmark §26 asks for: work the review queue it prints, and the answers
// are benchmark rows. `--queue` writes them somewhere a person can actually
// work through.
//
//   node analyse-v3.mjs                 the report
//   node analyse-v3.mjs --queue         plus the review queue, written out
//   node analyse-v3.mjs --json          machine-readable, for diffing runs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { indexCaches, buildRegistry, profileLibrary, libraryReport,
         analysePlaylists, nameVsMusic, ENGINE_VERSION } from './core/engine.mjs';
import { reviewQueue } from './core/review/queue.mjs';
import { CorrectionLog, fromV1Feedback } from './core/personal/corrections.mjs';
import { ONTOLOGY_VERSION } from './core/ontology/index.mjs';
import { CLASSIFIER_VERSION } from './core/analysis/classify.mjs';

const flag = f => process.argv.includes(f);
const readIf = f => existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;

if (!existsSync('library.json')) {
  console.error('No library.json — run: node snapshot.mjs');
  process.exit(1);
}
const lib = JSON.parse(readFileSync('library.json', 'utf8'));

// Corrections first: a personal concept mapping changes how evidence
// normalises, so it has to be in hand before anything is profiled.
const corrections = existsSync('corrections.json')
  ? CorrectionLog.fromJSON(JSON.parse(readFileSync('corrections.json', 'utf8')))
  : (existsSync('feedback.json') ? fromV1Feedback(JSON.parse(readFileSync('feedback.json', 'utf8'))) : new CorrectionLog());

const caches = {
  lastfm: readIf('tags-lastfm.json'),
  discogs: readIf('tags-discogs.json'),
  shared: readIf('docs/tags.json'),
  mbids: readIf('mbid.json'),
};
const trackTags = readIf('tags-lastfm-tracks.json');

const idx = indexCaches({ ...caches, conceptMap: corrections.conceptMap() });
const registry = buildRegistry(idx.present);

console.error(`engine ${ENGINE_VERSION} | ontology ${ONTOLOGY_VERSION} | classifier ${CLASSIFIER_VERSION}`);
console.error(`providers: ${registry.ids.join(', ')}${trackTags ? ' (+ track-level Last.fm)' : ''}`);
console.error(`corrections: ${corrections.entries.length}\n`);

// Listening is best-effort and optional: it only orders the queue, and a run
// with no Spotify auth is still a complete run (§22, §38).
let weights = new Map(), recentlyActive = new Set();
try {
  const { fetchListening } = await import('./listening.mjs');
  ({ weights, recentlyActive } = await fetchListening(lib));
} catch { console.error('(no listening history available — the queue is ordered by uncertainty alone)\n'); }
if (!recentlyActive.size) console.error('(no recent plays available — nothing will be flagged as heavily played)\n');

const profiles = profileLibrary(lib, idx, { registry, trackTags });
const report = libraryReport(profiles);
const analysis = analysePlaylists(lib, profiles);
const queue = reviewQueue(profiles, lib, {
  classifications: analysis.classifications,
  relationships: analysis.relationships,
  weights, recentlyActive, log: corrections,
});

const pct = x => (100 * x).toFixed(1) + '%';

console.log(`=== TRACKS: ${report.tracks} ===`);
console.log(`  classified:  ${report.classified} (${pct(report.coverage)})`);
for (const [band, n] of Object.entries(report.bands).sort((a, b) => b[1] - a[1]))
  console.log(`    ${band.padEnd(18)} ${String(n).padStart(6)}  ${pct(n / report.tracks)}`);

// Whether the answers can be trusted at all: how many tracks have more than
// one independent voice behind THE GENRE. Not `coverage`, which counts any
// provider saying anything — Spotify supplies an era for every dated track,
// so that number is ~100% in every library and means nothing.
const corroborated = [...profiles.values()].filter(p => (p.profile.confidence.genreCoverage ?? 0) > 1).length;
console.log(`  genre corroborated by more than one independent source: ${corroborated} (${pct(corroborated / report.tracks)})`);

console.log(`\n=== PLAYLISTS: ${analysis.classifications.size} ===`);
const byType = {};
for (const c of analysis.classifications.values()) (byType[c.type] ??= []).push(c);
for (const [type, rows] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
  const targets = rows.filter(r => r.isTarget).length;
  console.log(`  ${type.padEnd(9)} ${String(rows.length).padStart(3)}  ${targets} accept filing`);
  console.log(`     ${rows.sort((a, b) => b.dimensions[0]?.score - a.dimensions[0]?.score)
    .slice(0, 8).map(r => `${r.name}${r.musicalIdentity.primary ? ` [${r.musicalIdentity.primary}]` : ''}`).join(', ')}`);
}

const disagreeing = nameVsMusic(analysis.classifications);
if (disagreeing.length) {
  console.log(`\n=== NAMED ONE THING, MADE OF ANOTHER: ${disagreeing.length} ===`);
  for (const d of disagreeing.slice(0, 15))
    console.log(`  ${d.name}: called ${d.named}, mostly ${d.actual}`);
}

if (analysis.relationships.length) {
  console.log(`\n=== PLAYLIST RELATIONSHIPS: ${analysis.relationships.length} ===`);
  const byKind = {};
  for (const r of analysis.relationships) (byKind[r.kind] ??= []).push(r);
  for (const [kind, rows] of Object.entries(byKind)) {
    console.log(`  ${kind} (${rows.length})`);
    for (const r of rows.slice(0, 5)) console.log(`     ${r.a.name} <-> ${r.b.name}\n        ${r.why}`);
  }
}

if (analysis.collections.length) {
  console.log(`\n=== COLLECTIONS AND THEIR VIEWS ===`);
  for (const c of analysis.collections)
    console.log(`  ${c.parent.name}` + c.views.map(v => `\n     -> ${v.name} (${v.kind})`).join(''));
}

console.log(`\n=== WORTH ASKING YOU ABOUT ===`);
console.log(`  ${queue.tracks.length} track questions (covering `
  + `${queue.tracks.reduce((s, r) => s + r.tracks, 0)} tracks), `
  + `${queue.playlists.length} playlists, ${queue.concepts.length} unmapped concepts`);
for (const r of queue.tracks.slice(0, 10))
  console.log(`  [${String(r.score).padStart(7)}] ${r.artist} — ${r.title}`
    + (r.tracks > 1 ? `  (+${r.tracks - 1} more like it)` : '')
    + `\n      ${r.confidence}${r.suggested ? `, probably ${r.suggested}` : ''}`
    + `\n      ${r.reasons.map(x => x.why).join('; ')}`);

if (queue.concepts.length) {
  console.log(`\n  tags the ontology cannot place — answering one fixes every track carrying it:`);
  for (const c of queue.concepts.slice(0, 15)) console.log(`    ${String(c.tracks).padStart(5)}  ${c.raw}`);
}

const out = {
  generatedAt: new Date().toISOString(),
  versions: { engine: ENGINE_VERSION, ontology: ONTOLOGY_VERSION, classifier: CLASSIFIER_VERSION,
              providers: registry.versions() },
  report,
  playlists: [...analysis.classifications.values()].map(c => ({
    id: c.id, name: c.name, type: c.type, confidence: c.confidence, isTarget: c.isTarget,
    musicalIdentity: c.musicalIdentity, dimensions: c.dimensions, nameSaid: c.nameSaid,
  })),
  relationships: analysis.relationships,
  collections: analysis.collections,
  nameVsMusic: disagreeing,
};
writeFileSync('report-v3.json', JSON.stringify(out, null, 2));
console.log('\nwrote report-v3.json');

if (flag('--queue')) {
  writeFileSync('review-queue.json', JSON.stringify(queue, null, 2));
  console.log('wrote review-queue.json — answer these into corrections.json, '
    + 'and they become benchmark rows as well as improving your own library');
}
if (flag('--json')) console.log(JSON.stringify(out));
