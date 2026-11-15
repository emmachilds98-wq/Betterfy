/* ---------- the router: back and forward (docs/BUILD-5-PLAN.md A6, bug B9) ----------
 * Before this the app was one history entry: the browser's back button, and
 * Android's back gesture, left Betterfy from whatever screen or sheet was open.
 * Now every screen change is an entry (#tidy, #discover…; Home is the bare
 * address) and so is every sheet that opens over a screen, so back does what
 * a phone app's back does: close the sheet on top, else return to the screen
 * before. The first entry is replaced, not pushed, so back from the screen the
 * app opened on leaves the app exactly as it did before.
 *
 * Every entry carries { bf:1, v, n, layer?, arg? }: the screen, its depth in
 * this app's stack, and the sheet open over it. Anything else (the {} that
 * sign-in's tidy-up writes, a fragment link, a hash typed by hand) is not ours
 * and is adopted rather than trusted.
 *
 * Sheets are not changed to know about any of this. The router reads whether
 * each one is open (a class on the two sheets, S.editingArtist for the tag
 * editor) and reconciles history with that after every change: opening one
 * pushes an entry, closing one with its own button, Esc or the scrim goes back
 * over that entry, so the stack never holds a sheet that is no longer there.
 *
 * The sign-in round trip is left alone: auth reads ?code= and boot tidies the
 * address bar exactly as before. A deep link (#tidy) is read once, here, at
 * load, and kept for a few minutes, so a link opened signed out still lands on
 * its screen once the Spotify round trip (which drops the hash) comes back. */
const ROUTE = { on:false, n:0, echoTo:null, queued:null, deep:null };
const ROUTE_KEEP = 'bf_route';
const ROUTE_KEEP_MS = 15 * 60 * 1000;

/** The screen a hash names, or null: "#tidy" and "#/tidy" both count. */
function routeHashScreen(hash) {
  const v = String(hash ?? '').replace(/^#\/?/, '');
  return VORDER.includes(v) ? v : null;
}
/** The current entry, when it is one of ours. */
function routeState() {
  const s = history.state;
  return s && s.bf === 1 && VORDER.includes(s.v) ? s : null;
}
/** Home is the bare address; every other screen is its hash. Path and query stay. */
const routeUrl = v => v === 'home' ? location.pathname + location.search : '#' + v;
function routeWrite(push, st) {
  history[push ? 'pushState' : 'replaceState'](st, '', routeUrl(st.v));
  ROUTE.n = st.n;
}

/* The sheets, top-most first. `isOpen` is read, never stored, so the router can
 * never disagree with what is on screen. `open` is used by the forward button. */
const ROUTE_LAYERS = [
  { name:'settings', isOpen: () => !!$('#settingsPanel')?.classList.contains('open'),
    open: () => openSettings(true), close: () => openSettings(false) },
  { name:'more', isOpen: () => !!$('#moreSheet')?.classList.contains('open'),
    open: () => openSheet(true), close: () => openSheet(false) },
  // The tag editor opens in place under a Tidy row rather than over the page,
  // but it is the same idea: back closes it before it leaves the screen.
  { name:'tagedit', isOpen: () => view === 'tidy' && !!S.editingArtist, arg: () => S.editingArtist,
    open: id => { S.editingArtist = id; }, close: () => { S.editingArtist = null; render(); } },
];
const routeLayer = name => ROUTE_LAYERS.find(l => l.name === name) ?? null;
const routeTop = () => ROUTE_LAYERS.find(l => l.isOpen()) ?? null;

/** Called once, by the first render(): adopt the entry the app opened on. */
function routeStart() {
  ROUTE.on = true;
  let want = ROUTE.deep;
  if (!want) {
    try {
      const kept = JSON.parse(LS.getItem(ROUTE_KEEP) || 'null');
      if (kept && Date.now() - kept.at < ROUTE_KEEP_MS) want = routeHashScreen(kept.v);
    } catch {}
  }
  try { LS.removeItem(ROUTE_KEEP); } catch {}
  if (want && want !== view) {
    view = want;
    if (want === 'history') routeLoadHistory();
  }
  routeWrite(false, { bf:1, v:view, n:0 });
}

/** History reads its log before it is shown; every other route to it does the same. */
function routeLoadHistory() {
  fire(getLog().then(h => { S.history = h; if (view === 'history') render(); }));
}

/** A screen change by tap, swipe or key: one new entry. */
function routePush(v) {
  if (!ROUTE.on) return;
  if (ROUTE.echoTo !== null) { ROUTE.queued = v; return; }   // after the pending back lands
  const st = routeState();
  // A tab tapped inside the More sheet: the sheet is already shut, so its entry
  // becomes the new screen's rather than being left behind for back to reopen.
  if (st?.layer && !routeLayer(st.layer)?.isOpen()) return routeWrite(false, { bf:1, v, n:st.n });
  routeWrite(true, { bf:1, v, n:(st?.n ?? ROUTE.n) + 1 });
}

/** The screen changed without go() (a re-sync lands on Home): say so in place. */
function routeSync() {
  if (!ROUTE.on || ROUTE.echoTo !== null) return;
  const st = routeState();
  if (st && st.v !== view) routeWrite(false, { ...st, v:view });
}

/** Make history agree with which sheet is open. Run after anything that can open or close one. */
function routeReconcile() {
  if (!ROUTE.on || ROUTE.echoTo !== null) return;
  const st = routeState();
  if (!st) return;
  const top = routeTop(), arg = top?.arg?.() ?? null;
  if (top) {
    if (st.layer === top.name && (st.arg ?? null) === arg) return;
    // Over a sheet that is still open: stack. Over one that has gone (Settings
    // opened from inside More): take its place.
    const under = st.layer ? routeLayer(st.layer) : null;
    const stack = !under || under.isOpen();
    routeWrite(stack, { bf:1, v:st.v, n:st.n + (stack ? 1 : 0), layer:top.name, arg });
  } else if (st.layer) {
    // Shut by its own button, Esc or the scrim: step back over its entry, and
    // treat the popstate that follows as ours.
    ROUTE.echoTo = st.n - 1;
    history.back();
  }
}

addEventListener('popstate', e => {
  if (!ROUTE.on) return;                 // the landing page's own #fragment links
  const st = routeState();
  if (ROUTE.echoTo !== null) {
    const ours = st && st.n === ROUTE.echoTo;
    ROUTE.echoTo = null;
    if (ours) {
      const q = ROUTE.queued; ROUTE.queued = null;
      if (q && q !== st.v) routeWrite(true, { bf:1, v:q, n:st.n + 1 });
      routeSync(); routeReconcile();
      return;
    }
  }
  ROUTE.queued = null;
  if (!st) {
    // Not an entry this app wrote: a hash typed by hand or a fragment link.
    // Go where it names, if it names a screen, and stamp it as ours.
    const h = routeHashScreen(location.hash);
    const n = ROUTE.n + 1;
    if (h && h !== view) routeShow(h, 1);
    routeWrite(false, { bf:1, v:view, n });
    return;
  }
  // Back closes whatever is open over the entry it lands on...
  for (const l of ROUTE_LAYERS) if (l.name !== st.layer && l.isOpen()) l.close();
  // ...and forward reopens the sheet its entry had.
  const want = st.layer ? routeLayer(st.layer) : null;
  if (want && !want.isOpen()) want.open(st.arg);
  const dir = st.n < ROUTE.n ? -1 : 1;
  ROUTE.n = st.n;
  if (st.v !== view) routeShow(st.v, dir, { cut: e.hasUAVisualTransition });
  else if (want?.name === 'tagedit') render();
});

/** Show a screen history asked for, without writing a new entry. */
function routeShow(v, dir, how) {
  view = v;
  if (v === 'history') routeLoadHistory();
  return swapScreen(dir, how);
}

// The deep link, read before boot rewrites the address on its way through
// sign-in. Kept across the Spotify round trip, which comes back without it.
ROUTE.deep = routeHashScreen(location.hash);
if (ROUTE.deep) { try { LS.setItem(ROUTE_KEEP, JSON.stringify({ v:ROUTE.deep, at:Date.now() })); } catch {} }

// The two sheets open and close by a class; watch it rather than teach them.
if (typeof MutationObserver === 'function') {
  const watch = new MutationObserver(() => routeReconcile());
  for (const id of ['#moreSheet', '#settingsPanel']) {
    const el = $(id);
    if (el) watch.observe(el, { attributes:true, attributeFilter:['class'] });
  }
}

