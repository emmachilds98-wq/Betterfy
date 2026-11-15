/* ---------- the shell: four tabs and the Settings sheet (docs/BUILD-5-PLAN.md §4.1, UI-D) ----------
 * File, Tidy, Discover and Library are the tabs. Everything that used to be a
 * screen of its own and is not one of those lives in the Settings sheet under
 * "Under the hood": Sources (Listening first, then Last.fm, Wikidata, Discogs),
 * Engine and History. Their modules (screens/sources|engine|history.mjs) are
 * unchanged: this file paints each one's view into the sheet, one section open
 * at a time, and dispatchAct() (screens.js) finds their actions through the
 * [data-uh] wrapper. Anything still asking for the old screens by name is sent
 * to the right place (LEGACY_VIEWS, used by go() and the router). */

/** The sections of "Under the hood", in order, and what each says when closed. */
const UH_SECTIONS = [
  ['sources', 'Listening and genre sources', () => {
    let on = false, key = false;
    try { on = !!audioSettings().on; } catch { /* before the audio glue loads */ }
    try { key = !!lfmKey(); } catch { /* no key */ }
    return `Listening ${on ? 'on' : 'off'} · Last.fm ${key ? 'connected' : 'no key'} · Wikidata · Discogs`;
  }],
  ['engine', 'Engine', () => 'How picks are scored, and how well'],
  ['history', 'History', () => 'Everything Betterfy wrote to Spotify, with undo'],
];

/** The screens whose modules answer a click on the page behind `v`: File is two. */
const actScreens = v => v === 'inbox' ? ['home', 'inbox'] : [v];

const settingsOpen = () => !!$('#settingsPanel')?.classList.contains('open');

/** One line of status for the File tab: "listening 37/412", or empty before listening has ever run. */
function listenStatus() {
  if (!listenEverRan()) return '';
  const done = LISTEN.done ?? 0, total = LISTEN.total ?? 0;
  if (LISTEN.state === 'running' && total) return `listening ${Math.min(done, total).toLocaleString()}/${total.toLocaleString()}`;
  const heard = listenHeard();
  return heard ? `${heard.toLocaleString()} heard` : '';
}

/** The strip at the top of Library's screens: Playlists, New playlists, Shuffle. */
function libNav(cur) {
  const n = R.clusters.length;
  const tabs = [['lists', 'Playlists', ''], ['new', 'New playlists', n ? ` <span class="c">${n > 999 ? '999+' : n}</span>` : ''],
                ['shuffle', 'Shuffle', '']];
  return `<div class="libnav" role="tablist" aria-label="Library">${tabs.map(([v, l, c]) =>
    `<button class="seg" role="tab" data-go="${v}" aria-selected="${v === cur}">${l}${c}</button>`).join('')}</div>`;
}

function underHoodHTML() {
  return UH_SECTIONS.map(([name, title, sub]) => {
    const open = S.uhOpen === name;
    let body = '';
    if (open) {
      // The module's own page heading is the section title here.
      try { body = SCREEN_MODS[name].view(screenCtx(name)).replace(/^\s*<h1>[^<]*<\/h1>/, ''); }
      catch (e) { body = `<p class="hint">Couldn’t draw this: ${esc(e.message)}</p>`; }
    }
    return `<div class="uh${open ? ' open' : ''}" data-uhsec="${name}">
      <button class="uhhead" type="button" data-uhtoggle="${name}" aria-expanded="${open}">
        <span class="uht"><b>${esc(title)}</b><span class="uhs">${esc(sub())}</span></span><span class="chev" aria-hidden="true"></span>
      </button>${open ? `<div class="uhbody" data-uh="${name}">${body}</div>` : ''}</div>`;
  }).join('');
}

/** Repaint the sections while the sheet is up. Keeps the sheet's scroll where it was. */
function underHoodRefresh() {
  const host = $('#uhBody');
  if (!host || !settingsOpen()) return;
  const scroller = host.closest('.settings-body'), top = scroller?.scrollTop ?? 0;
  host.innerHTML = underHoodHTML();
  if (scroller) scroller.scrollTop = top;
}

/** Load what the open section needs, then paint. The sheet calls this each time it opens. */
async function underHoodOpen() {
  if (S.uhOpen === 'history') S.history = await getLog();
  underHoodRefresh();
  if (S.uhJump) {
    S.uhJump = false;
    document.querySelector(`[data-uhsec="${S.uhOpen}"]`)?.scrollIntoView({ block: 'start' });
  }
}

/** Open the Settings sheet on one of its sections (or just open it with none). */
function openUnderHood(section) {
  if (section) { S.uhOpen = section; S.uhJump = true; }
  if (settingsOpen()) underHoodOpen(); else openSettings(true);
}

document.addEventListener('click', guard(async e => {
  const t = e.target.closest?.('[data-uhtoggle]');
  if (!t) return;
  const name = t.dataset.uhtoggle;
  S.uhOpen = S.uhOpen === name ? null : name;
  await underHoodOpen();
}));
