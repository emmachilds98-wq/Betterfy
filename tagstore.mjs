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
 * Fold any number of tag sources together, strongest first. The first source
 * is the backbone, taken as-is; each source after that only ever fills a
 * total gap outright or, short of that, blends its tags in alongside a thin
 * answer (fewer than THIN_TAG_FLOOR tags) — never replacing or reordering
 * what a stronger source already said. Re-running an earlier enrich script
 * later (say, after autocorrect or a MusicBrainz match improves) still leaves
 * everything already-confident in place and in front.
 *
 * Order matters and is the caller's call: loadTags() below lists it once, in
 * one place, rather than leaving several pairwise blends to reason about
 * separately. Two things decide the order: how granular a source is, and how
 * it identifies the artist in the first place. MusicBrainz's genres are
 * looked up by an exact id — no name involved, no same-named-artist risk —
 * so they outrank iTunes, which searches by name and can misfire the exact
 * way Last.fm's autocorrect can. Last.fm's crowd tags are the most granular
 * of all, so they lead regardless.
 *
 * Spotify's own `genres` field on the Artist object was tried and dropped:
 * verified dead in September 2026 (0 tags across 956 artists — see "Why it
 * uses Last.fm, MusicBrainz, Discogs and iTunes" in the README), the same fate as the
 * audio-features/recommendations endpoints. Worth re-checking if Spotify
 * ever brings it back, but not worth spending a batch call on today.
 */
export function mergeTagSources(...sources) {
  const [primary, ...rest] = sources;
  const tags = { ...primary };
  for (const source of rest) {
    for (const [id, entry] of Object.entries(source)) {
      if (!entry.tags?.length) continue;
      const own = tags[id]?.tags ?? [];
      if (!own.length) { tags[id] = entry; continue; }
      if (own.length >= THIN_TAG_FLOOR) continue; // already enough to stand on its own
      const seen = new Set(own.map(([t]) => t));
      const extra = entry.tags.filter(([t]) => !seen.has(t));
      if (extra.length) tags[id] = { ...tags[id], tags: [...own, ...extra] };
    }
  }
  return tags;
}

const readIfExists = file => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};

/**
 * Load and merge every tag source, strongest first, then drop whatever a
 * library-wide gate doesn't trust — a tag attested by only one artist is
 * indistinguishable, at the model level, from a misspelling or a same-named-
 * artist mismatch. See tagGate() in profile.mjs for what this costs a
 * genuinely one-artist niche genre (real, but rare enough in the caller's
 * own library). Every source but Last.fm itself is optional — this runs the
 * same whether `npm run setup` fetched all of them or none.
 */
export function loadTags() {
  if (!existsSync('tags-lastfm.json'))
    throw new Error('No tags yet — run: node enrich-lastfm.mjs');
  const lastfm = JSON.parse(readFileSync('tags-lastfm.json', 'utf8'));
  const merged = mergeTagSources(
    lastfm,
    readIfExists('tags-musicbrainz.json'),
    readIfExists('tags-discogs.json'),
    readIfExists('tags-itunes.json'),
  );
  return gateTags(merged, tagGate(merged));
}
