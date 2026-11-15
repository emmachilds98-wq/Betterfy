const VIEWS = { home:vHome, inbox:vInbox, tidy:vTidy,
                new:vNew, discover:vDiscover, shuffle:vShuffle, lists:vLists,
                engine:vEngine, history:vHistory, sources:vSources };
/**
 * Re-draw the current screen, in place and without animating. A screen change
 * goes through go(), which wraps this in swapScreen() so the new screen slides
 * in; re-rendering after an action (filing a track, undoing) or from a
 * background job calls this directly and nothing moves. What lands in #main is
 * VIEWS[view]() either way: the transition wraps the swap, it never changes it.
 */
function render() {
  // The first paint adopts the history entry the app opened on, and may move
  // `view` to the screen a deep link (#tidy) asked for (web/app/router.js).
  if (!ROUTE.on) routeStart();
  const root = document.documentElement.style;
  const hue = VHUE[view];
  root.setProperty('--view', `var(--${hue})`);
  // Mixed rather than looked up: the fixed screen hues have no -soft twin, and
  // a wash of the hue over the surface is what -soft always meant anyway.
  root.setProperty('--view-soft', `color-mix(in srgb, var(--${hue}) 14%, var(--surface))`);
  root.setProperty('--view-ink', `var(--${hue}-ink)`);

  const main = $('#main');
  main.dataset.view = view;
  delete main.dataset.dir;
  main.innerHTML = VIEWS[view]();

  $('#mtitle').textContent = VTITLE[view] ?? '';
  document.querySelectorAll('.nav').forEach(n => n.setAttribute('aria-current', String(n.dataset.v === view)));
  $('#tabMore').setAttribute('aria-current', String(SECONDARY.has(view)));

  const counts = { inbox:R.backlog.length, tidy:R.within.length + R.misfiled.length,
                   new:R.clusters.length, lists:LIB.playlists.length };
  document.querySelectorAll('[data-count]').forEach(el => {
    const n = counts[el.dataset.count] ?? 0;
    // On the tab bar this rides the icon, so it has to stay narrow.
    el.textContent = !n ? '' : n > 999 ? '999+' : String(n);
  });

  const dots = $('#dots');
  if (dots.childElementCount !== VORDER.length) dots.innerHTML = VORDER.map(() => '<i></i>').join('');
  const at = VORDER.indexOf(view);
  [...dots.children].forEach((d, i) => d.classList.toggle('on', i === at));

  bindSwipeCard();

  const seek = $('#seek');
  if (seek) {
    seek.oninput = () => { PLAYER.scrub = true; $('#pTime').textContent = mmss(+seek.value); };
    seek.onchange = guard(async ev => { const to = +ev.target.value; PLAYER.scrub = false; await playerSeek(to); });
    playerRun();
  } else playerStop();

  routeSync();
  routeReconcile();
}

/* Transition types (forward/back) are newer than view transitions themselves:
 * where they are missing the direction rides on <html data-dir> instead, which
 * the same stylesheet rules read (web/styles/74-motion.css). */
const VT_TYPES = typeof ViewTransition === 'function' && 'types' in ViewTransition.prototype;

/**
 * Swap #main for the screen `view` now names, sliding in from the direction of
 * travel: dir > 0 forwards, < 0 back. With view transitions the browser
 * snapshots the old screen, render() runs, and the snapshot slides out while
 * the new one slides in; the top bar, tab bar and corner buttons are named in
 * the stylesheet, so they stay put and only the active tab's pill glides.
 * Without them, render() runs at once and #main slides in on data-dir.
 * `cut` skips the motion (the browser already animated a swipe-back).
 * Only same-document, document-level transitions: nested and scoped ones are
 * Chrome-only (BUILD-5-PLAN §4.2).
 */
function swapScreen(dir, { cut = false } = {}) {
  const way = dir < 0 ? 'back' : 'forward';
  // A swipe leaves #main where the finger let go: the old snapshot carries
  // that offset, so the slide carries on from it rather than snapping back.
  const paint = () => { $('#main').style.transform = ''; render(); window.scrollTo(0, 0); };
  if (cut || typeof document.startViewTransition !== 'function') {
    paint();
    if (!cut) { const main = $('#main'); void main.offsetWidth; main.dataset.dir = way; }
    return;
  }
  const root = document.documentElement;
  if (!VT_TYPES) root.dataset.dir = way;
  const t = VT_TYPES ? document.startViewTransition({ update: paint, types: [way] })
                     : document.startViewTransition(paint);
  // Skipped (another swap began, the tab was hidden): the new screen is still
  // drawn, so these say nothing worth a console error.
  t.ready.catch(() => {});
  t.finished.catch(() => {}).then(() => { if (root.dataset.dir === way) delete root.dataset.dir; });
  // render() now runs a frame later, inside the transition; whatever it throws
  // still reaches the screen, as it did when go() called it directly.
  return t.updateCallbackDone.catch(actionFailed);
}

/** Move to another screen: one history entry, a slide in the direction of travel, and the top of the page. */
function go(v) {
  if (v === view) return render();
  const dir = VORDER.indexOf(v) >= VORDER.indexOf(view) ? 1 : -1;
  view = v;
  routePush(v);
  return swapScreen(dir);
}
