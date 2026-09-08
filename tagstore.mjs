// Node-side tag loading, kept out of profile.mjs so that module stays
// bundleable into the browser build.
import { readFileSync, existsSync } from 'node:fs';
import { tagGate, gateTags } from './profile.mjs';

// A thin Last.fm answer (see THIN_TAG_FLOOR) is real signal, just not much of
// it — Discogs release styles are worth blending in as extra evidence rather
// than a full gap-fill. A total gap is filled outright; anything with at
// least this many Last.fm tags is trusted enough to stand on its own, and
// Discogs is never consulted for it at all.
const THIN_TAG_FLOOR = 3;

/**
 * Fold Discogs release styles in behind Last.fm. A total gap is filled
 * outright; a thin answer (fewer than THIN_TAG_FLOOR tags) gets Discogs'
 * styles added alongside what Last.fm already said, never replacing or
 * reordering it — re-running enrich-lastfm.mjs later (say, after autocorrect
 * or a MusicBrainz match improves) still leaves Last.fm's own tags in place
 * and in front.
 */
export function mergeTagSources(lastfm, discogs) {
  const tags = { ...lastfm };
  for (const [id, entry] of Object.entries(discogs)) {
    if (!entry.tags?.length) continue;
    const own = tags[id]?.tags ?? [];
    if (!own.length) { tags[id] = entry; continue; }
    if (own.length >= THIN_TAG_FLOOR) continue; // Last.fm already has enough to stand on its own
    const seen = new Set(own.map(([t]) => t));
    const extra = entry.tags.filter(([t]) => !seen.has(t));
    if (extra.length) tags[id] = { ...tags[id], tags: [...own, ...extra] };
  }
  return tags;
}

/**
 * Load and merge every tag source, then drop whatever a library-wide gate
 * doesn't trust — a tag attested by only one artist is indistinguishable, at
 * the model level, from a misspelling or a same-named-artist mismatch. See
 * tagGate() in profile.mjs for what this costs a genuinely one-artist niche
 * genre (real, but rare enough in the caller's own library).
 */
export function loadTags() {
  if (!existsSync('tags-lastfm.json'))
    throw new Error('No tags yet — run: node enrich-lastfm.mjs');
  const lastfm = JSON.parse(readFileSync('tags-lastfm.json', 'utf8'));
  const merged = existsSync('tags-discogs.json')
    ? mergeTagSources(lastfm, JSON.parse(readFileSync('tags-discogs.json', 'utf8')))
    : lastfm;
  return gateTags(merged, tagGate(merged));
}
