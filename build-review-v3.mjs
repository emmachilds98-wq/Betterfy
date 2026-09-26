// Inject the v3 engine's report and review queue into the v3 review page.
//
// Phase 11 (§33 track review, §34 playlist review, §35 queue rendering),
// built the way v1's own review page is built: a standalone file with its
// data baked in. It does NOT touch docs/app.template.html — the shipping app
// still answers every question with v1, which is the whole point of building
// v3 beside it.
//
//   node analyse-v3.mjs --queue     # produces the two inputs
//   node build-review-v3.mjs        # writes review-v3.build.html
//
// The page writes nothing by itself. Answers are collected in the browser and
// exported as a corrections.json for you to save into the repo, which is
// exactly the loop docs/ENGINE-V3-ARCHITECTURE.md claims: work the queue, and
// the answers become both your personal layer and benchmark rows.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { GENRES } from './core/ontology/genres.mjs';
import { MOODS, CONTEXTS } from './core/ontology/facets.mjs';
import { TYPES } from './core/playlists/classify.mjs';
import { ONTOLOGY_VERSION } from './core/ontology/index.mjs';
import { ENGINE_VERSION } from './core/engine.mjs';

const need = f => {
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  console.error(`No ${f} — run: node analyse-v3.mjs --queue`);
  process.exit(1);
};

const report = need('report-v3.json');
const queue = need('review-queue.json');
// Already-answered corrections are loaded so the page can show what is done
// rather than asking again — the same rule the queue itself follows.
const existing = existsSync('corrections.json')
  ? JSON.parse(readFileSync('corrections.json', 'utf8')) : { entries: [] };

const data = {
  generatedAt: report.generatedAt,
  versions: { ...report.versions, ontology: ONTOLOGY_VERSION, engine: ENGINE_VERSION },
  report: report.report,
  playlists: report.playlists,
  relationships: report.relationships,
  nameVsMusic: report.nameVsMusic,
  unfiled: report.unfiled ?? null,
  underserved: report.underservedGenres ?? [],
  queue,
  // The closed choice sets the page offers. A review UI that lets you type
  // anything produces answers the ontology cannot read back.
  genres: Object.keys(GENRES).sort(),
  moods: Object.keys(MOODS).sort(),
  contexts: Object.keys(CONTEXTS).sort(),
  playlistTypes: TYPES,
  existing: existing.entries ?? [],
};

const html = readFileSync('review-v3.html', 'utf8')
  .replace('__DATA__', JSON.stringify(data).replace(/</g, '\\u003c'));
writeFileSync('review-v3.build.html', html);

console.log(`${queue.tracks.length} track questions (covering `
  + `${queue.tracks.reduce((s, r) => s + r.tracks, 0)} tracks), `
  + `${queue.playlists.length} playlists, ${queue.concepts.length} unmapped tags`
  + ` | ${(html.length / 1024).toFixed(0)} KB -> review-v3.build.html`);
