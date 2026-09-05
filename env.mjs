// Reads .env lazily, on first access to a key, rather than at import time —
// otherwise importing anything upstream of spotify.mjs (including pure
// modules like actions.mjs, for testing) throws in any environment without
// Spotify credentials, such as CI.
import { readFileSync, existsSync } from 'node:fs';

const ENV_PATH = new URL('.env', import.meta.url);
let cached = null;

function load() {
  if (cached) return cached;
  if (!existsSync(ENV_PATH)) throw new Error('No .env — copy .env.example to .env and fill it in.');
  cached = Object.fromEntries(
    readFileSync(ENV_PATH, 'utf8')
      .split('\n')
      .filter(l => l.trim() && !l.trim().startsWith('#') && l.includes('='))
      .map(l => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      })
  );
  return cached;
}

export const env = new Proxy({}, { get: (_, key) => load()[key] });
