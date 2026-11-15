/* ---------- the store: docs/BUILD-5-PLAN.md A3 ----------
 * Background jobs (listening, the engine, sync, tag fills, the screens' own
 * workers) used to finish with a bare render(), which redraws whatever screen
 * happens to be up: a sync landing while you swipe through File threw the deck
 * away and drew it again, for data File doesn't show. Now a job says which
 * slice of state it changed, and only a screen that reads that slice repaints,
 * at most once per animation frame however many jobs finish in it.
 *
 * The state itself stays where it always lived (LIB, R, ENG, SOUND, AUDIO,
 * GAPS, PLAYER and each screen's own object); the store wraps those, so no
 * screen reads anything differently. A click handler redrawing after the user
 * acted still calls render() itself until A4 gives each screen its actions.
 *
 *   store.get(slice)                the slice's current value
 *   store.set(slice, value | fn)    write it, tell its listeners, repaint
 *   store.on(slice, fn) → off       fn(value, slice) after every change
 *   repaint(slices)                 changed in place: tell listeners, repaint
 *
 * Slices: lib, reports, eng, sound, audio, gaps, player, and ui.<screen> for
 * state only that screen draws (Tidy by sound, a Lists profile run, ...).
 * ======================================================================== */

/* What each screen reads, and so repaints for. Checked against each screen's
 * view function, not guessed:
 * - lib and reports reach every screen: the tab bar's counts are drawn from
 *   them by render() itself.
 * - audio is the listening run. Its progress is patched in place (the
 *   indicator, Home's heard count, the Sources panel); Home repaints only when
 *   its Heard card appears or goes (setListen).
 * - sound is what has been heard and the sound-first space built from it: the
 *   File card's sound picks, and Tidy's By sound section and its key.
 *   Lists, Discover, Shuffle and New read heard tracks only through jobs of
 *   their own, keyed on the record count and restarted by a repaint, so a
 *   mid-run refresh leaves them be; each job's result is its ui.<screen>.
 * - player is patched in place by playerPaint(); nothing repaints for it.
 * Every screen also reads its own ui.<screen>. */
const STORE_CHROME = ['lib', 'reports'];
const SCREEN_SLICES = {
  home: ['audio'],
  inbox: ['sound'],
  tidy: ['sound'],
  discover: [],
  shuffle: [],
  new: ['gaps'],
  lists: [],
  engine: ['eng'],
  history: [],
  sources: [],
};
/** Whether screen `v` draws anything from `slice`. */
const screenReads = (v, slice) => STORE_CHROME.includes(slice) || slice === `ui.${v}`
  || (SCREEN_SLICES[v] ?? []).includes(slice);

/* The page's own state, wrapped. Read lazily: most of these are declared in
 * files further down, and exist by the time any job runs. A slice with a
 * setter is replaced by set(); one without is an object set() patches. */
const STORE_BOUND = {
  lib: [() => LIB, v => { LIB = v; }],
  reports: [() => R, v => { R = v; }],
  eng: [() => ENG],
  sound: [() => SOUND],
  audio: [() => AUDIO],
  gaps: [() => GAPS],
  player: [() => PLAYER],
};
const STORE_Q = { vals: new Map(), subs: new Map(), due: new Set(), frame: 0 };

const store = {
  get(slice) {
    const b = STORE_BOUND[slice];
    return b ? b[0]() : STORE_Q.vals.get(slice);
  },
  /** A value, or fn(current). For lib, reports and ui.* the result replaces the
   *  slice (a fn returning nothing keeps the current one, changed in place);
   *  for the page's own objects (eng, sound, audio, gaps, player) it is merged in. */
  set(slice, v) {
    const b = STORE_BOUND[slice], cur = store.get(slice);
    const next = typeof v === 'function' ? v(cur) : v;
    if (b && !b[1]) { if (next && next !== cur) Object.assign(cur, next); }
    else if (next !== undefined || typeof v !== 'function') {
      if (b) b[1](next); else STORE_Q.vals.set(slice, next);
    }
    repaint([slice]);
    return store.get(slice);
  },
  on(slice, fn) {
    if (!STORE_Q.subs.has(slice)) STORE_Q.subs.set(slice, new Set());
    STORE_Q.subs.get(slice).add(fn);
    return () => { STORE_Q.subs.get(slice)?.delete(fn); };
  },
};

/** These slices changed: tell their listeners now, and repaint the screen on
 *  view at the next frame if it reads any of them. Many calls, one repaint. */
function repaint(slices) {
  for (const s of slices ?? []) {
    STORE_Q.due.add(s);
    for (const fn of [...(STORE_Q.subs.get(s) ?? [])]) {
      try { fn(store.get(s), s); } catch (e) { console.error(e); }
    }
  }
  if (STORE_Q.frame || !STORE_Q.due.size) return;
  STORE_Q.frame = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(repaintFrame) : setTimeout(repaintFrame, 16);
}
/** The frame's one repaint, of the screen on view then. True when it drew. */
function repaintFrame() {
  STORE_Q.frame = 0;
  const due = [...STORE_Q.due];
  STORE_Q.due.clear();
  // Not signed in yet (or signed out since): there is no screen to draw.
  if (!LIB || !R || !due.some(s => screenReads(view, s))) return false;
  render();
  return true;
}
/* ---------- end of the store ---------- */
