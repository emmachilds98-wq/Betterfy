/* ---------- axis classification (core/playlists/axes.mjs, shared with axes.mjs) ---------- */

/* The rules themselves — the name regexes, genreInName(), addedShape(), the
 * facet fallback and the default target — live in core/playlists/axes.mjs,
 * bundled into the scoring core above and exposed as globals (`classifyAxes`,
 * `MIN_FOR_TARGET`, `NO_SIGNAL`, ...). The Node CLI axes.mjs runs the very same
 * module, so the two cannot drift apart again (docs/BUILD-5-PLAN.md B10). What
 * stays here is what only the page has: the genre vocabulary baked in at build
 * time, which playlist is this account's All Songs mirror, and the corrections
 * the listener has saved.
 *
 * Every name the ontology knows a genre by (core/playlists/genre-words.mjs). */
const GENRE_WORDS = new Set('__GENRE_WORDS__');

function classify(lib, tags = null, now = Date.now()) {
  const cfg = classifyAxes(lib, { tags, now, genreWords: GENRE_WORDS, isMirror: isMirrorPlaylist });
  const saved = JSON.parse(LS.getItem('bf_axes') || '{}');
  // `at` is when it was set, for syncing between devices; not part of the config.
  for (const [id, { at, ...v }] of Object.entries(saved)) if (cfg[id]) Object.assign(cfg[id], v, { why:'set by you' });
  return cfg;
}

