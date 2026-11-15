/* ---------- router (docs/BUILD-5-PLAN.md A6, fixes B9) ----------
 * One history entry per screen and per open sheet, so the browser's and
 * Android's back button closes a sheet first and then walks back through the
 * screens instead of leaving the app. The address is a hash (#/tidy,
 * #/tidy/settings): it works on static hosting with no server
 * rewrites, and it never touches the ?code= / ?error= query sign-in returns on.
 *
 * makeRouter() takes everything it touches, so the tests can run it against a
 * fake history. go() and openSettings() call routeNote() after
 * they change anything; boot calls ROUTER.start() once the app is showing. */
function makeRouter(env) {
  const { views, hist, loc, getView, setView, getSheet, setSheet } = env;
  // Screens that moved (UI-D): { name: { view } } for one that is now another
  // screen, { name: { section } } for one that is now a section of the Settings
  // sheet. An old link or bookmark still lands somewhere sensible.
  const moved = env.moved ?? {}, fallback = env.fallback ?? 'inbox';
  let active = false, applying = false, settling = false, landedSection = null;

  const parse = hash => {
    const [v, s] = String(hash || '').replace(/^#\/?/, '').split('/');
    const old = Object.hasOwn(moved, v) ? moved[v] : null;
    const r = { view: views.includes(v) ? v : old?.view ?? null,
                sheet: s === 'settings' || old?.section ? 'settings' : null };
    if (old?.section) r.section = old.section;
    return r;
  };
  const hashOf = (view, sheet) => '#/' + view + (sheet ? '/' + sheet : '');
  const here = () => ({ view: getView(), sheet: getSheet() });
  const same = (a, b) => !!a && a.view === b.view && (a.sheet ?? null) === (b.sheet ?? null);
  const stamp = r => ({ view: r.view, sheet: r.sheet ?? null });

  /** Make the screen match an entry (back/forward), without writing history. */
  function apply(r) {
    applying = true;
    try {
      if (getSheet() !== r.sheet) setSheet(r.sheet);
      if (r.view && r.view !== getView()) setView(r.view);
    } finally { applying = false; }
  }

  /** Called after the screen or a sheet changed by the app's own doing. */
  function note() {
    if (!active || applying) return;
    // Changes made while a back step is still landing wait for it (see onPop).
    if (settling) return;
    const want = here(), at = hist.state;
    if (same(at, want)) return;
    // A sheet closed from its own buttons: take its entry off the stack by
    // going back, so the next back press is not a no-op on the same screen.
    if (!want.sheet && at?.sheet && at.view === want.view) { settling = true; hist.back(); return; }
    hist.pushState(stamp(want), '', hashOf(want.view, want.sheet));
  }

  function onPop() {
    if (!active) return;
    if (settling) { settling = false; note(); return; }
    const r = hist.state ?? parse(loc.hash);
    if (!r.view) return;
    apply(r);
  }

  /** The screen the URL asks for, falling back to home; claims the first entry. */
  function start() {
    const at = parse(loc.hash), view = at.view ?? fallback;
    landedSection = at.section ?? null;
    active = true;
    hist.replaceState(stamp({ view, sheet: null }), '', hashOf(view, null));
    return view;
  }

  return { parse, hashOf, start, note, onPop, get active() { return active; },
           /** The Settings section an old link (#/sources) asked for; read once, after start(). */
           get section() { const s = landedSection; landedSection = null; return s; } };
}

const ROUTER = typeof document === 'undefined' ? null : makeRouter({
  views: VORDER, hist: history, loc: location, moved: LEGACY_VIEWS, fallback: 'inbox',
  getView: () => view,
  getSheet: () => settingsOpen() ? 'settings' : null,
  setView: v => go(v),
  setSheet: s => openSettings(s === 'settings'),
});
if (ROUTER) addEventListener('popstate', () => ROUTER.onPop());
function routeNote() { ROUTER?.note(); }
