// Build the static browser app into docs/ for GitHub Pages.
//
// The scoring modules are bundled verbatim rather than re-implemented, so the
// web build and the local app score identically and cannot drift apart.
// Only the public client ID is embedded — the client secret is never read here.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { bundleModules } from './bundler.mjs';
import { GENRES } from './core/ontology/genres.mjs';
import { canonTag } from './profile.mjs';

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

/* The sound layer's renderers (docs/UI-BUILD-PLAN.md §5). Inlined and exposed as
 * globals like v1, because every screen calls them; with no audio data each one
 * returns '' so they cost a listener who never turns listening on nothing but
 * their few hundred bytes. */
const UI_MODULES = ['web/ui/sound.mjs'];

const { code: core, files: bundled } = bundleModules([...V1_MODULES, ...UI_MODULES],
  { expose: [...V1_MODULES, ...UI_MODULES] });

/* The stylesheet, kept as partials in web/styles/ so packages that restyle
 * different screens own different files (docs/UI-BUILD-PLAN.md §3). Inlined in
 * file-name order — the numeric prefixes are the cascade order — so the page is
 * still one file with no second request. */
const STYLES = readdirSync('web/styles').filter(f => f.endsWith('.css')).sort()
  .map(f => readFileSync(`web/styles/${f}`, 'utf8')).join('');

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
  // The neighbour bridge (docs/SMARTER-GENRES-PLAN.md phase 0). Pure, plus an
  // orchestrator whose network calls are handed in by the page.
  'core/intrinsic/bridge.mjs',
  'core/intrinsic/bridge-fetch.mjs',
  // How sure it may sound, fitted on held-out filing (plan phase 2).
  'core/intrinsic/calibrate.mjs',
  // Genres with no playlist, and playlists that are two genres (plan phase 3).
  // Brings the ontology with it, which is why it lives in the lazy bundle.
  'core/recommend/gaps.mjs',
  // The same screen's proposals by sound (docs/AUDIO-BUILD-PLAN.md WP-H2).
  // Empty without audio records; brings the style vocabulary with it.
  'core/recommend/audio-gaps.mjs',
  // What a heard track is (genre, sub-genre, tempo) and what it sounds like and
  // mixes with, from the account's own heard tracks.
  'core/audio/match.mjs',
  'core/audio/identify.mjs',
  // Tidy by sound: filed tracks whose sound disagrees with their playlist.
  'core/audio/misfit.mjs',
  // Each playlist's genre mix, BPM range and "two genres?" from its heard members.
  'core/audio/plprofile.mjs',
  // Shuffle's DJ order: heard tracks sequenced so each next one beatmatches.
  'core/audio/order.mjs',
  // Discover by sound: re-rank picks by fit to the seed, and the keyless
  // candidate path over the neighbour bridge's cached lookups.
  'core/audio/discover.mjs',
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
    BetterfyBridge: 'core/intrinsic/bridge.mjs',
    BetterfyBridgeFetch: 'core/intrinsic/bridge-fetch.mjs',
    BetterfyDeezer: 'core/sources/deezer.mjs',
    BetterfyCalibrate: 'core/intrinsic/calibrate.mjs',
    BetterfyGaps: 'core/recommend/gaps.mjs',
    BetterfyAudioGaps: 'core/recommend/audio-gaps.mjs',
    BetterfyWikidata: 'core/sources/wikidata.mjs',
    BetterfyMatch: 'core/audio/match.mjs',
    BetterfyIdentify: 'core/audio/identify.mjs',
    BetterfyMisfit: 'core/audio/misfit.mjs',
    BetterfyPlProfile: 'core/audio/plprofile.mjs',
    BetterfyOrder: 'core/audio/order.mjs',
    BetterfyDiscover: 'core/audio/discover.mjs',
  },
});

/* The worker that runs the engine off the page's main thread.
 *
 * Measured on the live build with a 250-playlist, 21k-entry library: scoring
 * held the main thread for 6.2s and learning for 1.7s on a desktop-class CPU,
 * which on a phone is long enough for the OS to offer to kill the page. The
 * engine bundle touches no DOM, so a worker can load it unchanged; the only
 * page state it needs is which playlists are mirrors, and that arrives as ids
 * because `isMirrorPlaylist` reads the page's own settings.
 *
 * Generated rather than committed by hand so the engine it imports always
 * carries the same build stamp as the page that started it. */
const WORKER = `/* Generated by build-web.mjs — do not edit here. */
importScripts('engine.js?v=${BUILD}');
self.onmessage = function (e) {
  var m = e.data || {};
  var mirrors = new Set(m.mirrorIds || []);
  var isMirror = function (p) { return !!p && mirrors.has(p.id); };
  var t0 = performance.now();
  try {
    var result;
    if (m.op === 'build') {
      // Posted back serialised: the page revives it far faster than it could
      // build it, and the same object is what gets cached in IndexedDB.
      // genreGraph: the artist graph learns from genre playlists only, so
      // mood and event playlists stop teaching genre (sound-first filing).
      var space = BetterfyIntrinsic.buildSpace(m.lib, { isMirror: isMirror, targets: m.targets || null,
                                                        audio: m.audio || null, genreGraph: m.genreGraph === true });
      result = BetterfyPersist.serialiseSpace(space, m.lib);
      // The "can't tell apart" report costs more than the build on a big
      // library (2.9s for 250 playlists) and needs nothing but the space, so it
      // is worked out here too, and cached beside the space it came from.
      try { result.pairs = (BetterfyReports.bucketPairs(space) || []).slice(0, 6); }
      catch (e) { result.pairs = null; }
    } else if (m.op === 'validate') {
      var common = Object.assign({}, m.opts, { isMirror: isMirror,
                                                targets: m.targets ? new Set(m.targets) : null,
                                                bridge: m.bridge || null, audio: m.audio || null,
                                                // The sound variant is scored the way the File screen
                                                // files a heard track: sound leading.
                                                soundWeights: m.opts && m.opts.soundFirst
                                                  ? BetterfyIntrinsic.SOUND_FIRST_WEIGHTS : null });
      result = { mine: BetterfyValidate.placementAccuracy(m.lib, common),
                 base: m.tags ? BetterfyBaseline.baselineAccuracy(m.lib, m.tags, common) : null };
      // How well it names genres by sound, on the same filed tracks.
      try { result.identify = m.audio ? BetterfyIdentify.identifyAccuracyFor(m.lib, m.audio,
              { targets: m.targets || null, isMirror: isMirror }) : null; }
      catch (e) { result.identify = null; }
    } else if (m.op === 'misfits') {
      // Tidy by sound: an all-pairs nearest-neighbour pass over the heard
      // tracks, too long for the page's thread on a big library.
      result = BetterfyMisfit.soundMisfitsFor(m.lib, m.audio || null,
        { targets: m.targets || null, isMirror: isMirror, measure: m.measure !== false });
    } else {
      throw new Error('unknown engine op: ' + m.op);
    }
    self.postMessage({ id: m.id, ok: true, result: result, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: (err && err.message) || String(err) });
  }
};
`;

/* "Listen to my music" (docs/AUDIO-BUILD-PLAN.md WP-B2): a third lazy file,
 * fetched only when somebody switches listening on, for the same reason the
 * engine is one. Everything core/audio has, plus whichever audio engine
 * components (core/intrinsic/audio*.mjs) exist on this branch, so a package
 * that lands one does not also need a build edit to reach the page. */
const listMjs = dir => { try { return readdirSync(dir).filter(f => /\.(mjs|js)$/.test(f)).sort().map(f => `${dir}/${f}`); } catch { return []; } };
const AUDIO_INTRINSIC = readdirSync('core/intrinsic').filter(f => /^audio.*\.mjs$/.test(f)).sort().map(f => `core/intrinsic/${f}`);
// Engine-side lookups over the sound space (sound ID, sound-alikes, mixes):
// they ship in engine.js, and would only add the genre ontology (~100 KB) here.
const ENGINE_SIDE = new Set(['core/audio/identify.mjs', 'core/audio/match.mjs', 'core/audio/misfit.mjs', 'core/audio/plprofile.mjs', 'core/audio/order.mjs', 'core/audio/discover.mjs']);
const AUDIO_ENTRIES = ['web/audio/index.mjs', ...listMjs('core/audio').filter(f => !ENGINE_SIDE.has(f)),
                       ...listMjs('core/audio/dsp'), ...AUDIO_INTRINSIC];
const camel = f => f.replace(/^.*\//, '').replace(/\.m?js$/, '').split(/[-_]/).map(w => w[0].toUpperCase() + w.slice(1)).join('');
const { code: audio, files: audioFiles } = bundleModules(AUDIO_ENTRIES, {
  namespace: {
    BetterfyAudio: 'web/audio/index.mjs',
    // deezerJsonp() checks addresses with it; the engine bundle defines it too.
    BetterfyDeezer: 'core/sources/deezer.mjs',
    // core/intrinsic/audio.mjs → BetterfyAudioIntrinsic, audio-learn.mjs → BetterfyAudioLearnIntrinsic
    ...Object.fromEntries(AUDIO_INTRINSIC.map(f => [`Betterfy${camel(f)}Intrinsic`, f])),
  },
});

/* Where onnxruntime-web and the models come from. ORT is pinned (1.31.1) and
 * runs WASM only, single-threaded: GitHub Pages cannot send COOP/COEP, so no
 * SharedArrayBuffer, so no threads. The models are self-hosted under
 * docs/models/ (Essentia sends no CORS header) with their licence. Both are
 * build options so a fork, or a test, can point them elsewhere. */
const ORT_BASE = arg('ort-base') ?? readEnv('ORT_BASE') ?? 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';
const AUDIO_MODELS = arg('audio-models') ?? readEnv('AUDIO_MODELS') ?? 'models/';

/* The inference worker: a module worker, because onnxruntime-web 1.31 ships as
 * ES modules. It holds the ear and the heads and nothing else; the page keeps
 * lookup, download, decode and the mel (core/audio/worker.js explains why). */
const { code: earCode } = bundleModules(['core/audio/infer.mjs', 'core/audio/heads.mjs'], {
  namespace: { BetterfyInfer: 'core/audio/infer.mjs', BetterfyHeads: 'core/audio/heads.mjs' },
});
const AUDIO_WORKER = `/* Generated by build-web.mjs — do not edit here. */
${earCode}
let ort = null, ear = null, heads = null;
const opts = () => ({ executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
self.onmessage = async function (e) {
  const m = e.data || {};
  try {
    let result = null, transfer = [];
    if (m.op === 'init') {
      const base = m.ortBase || ${JSON.stringify(ORT_BASE)};
      ort = await import(base + 'ort.wasm.bundle.min.mjs');
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = base;
      ear = await BetterfyInfer.createEar({ ort, modelUrl: m.modelUrl, sessionOptions: opts() });
      let names = [];
      try {
        heads = await BetterfyHeads.createHeads({ ort, urls: m.headUrls || {}, sessionOptions: opts() });
        names = heads.names;
      } catch (err) { heads = null; } // heads are optional: the ear alone is enough
      result = { heads: names };
    } else if (m.op === 'ear') {
      const out = await ear.run(m.data, m.patches);
      result = out; transfer = [out.activations.buffer, out.embeddings.buffer];
    } else if (m.op === 'heads') {
      if (!heads) throw new Error('no heads loaded');
      result = await heads.run(m.emb, m.patches);
      transfer = Object.values(result).map(a => a.buffer);
    } else {
      throw new Error('unknown audio op: ' + m.op);
    }
    self.postMessage({ id: m.id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: (err && err.message) || String(err) });
  }
};
`;

/* Every name the ontology knows a genre by, in the one spelling profile.mjs
 * counts tags under, baked into the page so classify() can tell a genre
 * playlist ("Donk", "D&B Rollers", "Tech House") from one that only happens to
 * have no other signal in its name. ~4 KB, and it means one vocabulary for the
 * whole app rather than a second list to keep in step with the ontology.
 *
 * A few single words are left out because, alone as a playlist name, they are
 * as likely to be a place or an ordinary word as a genre ("Goa", "Detroit",
 * "Lounge"). Their longer forms still count: "detroit techno", "liquid dnb". */
const NOT_ALONE = new Set(['goa', 'detroit', 'lounge', 'niche', 'liquid', 'neuro', 'score', 'fusion', 'wonky']);
const GENRE_WORDS = [...new Set(Object.entries(GENRES)
  .flatMap(([slug, g]) => [slug.replace(/-/g, ' '), ...(g.aliases ?? [])])
  .map(canonTag)
  .filter(w => w && !NOT_ALONE.has(w)))].sort();

const html = readFileSync('docs/app.template.html', 'utf8')
  // A function, not a string: CSS is free to contain `$&` and friends.
  .replace('__STYLES__', () => STYLES)
  .replace("'__GENRE_WORDS__'", JSON.stringify(GENRE_WORDS))
  .replace('__CORE__', core)
  .replace('__CLIENT_ID__', CLIENT_ID)
  .replace('__TAGS_PROJECT__', TAGS_PROJECT)
  .replace('__TAGS_KEY__', TAGS_KEY)
  .replace('__CONTACT_EMAIL__', CONTACT_EMAIL)
  .replace('__APPCHECK_SITE_KEY__', APPCHECK_SITE_KEY)
  .replace('__APPCHECK_APP_ID__', APPCHECK_APP_ID)
  .replace('__ORT_BASE__', ORT_BASE)
  .replace('__AUDIO_MODELS__', AUDIO_MODELS)
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
for (const [name, out] of [['docs/index.html', html], ['docs/engine.js', engine],
                           ['docs/engine-worker.js', WORKER], ['docs/audio.js', audio],
                           ['docs/audio-worker.js', AUDIO_WORKER]]) {
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
writeFileSync('docs/engine-worker.js', WORKER);
writeFileSync('docs/audio.js', audio);
writeFileSync('docs/audio-worker.js', AUDIO_WORKER);
console.log(`docs/audio.js   — ${(audio.length / 1024).toFixed(0)} KB, `
  + `${audioFiles.length} modules, fetched only when listening is switched on`);
console.log(`docs/engine.js  — ${(engine.length / 1024).toFixed(0)} KB, `
  + `${engineFiles.length} modules, fetched only when the Engine screen is opened`);
console.log(`docs/index.html — ${(html.length / 1024).toFixed(0)} KB, ${bundled.length} modules bundled`
  + `, client id ${CLIENT_ID ? 'embedded' : 'MISSING'}`
  + `, shared tags ${TAGS_PROJECT && TAGS_KEY ? `→ ${TAGS_PROJECT}` : 'off'}`
  + `, request-access link ${CONTACT_EMAIL ? `→ ${CONTACT_EMAIL}` : 'off'}`
  + `, App Check ${APPCHECK_SITE_KEY && APPCHECK_APP_ID ? 'on' : 'off'}`);
