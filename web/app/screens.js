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
                    toast, render, enrichMissing, fillFromWikidata }),
  engine: () => ({ ENG, LIB, LS, esc, idb, SPACE_KEY, CAL_KEY, VALIDATE_N, toast, render, go,
                   engineTargets, engineInBackground, bridgeOn, bridgeProgressText,
                   engineAnalyse, engineValidate, BLEND_KEY, weightsForget,
                   blendForget: () => { if (typeof blendForget === 'function') blendForget(); },
                   maestScoreText: (...a) => globalThis.BetterfyAudio?.maestScoreText?.(...a) ?? null,
                   getLog: () => (typeof getLog === 'function' ? getLog() : Promise.resolve(null)),
                   measureLines: log => globalThis.BetterfyMeasure ? BetterfyMeasure.measureLines(BetterfyMeasure.measureHistory(log)) : [],
                   get navigator() { return globalThis.navigator; }, prompt: (...a) => prompt(...a) }),
};

/** The ctx a screen module is given, built fresh each time so it never goes stale. */
const screenCtx = name => SCREEN_CTX[name]();

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
  const fn = SCREEN_MODS[view]?.actions?.[el.dataset.act];
  if (!fn) return false;
  await fn(screenCtx(view), el, e);
  return true;
}

// --- tidy/lists/new ---
SCREEN_CTX.tidy = () => ({
  S, R, FB, LIB, CFG, T, TSOUND, esc, thumbHTML, cmpTable, emptyState, moreButton, shownOf, tagChips, tagEditorHTML,
  store, getListening, toast, render, saveTheme, recordKeep, recordMove, playlistIds, delTracks, addTracks,
  logAction, getLog, undoAction, newGroup, tidySoundOn, tidySoundRows, tidySoundCount, tidySoundWarm,
  get bandChip() { return typeof bandChip === 'function' ? bandChip : undefined; },
  get LISTENING_CACHE() { return LISTENING_CACHE; },
  get LISTENING_PENDING() { return LISTENING_PENDING; },
});
SCREEN_CTX.lists = () => ({
  CFG, LIB, LS, R, LPROF, LISTS_SOUND, NO_SIGNAL, MIN_FOR_TARGET, esc, store, tagCoverage, playlistMixes, listsSplits,
  listsSplitMake, profileRow, isMirrorPlaylist, syncAxes, toast, render,
  rebuildReports: () => (R = buildReports(LIB, CFG, TAGS)),
  get BetterfyPlProfile() { return globalThis.BetterfyPlProfile; },
  get document() { return globalThis.document; },
});
SCREEN_CTX.new = () => ({
  R, GAPS, esc, $, emptyState, fire, gapsCompute, gapsCreate, gapsFile, toast, render, sp, addTracks,
  get BetterfyGaps() { return globalThis.BetterfyGaps; },
  get clapConfirm() { return typeof clapConfirm === 'function' ? clapConfirm : undefined; },
});
// --- home/inbox ---
Object.assign(SCREEN_CTX, {
  home: () => ({ S, R, LIB, esc, isMirrorPlaylist, listenEverRan, listenHeard, listenTarget, tagCoverage,
                 analyseHTML, analyseGo, VHUE, HEARD_HUE, hueOf, filePicks, go }),
  inbox: () => ({ S, R, LIB, CFG, FB, TAGS, esc, filePicks, soundWarm, artHTML, ICON_PLAY, mmss, trackChip,
                  tagChips, trackStrip, soundIdHTML, soundNote, pickEvidence, pickBand,
                  addTracks, logAction, getLog, undoAction, recordAccept, forgetAccept, recordSkip, recordReject,
                  libraryCall, playTrack, backlogSuggest, gateTags, tagGate, artistRejectMemory, fbUnstamp,
                  saveFeedback, toast, render,
                  rebuildReports: () => { R = buildReports(LIB, CFG, TAGS); },
                  matchMedia: q => globalThis.matchMedia(q) }),
});
// --- /home/inbox ---
// --- shuffle/discover ---
SCREEN_CTX.shuffle = () => ({ S, LIB, LS, esc, emptyState, isMirrorPlaylist, dedupe, spacedShuffle, shuffleStats, rnd, artistOf,
  mixHeardIn, shuffleMix, MIX_MODES, MIX_PAGE, paged, sp, plCall, chunk, logAction, toast, render, syncAllSongsPlaylist,
  get BetterfyOrder() { return globalThis.BetterfyOrder; }, get BetterfyAudio() { return globalThis.BetterfyAudio; },
  labelsShownNow: () => typeof labelsShownNow === 'function' ? labelsShownNow() : null });
SCREEN_CTX.discover = () => ({ S, LIB, LS, CFG, $, esc, lfmKey, emptyState, discListenOn, discSoundLine, discFitHTML,
  soundSearchHTML: () => typeof soundSearchHTML === 'function' ? soundSearchHTML() : '',
  artHTML, trackChip, trackStrip, tagChips, pickEvidence, pickBand, mmss, ICON_PLAY,
  runDiscovery, addTracks, logAction, getLog, toast, undoAction, render, libraryCall });
// --- end shuffle/discover ---
