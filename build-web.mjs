// Build the static browser app into docs/ for GitHub Pages.
//
// The scoring modules are bundled verbatim rather than re-implemented, so the
// web build and the local app score identically and cannot drift apart.
// Only the public client ID is embedded — the client secret is never read here.
import { readFileSync, writeFileSync } from 'node:fs';

// argv, then .env, then whatever the last build baked into docs/index.html.
// That last fallback is the important one: .env is gitignored, so a rebuild in
// a fresh clone used to silently replace a working client ID with an empty
// string and ship a page nobody could sign in to.
const CLIENT_ID = process.argv.slice(2).find(a => !a.startsWith('--'))
  ?? readEnvClientId() ?? builtClientId() ?? '';

// Shown in the UI and used to cache-bust tags.json. GitHub Pages caches HTML for
// ~10 minutes, so this is how you tell which version you are actually looking at.
const BUILD = new Date().toISOString().slice(0,16).replace('T','-').replace(':','');

function readEnvClientId() {
  try {
    const line = readFileSync('.env', 'utf8').split('\n').find(l => l.startsWith('SPOTIFY_CLIENT_ID='));
    return line?.split('=')[1].trim() || null;
  } catch { return null; }
}

/** The client ID the currently published page carries. */
function builtClientId() {
  try {
    const m = readFileSync('docs/index.html', 'utf8').match(/const DEFAULT_CLIENT_ID = '([0-9a-f]{32})'/);
    return m?.[1] ?? null;
  } catch { return null; }
}

/* The shared tag table, which is optional in a way the client ID is not: with
 * no project configured the page simply never contributes, and behaves exactly
 * as it did before any of this existed. Same read order as the client ID —
 * argv, .env, then whatever the last build baked in — so a rebuild in a fresh
 * clone cannot silently switch sharing off. Both values are public: a Firebase
 * web key identifies a project, it does not authorise anything. The Firestore
 * rules do that. */
const readEnv = k => {
  try {
    const line = readFileSync('.env', 'utf8').split('\n').find(l => l.startsWith(k + '='));
    return line?.slice(k.length + 1).trim() || null;
  } catch { return null; }
};
const built = re => {
  try { return readFileSync('docs/index.html', 'utf8').match(re)?.[1] ?? null; } catch { return null; }
};
const arg = k => process.argv.slice(2).find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');

const TAGS_PROJECT = arg('tags-project') ?? readEnv('TAGS_PROJECT')
  ?? built(/const TAGS_PROJECT = '([a-z][a-z0-9-]{3,39})'/) ?? '';
const TAGS_KEY = arg('tags-key') ?? readEnv('TAGS_KEY')
  ?? built(/TAGS_KEY = '([A-Za-z0-9_-]{20,})'/) ?? '';

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
  .replace('__TAGS_PROJECT__', TAGS_PROJECT)
  .replace('__TAGS_KEY__', TAGS_KEY)
  .replaceAll('__BUILD__', BUILD);

if (/SPOTIFY_CLIENT_SECRET|LASTFM_SHARED_SECRET|DISCOGS_TOKEN/.test(html))
  throw new Error('Refusing to build: a secret leaked into the web bundle.');

// A page with no client ID looks fine and cannot sign anyone in, which is the
// worst way for a build to fail — so it fails here instead.
if (!CLIENT_ID && !process.argv.includes('--allow-missing-id'))
  throw new Error('Refusing to build: no Spotify client ID. Pass one as an argument, '
    + 'set SPOTIFY_CLIENT_ID in .env, or pass --allow-missing-id if you really mean it.');

writeFileSync('docs/index.html', html);
console.log(`docs/index.html — ${(html.length / 1024).toFixed(0)} KB, client id ${CLIENT_ID ? 'embedded' : 'MISSING'}`
  + `, shared tags ${TAGS_PROJECT && TAGS_KEY ? `→ ${TAGS_PROJECT}` : 'off'}`);
