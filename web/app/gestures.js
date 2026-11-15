/* ======================= touch gestures =======================
 * Everything here is additive: the same actions all have buttons and keys,
 * so a phone with a cracked digitiser, a mouse, or a screen reader loses
 * nothing. Nothing below runs on a pointer that can hover.
 * ============================================================= */
const buzz = ms => { try { navigator.vibrate?.(ms); } catch {} };
const isPhone = () => innerWidth <= 820;
// Set while the inbox card owns the current gesture, so the screen-level
// swipe below doesn't try to change screen out from under it.
let gestureClaimed = false;
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The File card leaving: a ghost copy flies off while the real deck redraws
 *  underneath, so filing never waits on the animation (or on Spotify). dir is
 *  +1 for filed (right), -1 for skipped. Reduced motion: a cut. */
function flyCard(dir) {
  const card = $('#swipeCard');
  if (!card || calm()) return;
  const from = card.style.transform;
  card.style.transition = 'none'; card.style.transform = '';
  const r = card.getBoundingClientRect();
  const g = card.cloneNode(true);
  g.removeAttribute('id'); g.removeAttribute('data-best'); g.setAttribute('aria-hidden', 'true');
  g.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
  g.querySelectorAll('[style*="view-transition-name"]').forEach(n => { n.style.viewTransitionName = 'none'; });
  g.classList.remove('drag', 'to-file', 'to-skip', 'promote');
  Object.assign(g.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px',
    height: r.height + 'px', margin: '0', zIndex: '60', pointerEvents: 'none', transition: 'none', transform: from });
  document.body.appendChild(g);
  g.getBoundingClientRect();
  g.style.transition = 'transform var(--dur-3) var(--ease-in), opacity var(--dur-3) var(--ease-in)';
  g.style.transform = `translate3d(${dir * 120}vw,40px,0) rotate(${dir * 14}deg)`;
  g.style.opacity = '0';
  setTimeout(() => g.remove(), 450);
}

/** Up-next cover -> File card art: name both ends the same, redraw inside a
 *  View Transition. Anywhere without them (or with reduced motion) it is a plain redraw. */
function morphArt(cover, id, update) {
  if (!cover || !id || !document.startViewTransition || calm()) return update();
  const name = 'art-' + String(id).replace(/[^\w-]/g, '');
  cover.style.viewTransitionName = name;
  document.startViewTransition(() => { update(); const a = document.querySelector('#swipeCard .artwrap'); if (a) a.style.viewTransitionName = name; });
}

/** Drag the top inbox card: right files it into the best suggestion, left skips. */
function bindSwipeCard() {
  const card = $('#swipeCard');
  if (!card) return;
  const TH = 76;                       // travel, in px, before a swipe counts
  let x0 = 0, y0 = 0, dx = 0, mode = null, trail = [];
  const FLICK = 0.55, FLICK_MIN = 28;   // px/ms, and the least travel a flick may commit on
  const vFile = card.querySelector('.verdict.file'), vSkip = card.querySelector('.verdict.skip');

  const paint = () => {
    const t = Math.max(-1, Math.min(1, dx / 160));
    card.style.transform = `translate3d(${dx}px,0,0) rotate(${t * 6}deg)`;
    if (vFile) vFile.style.opacity = dx > 12 ? Math.min(1, (dx - 12) / 60) : 0;
    if (vSkip) vSkip.style.opacity = dx < -12 ? Math.min(1, (-dx - 12) / 60) : 0;
    card.classList.toggle('to-file', dx > TH && (!!card.dataset.best || S.fileSel.size > 0));
    card.classList.toggle('to-skip', dx < -TH);
  };
  const reset = () => {
    card.classList.remove('drag', 'to-file', 'to-skip');
    card.style.transform = '';
    if (vFile) vFile.style.opacity = 0;
    if (vSkip) vSkip.style.opacity = 0;
  };

  card.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; mode = null; trail = [];
  }, { passive: true });

  card.addEventListener('touchmove', e => {
    if (e.touches.length !== 1) return;
    const nx = e.touches[0].clientX - x0, ny = e.touches[0].clientY - y0;
    if (mode === null) {
      if (Math.abs(nx) < 12 && Math.abs(ny) < 12) return;
      // touch-action:pan-y already hands vertical drags to the scroller; this
      // only decides whether to draw the card following the finger.
      mode = Math.abs(nx) > Math.abs(ny) * 1.3 ? 'swipe' : 'scroll';
      if (mode === 'swipe') { gestureClaimed = true; card.classList.add('drag'); }
    }
    if (mode !== 'swipe') return;
    dx = nx; paint();
    trail.push([e.timeStamp, nx]); if (trail.length > 8) trail.shift();
  }, { passive: true });

  const finish = () => {
    if (mode !== 'swipe') { gestureClaimed = false; mode = null; return; }
    mode = null; gestureClaimed = false;
    const best = card.dataset.best;
    // Speed over the last ~100 ms: a quick flick commits below the distance threshold.
    const [t1, x1] = trail[trail.length - 1] ?? [0, dx];
    const [t0, x0v] = trail.find(([tt]) => t1 - tt <= 100) ?? [t1, x1];
    const v = t1 > t0 ? (x1 - x0v) / (t1 - t0) : 0;
    const flickR = v > FLICK && dx > FLICK_MIN, flickL = v < -FLICK && dx < -FLICK_MIN;
    // A pending tap selection wins over the single best guess: swiping is
    // then "confirm what I picked", not "override it with something else".
    if ((dx > TH || flickR) && (S.fileSel.size > 0 || best)) {
      buzz(12);
      fire(fileCurrent(S.fileSel.size ? [...S.fileSel] : best));   // flies the card out itself
    } else if (dx < -TH || flickL) {
      buzz(8);
      flyCard(-1);
      fire(inboxAct('skip'));
    } else reset();
  };
  card.addEventListener('touchend', finish);
  card.addEventListener('touchcancel', () => { mode = null; gestureClaimed = false; reset(); });
}

/** Swipe left/right anywhere else on a screen to walk VORDER.
 *  Pulling down used to re-sync from here. A stray downward swipe at the top of
 *  a list is about the easiest gesture on a phone to make by accident, and what
 *  it triggered was hundreds of calls against a shared quota — so re-syncing is
 *  one deliberate button in Settings now, and a pull does nothing. */
function bindAppGestures() {
  const app = $('#app');
  const VTH = 62;                      // screen-change threshold
  let x0 = 0, y0 = 0, dx = 0, dy = 0, mode = null;

  // Scrollable in its own right — a swipe that starts here belongs to it.
  const OWN = 'table.cmp, input, select, textarea, .settings, .sheet, .swipecard, .scrim';

  app.addEventListener('touchstart', e => {
    mode = null; dx = dy = 0;
    if (!isPhone() || e.touches.length !== 1 || e.target.closest(OWN)) { mode = 'ignore'; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
  }, { passive: true });

  app.addEventListener('touchmove', e => {
    if (mode === 'ignore' || gestureClaimed || e.touches.length !== 1) return;
    dx = e.touches[0].clientX - x0; dy = e.touches[0].clientY - y0;
    if (mode === null) {
      if (Math.abs(dx) < 14 && Math.abs(dy) < 14) return;
      if (Math.abs(dx) > Math.abs(dy) * 1.5) mode = 'page';
      else mode = 'scroll';
    }
    if (mode === 'page') {
      // A little travel under the finger, so the swipe feels connected.
      $('#main').style.transform = `translate3d(${Math.max(-40, Math.min(40, dx / 3))}px,0,0)`;
    }
  }, { passive: false });

  const end = async () => {
    $('#main').style.transform = '';
    const m = mode; mode = null;
    if (m === 'page' && Math.abs(dx) > VTH) {
      const at = VORDER.indexOf(view);
      const next = VORDER[at + (dx < 0 ? 1 : -1)];
      if (next) { buzz(6); go(next); }
    }
  };
  // guard() itself isn't declared until further down the script — bindAppGestures()
  // runs at startup, long before that point, so calling guard(end) here directly
  // hit its temporal dead zone and threw, aborting every top-level statement after
  // it (every button's onclick wiring included). Deferring the lookup to the event
  // itself, by which time the whole script has run, is what actually fixes it.
  app.addEventListener('touchend', e => guard(end)(e));
  app.addEventListener('touchcancel', () => {
    $('#main').style.transform = ''; mode = null;
  });
}

