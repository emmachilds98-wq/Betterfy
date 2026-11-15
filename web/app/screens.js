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
