// File is the home tab: the `home` module composes the status strip, the File
// deck (the `inbox` module) and Up next. Library is, for now, Playlists with
// New playlists and Shuffle one tap away (libNav, app/shell.js); the screens
// themselves are untouched.
/** The screen last drawn into #main, or null when the next draw must replace it whole. */
let paintedView = null;
const VIEWS = { inbox:screenView('home'), tidy:screenView('tidy'), discover:screenView('discover'),
                lists:() => libNav('lists') + screenView('lists')(),
                new:() => libNav('new') + screenView('new')(),
                shuffle:() => libNav('shuffle') + screenView('shuffle')() };
/**
 * Re-draw the current screen. `dir` is only passed when the screen changed:
 * +1 came from a swipe or tap moving forwards, -1 backwards, and the new
 * content slides in from that side. Re-rendering in place after an action
 * (filing a track, undoing) passes nothing and so doesn't animate.
 */
function render(dir) {
  const root = document.documentElement.style;
  const hue = VHUE[view];
  root.setProperty('--view', `var(--${hue})`);
  // Mixed rather than looked up: the fixed screen hues have no -soft twin, and
  // a wash of the hue over the surface is what -soft always meant anyway.
  root.setProperty('--view-soft', `color-mix(in srgb, var(--${hue}) 14%, var(--surface))`);
  root.setProperty('--view-ink', `var(--${hue}-ink)`);

  const main = $('#main');
  main.dataset.view = view;
  // The screen already showing, redrawn in place (a click, a store repaint):
  // patch() keeps the focused input, its caret and scroll, and slides rows
  // that moved (A5, UI-G). A screen change or a sync (stage() forgets what was
  // painted) is a full replace.
  const html = VIEWS[view]();
  if (dir === undefined && paintedView === view && typeof patch === 'function') patch(main, html);
  else main.innerHTML = html;
  paintedView = view;
  for (const m of actScreens(view)) SCREEN_MODS[m]?.mount?.(screenCtx(m));

  $('#mtitle').textContent = VTITLE[view] ?? '';
  document.querySelectorAll('.nav').forEach(n => n.setAttribute('aria-current', String(n.dataset.v === tabOf(view))));
  // The Settings sheet's sections repaint with the page they sit on.
  underHoodRefresh();

  const counts = { inbox:R.backlog.length, tidy:R.within.length + R.misfiled.length,
                   new:R.clusters.length, lists:LIB.playlists.length };
  document.querySelectorAll('[data-count]').forEach(el => {
    const n = counts[el.dataset.count] ?? 0;
    // On the tab bar this rides the icon, so it has to stay narrow.
    el.textContent = !n ? '' : n > 999 ? '999+' : String(n);
  });

  bindSwipeCard();

  const seek = $('#seek');
  if (seek) {
    seek.oninput = () => { PLAYER.scrub = true; $('#pTime').textContent = mmss(+seek.value); };
    seek.onchange = guard(async ev => { const to = +ev.target.value; PLAYER.scrub = false; await playerSeek(to); });
    playerRun();
  } else playerStop();
}

/** Move to another screen: animates in the direction of travel and starts at the top. */
function go(v) {
  // Screens that moved: Home became File; Sources, Engine and History became
  // sections of the Settings sheet. Anything still asking for them lands there.
  if (LEGACY_VIEWS[v]) {
    const to = LEGACY_VIEWS[v];
    return to.section ? openUnderHood(to.section) : go(to.view);
  }
  // A tap on a tab or card takes you out of the sheet.
  if (settingsOpen()) openSettings(false);
  if (v === view) return render();
  const dir = VORDER.indexOf(v) >= VORDER.indexOf(view) ? 1 : -1;
  view = v;
  // The redraw runs inside a View Transition where there is one (motion.js).
  swapScreen(dir, () => { render(dir); window.scrollTo(0, 0); });
  routeNote();
}

