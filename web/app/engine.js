/* ======================= the account-native engine =======================
 * One screen, and the only place in the app that reads `core/intrinsic/`. The
 * engine learns what this account's playlists mean from the account itself — who
 * you file together, which label, what shape of record, what era — with no key,
 * no second website and no genre list written by somebody else.
 *
 * It is a shadow, by the owner's explicit choice: nothing here writes to Spotify,
 * and the File screen only takes picks from it (blended with the tag engine,
 * app/blend.js) once this account's own Score run shows the blend ahead. The
 * point is to be able to judge it before it is allowed near anybody's library.
 * See docs/THINKING-ENGINE-PLAN.md, phases 5 and 6, and
 * docs/SMARTER-GENRES-PLAN.md phase 1.
 * ======================================================================== */

/** Fetched on first use, so a listener who never opens this screen never pays
 *  the ~145 KB for it. Null again on failure, so a retry actually retries. */
let ENGINE_JS = null;
function engineLoad() {
  return ENGINE_JS ??= new Promise((ok, bad) => {
    if (globalThis.BetterfyIntrinsic) return ok(true);
    const s = document.createElement('script');
    s.src = 'engine.js?v=__BUILD__';
    s.onload = () => globalThis.BetterfyIntrinsic ? ok(true)
      : bad(new Error('engine.js loaded but defined nothing'));
    s.onerror = () => { ENGINE_JS = null; bad(new Error('could not fetch engine.js')); };
    document.head.appendChild(s);
  }).catch(e => { ENGINE_JS = null; throw e; });
}

const ENG = { status:'idle', err:null, space:null, rung:null, shadow:null,
              pairs:null, val:null, valRunning:false, valStage:null, bridgeProgress:null, calib:null, ms:0, from:null };

/* The engine runs in a worker when it can, so learning and scoring a big library
 * leave the page usable instead of freezing it for seconds at a time (measured:
 * 6.2s for scoring a 250-playlist library on a desktop CPU, several times that on
 * a phone). `false` means a worker is not available here, and everything falls
 * back to the main thread exactly as before — slower to sit through, same answer. */
let ENGINE_WORKER = null, ENGINE_SEQ = 0;
const ENGINE_WAIT = new Map();
function engineWorker() {
  if (ENGINE_WORKER !== null) return ENGINE_WORKER;
  try {
    if (typeof Worker !== 'function') return ENGINE_WORKER = false;
    const w = new Worker('engine-worker.js?v=__BUILD__');
    w.onmessage = e => {
      const wait = ENGINE_WAIT.get(e.data?.id);
      if (!wait) return;
      ENGINE_WAIT.delete(e.data.id);
      e.data.ok ? wait.ok(e.data) : wait.bad(new Error(e.data.error));
    };
    // A worker that cannot start (offline, a blocked script) fails here rather
    // than per message. Give up on it for the session and let callers fall back.
    w.onerror = ev => {
      ev?.preventDefault?.();
      for (const wait of ENGINE_WAIT.values()) wait.bad(new Error(ev?.message || 'the engine worker stopped'));
      ENGINE_WAIT.clear();
      ENGINE_WORKER = false;
      try { w.terminate(); } catch {}
    };
    return ENGINE_WORKER = w;
  } catch { return ENGINE_WORKER = false; }
}
/** The playlists both engines may file into: the ones taking suggestions on the
 *  Playlists screen. Sorted, so it can be compared with a cached space's. */
const engineTargets = () => Object.entries(CFG ?? {}).filter(([, v]) => v.target).map(([id]) => id).sort();

/** Run one engine op in the worker. Null when there is no worker to run it in. */
function inEngineWorker(op, payload) {
  const w = engineWorker();
  if (!w) return null;
  return new Promise((ok, bad) => {
    const id = ++ENGINE_SEQ;
    ENGINE_WAIT.set(id, { ok, bad });
    w.postMessage({ id, op, mirrorIds: LIB.playlists.filter(isMirrorPlaylist).map(p => p.id),
                    targets: engineTargets(), ...payload });
  });
}

/** How many waiting tracks the comparison covers: a screenful of evidence,
 *  not a report nobody reads. */
const SHADOW_N = 40;
/** And how many filed tracks the score covers. The cost is k rebuilds of the
 *  whole space, so this is the dial between seconds and minutes. */
const VALIDATE_N = 600;

/** Let the browser paint before something long and synchronous.
 *  Not `paint`: `bindSwipeCard` has a local of that name meaning something
 *  entirely different, and one shadowing the other would be a trap. */
const yieldToPaint = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

// -g: built with the genre-only artist graph (sound-first filing), so a space
// cached before that, whose graph counted mood and event playlists, is not reused.
const SPACE_KEY = 'engine-space-g';

/**
 * Revive the learned space, or build it.
 *
 * Building costs one to four seconds on a real library and blocks the main
 * thread while it does — measured, in the plan's §12. So it happens once, behind
 * a tap somebody chose to make, and the result is kept. `reviveSpace` returns
 * null whenever the cache was written by a different engine version or by a
 * library that has since changed, which is the only reason it is safe to trust.
 */
async function engineSpace() {
  const t0 = performance.now();
  let space = null, from = 'built', pairs, onPage = false;
  const targets = engineTargets();
  const audio = await engineAudio();
  try {
    const cached = await idb.get(SPACE_KEY);
    if (cached) space = BetterfyPersist.reviveSpace(cached, LIB);
    // Built for a different set of genre playlists: right library, wrong question.
    if (space && JSON.stringify(space.targets ?? null) !== JSON.stringify(targets)) space = null;
    // Or before more tracks were heard.
    if (space && (cached.audioN ?? 0) !== (audio?.length ?? 0)) space = null;
    if (space) { from = 'cache'; pairs = cached.pairs; }
  } catch { /* a cache that cannot be read is the same situation as no cache */ }

  if (!space) {
    // Built in the worker and posted back serialised — the same object the
    // cache keeps — so the page only pays for reviving it, not building it.
    let json = null;
    try { json = (await inEngineWorker('build', { lib: LIB, audio, genreGraph: true }))?.result ?? null; }
    catch { json = null; }
    space = json ? BetterfyPersist.reviveSpace(json, LIB) : null;
    if (space) { ENG.where = 'worker'; pairs = json.pairs; }
    else {
      ENG.where = 'page'; onPage = true;
      await yieldToPaint();
      space = BetterfyIntrinsic.buildSpace(LIB, { isMirror: isMirrorPlaylist, targets, audio: engineAudioIn(audio),
                                                  genreGraph: true });
      json = null;
    }
    try { await idb.set(SPACE_KEY, { ...(json ?? BetterfyPersist.serialiseSpace(space, LIB)), audioN: audio?.length ?? 0 }); }
    catch { /* nowhere to remember it is not a reason to refuse to use it */ }
  }
  // A revived space (from the cache, or posted back by the worker) comes back
  // without its sound layer, because persist does not keep it. WP-E2's
  // withAudioLayer() puts it back from the same records (1-3 s with the learner).
  // Guarded, because it exists only once that package has landed.
  if (space && audio && !onPage && typeof BetterfyIntrinsic.withAudioLayer === 'function') {
    try { space = BetterfyIntrinsic.withAudioLayer(space, engineAudioIn(audio)); } catch { /* tags-only space: same as before audio */ }
  }
  // `pairs` is undefined when nothing worked it out yet, which tells the caller
  // to; null is a real answer ("it failed"), and is not asked again.
  return { space, from, pairs, ms: Math.round(performance.now() - t0) };
}

/* ---------- how sure it may sound: docs/SMARTER-GENRES-PLAN.md, phase 2 ----------
 * Fitted on the score run's held-out placements (core/intrinsic/calibrate.mjs)
 * and kept for this library and these genre playlists, so the comparison below
 * can say "confident", "probably", "pick one" or "not sure" with a checked
 * meaning instead of a raw percentage. A changed library or a changed set of
 * genre playlists is a different question, so the old answer is not reused. */
const CAL_KEY = 'engine-calibration';
// /sf: fitted on the sound-first engine; one fitted before it described a different engine.
const calStamp = () => `${BetterfyCalibrate.CALIBRATE_VERSION}/${BetterfyPersist.ENGINE_STAMP}/sf`;

async function engineLoadCalibration() {
  if (ENG.calib) return;
  try {
    const c = await idb.get(CAL_KEY);
    if (c && c.stamp === calStamp() && c.fingerprint === BetterfyPersist.fingerprint(LIB)
        && JSON.stringify(c.targets) === JSON.stringify(engineTargets()))
      ENG.calib = { base: c.base, bridge: c.bridge ?? null, audio: c.audio ?? null, audioGate: c.audioGate ?? null,
                   at: c.at ?? null };
  } catch { /* nothing remembered: the comparison shows raw scores, as before */ }
}

/** Fit from a score run's rows, keep it, and drop the rows: they are only for this. */
async function engineCalibrate(v) {
  const mine = v?.mine;
  if (!mine?.rows) return;
  await engineLoad();
  const base = BetterfyCalibrate.calibrationReport(mine.rows);
  const bridge = mine.withBridge?.rows ? BetterfyCalibrate.calibrationReport(mine.withBridge.rows) : null;
  const audio = mine.withAudio?.rows ? BetterfyCalibrate.calibrationReport(mine.withAudio.rows) : null;
  // The audio gate's verdict, kept with the calibration so it survives a reload.
  const audioGate = mine.withAudio?.gate ?? null;
  delete mine.rows;
  if (mine.withBridge) delete mine.withBridge.rows;
  if (mine.withAudio) delete mine.withAudio.rows;
  ENG.calib = { base, bridge, audio, audioGate, at: Date.now() };
  try {
    await idb.set(CAL_KEY, { stamp: calStamp(), fingerprint: BetterfyPersist.fingerprint(LIB),
                             targets: engineTargets(), base, bridge, audio, audioGate, at: ENG.calib.at });
  } catch { /* not remembered: it still applies until the page is closed */ }
  engineDecorate();
}

/** Put a checked answer on each track in the comparison, once there is a calibration. */
function engineDecorate() {
  const sh = ENG.shadow, space = ENG.space, cal = ENG.calib?.base?.cal;
  // A heard track is placed sound-first, so it is judged by the calibration fitted
  // on the sound-first engine's held-out rows (the Score run's "with sound").
  const soundCal = ENG.calib?.audio?.cal ?? cal;
  if (!sh || !space) return;
  const likedById = new Map((LIB.liked ?? []).map(t => [t.id, t]));
  const count = { confident: 0, choose: 0, unsure: 0 };
  for (const row of sh.rows) {
    row.decision = null;
    const raw = cal && likedById.get(row.id);
    if (!raw) continue;
    const full = BetterfyIntrinsic.placements(raw, space, { limit: Infinity, soundFirst: true });
    const p = full.results?.[0]?.parts ?? {};
    const d = BetterfyCalibrate.decide(BetterfyCalibrate.scoresOf(full.results ?? []),
                                       'audio' in p || 'learned' in p ? soundCal : cal);
    row.decision = { kind: d.kind,
                     playlists: d.playlists.map(id => ({ id, name: space.destinations.get(id)?.name ?? id })) };
    count[d.kind]++;
  }
  sh.decided = cal ? count : null;
}

/** Learn the account, then show what this engine would do with the same tracks
 *  the File screen is currently offering the tag engine's answer for. */
const engineAnalyse = guard(async () => {
  ENG.status = 'working'; ENG.err = null; render();
  try {
    await engineLoad();
    const { space, from, ms, pairs } = await engineSpace();
    Object.assign(ENG, { space, from, ms });
    soundAdopt(space);
    ENG.rung = BetterfyColdStart.rungOf(LIB, space);

    const likedById = new Map((LIB.liked ?? []).map(t => [t.id, t]));
    const rows = [];
    for (const b of R.backlog.slice(0, SHADOW_N)) {
      const raw = likedById.get(b.id);
      if (!raw) continue;
      // Sound-first, as the File screen files: a heard track by its sound.
      const out = BetterfyIntrinsic.placements(raw, space, { why: true, limit: 3, soundFirst: true });
      const mine = out.results?.[0] ?? null;
      const theirs = b.suggest?.[0] ?? null;
      rows.push({ id: b.id, title: b.title, artist: b.artist,
        theirs: theirs ? { id: theirs.id, name: theirs.name } : null,
        mine: mine ? { id: mine.playlistId, name: mine.name, score: mine.score } : null,
        band: out.band ?? null, declined: !!out.declined, why: mine?.why ?? null,
        // Whether anything it said is about *this record* rather than about its
        // shape. A track by an artist the account has never filed still places,
        // on duration and release type and era alone — and that is a far weaker
        // claim than the confidence band on its own suggests, because generic
        // shape fits a generic bucket comfortably. The strong mark is the engine's
        // own flag for evidence that names something, so its absence is the test.
        shapeOnly: !!mine && !(mine.why ?? []).some(w => w.mark === BetterfyExplain.MARKS.strong) });
    }
    const judged = rows.filter(r => r.theirs && r.mine);
    ENG.shadow = { rows, judged: judged.length,
      agree: judged.filter(r => r.theirs.id === r.mine.id).length,
      onlyMine: rows.filter(r => r.mine && !r.theirs).length,
      onlyTheirs: rows.filter(r => r.theirs && !r.mine).length,
      shapeOnly: rows.filter(r => r.shapeOnly).length };
    await engineLoadCalibration();
    engineDecorate();

    if (pairs !== undefined) ENG.pairs = pairs;
    else {
      try { ENG.pairs = (BetterfyReports.bucketPairs(space) ?? []).slice(0, 6); }
      catch { ENG.pairs = null; }
    }

    ENG.status = 'ready';
  } catch (e) {
    ENG.status = 'error'; ENG.err = e?.message ?? String(e);
  }
  render();
});

/* ---------- the neighbour bridge: docs/SMARTER-GENRES-PLAN.md, phase 0 ----------
 * "Where did you file artists like this one?" Deezer's "fans also like" and
 * ListenBrainz's listening-session neighbours, reached through the ISRC and
 * Wikidata so nobody is matched by name. They only ever say who sits near whom;
 * the vote goes to this account's own playlists. Phase 0 only measures it: the
 * score shows each engine with and without it, and nothing else uses it yet. */
const BRIDGE_KEY = 'bridge-raw';
const bridgeOn = () => LS.getItem('bf_bridge_off') !== '1';

/* Deezer sends no CORS header, so the one way a page can read it is a <script>
 * tag (JSONP). A script tag runs whatever comes back with the page's full
 * authority, Spotify sign-in included. So it runs inside a sandboxed frame
 * instead: scripts allowed, same-origin not. That gives the frame an opaque
 * origin with no reach into this page's storage, cookies or DOM, and its
 * answers come back by postMessage as plain data. Both sides pin the host. */
let DZ_FRAME = null, DZ_SEQ = 0;
const DZ_WAIT = new Map();
function deezerFrame() {
  return DZ_FRAME ??= new Promise((ok, bad) => {
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('aria-hidden', 'true');
    f.setAttribute('title', 'Deezer lookups');
    f.tabIndex = -1;
    f.style.cssText = 'position:absolute; width:0; height:0; border:0; visibility:hidden';
    f.srcdoc = `<!doctype html><meta charset="utf-8"><script>
      var host = /^https:\\/\\/api\\.deezer\\.com\\/[a-z0-9/:._-]+(\\?[a-z0-9=&_-]*)?$/i, n = 0;
      addEventListener('message', function (e) {
        var m = e.data || {};
        if (e.source !== parent || !host.test(m.url)) return;
        var cb = 'dz' + (++n), s = document.createElement('script'), done = false;
        function end(msg) {
          if (done) return; done = true; delete window[cb]; s.remove();
          parent.postMessage({ dz: m.id, ok: msg.ok, data: msg.data, timeout: !!msg.timeout }, '*');
        }
        window[cb] = function (data) { end({ ok: true, data: JSON.parse(JSON.stringify(data)) }); };
        s.onerror = function () { end({ ok: false }); };
        setTimeout(function () { end({ ok: false, timeout: true }); }, 15000);
        s.src = m.url + (m.url.indexOf('?') < 0 ? '?' : '&') + 'output=jsonp&callback=' + cb;
        document.head.appendChild(s);
      });
      parent.postMessage({ dzReady: true }, '*');
    <\/script>`;
    addEventListener('message', e => {
      if (e.source !== f.contentWindow) return;
      const d = e.data ?? {};
      if (d.dzReady) return ok(f);
      const wait = DZ_WAIT.get(d.dz);
      if (!wait) return;
      DZ_WAIT.delete(d.dz);
      d.ok ? wait.ok(d.data) : wait.bad(new Error(d.timeout ? 'Deezer did not answer in time' : 'Deezer could not be reached'));
    });
    setTimeout(() => bad(new Error('the Deezer lookup frame did not start')), 10000);
    document.body.appendChild(f);
  }).catch(e => { DZ_FRAME = null; throw e; });
}
async function deezerJsonp(url) {
  if (!BetterfyDeezer.isDeezerApiUrl(url)) throw new Error('not a Deezer API address');
  const f = await deezerFrame();
  return new Promise((ok, bad) => {
    const id = ++DZ_SEQ;
    DZ_WAIT.set(id, { ok, bad });
    f.contentWindow.postMessage({ id, url }, '*');
  });
}
/** Wikidata and ListenBrainz send CORS headers, so plain fetch works. */
async function corsJson(url, init) {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}

