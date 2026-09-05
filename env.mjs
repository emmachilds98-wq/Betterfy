// Configuration, read from .env with process.env layered on top.
//
// A missing .env is not an error here: the pure modules are importable without
// credentials (so they can be tested), and anything that actually needs a key
// fails at the point of use with a message naming the key it wanted.
import { readFileSync, existsSync } from 'node:fs';

const FILE = new URL('.env', import.meta.url);

const fromFile = existsSync(FILE)
  ? Object.fromEntries(
      readFileSync(FILE, 'utf8')
        .split('\n')
        .filter(l => l.trim() && !l.trim().startsWith('#') && l.includes('='))
        .map(l => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        }))
  : {};

// Real environment variables win, so a container or CI run needs no file.
export const env = { ...fromFile, ...Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== undefined && v !== '')) };

/** Read a key that the caller cannot proceed without. */
export function required(key) {
  const v = env[key];
  if (!v) throw new Error(`Missing ${key} — add it to .env (see .env.example) or set it in the environment.`);
  return v;
}
