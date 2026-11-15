const VIEWS = { home:vHome, inbox:vInbox, tidy:vTidy,
                new:vNew, discover:vDiscover, shuffle:vShuffle, lists:vLists,
                engine:vEngine, history:vHistory, sources:vSources };
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
  main.classList.remove('in-l', 'in-r');
  main.innerHTML = VIEWS[view]();
  if (dir) { void main.offsetWidth; main.classList.add(dir > 0 ? 'in-l' : 'in-r'); }

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
}

/** Move to another screen: animates in the direction of travel and starts at the top. */
function go(v) {
  if (v === view) return render();
  const dir = VORDER.indexOf(v) >= VORDER.indexOf(view) ? 1 : -1;
  view = v;
  render(dir);
  window.scrollTo(0, 0);
}

