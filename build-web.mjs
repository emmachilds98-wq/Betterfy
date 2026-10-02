// Build the static browser app into docs/ for GitHub Pages.
//
// The scoring modules are bundled verbatim rather than re-implemented, so the
// web build and the local app score identically and cannot drift apart.
// Only the public client ID is embedded — the client secret is never read here.
import { readFileSync, writeFileSync } from 'node:fs';
import { bundleModules } from './bundler.mjs';

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

// Same optional, same read order: blank means the "Request access" mailto
// link is never shown, so nobody who forks this repo ships a stranger's inbox.
const CONTACT_EMAIL = arg('contact-email') ?? readEnv('CONTACT_EMAIL')
  ?? built(/const CONTACT_EMAIL = '([^'@]+@[^'@]+\.[^']+)'/) ?? '';

// Same again: blank means the shared-tag write never loads reCAPTCHA or asks
// for an App Check token, and behaves exactly as it did before either existed.
const APPCHECK_SITE_KEY = arg('appcheck-site-key') ?? readEnv('APPCHECK_SITE_KEY')
  ?? built(/const APPCHECK_SITE_KEY = '([^']{10,})'/) ?? '';
const APPCHECK_APP_ID = arg('appcheck-app-id') ?? readEnv('APPCHECK_APP_ID')
  ?? built(/APPCHECK_APP_ID = '(\d+:\d+:web:[^']+)'/) ?? '';

/* The scoring modules, bundled by `bundler.mjs` rather than concatenated.
 *
 * v1's three files are exposed as globals, because the page's inline script
 * calls `rank()` and `trackVec()` as bare identifiers and used to get them from
 * a flat concatenation. Checked rather than assumed: of the 26 private top-level
 * declarations in those files, the template references none — the only near miss
 * was `dot`, which appears in the page as a CSS class for the pager dots.
 *
 * These are inlined because the page cannot draw a single screen without them. */
const V1_MODULES = ['norm.mjs', 'credits.mjs', 'profile.mjs'];

const { code: core, files: bundled } = bundleModules(V1_MODULES, { expose: V1_MODULES });

/* The account-native engine goes in a **separate file the page fetches only when
 * somebody opens the Engine screen**, rather than inline.
 *
 * Inlining it was the obvious thing and it is the wrong thing. It is ~144 KB
 * that every listener would download on every cold load to run a screen most of
 * them will never open — and `CLAUDE.md`'s rule about optional things being
 * "zero-cost for anyone who doesn't have it" is about respecting someone's
 * phone, which a mandatory download for an unused feature does not do. A second
 * file makes the cost fall on whoever asked for it.
 *
 * `profile.mjs` is in both bundles, so v1's ~29 KB is paid twice by anyone who
 * opens the screen. Left deliberately: the alternative is cross-bundle import
 * plumbing to save 29 KB on one screen, and the simpler build is worth more than
 * the bytes. Each bundle stays independently loadable, which is the property
 * that matters.
 *
 * `core/engine.mjs` — the provider/evidence path — is deliberately NOT here. It
 * is the part that needs Last.fm and Discogs keys, and the whole point of this
 * screen is what the account can do without them. */
const ENGINE_ENTRIES = [
  'core/intrinsic/space.mjs',
  'core/intrinsic/coldstart.mjs',
  'core/intrinsic/explain.mjs',
  'core/intrinsic/reports.mjs',
  'core/intrinsic/persist.mjs',
  'core/validate/loo.mjs',
  'core/validate/baseline.mjs',
];

const { code: engine, files: engineFiles } = bundleModules(ENGINE_ENTRIES, {
  namespace: {
    BetterfyIntrinsic: 'core/intrinsic/space.mjs',
    BetterfyColdStart: 'core/intrinsic/coldstart.mjs',
    BetterfyExplain: 'core/intrinsic/explain.mjs',
    BetterfyReports: 'core/intrinsic/reports.mjs',
    BetterfyPersist: 'core/intrinsic/persist.mjs',
    BetterfyValidate: 'core/validate/loo.mjs',
    BetterfyBaseline: 'core/validate/baseline.mjs',
  },
});

const html = readFileSync('docs/app.template.html', 'utf8')
  .replace('__CORE__', core)
  .replace('__CLIENT_ID__', CLIENT_ID)
  .replace('__TAGS_PROJECT__', TAGS_PROJECT)
  .replace('__TAGS_KEY__', TAGS_KEY)
  .replace('__CONTACT_EMAIL__', CONTACT_EMAIL)
  .replace('__APPCHECK_SITE_KEY__', APPCHECK_SITE_KEY)
  .replace('__APPCHECK_APP_ID__', APPCHECK_APP_ID)
  .replaceAll('__BUILD__', BUILD);

/* The old guard matched the *names* SPOTIFY_CLIENT_SECRET, LASTFM_SHARED_SECRET
 * and DISCOGS_TOKEN, which only catches a leak that happens to arrive carrying
 * its own label. A value pasted into the template by hand, or interpolated by
 * some future build step, has no name attached to it at all — exactly the shape
 * a real accident takes. So check the values too: anything in .env that is not
 * meant to ship must not appear in the output.
 *
 * The allowlist is short and deliberate. A Spotify client ID and a Firebase web
 * key are public by design — they name a thing, they do not authorise anything,
 * and the whole PKCE-and-rules design depends on being able to ship them. */
const PUBLIC_BY_DESIGN = new Set(['SPOTIFY_CLIENT_ID', 'SPOTIFY_REDIRECT_URI',
  'TAGS_PROJECT', 'TAGS_KEY', 'CONTACT_EMAIL', 'APPCHECK_SITE_KEY', 'APPCHECK_APP_ID']);

/** @returns {string|null} the name of the first .env value found in `out`. */
function leakedSecret(out) {
  let env;
  try { env = readFileSync('.env', 'utf8'); } catch { return null; }
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    const [, name, value] = m;
    if (PUBLIC_BY_DESIGN.has(name)) continue;
    // Short values are placeholders, or too common to match on without crying
    // wolf over every "true" and "1" someone leaves in a config.
    if (value.length >= 8 && out.includes(value)) return name;
  }
  return null;
}

/* Every file this build writes, checked — not only the page.
 *
 * The guard used to run over `html` alone, which was complete while the page was
 * the only output. Adding a second file silently moved a chunk of shipped
 * JavaScript outside the only thing standing between .env and GitHub Pages, so
 * the guard iterates outputs instead of naming one. */
for (const [name, out] of [['docs/index.html', html], ['docs/engine.js', engine]]) {
  const named = out.match(/SPOTIFY_CLIENT_SECRET|LASTFM_SHARED_SECRET|LASTFM_API_KEY|DISCOGS_TOKEN/);
  const valued = leakedSecret(out);
  if (named || valued)
    throw new Error(`Refusing to build: ${valued ?? named[0]} leaked into ${name}.`);
}

// A page with no client ID looks fine and cannot sign anyone in, which is the
// worst way for a build to fail — so it fails here instead.
if (!CLIENT_ID && !process.argv.includes('--allow-missing-id'))
  throw new Error('Refusing to build: no Spotify client ID. Pass one as an argument, '
    + 'set SPOTIFY_CLIENT_ID in .env, or pass --allow-missing-id if you really mean it.');

writeFileSync('docs/index.html', html);
writeFileSync('docs/engine.js', engine);
console.log(`docs/engine.js  — ${(engine.length / 1024).toFixed(0)} KB, `
  + `${engineFiles.length} modules, fetched only when the Engine screen is opened`);
console.log(`docs/index.html — ${(html.length / 1024).toFixed(0)} KB, ${bundled.length} modules bundled`
  + `, client id ${CLIENT_ID ? 'embedded' : 'MISSING'}`
  + `, shared tags ${TAGS_PROJECT && TAGS_KEY ? `→ ${TAGS_PROJECT}` : 'off'}`
  + `, request-access link ${CONTACT_EMAIL ? `→ ${CONTACT_EMAIL}` : 'off'}`
  + `, App Check ${APPCHECK_SITE_KEY && APPCHECK_APP_ID ? 'on' : 'off'}`);
