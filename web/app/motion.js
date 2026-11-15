/* Screen-change motion (docs/BUILD-5-PLAN.md §4.2, UI-B).
 * swapScreen(dir, update) runs `update` (which redraws the screen) inside a
 * same-document View Transition when the browser has one, with a forward/back
 * type; elsewhere it just runs `update`. Either way <html data-dir> says which
 * way we are travelling, so the CSS has one hook that works in every browser.
 * Reduced motion is a cut. The top bar and tab bar carry their own
 * view-transition-names in the stylesheet, so they stay put. */
let popping = false;
if (typeof addEventListener === 'function') {
  // Registered before the router's own popstate listener: a browser back/forward
  // step is "back" for the animation, whatever the screen order says.
  addEventListener('popstate', () => { popping = true; setTimeout(() => { popping = false; }); });
}

/** +1 forward, -1 back: the router's popstate wins over the screens' order. */
function navDir(dir) { return popping ? -1 : dir; }

function swapScreen(dir, update) {
  const d = navDir(dir), root = document.documentElement;
  const still = !document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const type = d > 0 ? 'forward' : 'back';
  root.dataset.dir = type;
  if (still) { update(); return; }
  const typed = typeof ViewTransition !== 'undefined' && 'types' in ViewTransition.prototype;
  const t = typed ? document.startViewTransition({ update, types: [type] }) : document.startViewTransition(update);
  t.finished.finally(() => { delete root.dataset.dir; });
}
