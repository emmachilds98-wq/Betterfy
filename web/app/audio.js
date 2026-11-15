/* ===========================================================================
 * "Listen to my music" (docs/AUDIO-BUILD-PLAN.md WP-B2)
 *
 * On by default (switching it off is saved and wins), and it costs nothing
 * before listening starts: docs/audio.js (~120 KB) is fetched on first use, the
 * models (~22 MB, self-hosted under models/) and onnxruntime-web's WASM
 * (~15 MB, jsDelivr) only when listening actually starts, and only on Wi-Fi
 * unless told otherwise. Each track is looked up on Deezer by its ISRC, two
 * ~10 s windows of the 30 s preview are downloaded and decoded, heard by the
 * model in a Worker, and reduced to a ~2.5 KB record in IndexedDB. The audio
 * itself is never kept.
 *
 * Nothing here changes a suggestion: the records are what the engine's audio
 * component and the learner read, and WP-E2's gate decides when that counts.
 * ======================================================================== */
const ORT_BASE = '__ORT_BASE__', AUDIO_MODELS = '__AUDIO_MODELS__';
const AUDIO_MODEL_FILE = 'discogs-effnet-bsdynamic-1.onnx';
// The heads this build hosts. approachability/engagement are not shipped.
const AUDIO_HEAD_FILES = { mtg_jamendo_moodtheme: 'mtg_jamendo_moodtheme-discogs-effnet-1.onnx',
  voice_instrumental: 'voice_instrumental-discogs-effnet-1.onnx', danceability: 'danceability-discogs-effnet-1.onnx' };

const AUDIO = { ctrl: null, store: null, vm: null, records: null, labels: null, wifiOk: false, err: null, worker: null, wear: null,
                maest: null, maestVm: null };

let AUDIO_JS = null;
function audioLoad() {
  return AUDIO_JS ??= new Promise((ok, bad) => {
    if (globalThis.BetterfyAudio) return ok(true);
    const s = document.createElement('script');
    s.src = 'audio.js?v=__BUILD__';
    s.onload = () => globalThis.BetterfyAudio ? ok(true) : bad(new Error('audio.js loaded but defined nothing'));
    s.onerror = () => bad(new Error('could not fetch audio.js'));
    document.head.appendChild(s);
  }).catch(e => { AUDIO_JS = null; throw e; });
}

/** The saved settings; readable before audio.js has loaded, with the same defaults. */
function audioSettings() {
  if (globalThis.BetterfyAudio) return BetterfyAudio.readAudioSettings(LS);
  let s = null; try { s = JSON.parse(LS.getItem('bf_audio') || 'null'); } catch { s = null; }
  return { on: s?.on !== false, wifiOnly: s?.wifiOnly !== false, scope: s?.scope === 'all' ? 'all' : 'playing+unfiled' };
}

const audioModelUrl = f => new URL(AUDIO_MODELS + f, location.href).href;

/** "Deep listen (laptop)" settings (web/audio/deep-settings.mjs), readable before audio.js has loaded. */
function deepSettings() {
  if (globalThis.BetterfyAudio?.readDeepSettings) return BetterfyAudio.readDeepSettings(LS);
  let s = null; try { s = JSON.parse(LS.getItem('bf_audio_deep') || 'null'); } catch { s = null; }
  return { maest: s?.maest === true, clap: s?.clap === true, memoryOverride: s?.memoryOverride === true };
}
/** May this deep ear run now? 'off' until audio.js has loaded. */
function deepAllowed(ear) {
  if (!globalThis.BetterfyAudio?.deepListenAllowed) return 'off';
  return BetterfyAudio.deepListenAllowed(ear, { settings: deepSettings(), connection: navigator.connection,
    deviceMemory: navigator.deviceMemory, confirmed: AUDIO.wifiOk });
}

/** The models, loaded once into one Worker and shared by everything that
 *  listens (the library queue, and Discover's picks). Null again on failure,
 *  so a retry actually retries. */
let AUDIO_EARS = null;
function audioEars() {
  return AUDIO_EARS ??= (async () => {
    const A = BetterfyAudio;
    AUDIO.worker = new Worker('audio-worker.js?v=__BUILD__', { type: 'module' });
    const w = A.createWorkerEar(AUDIO.worker, { modelUrl: audioModelUrl(AUDIO_MODEL_FILE), ortBase: ORT_BASE,
      headUrls: Object.fromEntries(Object.entries(AUDIO_HEAD_FILES).map(([k, f]) => [k, audioModelUrl(f)])) });
    AUDIO.wear = w; // CLAP (WP-C2) loads into this same Worker
    const r = await w.ready;
    return { ear: w.ear, heads: r?.heads?.length ? w.heads : undefined, summariseHeads: A.summariseHeads };
  })().catch(e => { AUDIO_EARS = null; throw e; });
}

/** Load the bundle, open the store, build the controller. Once. */
async function audioInit() {
  if (AUDIO.ctrl) return AUDIO.ctrl;
  await audioLoad();
  const A = BetterfyAudio;
  AUDIO.store = A.openAudioStore();
  AUDIO.ctrl = A.createAudioController({
    store: AUDIO.store,
    lookup: (isrc, o) => A.lookup(isrc, { jsonp: deezerJsonp, ...o }),
    fetchPreview: url => A.fetchPreview(url, { fetch: (u, init) => fetch(u, init) }),
    decode: buf => A.decodeTo16k(buf),
    loadEar: audioEars,
    // CLAP (WP-C2): only while "Search by description" is ticked and Wi-Fi allows it.
    // Its encoder (~77 MB) loads in the same Worker on the first such run.
    clapOn: () => deepAllowed('clap') === 'ok',
    loadClap: async () => {
      await audioEars();
      const c = await AUDIO.wear.loadClap(audioModelUrl(A.CLAP_MODEL_FILE));
      return { decode: buf => A.decodeTo48k(buf), embed: c.embed };
    },
    onChange: vm => { AUDIO.vm = vm; audioRedraw(); audioMidRun(vm); },
  });
  await audioRefresh();
  // The style names, for ProfileVM. Optional: a playlist row without them still says how much was heard.
  fetch(audioModelUrl('discogs-effnet-bsdynamic-1.json')).then(r => r.ok ? r.json() : null)
    .then(j => { AUDIO.labels = j?.classes ?? null; }).catch(() => {});
  return AUDIO.ctrl;
}

/* While listening runs, re-read the heard records every so often (not only at
 * the start and end of a run), so the File card can name and file newly heard
 * tracks, and Tidy can judge them, without waiting for the run to finish.
 * refresh() itself emits a change, hence the flag. */
const AUDIO_MIDRUN = { every: 25, minMs: 30000 };
let AUDIO_MIDRUN_AT = { heard: 0, t: 0, busy: false };
function audioMidRun(vm) {
  if (vm?.state !== 'running' || AUDIO_MIDRUN_AT.busy) return;
  const now = Date.now();
  if ((vm.heard ?? 0) - AUDIO_MIDRUN_AT.heard < AUDIO_MIDRUN.every || now - AUDIO_MIDRUN_AT.t < AUDIO_MIDRUN.minMs) return;
  AUDIO_MIDRUN_AT = { heard: vm.heard ?? 0, t: now, busy: true };
  fire((async () => {
    try { await audioRefresh(); } finally { AUDIO_MIDRUN_AT.busy = false; }
    // The File card picks new tracks up through soundHear; a rebuild is due only once enough more was heard.
    if (view === 'inbox') soundWarm();
    store.touch('audio');
  })());
}

async function audioRefresh() {
  if (!AUDIO.ctrl) return;
  AUDIO.records = await AUDIO.ctrl.refresh();
  LABELCHECKS ??= (await idb.get(BetterfyAudio.CHECKS_KEY)) ?? {};
}

/* ---------- mood, voice and energy: shown once checked ----------
 * web/audio/labels-view.mjs. The heads and D4's energy are in every record but
 * hidden; the "Check sound labels" card on Sources asks the listener to mark
 * 30 of them right or wrong, and a label type shows only once 70% of at least
 * 20 are right. Verdicts are this account's only (keyed by Spotify user id).
 * With no records nothing here draws anything. */
let LABELCHECKS = null;
const LABELS = { seed: 1, sample: null };
const labelUser = () => LIB?.user?.id ?? null;
const labelChecks = () => globalThis.BetterfyAudio && LABELCHECKS ? BetterfyAudio.checksFor(LABELCHECKS, labelUser()) : {};
const labelsShownNow = () => globalThis.BetterfyAudio?.labelsShown ? BetterfyAudio.labelsShown(labelChecks(), LS) : null;
function labelCheckHTML() {
  if (!AUDIO.records?.size || !globalThis.BetterfyAudio?.reviewHTML || !labelUser()) return '';
  const A = BetterfyAudio, checks = labelChecks();
  LABELS.sample ??= A.reviewSample(LIB, AUDIO.records, { seed: LABELS.seed, checks, skip: p => isMirrorPlaylist(p) });
  const html = A.reviewHTML(A.reviewVM(LABELS.sample, AUDIO.records, checks));
  return html ? `<section class="srccard srclabels" id="src-labels" aria-labelledby="src-labels-h">${html}</section>` : '';
}
const labelCheckRedraw = () => { const el = document.getElementById('src-labels'); if (el) el.outerHTML = labelCheckHTML(); };
async function labelVerdict(btn) {
  const A = BetterfyAudio, id = btn.dataset.lchk, type = btn.dataset.lt, ok = btn.dataset.lok === '1', me = labelUser();
  const reading = A.readingsOf(AUDIO.records?.get(id))[type];
  const again = A.checksFor(LABELCHECKS, me)[id]?.[type] === ok;   // tapping the chosen answer again clears it
  LABELCHECKS = A.withVerdict(LABELCHECKS, me, id, type, again ? null : ok, reading == null ? null : A.seenOf(type, reading));
  await idb.set(A.CHECKS_KEY, LABELCHECKS);
  labelCheckRedraw();
}

/** The heard tracks for the engine (WP-E2 reads them as `audio`), as an array of
 *  records, or null. Null costs nothing: a listener who never switched listening
 *  on never fetches audio.js for the Engine screen's sake. */
async function engineAudio() {
  if (!audioSettings().on && !AUDIO.records) return null;
  try { await audioInit(); await audioRefresh(); } catch { return null; }
  const recs = [...(AUDIO.records?.values() ?? [])].filter(r => !r.miss);
  return recs.length ? recs : null;
}
/** The records as the engine takes them, plus what you told it (WP-L2): a
 *  rejection teaches the sound learner "not there", and the Score run drops the
 *  verdicts on whichever tracks it is holding out. The learner is always the
 *  prototype one (BUILD-5-PLAN §2.3, option b): each playlist's sound is the
 *  average of your own heard tracks in it, and nothing is fitted to playlist
 *  membership — the logistic model stays for offline measurement only. The
 *  worker holds itself to the same (build-web.mjs). */
const ENGINE_LEARN_MODEL = 'prototype';
const engineAudioBase = audio => (audio ? { records: audio, model: ENGINE_LEARN_MODEL, ...(Object.keys(FB).length ? { feedback: FB } : {}) } : audio);
/** WP-C1: the second ear places only once a Score run chose it (engineEar). */
const engineAudioIn = audio => {
  const base = engineAudioBase(audio);
  const ear = audio ? engineEar(audio) : 'effnet';
  return ear === 'effnet' ? base : { ...base, ear };
};
/** Which ear places tracks: the first, unless a Score run chose a second ear. */
const engineEar = audio => (globalThis.BetterfyAudio?.chosenEar ? BetterfyAudio.chosenEar(ENG.calib?.soundChoice ?? null, audio) : 'effnet');
/** For the Score run: as the engine takes them, first ear always, plus the second-ear arms when some records have one. */
const engineAudioScore = audio => {
  const base = engineAudioBase(audio);
  const arms = audio && globalThis.BetterfyAudio?.scoreArms ? BetterfyAudio.scoreArms(audio) : null;
  return arms ? { ...base, arms } : base;
};
/** Audio changes a suggestion only once WP-E2's gate has passed on this library. */
const engineAudioGate = () => (ENG.calib?.audioGate ?? ENG.val?.mine?.withAudio?.gate ?? null);

