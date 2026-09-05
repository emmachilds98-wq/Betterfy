// Node-side tag loading, kept out of profile.mjs so that module stays
// bundleable into the browser build.
import { readFileSync, existsSync } from 'node:fs';

export function loadTags() {
  if (!existsSync('tags-lastfm.json'))
    throw new Error('No tags yet — run: node enrich-lastfm.mjs');
  return JSON.parse(readFileSync('tags-lastfm.json', 'utf8'));
}
