// Node-side tag loading, kept out of profile.mjs so that module stays
// bundleable into the browser build.
import { readFileSync, existsSync } from 'node:fs';

// Discogs only ever fills an artist Last.fm returned nothing for — it never
// outranks or blends with a real Last.fm tag, so re-running enrich-lastfm.mjs
// later (say, after autocorrect learns an artist) still wins outright.
export function mergeTagSources(lastfm, discogs) {
  const tags = { ...lastfm };
  for (const [id, entry] of Object.entries(discogs))
    if (entry.tags?.length && !tags[id]?.tags?.length) tags[id] = entry;
  return tags;
}

export function loadTags() {
  if (!existsSync('tags-lastfm.json'))
    throw new Error('No tags yet — run: node enrich-lastfm.mjs');
  const lastfm = JSON.parse(readFileSync('tags-lastfm.json', 'utf8'));
  if (!existsSync('tags-discogs.json')) return lastfm;
  const discogs = JSON.parse(readFileSync('tags-discogs.json', 'utf8'));
  return mergeTagSources(lastfm, discogs);
}
