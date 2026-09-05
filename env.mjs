import { readFileSync } from 'node:fs';

export const env = Object.fromEntries(
  readFileSync(new URL('.env', import.meta.url), 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map(l => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);
