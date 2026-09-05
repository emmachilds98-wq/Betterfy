// Build the static browser app into docs/ for GitHub Pages.
//
// The scoring modules and the stylesheet are bundled verbatim rather than
// re-implemented, so the browser build and the local app score identically and
// look identical. (The report builders are still duplicated — see V2-PLAN.md.)
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

// One stylesheet for both front ends: ui/index.html links it, the page inlines it.
const theme = readFileSync('ui/theme.css', 'utf8');

const html = readFileSync('docs/app.template.html', 'utf8')
  .replace('__CORE__', core)
  .replace('__THEME__', theme)
  .replace('__CLIENT_ID__', CLIENT_ID)
  .replaceAll('__BUILD__', BUILD);

if (/SPOTIFY_CLIENT_SECRET|LASTFM_SHARED_SECRET|DISCOGS_TOKEN/.test(html))
  throw new Error('Refusing to build: a secret leaked into the web bundle.');

// A page with no client id cannot sign anyone in, and the failure only shows up
// after it is deployed. Better to refuse here.
if (!CLIENT_ID)
  throw new Error('Refusing to build: no client id. Pass one as an argument, or set SPOTIFY_CLIENT_ID.');

writeFileSync('docs/index.html', html);
console.log(`docs/index.html — ${(html.length / 1024).toFixed(0)} KB, client id ${CLIENT_ID ? 'embedded' : 'MISSING'}`);
