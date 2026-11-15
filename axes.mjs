// First-pass classification of every playlist by axis. Writes playlists.config.json
// for you to hand-correct; everything downstream reads that file, not these rules.
//
// The rules are not here: they are core/playlists/axes.mjs, the same module the
// browser build's classify() runs (docs/BUILD-5-PLAN.md A2, fixing B10). What
// this file adds is the CLI's own equivalent of the page's saved corrections —
// the OVERRIDE table and the previous playlists.config.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { classifyAxes, MIN_FOR_TARGET } from './core/playlists/axes.mjs';
import { genreWords } from './core/playlists/genre-words.mjs';

const GENRE_WORDS = new Set(genreWords());

// The All Songs mirror holds a copy of every track by construction, so reading
// it into the baseline counts the whole library twice, and it is never a target.
// The page also recognises it by a pinned id; the CLI has only the name.
export const isMirror = p => !!p && p.name === 'All Songs — Betterfy';

// Playlists whose name misleads the rules. A name can look like a genre
// while the playlist is really organised on something tags cannot see —
// "Lyricism" is a judgement about wordplay, not a sound, so left as a genre
// target it silently becomes "the rap playlist" and attracts every rap track.
// This is one library's hand corrections — the CLI's counterpart of what the
// page keeps under bf_axes — not a rule any other account runs.
export const OVERRIDE = {
  'Lyricism Emma':          'context',   // lyrical quality, not a genre
  'COD Killstreak Emma':    'context',   // an activity
  'Graveyard Emma':         'context',
  'Misc EDM':               'context',   // a leftovers bin
  'My Shazam Tracks':       'inbox',     // an inflow, not a destination
  'You may have missed 25': 'inbox',     // Spotify-generated
  'Demma Exports Inc':      'context',
  "Adam's BDay":            'context',
  'Saudade Vem Correndo':   'context',
  'Old Soul Sound Emma':    'context',
  'Long Tracks Emma':       'context',   // a duration rule
  'VibinWEmma':             'mood',      // MOOD regex misses it — no word break
  'Unique Happier Relaxing Sleep Music': 'mood',
};

/**
 * playlists.config.json's `playlists`, before anything is written.
 *
 * The first pass is exactly the page's classify() without its saved
 * corrections. Then, in order: an OVERRIDE always wins, and a previous
 * hand-edit (`prev`) is kept. A forced axis takes suggestions the way the page
 * treats an axis the listener picks: genre does (size and mirror permitting),
 * anything else does not.
 */
export function axesConfig(lib, { tags = null, prev = { playlists: {} }, now = Date.now(),
                                  overrides = OVERRIDE } = {}) {
  const first = classifyAxes(lib, { tags, now, genreWords: GENRE_WORDS, isMirror });
  const out = {};
  for (const p of lib.playlists) {
    const g = first[p.id], old = prev?.playlists?.[p.id];
    const forced = overrides[p.name];
    const axis = forced ?? old?.axis ?? g.axis;
    const why = forced ? 'set by you'
              : old?.axis && old.axis !== g.axis ? 'kept from playlists.config.json' : g.why;
    // The size gate is unconditional: a centroid built from a handful of
    // tracks matches almost anything, so such a playlist is never *suggested*.
    // Hand-editing the axis is respected; hand-raising a tiny playlist to a
    // suggestion target is not, because the model cannot support it. Never the
    // mirror either.
    const eligible = g.tracks >= MIN_FOR_TARGET && !isMirror(p);
    const target = eligible && (forced !== undefined ? axis === 'genre' : (old?.target ?? g.target));
    out[p.id] = { name: p.name, axis, why, target, tracks: g.tracks };
  }
  return out;
}

function main() {
  const lib = JSON.parse(readFileSync('library.json', 'utf8'));
  // Silently skipped when no tags have been fetched yet — `npm run axes` has
  // always worked before `npm run enrich`, and still does.
  let tags = null;
  return import('./tagstore.mjs')
    .then(({ loadTags }) => { tags = loadTags(); })
    .catch(() => { /* no tags yet — name rules only */ })
    .then(() => {
      // Preserve any manual edits already made.
      const prev = existsSync('playlists.config.json')
        ? JSON.parse(readFileSync('playlists.config.json', 'utf8')) : { playlists: {} };
      const cfg = { playlists: axesConfig(lib, { tags, prev }) };
      writeFileSync('playlists.config.json', JSON.stringify(cfg, null, 2));

      const by = {};
      for (const v of Object.values(cfg.playlists)) (by[v.axis] ??= []).push(v);
      for (const axis of ['genre', 'mood', 'era', 'event', 'djset', 'context', 'inbox']) {
        const rows = (by[axis] ?? []).sort((a, b) => b.tracks - a.tracks);
        const targets = rows.filter(r => r.target).length;
        console.log(`\n${axis.toUpperCase()} — ${rows.length} playlists, ${targets} accept auto-filing`);
        console.log('  ' + rows.map(r => `${r.name}(${r.tracks})`).join(', '));
      }
      console.log(`\nwrote playlists.config.json`);
    });
}

// Run as `node axes.mjs`; imported (by the tests), it only defines things.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
