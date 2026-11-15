// WP-C2, step 1: the prompts CLAP's text encoder embeds at build time
// (docs/AUDIO-BUILD-PLAN.md, Option C). Writes prompts.json beside this file.
//
//   node scripts/audio-clap/prompts.mjs
//
// Two kinds, the two core/audio/clap-search.mjs reads:
//  - genre:       every concept in the ontology, as "{name} music" (the
//                 table's `template`), so a "new genre?" group can be named in
//                 the app's own vocabulary and a search can be typed by genre;
//  - description: a short, reviewed list of how people describe a sound
//                 rather than name it ("dark rolling bassline"). Kept small on
//                 purpose: every line is a promise that typing it finds
//                 something, and a phrase CLAP has no grip on returns noise.
//
// Nothing here is Spotify content (docs/SMARTER-GENRES-PLAN.md §3, R1): the
// genre names are the ontology's and the descriptions are ours.
import { writeFileSync } from 'node:fs';
import { GENRES } from '../../core/ontology/genres.mjs';

export const TEMPLATE = '{name} music';

/** A concept id as words: 'drum-and-bass' → 'drum and bass', 'rnb' → 'r&b'. */
export const conceptWords = c => ({ rnb: 'r&b', 'lo-fi': 'lo-fi', 'hip-hop': 'hip hop', edm: 'edm' }[c]
  ?? c.replace(/-/g, ' '));

/** Reviewed descriptions: sound, energy and production, not genre names. */
export const DESCRIPTIONS = [
  'dark rolling bassline', 'bouncy pitched-up vocals over a hard kick', 'euphoric hands-up vocal',
  'uplifting piano house', 'warehouse techno with pounding kicks', 'acid squelch', 'chopped soul vocal samples',
  'skippy two-step garage drums', 'heavy wobbling bass', 'rave stabs and breakbeats', 'amen break',
  'liquid drum and bass with soft pads', 'reese bass', 'cowbell and distorted 808s', 'hard bouncy donk',
  'fast footwork drums', 'jersey club bed squeak kicks', 'sub-heavy halftime beat', 'grime square wave lead',
  'melodic deep house chords', 'minimal hypnotic groove', 'tribal percussion', 'big room festival drop',
  'lo-fi chilled beat with vinyl crackle', 'ambient drone with no drums', 'orchestral strings',
  'acoustic guitar and voice', 'distorted guitars', 'smooth r&b vocals', 'rap verse over a trap beat',
  'reggae offbeat skank', 'dub echo and reverb', 'latin percussion', 'afrobeats rhythm', 'disco strings and bass',
  'funky slap bass', 'jazzy chords', 'eighties synth pop', 'hardstyle reverse bass kick', 'happy hardcore piano',
  'slow emotional ballad', 'high-energy peak-time track', 'late-night downtempo', 'female vocal anthem',
  'male rap vocal', 'instrumental with no vocals',
];

export function prompts() {
  const genre = Object.keys(GENRES).sort()
    .map(concept => ({ text: TEMPLATE.replace('{name}', conceptWords(concept)), kind: 'genre', concept }));
  const description = DESCRIPTIONS.map(text => ({ text, kind: 'description' }));
  return { template: TEMPLATE, prompts: [...genre, ...description] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = prompts();
  writeFileSync(new URL('./prompts.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
  console.log(`${out.prompts.length} prompts (${out.prompts.filter(p => p.kind === 'genre').length} genres)`);
}
