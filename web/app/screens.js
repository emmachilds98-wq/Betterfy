/* ---------- screen modules (docs/BUILD-5-PLAN.md A4) ----------
 * A migrated screen is web/screens/<name>.mjs: an ES module that build-web.mjs
 * bundles (its `// @bundle screens <name> <order>` header is the whole
 * registration) and exposes here as BetterfyScreens.<name>. It exports
 *   view(ctx)                 pure: ctx in, HTML string out
 *   actions                   { 'data-act name': (ctx, el, ev) => ... }
 *   mount(ctx)  (optional)    runs after the screen has been painted
 * and reaches nothing but `ctx`. SCREEN_CTX below is the one place that says
 * what a screen is given: add a `name: () => ({ ... })` per migrated screen,
 * listing exactly what its module destructures. Not-yet-migrated screens are
 * still the classic functions in web/screens/*.js and VIEWS in render.js.
 * web/README.md ("Screen modules") is the convention in full. */
const SCREEN_MODS = globalThis.BetterfyScreens ?? {};

const SCREEN_CTX = {
  history: () => ({ S, esc, isUndone, emptyState, undoAction, getLog, toast, render }),
  sources: () => ({ LS, esc, lfmKey, $, tagCoverage, playlistMixes, audioPanelHTML, labelCheckHTML,
                    toast, render, enrichMissing, fillFromWikidata, sourceCoverage,
                    helpersPanelHTML: () => (typeof helpersPanelHTML === 'function' ? helpersPanelHTML() : '') }),
  engine: () => ({ ENG, LIB, LS, esc, idb, SPACE_KEY, CAL_KEY, VALIDATE_N, toast, render, go,
                   engineTargets, engineInBackground, bridgeOn, bridgeProgressText,
                   engineAnalyse, engineValidate, BLEND_KEY, weightsForget,
                   TUNE, engineScoreTune, engineTune, tuneApply, tuneForget, autoScoreText,
                   tuneBlock: r => (globalThis.BetterfyTune ? BetterfyTune.tuneBlock(r) : ''),
                   blendForget: () => { if (typeof blendForget === 'function') blendForget(); },
                   maestScoreText: (...a) => globalThis.BetterfyAudio?.maestScoreText?.(...a) ?? null,
                   getLog: () => (typeof getLog === 'function' ? getLog({ all: true }) : Promise.resolve(null)),
                   measureLines: log => globalThis.BetterfyMeasure ? BetterfyMeasure.measureLines(BetterfyMeasure.measureHistory(log)) : [],
                   get navigator() { return globalThis.navigator; }, prompt: (...a) => prompt(...a) }),
};

/** The ctx a screen module is given, built fresh each time so it never goes stale. */
const screenCtx = name => Object.assign(SCREEN_CTX[name](), { infoBtn: typeof infoBtn === 'function' ? infoBtn : undefined });

/** The VIEWS entry for a migrated screen. */
function screenView(name) { return () => SCREEN_MODS[name].view(screenCtx(name)); }

/** Run the current screen module's action for the clicked `data-act` element.
 *  Returns true when it handled the event, so the caller can stop there; false
 *  sends the event on to the older branches in events.js. Checkboxes and
 *  selects dispatch on `change`, everything else on `click`, so a tick is
 *  never handled twice. */
async function dispatchAct(e) {
  const el = e.target.closest?.('[data-act]');
  if (!el) return false;
  if ((e.type === 'change') !== el.matches('select, input[type=checkbox], input[type=radio]')) return false;
  // A control inside a Settings section belongs to that section's module,
  // whichever tab is showing behind the sheet.
  const host = el.closest('[data-uh]')?.dataset.uh;
  const owner = (host ? [host] : actScreens(view)).find(n => SCREEN_MODS[n]?.actions?.[el.dataset.act]);
  if (!owner) return false;
  await SCREEN_MODS[owner].actions[el.dataset.act](screenCtx(owner), el, e);
  return true;
}

// --- tidy/lists/new ---
SCREEN_CTX.tidy = () => ({
  S, R, FB, LIB, CFG, T, TSOUND, esc, thumbHTML, cmpTable, emptyState, moreButton, shownOf, tagChips, tagEditorHTML,
  store, getListening, toast, render, saveTheme, recordKeep, recordMove, playlistIds, delTracks, addTracks,
  logAction, getLog, undoAction, newGroup, tidySoundOn, tidySoundRows, tidySoundCount, tidySoundWarm,
  get bandChip() { return typeof bandChip === 'function' ? bandChip : undefined; },
  get skeleton() { return typeof skeleton === 'function' ? skeleton : undefined; },
  get LISTENING_CACHE() { return LISTENING_CACHE; },
  get LISTENING_PENDING() { return LISTENING_PENDING; },
  // The health report and keyboard sprint (BUILD-6 F9): Library's own score, read from its module.
  LS, NO_SIGNAL, saveFeedback, go, openPlSheet, isMirrorPlaylist, twinPairs: () => ENG?.pairs ?? null,
  healthSplits: () => (LPROF?.out ? listsSplits().map(x => x.p.id) : []),
  get libHealth() { return SCREEN_MODS.lists; },
  get document() { return globalThis.document; },
});
/** Library's "How well it knows you" (Wave F): the last Score run's headline, kept on this device so the
 *  card still has it after a reload. Read from ENG.val, never computed here; nothing until one run. */
function engineSummary() {
  const m = typeof ENG !== 'undefined' ? ENG.val?.mine : null;
  if (m && Number.isFinite(m.top1)) {
    const sum = { top1: m.top1, top3: m.top3 ?? null, scored: m.scored ?? null, at: ENG.val.at ?? Date.now() };
    try {
      const old = JSON.parse(LS.getItem('bf_engscore') || 'null');
      if (!old || old.top1 !== sum.top1 || old.scored !== sum.scored) LS.setItem('bf_engscore', JSON.stringify(sum));
      else sum.at = old.at;
    } catch { /* private mode: shown this session only */ }
    return sum;
  }
  let saved = null;
  try { saved = JSON.parse(LS.getItem('bf_engscore') || 'null'); } catch { /* none */ }
  return { ...(saved ?? {}), running: typeof ENG !== 'undefined' && !!ENG.valRunning };
}
SCREEN_CTX.lists = () => ({
  CFG, LIB, LS, R, S, GAPS, LPROF, MIX_MODES, go, mixHeardIn, openPlSheet, closePlSheet, LISTS_SOUND, NO_SIGNAL, MIN_FOR_TARGET, esc, store, tagCoverage, playlistMixes, listsSplits,
  listsSplitMake, profileRow, isMirrorPlaylist, syncAxes, toast, render, $, COLD, gapsCreate, thumbHTML, engineSummary,
  twinPairs: () => ENG?.pairs ?? null,
  // The last Score run's weakest playlists, with reasons (core/intrinsic/weak.mjs via app/engine.js).
  weakSaved: () => (typeof weakSaved === 'function' ? weakSaved() : null),
  // Merge/split wizard (BUILD-6 F4): new private playlists, written through the History log.
  sp, landedIn,
  // Fill this playlist (BUILD-6 F2): ranked by core/recommend/fill.mjs in the lazy engine, written through the History log.
  TAGS, addTracks, logAction, undoAction, newGroup, engineLoad,
  engineAudio: () => (typeof engineAudio === 'function' ? engineAudio() : null),
  get BetterfyFill() { return globalThis.BetterfyFill; },
  coldKick: needCold => coldKick(needCold),
  get clapConfirm() { return typeof clapConfirm === 'function' ? clapConfirm : undefined; },
  rebuildReports: () => (R = buildReports(LIB, CFG, TAGS)),
  // Library's Suggested section reads the same gaps New playlists draws: start them the way that screen does.
  gapsKick: () => { if (GAPS.status === 'idle' || (GAPS.status === 'ready' && GAPS.for !== R)) { GAPS.status = 'working'; fire(gapsCompute()); } },
  get BetterfyOrder() { return globalThis.BetterfyOrder; },
  get BetterfyPlProfile() { return globalThis.BetterfyPlProfile; },
  get document() { return globalThis.document; },
});
SCREEN_CTX.new = () => ({
  R, GAPS, esc, $, emptyState, fire, gapsCompute, gapsCreate, gapsFile, toast, render, sp, addTracks,
  mergeSplitOpen: spec => SCREEN_MODS.lists.wizardOpen(screenCtx('lists'), spec),
  get BetterfyGaps() { return globalThis.BetterfyGaps; },
  get clapConfirm() { return typeof clapConfirm === 'function' ? clapConfirm : undefined; },
});
// --- home/inbox ---
Object.assign(SCREEN_CTX, {
  // The File tab: the status line and Up next around the `inbox` module's deck.
  home: () => ({ S, R, LIB, esc, onbHTML, onbColdOffers, gapsCreate, COLD, toast, $, go, isMirrorPlaylist, listenStatus, analyseHTML, analyseGo, hueOf, filePicks, pickBacked,
                 render, openUnderHood, morphArt, deck: screenView('inbox') }),
  inbox: () => ({ S, R, LIB, CFG, FB, TAGS, esc, filePicks, soundWarm, artHTML, ICON_PLAY, mmss, trackChip,
                  tagChips, trackStrip, soundIdHTML, soundNote, pickEvidence, pickBand, pickBacked,
                  addTracks, landedIn, logAction, getLog, undoAction, newGroup, recordAccept, forgetAccept, recordSkip, recordReject,
                  fileBand, fileSure, fileOrderKick, teachHTML, teachAct,
                  fileDecision: t => (typeof engineDecisionOf === 'function' ? engineDecisionOf(t?.id) : null),
                  moodChips: t => (typeof moodChipsFor === 'function' ? moodChipsFor(t) : []),
                  rollSound: fileRollSound, rollRegistrant: t => registrantOfIsrc(likedIsrc(t.id)),
                  libraryCall, playTrack, backlogSuggest, gateTags, tagGate, artistRejectMemory, fbUnstamp,
                  saveFeedback, toast, render, flyCard,
                  // The "since you last opened" card (F5): reads only what is already held.
                  LS, COLD, isMirrorPlaylist, listeningRaw: async () => (await idb.get('listening_raw'))?.data ?? null,
                  rebuildReports: () => { R = buildReports(LIB, CFG, TAGS); },
                  matchMedia: q => globalThis.matchMedia(q) }),
});
// --- /home/inbox ---
// --- shuffle/discover ---
SCREEN_CTX.shuffle = () => ({ S, LIB, LS, esc, emptyState, isMirrorPlaylist, dedupe, spacedShuffle, shuffleStats, rnd, artistOf,
  mixHeardIn, shuffleMix, shuffleOrder, flowReady, flowNear, rediscoverKick, MIX_MODES, MIX_PAGE, paged, sp, plCall, chunk, logAction, toast, render, syncAllSongsPlaylist,
  get skeleton() { return typeof skeleton === 'function' ? skeleton : undefined; },
  get BetterfyOrder() { return globalThis.BetterfyOrder; }, get BetterfyAudio() { return globalThis.BetterfyAudio; },
  labelsShownNow: () => typeof labelsShownNow === 'function' ? labelsShownNow() : null });
SCREEN_CTX.discover = () => ({ S, LIB, LS, CFG, $, esc, isMirrorPlaylist, lfmKey, emptyState, discListenOn, discSoundLine, discFitHTML,
  soundSearchHTML: () => typeof soundSearchHTML === 'function' ? soundSearchHTML() : '',
  artHTML, trackChip, trackStrip, tagChips, pickEvidence, pickBand, mmss, ICON_PLAY,
  runDiscovery, addTracks, logAction, getLog, toast, undoAction, render, libraryCall, discRemember,
  thumbHTML, previewToggle, previewState,
  // Release radar, Discover's first section (web/app/radar.js, web/screens/radar.mjs).
  radar: typeof radarCtx === 'function' ? radarCtx() : null,
  get skeleton() { return typeof skeleton === 'function' ? skeleton : undefined; },
  get document() { return globalThis.document; } });
// --- end shuffle/discover ---
