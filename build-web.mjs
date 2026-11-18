// Build the static browser app into docs/ for GitHub Pages.
//
// The scoring modules are bundled verbatim rather than re-implemented, so the
// web build and the local app score identically and cannot drift apart.
// Only the public client ID is embedded — the client secret is never read here.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { bundleModules, discoverBundles } from './bundler.mjs';
import { genreWords } from './core/playlists/genre-words.mjs';
import { assembledTemplate } from './web/manifest.mjs';

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

// Last.fm's read-only methods need only the API key, never the shared secret,
// so a key meant for the page is public by design. Blank = no default key and
// the page behaves exactly as before.
const LASTFM_PUBLIC_KEY = arg('lastfm-key') ?? readEnv('LASTFM_PUBLIC_KEY')
  ?? built(/DEFAULT_LFM_KEY = '([A-Za-z0-9]{16,})'/) ?? '';

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

/* Which axis each playlist is on (docs/archive/BUILD-5-PLAN.md A2): the one copy that
 * both the page's classify() and the Node CLI axes.mjs use, so the two cannot
 * drift apart again (B10). Exposed as globals like v1 (`classifyAxes`,
 * `MIN_FOR_TARGET`, `NO_SIGNAL`, ...), because web/app/classify.js and the
 * Playlists screen use them as bare identifiers. */
const AXES_MODULES = ['core/playlists/axes.mjs'];

/* The sound layer's renderers (docs/archive/UI-BUILD-PLAN.md §5). Inlined and exposed as
 * globals like v1, because every screen calls them; with no audio data each one
 * returns '' so they cost a listener who never turns listening on nothing but
 * their few hundred bytes. */
const UI_MODULES = ['web/ui/sound.mjs', 'web/app/patch.mjs'];

/* The File queue's order and sure batch (BUILD-5-PLAN §5.2): relevance.mjs's listening-x-uncertainty
 * pieces and the pure ordering built on them. Exposed as globals like v1. */
const FILE_MODULES = ['core/personal/relevance.mjs', 'core/review/filequeue.mjs', 'core/review/teach.mjs', 'core/review/autoscore.mjs'];

/* Screen modules (docs/archive/BUILD-5-PLAN.md A4): web/screens/<name>.mjs, each opting
 * in with `// @bundle screens <name> <order>` (see bundler.mjs discoverBundles;
 * the second field is the screen's name, not a global). They are bundled with
 * the rest and collected on one global, `BetterfyScreens.<name>`, which
 * web/app/screens.js reads. A screen module reaches nothing but its ctx. */
const { entries: SCREEN_ENTRIES, namespace: SCREEN_NAMES } = discoverBundles('web/screens', 'screens');

const { code: coreCode, files: bundled } = bundleModules([...V1_MODULES, ...AXES_MODULES, ...FILE_MODULES, ...UI_MODULES, ...SCREEN_ENTRIES],
  { expose: [...V1_MODULES, ...AXES_MODULES, ...FILE_MODULES, ...UI_MODULES] });
const core = `${coreCode}\nglobalThis.BetterfyScreens = { ${Object.entries(SCREEN_NAMES)
  .map(([name, path]) => `${name}: __mod[${JSON.stringify(path)}]`).join(', ')} };`;

/* The stylesheet, kept as partials in web/styles/ so packages that restyle
 * different screens own different files (docs/archive/UI-BUILD-PLAN.md §3). Inlined in
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
/* Which modules go in engine.js is declared by each module's own
 * `// @bundle engine <Global> <order>` header (see bundler.mjs), found by
 * scanning core/ — a new module opts in from its own file. */
const { entries: ENGINE_ENTRIES, namespace: ENGINE_NAMESPACE } = discoverBundles('core', 'engine');

const { code: engine, files: engineFiles } = bundleModules(ENGINE_ENTRIES, {
  namespace: ENGINE_NAMESPACE,
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
  // The hosted app fits nothing to playlist membership: its sound learner is
  // prototypes only (docs/archive/BUILD-5-PLAN.md §2.3, option b), whatever arrives.
  var prototypesOnly = function (a) {
    if (!a) return null;
    var o = (typeof a === 'object' && !Array.isArray(a) && ('records' in a || 'index' in a)) ? a : { records: a };
    return Object.assign({}, o, { model: 'prototype' });
  };
  var t0 = performance.now();
  try {
    var result;
    if (m.op === 'build') {
      // Posted back serialised: the page revives it far faster than it could
      // build it, and the same object is what gets cached in IndexedDB.
      // genreGraph: the artist graph learns from genre playlists only, so
      // mood and event playlists stop teaching genre (sound-first filing).
      var space = BetterfyIntrinsic.buildSpace(m.lib, { isMirror: isMirror, targets: m.targets || null,
                                                        audio: prototypesOnly(m.audio), genreGraph: m.genreGraph === true });
      result = BetterfyPersist.serialiseSpace(space, m.lib);
      // The "can't tell apart" report costs more than the build on a big
      // library (2.9s for 250 playlists) and needs nothing but the space, so it
      // is worked out here too, and cached beside the space it came from.
      try { result.pairs = (BetterfyReports.bucketPairs(space) || []).slice(0, 6); }
      catch (e) { result.pairs = null; }
    } else if (m.op === 'validate') {
      var common = Object.assign({}, m.opts, { isMirror: isMirror,
                                                targets: m.targets ? new Set(m.targets) : null,
                                                bridge: m.bridge || null, audio: prototypesOnly(m.audio),
                                                // The sound variant is scored the way the File screen
                                                // files a heard track: sound leading.
                                                soundWeights: m.opts && m.opts.soundFirst
                                                  ? BetterfyIntrinsic.SOUND_FIRST_WEIGHTS : null });
      result = { mine: BetterfyValidate.placementAccuracy(m.lib, common),
                 base: m.tags ? BetterfyBaseline.baselineAccuracy(m.lib, m.tags, common) : null };
      // This engine's component weights fitted to the account's own held-out
      // filing (core/validate/weights.mjs), nested over the same folds. Takes
      // the per-track components off the result, so they never cross back.
      var fit = null;
      try { fit = BetterfyWeightFit.weightsFromRun(result.mine); }
      catch (e) { fit = null; if (result.mine) delete result.mine.partRows; }
      // Tags and this engine (with similar artists when there were any) blended
      // per track, one weight fitted on held-out folds (plan phase 1), on top
      // of the fitted weights when those earned their place. The tag rows are
      // only for this, so they don't cross back to the page.
      try { result.blend = BetterfyBlendScore.blendFromRun(m.lib, { base: result.base, mine: result.mine,
              folds: common.folds, targets: common.targets, isMirror: isMirror, nativeFit: fit }); }
      catch (e) { result.blend = null; }
      result.weights = BetterfyWeightFit.fitSummary(fit);
      // The tag engine's own top picks per track, for the agreement check
      // (core/intrinsic/agree.mjs, package 4): small, unlike the rows.
      try { result.tagTops = result.base && result.base.rows ? BetterfyAgree.tagTopsOf(result.base.rows) : null; }
      catch (e) { result.tagTops = null; }
      if (result.base) delete result.base.rows;
      // How well it names genres by sound, on the same filed tracks.
      try { result.identify = m.audio ? BetterfyIdentify.identifyAccuracyFor(m.lib, m.audio,
              { targets: m.targets || null, isMirror: isMirror }) : null; }
      catch (e) { result.identify = null; }
      // Fill this playlist's gate (BUILD-6 F2, M4): recall@10 on hidden tracks.
      try { result.fill = BetterfyFill.fillRecall(m.lib, { tags: m.tags || null, audio: m.audio || null, isMirror: isMirror }); }
      catch (e) { result.fill = null; }
      // The teach queue's gate (BUILD-6 SG): 20 simulated answers on a hidden fold of the
      // account's own filing, the engine scored before and after (core/validate/teach.mjs).
      try { result.teach = BetterfyTeach.teachGate(m.lib, { targets: m.targets || null, isMirror: isMirror,
              genreGraph: !!(m.opts && m.opts.genreGraph), audio: prototypesOnly(m.audio) }); }
      catch (e) { result.teach = null; }
      // Learning from every tap (BUILD-7 E1): the held-out folds replayed in order, each tap learnt at once.
      try { result.online = BetterfyOnline.onlineAccuracy(m.lib, { targets: m.targets || null, isMirror: isMirror,
              genreGraph: !!(m.opts && m.opts.genreGraph) }); }
      catch (e) { result.online = null; }
    } else if (m.op === 'misfits') {
      // Tidy by sound: an all-pairs nearest-neighbour pass over the heard
      // tracks, too long for the page's thread on a big library.
      result = BetterfyMisfit.soundMisfitsFor(m.lib, m.audio || null,
        { targets: m.targets || null, isMirror: isMirror, measure: m.measure !== false, opts: m.misfitOpts || undefined });
    } else if (m.op === 'tune') {
      // Engine › Tune: one group per call, so the page can show where it is.
      // Per-device parameter sweep over the account's own folds (core/validate/tune.mjs).
      result = BetterfyTune.tuneSweep(m.lib, { audio: prototypesOnly(m.audio), targets: m.targets || null, isMirror: isMirror,
                                               limit: m.limit || 300, folds: m.folds || 5, groups: m.groups || undefined });
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
const ENGINE_SIDE = new Set(ENGINE_ENTRIES.filter(f => f.startsWith('core/audio/')));
// Nothing is research-only any more: Beat This (beat-mel.mjs, beats.mjs) ships as
// an opt-in under Deep listen, run only on tracks the DSP flags as octave-unsure
// (BUILD-5-PROGRESS.md, 2026-11-16). The page bundle carries its gating and the
// merge (withBeats); the tracker itself runs in audio-worker.js.
const RESEARCH_ONLY = new Set();
const AUDIO_ENTRIES = ['web/audio/index.mjs', ...listMjs('core/audio').filter(f => !ENGINE_SIDE.has(f)),
                       ...listMjs('core/audio/dsp').filter(f => !RESEARCH_ONLY.has(f)), ...AUDIO_INTRINSIC];
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
const { code: earCode } = bundleModules(['core/audio/infer.mjs', 'core/audio/heads.mjs', 'core/audio/clap.mjs', 'core/audio/dsp/beats.mjs', 'core/audio/dsp/keynet.mjs'], {
  namespace: { BetterfyInfer: 'core/audio/infer.mjs', BetterfyHeads: 'core/audio/heads.mjs', BetterfyClap: 'core/audio/clap.mjs',
               BetterfyBeats: 'core/audio/dsp/beats.mjs', BetterfyKeyNet: 'core/audio/dsp/keynet.mjs' },
});
const AUDIO_WORKER = `/* Generated by build-web.mjs — do not edit here. */
${earCode}
let ort = null, ear = null, heads = null, clapEar = null, beatTracker = null, keyNet = null;
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
    } else if (m.op === 'clapInit') {
      // CLAP (WP-C2): only when the page's "Search by description" switch is on.
      clapEar = clapEar || await BetterfyClap.createClapEar({ ort, modelUrl: m.modelUrl, sessionOptions: opts() });
      result = true;
    } else if (m.op === 'beatsInit') {
      // Beat This (tempo), only when the Deep listen "Better tempo" switch is on.
      beatTracker = beatTracker || await BetterfyBeats.createBeatTracker({ ort, modelUrl: m.modelUrl, sessionOptions: opts() });
      result = true;
    } else if (m.op === 'beats') {
      if (!beatTracker) throw new Error('Beat This not loaded');
      result = await beatTracker.measure(m.windows);
    } else if (m.op === 'keynetInit') {
      // Key v4: on wherever listening runs.
      keyNet = keyNet || await BetterfyKeyNet.createKeyNet({ ort, modelUrl: m.modelUrl, sessionOptions: opts() });
      result = true;
    } else if (m.op === 'keynet') {
      if (!keyNet) throw new Error('key model not loaded');
      result = await keyNet.logp(m.windows);
    } else if (m.op === 'clap') {
      if (!clapEar) throw new Error('CLAP not loaded');
      result = await BetterfyClap.clapEmbed(clapEar, m.windows);
    } else {
      throw new Error('unknown audio op: ' + m.op);
    }
    self.postMessage({ id: m.id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: (err && err.message) || String(err) });
  }
};
`;

/* The second ear's worker (WP-C1): MAEST alone, in a worker of its own so the
 * ~90 MB model is freed by terminating it when a laptop run ends, without
 * touching the first ear. Loaded only from the Deep listen switch. */
const { code: maestCode } = bundleModules(['core/audio/maest.mjs'], { namespace: { BetterfyMaest: 'core/audio/maest.mjs' } });
const MAEST_WORKER = `/* Generated by build-web.mjs — do not edit here. */
${maestCode}
let ort = null, ear = null;
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
      ear = await BetterfyMaest.createMaestEar({ ort, modelUrl: m.modelUrl,
        sessionOptions: { executionProviders: ['wasm'], graphOptimizationLevel: 'all' } });
      result = {};
    } else if (m.op === 'maest') {
      const out = await ear.run(m.data, m.patches);
      result = out; transfer = [out.activations.buffer, out.embedding.buffer];
    } else {
      throw new Error('unknown MAEST op: ' + m.op);
    }
    self.postMessage({ id: m.id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: (err && err.message) || String(err) });
  }
};
`;

/* Every name the ontology knows a genre by, baked into the page so classify()
 * can tell a genre playlist ("Donk", "D&B Rollers", "Tech House") from one that
 * only happens to have no other signal in its name. ~4 KB. Built by
 * core/playlists/genre-words.mjs, which axes.mjs reads too, so the CLI and the
 * page share one vocabulary. */
const GENRE_WORDS = genreWords();

/* The worker that builds the reports off the main thread (docs/archive/BUILD-6-PLAN.md D4).
 *
 * buildReports() is the one heavy piece of the page's own code: scoring every
 * liked track against every playlist took 1.4s of main thread on a 5k-liked
 * library (scripts/perf.mjs). It reads only the scoring core and a few page
 * globals, so the worker is: the same core bundle, stand-ins for those globals
 * (filled from each request), and web/app/reports.js verbatim up to its
 * page-side marker — the same source, never a second copy to keep in step. */
const REPORTS_SRC = readFileSync('web/app/reports.js', 'utf8');
const REPORTS_CUT = REPORTS_SRC.indexOf('/* ---------- reports, off the main thread (page side)');
if (REPORTS_CUT < 0) throw new Error('web/app/reports.js lost its page-side marker; the reports worker cannot be cut from it.');
const MMSS = readFileSync('web/app/storage.js', 'utf8').match(/^const mmss = .*$/m)?.[0];
if (!MMSS) throw new Error('web/app/storage.js no longer declares mmss on one line; the reports worker needs it.');
const { code: reportsCore } = bundleModules([...V1_MODULES, ...FILE_MODULES], { expose: [...V1_MODULES, ...FILE_MODULES] });
const REPORTS_WORKER = `/* Generated by build-web.mjs — do not edit here. */
${reportsCore}
/* Stand-ins for the page globals reports.js reads; every request refills them. */
var FB = {}, ENG, LISTENING_CACHE, ALL_SONGS_NAME = '', PINNED = null;
var LS = { getItem: function () { return PINNED; } };
${MMSS}
${REPORTS_SRC.slice(0, REPORTS_CUT)}
self.onmessage = function (e) {
  var m = e.data || {};
  try {
    FB = m.fb || {}; PINNED = m.pinned || null; ALL_SONGS_NAME = m.allSongsName || '';
    LISTENING_CACHE = m.listening || undefined; ENG = { shadow: m.shadow || null };
    var t0 = performance.now();
    var result = buildReports(m.lib, m.cfg, m.tags);
    self.postMessage({ id: m.id, ok: true, result: result, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: (err && err.message) || String(err) });
  }
};
`;

/* The service worker (BUILD-6 F6): web/sw.js with this build's stamp, so its
 * cache is named after the build the page and workers carry. */
const SW = readFileSync('web/sw.js', 'utf8').replaceAll('__BUILD__', BUILD);

/* The page's own script lives in web/app/ and web/screens/ (docs/archive/BUILD-5-PLAN.md
 * A1), listed in load order in web/manifest.mjs, and goes back in where the
 * template says __APP__ before any other placeholder is filled. */
const html = assembledTemplate()
  // A function, not a string: CSS is free to contain `$&` and friends.
  .replace('__STYLES__', () => STYLES)
  .replace("'__GENRE_WORDS__'", JSON.stringify(GENRE_WORDS))
  .replace('__CORE__', core)
  .replace('__CLIENT_ID__', CLIENT_ID)
  .replace('__TAGS_PROJECT__', TAGS_PROJECT)
  .replace('__TAGS_KEY__', TAGS_KEY)
  .replace('__LASTFM_PUBLIC_KEY__', LASTFM_PUBLIC_KEY)
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
  'TAGS_PROJECT', 'TAGS_KEY', 'LASTFM_PUBLIC_KEY', 'CONTACT_EMAIL', 'APPCHECK_SITE_KEY', 'APPCHECK_APP_ID']);

/** @returns {string|null} the name of the first .env value found in `out`. */
function leakedSecret(out) {
  let env;
  try { env = readFileSync('.env', 'utf8'); } catch { return null; }
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    const [, name, value] = m;
    if (PUBLIC_BY_DESIGN.has(name)) continue;
    // The owner may reuse the same key as the shipped public one.
    if (name === 'LASTFM_API_KEY' && LASTFM_PUBLIC_KEY && value === LASTFM_PUBLIC_KEY) continue;
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
                           ['docs/engine-worker.js', WORKER], ['docs/reports-worker.js', REPORTS_WORKER], ['docs/audio.js', audio],
                           ['docs/audio-worker.js', AUDIO_WORKER], ['docs/maest-worker.js', MAEST_WORKER], ['docs/sw.js', SW]]) {
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
writeFileSync('docs/reports-worker.js', REPORTS_WORKER);
writeFileSync('docs/audio.js', audio);
writeFileSync('docs/audio-worker.js', AUDIO_WORKER);
writeFileSync('docs/maest-worker.js', MAEST_WORKER);
writeFileSync('docs/sw.js', SW);
console.log(`docs/audio.js   — ${(audio.length / 1024).toFixed(0)} KB, `
  + `${audioFiles.length} modules, fetched only when listening is switched on`);
console.log(`docs/engine.js  — ${(engine.length / 1024).toFixed(0)} KB, `
  + `${engineFiles.length} modules, fetched only when the Engine screen is opened`);
console.log(`docs/index.html — ${(html.length / 1024).toFixed(0)} KB, ${bundled.length} modules bundled`
  + `, client id ${CLIENT_ID ? 'embedded' : 'MISSING'}`
  + `, shared tags ${TAGS_PROJECT && TAGS_KEY ? `→ ${TAGS_PROJECT}` : 'off'}`
  + `, request-access link ${CONTACT_EMAIL ? `→ ${CONTACT_EMAIL}` : 'off'}`
  + `, App Check ${APPCHECK_SITE_KEY && APPCHECK_APP_ID ? 'on' : 'off'}`);
