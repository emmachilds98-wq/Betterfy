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

/* ---- FLIP for rows that move or leave (docs/BUILD-5-PLAN.md §4.2, UI-G) ----
 * Rows opt in with data-flip (and a data-key, which the keyed patcher already
 * wants). flipRecord(root) notes where each one is; after the DOM changes,
 * flipPlay(root, before) slides every row that moved from its old place to its
 * new one with el.animate on --ease-spring (transform only, never opacity).
 * Rows that were added fade in from CSS (@starting-style); rows that left are
 * not animated, their neighbours close the gap. patch() calls both, so a
 * screen only adds the attribute. Reduced motion, or no el.animate: nothing. */
function flipRecord(root) {
  const before = new Map();
  if (!root || !root.querySelectorAll) return before;
  for (const n of root.querySelectorAll('[data-flip][data-key]')) {
    const r = n.getBoundingClientRect();
    before.set(n.getAttribute('data-key'), { x: r.left, y: r.top });
  }
  return before;
}

function flipPlay(root, before) {
  if (!before || !before.size || !root || !root.querySelectorAll) return 0;
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
  const doc = root.ownerDocument || document;
  const win = doc.defaultView;
  const css = win && win.getComputedStyle ? win.getComputedStyle(doc.documentElement) : null;
  const easing = (css && css.getPropertyValue('--ease-spring').trim()) || 'ease-out';
  let moved = 0;
  for (const n of root.querySelectorAll('[data-flip][data-key]')) {
    const was = before.get(n.getAttribute('data-key'));
    if (!was || typeof n.animate !== 'function') continue;
    const r = n.getBoundingClientRect();
    const dx = was.x - r.left, dy = was.y - r.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration: 300, easing, fill: 'backwards' });
    moved++;
  }
  return moved;
}

/* Skeleton blocks for first sync, Discover search and listening: the card's
 * and a row's shapes, shimmering (web/styles/74-motion.css). */
function skeleton(kind, n) {
  const row = '<div class="sk-row" aria-hidden="true"><i class="sk sk-cov"></i><span><i class="sk sk-l1"></i><i class="sk sk-l2"></i></span></div>';
  const card = '<div class="sk-card" aria-hidden="true"><i class="sk sk-art"></i><i class="sk sk-l1"></i><i class="sk sk-l2"></i></div>';
  const count = Math.max(1, (n | 0) || (kind === 'card' ? 1 : 4));
  return `<div class="sk-wrap" role="status" aria-label="Loading">${(kind === 'card' ? card : row).repeat(count)}</div>`;
}
