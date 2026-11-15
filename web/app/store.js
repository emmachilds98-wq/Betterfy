/* The store (docs/BUILD-5-PLAN.md A3). Background jobs (engine, listening,
 * sync, tag fills, the Gaps and Tidy-by-sound builds) say WHAT changed by
 * writing a slice, instead of calling render() blind. The slices are named in
 * the plan: lib, reports, eng, sound, audio, gaps, player and ui.<screen>.
 * Only the screen that is mounted AND watches that slice repaints; a job that
 * finishes while another screen is open costs nothing. The live objects (LIB,
 * R, ENG, ...) stay where they are: set() stores a reference and, like touch()
 * for state mutated in place, notifies. test/webstore.test.mjs bans a bare
 * render() in the background files. */
const store = (() => {
  const data = {}, subs = {};
  const api = {
    get: k => data[k],
    /** Replace a slice and tell its subscribers. Same value is still a change: state is mutated in place. */
    set(k, v) { data[k] = v; api.touch(k); return v; },
    /** The slice changed in place. */
    touch(k) { for (const fn of [...(subs[k] ?? [])]) { try { fn(data[k], k); } catch (e) { console.error(e); } } },
    /** Subscribe; returns the unsubscribe function. */
    on(k, fn) { (subs[k] ??= new Set()).add(fn); return () => subs[k].delete(fn); },
  };
  return api;
})();

/* Which slices repaint which screen. `ui.<screen>` always repaints that screen
 * (and only it); the shared slices are listed here. A screen not listed for a
 * slice ignores it. */
const STORE_SCREENS = ['inbox', 'tidy', 'new', 'discover', 'shuffle', 'lists', 'engine', 'history', 'sources'];
const STORE_WATCH = {
  lib:     STORE_SCREENS,
  reports: STORE_SCREENS,
  eng:     ['engine'],
  sound:   ['inbox'],
  audio:   ['inbox', 'tidy', 'sources'],
  gaps:    ['new'],
  player:  [],
};
for (const [slice, screens] of Object.entries(STORE_WATCH))
  store.on(slice, () => storeRepaint(screens));
for (const screen of STORE_SCREENS)
  store.on('ui.' + screen, () => storeRepaint([screen]));

/** Repaint the current screen if it is one of `screens` and the page is up. */
function storeRepaint(screens) {
  // Engine, History and Sources are sections of the Settings sheet now: repaint
  // the one that is open, and not the page behind it.
  if (typeof settingsOpen === 'function' && settingsOpen() && screens.includes(S.uhOpen)) underHoodRefresh();
  if (typeof view === 'undefined' || !screens.includes(view) || !document.getElementById('main')) return;
  render();
}
