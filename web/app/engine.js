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
  tuneLoad().catch(() => {});
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
                   ...(c.soundChoice ? { soundChoice: c.soundChoice } : {}), ...(c.family ? { family: c.family } : {}),
                   ...(c.mood ? { mood: c.mood } : {}), ...(c.pairs ? { pairs: c.pairs } : {}), at: c.at ?? null };
  } catch { /* nothing remembered: the comparison shows raw scores, as before */ }
}

/* ---------- family first, then sub-genre (docs/review/ENGINE-REVIEW.md layer 3) ----------
 * Each genre playlist's family from the genre its name names; how often the
 * family is right on held-out rows, and the family-level "confident" threshold,
 * fitted and checked the way the playlist level is. File commits to a family
 * only once this account's Score run says family top-1 reaches 85%. */
function engineFamilies() {
  return BetterfyFamily.playlistFamilies(engineTargets().map(id => [id, CFG[id]?.name ?? id]));
}
/* ---------- mood "also fits" chips (ENGINE-REVIEW layer 5) ----------
 * Each mood or context playlist with enough heard members gets a fits-or-not
 * threshold on its nearest members' sound, fitted on half its heard tracks and
 * checked on the other half (core/intrinsic/mood.mjs). Only the thresholds are
 * kept; the chips are scored live from the same index File already uses. */
function engineMoodIndex() {
  const sp = (typeof SOUND !== 'undefined' && SOUND.space) || ENG.space;
  return sp?.audio?.index ?? null;
}
function engineMoodFit() {
  const index = engineMoodIndex();
  if (!index?.size || typeof BetterfyMood === 'undefined') return null;
  const fit = BetterfyMood.fitMoods(LIB, index, id => CFG[id]?.axis ?? null);
  return fit.rows.length ? fit : null;
}

/* ---------- the playlists it confuses (docs/archive/NEXT-WORKPLAN.md package 5) ----------
 * A small sound check per confusable pair inside one family, fitted on half
 * the pair's heard members and checked on the other half (core/intrinsic/pairs.mjs).
 * Used only to order a card's top two picks, never to make a card Sure. */
let FAMS_MEMO = { key: null, map: null };
function engineFamiliesMemo() {
  const key = engineTargets().map(id => `${id}:${CFG[id]?.name ?? ''}`).join('|');
  if (FAMS_MEMO.key !== key) FAMS_MEMO = { key, map: engineFamilies() };
  return FAMS_MEMO.map;
}
function enginePairsFit(rows, extra = []) {
  const index = engineMoodIndex();
  if (!index?.size || !rows?.length || typeof BetterfyPairs === 'undefined' || typeof BetterfyFamily === 'undefined') return null;
  const fams = engineFamiliesMemo(), targets = new Set(engineTargets());
  const fit = BetterfyPairs.fitPairs(LIB, index, rows, ENG.pairs ?? [], {
    inScope: id => targets.has(id), extra,
    together: (a, b) => (fams.get(a) ?? `own:${a}`) === (fams.get(b) ?? `own:${b}`) });
  return fit.rows.length ? fit : null;
}

/* ---------- the playlists it understands least, and why (core/intrinsic/weak.mjs) ----------
 * Read off the held-out rows of the engine that places (not the engine alone,
 * which is what the old "Weakest" line measured), each with its likeliest
 * reason and the honest fix. Kept small in `bf_weak` for Library's advice and
 * for listening, which hears these playlists' tracks next. Nothing changes a
 * playlist: a merge is still the wizard, behind a tap. */
const WEAK_KEY = 'bf_weak';
function engineWeakList(rows) {
  if (!rows?.length || typeof BetterfyWeak === 'undefined') return null;
  const targets = new Set(engineTargets());
  return BetterfyWeak.weakPlaylists(rows, { inScope: id => targets.has(id) });
}
function engineWeakDiagnose(weak, pairs) {
  if (!weak || typeof BetterfyWeak === 'undefined') return null;
  const targets = new Set(engineTargets());
  return BetterfyWeak.diagnoseWeak(weak, { lib: LIB, index: engineMoodIndex(), pairs, families: engineFamiliesMemo(),
                                           inScope: id => targets.has(id) });
}
function engineWeakRemember(diag) {
  try { LS.setItem(WEAK_KEY, JSON.stringify({ ...BetterfyWeak.weakSummary(diag), targets: engineTargets() })); }
  catch { /* shown on the Engine screen this session only */ }
}
/** What the last Score run said about the weakest playlists, for Library and listening. Null before any. */
function weakSaved() {
  let w = null;
  try { w = JSON.parse(LS.getItem(WEAK_KEY) || 'null'); } catch { return null; }
  return Array.isArray(w?.rows) ? w : null;
}

function engineFamilyFit(rows) {
  if (!rows?.length || typeof BetterfyFamily === 'undefined') return null;
  const families = engineFamilies();
  const acc = BetterfyFamily.familyAccuracy(rows, families, { report: r => BetterfyCalibrate.calibrationReport(r) });
  if (!acc) return null;
  // Build 8 I1: in use when family top-1 clears its bar, or when the family's
  // confident calls do (familyGate says which, and why not).
  const gate = BetterfyFamily.familyGate(acc);
  const use = gate.use;
  const cal = BetterfyFamily.fitFamilyCalibration(acc.rows);
  const summary = { n: acc.n, family: acc.family, within: acc.within, flat: acc.flat, families: acc.families,
                    sure: acc.sure?.checked ?? null, holds: acc.sure?.holds ?? null, use, by: gate.by, why: gate.why };
  return { summary, keep: { use, cal, family: acc.family, families: acc.families } };
}

/** Fit from a score run's rows, keep it, and drop the rows: they are only for this. */
async function engineCalibrate(v) {
  const mine = v?.mine;
  if (!mine?.rows) return;
  await engineLoad();
  // Where this run's fitted weights are the ones placement now uses
  // (weightsRemember), "how sure" is fitted on the engine they make: each
  // track's held-out ranking under its own fold's weights. Otherwise the
  // default-weight rows, exactly as before.
  const wf = v.weights;
  const baseRows = wf?.plain?.use && wf.plain.rows ? wf.plain.rows : mine.rows;
  const bridgeRows = wf?.bridge?.use && wf.bridge.rows ? wf.bridge.rows : mine.withBridge?.rows;
  if (wf?.plain) delete wf.plain.rows;
  if (wf?.bridge) delete wf.bridge.rows;
  // Package 4: each row's agreement level (core/intrinsic/agree.mjs) from the
  // sources of the run that ranked it, plus the tag engine's own top picks,
  // so "confident" can be fitted per level. Without the module: as before.
  const agreeOn = typeof BetterfyAgree !== 'undefined';
  const tagTops = v.tagTops ?? null;
  // Read with only the sources the File card will have: similar artists count
  // only once the File space carries them (package 2), and tags only when loaded.
  const drop = [...(ENG.space?.bridge ? [] : ['similar']), ...(tagTops ? [] : ['tags'])];
  const withAgree = (rows, ...from) => agreeOn && rows
    ? BetterfyAgree.withAgreement(rows, BetterfyAgree.srcByIdOf(...from), tagTops, { drop }) : rows;
  const base = BetterfyCalibrate.calibrationReport(withAgree(baseRows, mine.rows));
  const bridge = bridgeRows ? BetterfyCalibrate.calibrationReport(withAgree(bridgeRows, mine.withBridge?.rows)) : null;
  // WP-C1: which ear this run chose. The first ear unless a second ear passed
  // the gate and beat it; its calibration then comes from that ear's rows.
  const choice = mine.withAudio?.choice ?? null;
  const near = choice?.ear === 'effnet' && mine.withAudio?.nearChoice?.use === true;
  const soundChoice = choice ? { ear: choice.ear, reason: choice.reason, gate: choice.gate ?? null, ...(near ? { near: true } : {}) } : null;
  // Calibrated on the engine that will place: the chosen ear, or the first ear with its nearest tracks.
  const soundRows = choice && choice.ear !== 'effnet' ? mine.withAudio.arms?.[choice.ear]?.rows
    : near ? mine.withAudio.arms?.near?.rows : mine.withAudio?.rows;
  const audio = soundRows ? BetterfyCalibrate.calibrationReport(withAgree(soundRows, soundRows)) : null;
  const agreeRep = audio?.agree ?? base?.agree ?? null;
  if (agreeOn && agreeRep) v.agreeLine = BetterfyAgree.agreeLine(audio?.agree ? audio : base);
  delete v.tagTops;
  // Family first (ENGINE-REVIEW layer 3), measured on the rows of the engine that places.
  const family = engineFamilyFit(soundRows ?? baseRows);
  if (family) v.family = family.summary;
  let mood = null;
  try { mood = engineMoodFit(); } catch { mood = null; }
  if (mood) v.moodLine = BetterfyMood.moodLine(mood);
  // The weakest playlists first, so each one's partner gets a pair check of its own.
  // Read off the rows of the engine that places: with sound, else with similar artists.
  const placeRows = soundRows ?? bridgeRows ?? baseRows;
  let weak = null;
  try { weak = engineWeakList(placeRows); } catch { weak = null; }
  // Build 8 A1: where the misses go, by playlist and by family. Display only.
  try {
    const targets = new Set(engineTargets());
    const conf = BetterfyFamily.familyConfusion(placeRows, engineFamiliesMemo(), { inScope: id => targets.has(id) });
    v.confusionLine = BetterfyFamily.confusionLine(conf, id => CFG[id]?.name ?? id);
  } catch { /* the line is left out */ }
  let pairs = null;
  try { pairs = enginePairsFit(soundRows ?? baseRows, weak ? BetterfyWeak.weakPairs(weak) : []); } catch { pairs = null; }
  if (pairs) v.pairsLine = BetterfyPairs.pairsLine(pairs, id => CFG[id]?.name ?? id);
  try {
    const diag = engineWeakDiagnose(weak, pairs);
    if (diag) {
      v.weak = diag;
      v.weakLine = BetterfyWeak.weakLine(diag, id => CFG[id]?.name ?? id);
      engineWeakRemember(diag);
    }
  } catch { /* the old list stays */ }
  // The audio gate's verdict, kept with the calibration so it survives a reload.
  const audioGate = mine.withAudio?.gate ?? null;
  delete mine.rows;
  if (mine.withBridge) delete mine.withBridge.rows;
  if (mine.withAudio) { delete mine.withAudio.rows; delete mine.withAudio.led; }
  for (const a of Object.values(mine.withAudio?.arms ?? {})) delete a.rows;
  ENG.calib = { base, bridge, audio, audioGate, ...(soundChoice ? { soundChoice } : {}), ...(family ? { family: family.keep } : {}),
                ...(mood ? { mood } : {}), ...(pairs ? { pairs } : {}), at: Date.now() };
  try {
    await idb.set(CAL_KEY, { stamp: calStamp(), fingerprint: BetterfyPersist.fingerprint(LIB),
                             targets: engineTargets(), base, bridge, audio, audioGate,
                             ...(soundChoice ? { soundChoice } : {}), ...(family ? { family: family.keep } : {}),
                             ...(mood ? { mood } : {}), ...(pairs ? { pairs } : {}), at: ENG.calib.at });
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
  let families = null;
  for (const row of sh.rows) {
    row.decision = null;
    const raw = cal && likedById.get(row.id);
    if (!raw) continue;
    const full = BetterfyIntrinsic.placements(raw, space, withFittedWeights({ limit: Infinity, soundFirst: true }, 'plain'));
    const p = full.results?.[0]?.parts ?? {};
    const scores = BetterfyCalibrate.scoresOf(full.results ?? []);
    const useCal = 'audio' in p || 'learned' in p ? soundCal : cal;
    // Package 4: how the sources line up behind the lead (sound, filing
    // history, similar artists, tags), read the way the Score run read it.
    const agree = useCal?.byLevel && typeof BetterfyAgree !== 'undefined'
      ? BetterfyAgree.agreement(scores[0]?.[0] ?? null,
          BetterfyAgree.sourceTops(full.results ?? [], { tags: engineTagScores(raw) })) : null;
    const dopts = agree ? { agree: agree.level } : {};
    // Family first, once this account's Score run earned it: commit to the
    // family and ask only which playlist inside it.
    const fam = ENG.calib?.family?.use ? ENG.calib.family : null;
    const dc = fam ? BetterfyFamily.decideCard(scores, useCal, fam.cal, families ??= engineFamilies(), dopts) : null;
    const d = dc ? { ...dc, kind: dc.kind === 'sure' ? 'confident' : dc.kind } : BetterfyCalibrate.decide(scores, useCal, dopts);
    row.decision = { kind: d.kind, ...(d.family ? { family: d.family } : {}),
                     ...(agree ? { agree: agree.agree, against: agree.against } : {}),
                     playlists: d.playlists.map(id => ({ id, name: space.destinations.get(id)?.name ?? id })) };
    count[d.kind] = (count[d.kind] ?? 0) + 1;
  }
  sh.decided = cal ? count : null;
}

/** The tag engine's ranking of one liked track, as [[playlistId, score]], for
 *  the agreement check. Empty when tags or the reports are not loaded. */
function engineTagScores(raw) {
  try {
    if (!raw || !R?.profiles || !TAGS || typeof rank !== 'function' || typeof blendTags !== 'function') return null;
    return rank(raw, blendTags(), R.profiles, R.idf, { top: Infinity }).map(b => [b.id, b.score]);
  } catch { return null; }
}

/** The comparison with the File screen's picks, for the tracks waiting first.
 *  Redone after a Score run, since that may have changed the weights. */
function engineShadow() {
  const space = ENG.space;
  if (!space) return;
  const likedById = new Map((LIB.liked ?? []).map(t => [t.id, t]));
  const rows = [];
  for (const b of R.backlog.slice(0, SHADOW_N)) {
    const raw = likedById.get(b.id);
    if (!raw) continue;
    // Sound-first, as the File screen files: a heard track by its sound.
    // With this account's fitted weights when its Score run earned them
    // (app/blend.js `withFittedWeights`); otherwise exactly as before.
    const out = BetterfyIntrinsic.placements(raw, space, withFittedWeights({ why: true, limit: 3, soundFirst: true }, 'plain'));
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
  engineDecorate();
}

/** Learn the account, then show what this engine would do with the same tracks
 *  the File screen is currently offering the tag engine's answer for. */
const engineAnalyse = guard(async () => {
  ENG.status = 'working'; ENG.err = null; store.touch('eng');
  try {
    await engineLoad();
    const { space, from, ms, pairs } = await engineSpace();
    Object.assign(ENG, { space, from, ms });
    soundAdopt(space);
    ENG.rung = BetterfyColdStart.rungOf(LIB, space);

    await weightsLoad();
    engineShadow();
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
  store.touch('eng');
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
  if (new URL(url).host === WD_HOST) return wikidataJson(url, init);
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}

/* Wikidata's query service rate-limits by IP (429). At startup the genre fill,
 * the similar-artist lookups and Settings' live check could all ask at once, and
 * a 429 dropped that batch, so on a phone it read "not answering" and knew 4% of
 * the artists. Every Wikidata request now goes through one queue, one at a time;
 * a 429 or 503 waits what Retry-After says (or 5 s, 15 s, 45 s) and retries; if it
 * still refuses, Wikidata rests for ten minutes and says so instead of hammering. */
const WD_HOST = 'query.wikidata.org';
const WD_RETRY_MS = [5000, 15000, 45000];
const WD_REST_MS = 10 * 60 * 1000;
const WD = { chain: Promise.resolve(), restUntil: 0 };
const wdSleep = ms => new Promise(r => setTimeout(r, ms));
function wikidataJson(url, init) {
  const run = WD.chain.then(async () => {
    if (Date.now() < WD.restUntil)
      throw new Error(`${WD_HOST} is busy; trying again in ${Math.ceil((WD.restUntil - Date.now()) / 60000)} min`);
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(url, init);
      if (r.ok) return r.json();
      if ((r.status !== 429 && r.status !== 503) || attempt >= WD_RETRY_MS.length) {
        if (r.status === 429 || r.status === 503) WD.restUntil = Date.now() + WD_REST_MS;
        throw new Error(`${WD_HOST} answered ${r.status}`);
      }
      const after = Number(r.headers?.get?.('Retry-After'));
      await wdSleep(Number.isFinite(after) && after > 0 ? Math.min(after, 120) * 1000 : WD_RETRY_MS[attempt]);
    }
  });
  WD.chain = run.catch(() => {});   // the next request waits for this one, success or not
  return run;
}

/* ---- the jobs behind the Engine screen (its view and actions are web/screens/engine.mjs) ---- */
function bridgeProgressText() {
  const p = ENG.bridgeProgress ?? {};
  const part = (label, x) => x ? `${label} ${Math.min(x.done, x.total).toLocaleString()} of ${x.total.toLocaleString()}` : null;
  const bits = [part('Wikidata', p.wikidata), part('Deezer', p.deezer), part('ListenBrainz', p.listenbrainz)].filter(Boolean);
  return `Looking up similar artists${bits.length ? ' — ' + bits.join(', ') : '…'}`;
}

/** Look up the neighbours of the artists about to be scored, remembering every
 *  answer on this device so the next run only asks about what is new or stale. */
async function engineBridge(tracks) {
  // Most-listened first (D9), so a run Deezer's quota cuts short has looked up what you play.
  const artists = new Map(await inEnrichOrder(BetterfyBridge.sourceArtists(tracks), ([, a]) => a.name));
  let cache = null;
  try { cache = (await idb.get(BRIDGE_KEY))?.raw ?? null; } catch { /* no cache: ask everything */ }
  let last = 0;
  const { raw, stats } = await BetterfyBridgeFetch.gatherBridge(artists, {
    deezer: deezerJsonp, json: corsJson, cache,
    onProgress: p => {
      ENG.bridgeProgress = { ...(ENG.bridgeProgress ?? {}), [p.stage]: p };
      const now = performance.now();
      if (now - last < 300) return;
      last = now;
      const el = document.getElementById('bridgeProgress');
      if (el) el.textContent = bridgeProgressText();
    },
  });
  try { await idb.set(BRIDGE_KEY, { at: Date.now(), raw }); }
  catch { /* nowhere to remember it costs the next run time, nothing else */ }
  return { bridge: BetterfyBridge.bridgeFrom(raw, LIB), stats };
}

/**
 * The gate, run here rather than on somebody's laptop.
 *
 * This is the number that decides whether this engine should ever take over, and
 * until now getting it meant exporting a `library.json` and running Node — which
 * is exactly the "works for one desktop, not for an account" shape CLAUDE.md
 * rules out. The browser already holds the library, so it can answer for itself.
 *
 * Both engines are scored over the same folds and the same capped track set. The
 * tag engine is only scored when there are tags to score it with: handing it an
 * empty table and reporting that it lost would be rigging the comparison.
 */
const engineValidate = guard(async () => {
  ENG.valRunning = true; ENG.val = null; ENG.valStage = null; store.touch('eng');
  try {
    const tags = TAGS && Object.keys(TAGS).length ? TAGS : null;
    const t0 = performance.now();

    // The neighbour bridge, for exactly the tracks about to be scored. Any
    // failure here costs the comparison, never the score: it carries on
    // without, and says so.
    let bridge = null, bridgeStats = null, bridgeErr = null;
    const useBridge = bridgeOn();
    if (useBridge) {
      ENG.valStage = 'bridge'; ENG.bridgeProgress = {}; store.touch('eng');
      try {
        await engineLoad();
        const tracks = BetterfyValidate.scoredTracks(LIB, { limit: VALIDATE_N, isMirror: isMirrorPlaylist,
                                                           targets: new Set(engineTargets()) });
        ({ bridge, stats: bridgeStats } = await engineBridge(tracks));
      } catch (e) { bridge = null; bridgeErr = e?.message ?? String(e); }
      ENG.valStage = 'score'; store.touch('eng');
    }
    const bridgeMs = useBridge ? Math.round(performance.now() - t0) : 0;
    const t1 = performance.now();

    // Heard tracks, so the score runs with and without sound on the same folds (WP-E2).
    const audio = await engineAudio();
    let done = null;
    // Scored the way the app files: the genre-only artist graph, and heard tracks
    // with sound leading (soundFirst), so the number is the engine you use.
    try { done = await inEngineWorker('validate', { lib: LIB, tags, bridge, audio: engineAudioScore(audio),
                                                    opts: { folds: 5, limit: VALIDATE_N, collect: true,
                                                            genreGraph: true, soundFirst: true, fitParts: true, sources: true } }); }
    catch { done = null; }
    const extra = { bridgeStats, bridgeErr, bridgeMs, bridgeOff: !useBridge, wikidataKnows: typeof wikidataKnows === 'function' ? wikidataKnows() : null };
    if (done?.result?.mine) {
      ENG.val = { ...done.result, ...extra, ms: Math.round(performance.now() - t1), where: 'worker' };
    } else {
      // No worker, or it failed: the original main-thread path, same answer.
      await engineLoad();
      await yieldToPaint();
      const common = { folds: 5, limit: VALIDATE_N, isMirror: isMirrorPlaylist, targets: new Set(engineTargets()), bridge,
                       audio: engineAudioScore(audio), collect: true,
                       genreGraph: true, soundWeights: BetterfyIntrinsic.SOUND_FIRST_WEIGHTS, fitParts: true, sources: true };
      const mine = BetterfyValidate.placementAccuracy(LIB, common);
      await yieldToPaint();
      const base = tags ? BetterfyBaseline.baselineAccuracy(LIB, tags, common) : null;
      // This engine's weights fitted to your filing, nested, as the worker does.
      let fit = null;
      try { fit = BetterfyWeightFit.weightsFromRun(mine); }
      catch { fit = null; delete mine.partRows; }
      // The two blended per track, as the worker does (plan phase 1), on top of
      // the fitted weights when those earned their place.
      let blend = null;
      try { blend = base ? BetterfyBlendScore.blendFromRun(LIB, { base, mine, folds: common.folds,
              targets: common.targets, isMirror: isMirrorPlaylist, nativeFit: fit }) : null; }
      catch { blend = null; }
      const weights = BetterfyWeightFit.fitSummary(fit);
      // The tag engine's own top picks per track, for the agreement check (package 4).
      const tagTops = base?.rows && typeof BetterfyAgree !== 'undefined' ? BetterfyAgree.tagTopsOf(base.rows) : null;
      if (base) delete base.rows;
      let identify = null;
      try { identify = audio ? BetterfyIdentify.identifyAccuracyFor(LIB, audio, { targets: engineTargets(), isMirror: isMirrorPlaylist }) : null; }
      catch { identify = null; }
      let fill = null;
      try { fill = BetterfyFill.fillRecall(LIB, { tags, audio: engineAudioScore(audio), isMirror: isMirrorPlaylist }); } catch { fill = null; }
      let teach = null;
      try { teach = BetterfyTeach.teachGate(LIB, { targets: engineTargets(), isMirror: isMirrorPlaylist, genreGraph: true, audio: engineAudioIn(audio) }); } catch { teach = null; }
      let online = null;
      try { online = BetterfyOnline.onlineAccuracy(LIB, { targets: engineTargets(), isMirror: isMirrorPlaylist, genreGraph: true }); } catch { online = null; }
      let tempoRange = null;
      try { tempoRange = BetterfyTempoRange.tempoRangeAccuracy(LIB, { ...common, limit: 300, collect: false, fitParts: false, sources: false }); } catch { tempoRange = null; }
      ENG.val = { mine, base, blend, identify, weights, fill, teach, online, tempoRange, tagTops, ...extra, ms: Math.round(performance.now() - t1), where: 'page' };
    }
    // Library's "Fill this playlist" shows only once this clears its bar (BUILD-6 F2).
    try { if (ENG.val.fill?.recall != null) LS.setItem('bf_fill', JSON.stringify({ ...ENG.val.fill, at: Date.now() })); } catch { /* shown next run */ }
    // File's teach questions show only once this account's own measurement beats (BUILD-6 SG).
    try { if (ENG.val.teach) teachRemember(ENG.val.teach); } catch { /* shown next run */ }
    // The fitted weights first: calibration is refitted on the engine they
    // make, and the comparison above is redone with them.
    // File's similar artists follow this account's own verdict (web/app/bridgewarm.js).
    if (typeof bridgeGateRemember === 'function') bridgeGateRemember(ENG.val);
    await weightsRemember(ENG.val);
    await engineCalibrate(ENG.val);
    // Kept for the File screen, which uses the blend only if this says it is ahead.
    await blendRemember(ENG.val);
    // A run by hand counts as this week's run, so the automatic one (app/autoscore.js) counts from it.
    if (typeof autoScoreNote === 'function' && !AUTOSCORE_RUN.running) autoScoreNote('manual', !ENG.val?.error);
    // Every run's report is kept on this device for the Engine screen's Past runs (app/autoscore.js).
    if (typeof scoreHistorySave === 'function') { try { await scoreHistorySave(AUTOSCORE_RUN.running ? AUTOSCORE_RUN.why : 'manual'); } catch { /* shown this session */ } }
    if (ENG.space && ENG.status === 'ready') { try { engineShadow(); } catch { /* the old comparison stays */ } }
  } catch (e) {
    ENG.val = { error: e?.message ?? String(e) };
  }
  ENG.valRunning = false; ENG.valStage = null; store.touch('eng');
});

/** Whether long engine work will run off the main thread. */
const engineInBackground = () => typeof Worker === 'function' && ENGINE_WORKER !== false;


/* ---------- Engine > Tune (BUILD-6 T1) ----------
 * Sweeps the Score run's constants on THIS account's own held-out tracks and
 * shows the best value next to the shipped one with the measured delta. A tuned
 * value is stored on this device only, and only for rows that cleared the bar on
 * both halves of the account's tracks (core/validate/tune.mjs). Nothing is
 * shared; "Reset to default" removes it. */
const TUNE_KEY = 'engine-tune';
const TUNE = { over: {}, loaded: false, res: null, running: false, stage: null, err: null, saved: false };

/** Read the stored overrides once. Ignored when the playlists it was fitted to have changed. */
async function tuneLoad() {
  if (TUNE.loaded) return TUNE.over;
  TUNE.loaded = true;
  try {
    const rec = await idb.get(TUNE_KEY);
    if (rec && JSON.stringify(rec.targets ?? null) === JSON.stringify(engineTargets()) && globalThis.BetterfyTune) {
      TUNE.over = BetterfyTune.cleanOverrides(rec.over); TUNE.saved = Object.keys(TUNE.over).length > 0;
    }
  } catch { /* defaults */ }
  return TUNE.over;
}
const tuneSoundFirst = () => (globalThis.BetterfyTune ? BetterfyTune.soundFirstFor(TUNE.over) : null);
const tuneIdentOpts = () => (globalThis.BetterfyTune ? BetterfyTune.identifyOptsFor(TUNE.over) : null);
const tuneMisfitOpts = () => (globalThis.BetterfyTune ? BetterfyTune.misfitOptsFor(TUNE.over) : null);

/** Sweep each group in the worker (the page's own thread when there is none). */
const engineTune = guard(async () => {
  TUNE.running = true; TUNE.res = null; TUNE.err = null; TUNE.stage = null; store.touch('eng');
  try {
    await engineLoad();
    const audio = engineAudioScore(await engineAudio());
    const parts = [];
    for (const g of BetterfyTune.TUNE_GROUPS) {
      TUNE.stage = g; store.touch('eng');
      let part = null;
      try { part = (await inEngineWorker('tune', { lib: LIB, audio, groups: [g], limit: 300 }))?.result ?? null; }
      catch { part = null; }
      if (!part) {
        await yieldToPaint();
        part = BetterfyTune.tuneSweep(LIB, { audio, targets: engineTargets(), isMirror: isMirrorPlaylist, groups: [g], limit: 300 });
      }
      parts.push(part);
    }
    TUNE.res = { ...BetterfyTune.mergeTune(parts), at: Date.now() };
    // The Score run's kept report gains its Tune block (same entry, rewritten).
    if (typeof scoreHistorySave === 'function' && ENG.val && !ENG.val.error) { try { await scoreHistorySave(); } catch { /* kept without it */ } }
  } catch (e) { TUNE.err = e?.message ?? String(e); }
  TUNE.running = false; TUNE.stage = null; store.touch('eng');
});

/** One action for the owner's paste: the Score run, then the sweep. */
async function engineScoreTune() { await engineValidate(); await engineTune(); }

/** Keep the rows that cleared the bar, on this device. */
async function tuneApply() {
  const over = TUNE.res ? BetterfyTune.tuneOverrides(TUNE.res) : {};
  TUNE.over = BetterfyTune.cleanOverrides(over); TUNE.saved = Object.keys(TUNE.over).length > 0;
  try { if (TUNE.saved) await idb.set(TUNE_KEY, { at: Date.now(), targets: engineTargets(), over: TUNE.over }); else await idb.del(TUNE_KEY); }
  catch { /* applies until the page is closed */ }
  if (typeof TSOUND !== 'undefined') TSOUND.key = null;   // Tidy by sound is re-read with the new numbers
  store.touch('eng');
}
/** "Reset to default". */
async function tuneForget() {
  TUNE.over = {}; TUNE.saved = false;
  try { await idb.del(TUNE_KEY); } catch {}
  if (typeof TSOUND !== 'undefined') TSOUND.key = null;
  store.touch('eng');
}
