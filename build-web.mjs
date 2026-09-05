// Build the static browser app into docs/ for GitHub Pages.
//
// The scoring modules are bundled verbatim rather than re-implemented, so the
// web build and the local app score identically and cannot drift apart.
// Only the public client ID is embedded — the client secret is never read here.
import { readFileSync, writeFileSync } from 'node:fs';

const CLIENT_ID = process.argv[2] ?? readEnvClientId();

// Shown in the UI and used to cache-bust tags.json. GitHub Pages caches HTML for
// ~10 minutes, so this is how you tell which version you are actually looking at.
const BUILD = new Date().toISOString().slice(0,16).replace('T','-').replace(':','');

function readEnvClientId() {
  try {
    const line = readFileSync('.env', 'utf8').split('\n').find(l => l.startsWith('SPOTIFY_CLIENT_ID='));
    return line ? line.split('=')[1].trim() : '';
  } catch { return ''; }
}

// Strip module syntax so these can be concatenated into one classic script.
const bundle = file => readFileSync(file, 'utf8')
  .replace(/^\s*import[^;]*;$/gm, '')
  .replace(/^export\s+(const|function|class|let)\b/gm, '$1')
  .replace(/^export\s*\{[^}]*\};?$/gm, '');

const core = ['norm.mjs', 'credits.mjs', 'profile.mjs'].map(f =>
  `/* ---- ${f} ---- */\n${bundle(f)}`).join('\n');

const html = readFileSync('docs/app.template.html', 'utf8')
  .replace('__CORE__', core)
  .replace('__CLIENT_ID__', CLIENT_ID)
  .replaceAll('__BUILD__', BUILD);

if (/SPOTIFY_CLIENT_SECRET|LASTFM_SHARED_SECRET|DISCOGS_TOKEN/.test(html))
  throw new Error('Refusing to build: a secret leaked into the web bundle.');

writeFileSync('docs/index.html', html);
console.log(`docs/index.html — ${(html.length / 1024).toFixed(0)} KB, client id ${CLIENT_ID ? 'embedded' : 'MISSING'}`);
