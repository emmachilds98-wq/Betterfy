/* ---------- the shell: four tabs and the Settings sheet (docs/BUILD-5-PLAN.md §4.1, UI-D) ----------
 * File, Tidy, Discover and Library are the tabs. Everything that used to be a
 * screen of its own and is not one of those lives in the Settings sheet under
 * "Under the hood": Sources (Listening first, then Last.fm, Wikidata, Discogs),
 * Engine and History. Their modules are
 * unchanged: this file paints each one's view into the sheet, one section open
 * at a time, and dispatchAct() (screens.js) finds their actions through the
 * [data-uh] wrapper. Anything still asking for the old screens by name is sent
 * to the right place (LEGACY_VIEWS, used by go() and the router). */

/** The sections of "Under the hood", in order, and what each says when closed. */
const UH_SECTIONS = [
  ['sources', 'Listening and genre sources', () => {
    let on = false, key = false, own = false;
    try { on = !!audioSettings().on; } catch { /* before the audio glue loads */ }
    try { key = !!lfmKey(); own = !!LS.getItem('bf_lfm'); } catch { /* no key */ }
    return `Listening ${on ? 'on' : 'off'} · Last.fm ${key ? (own ? 'on, your key' : 'on, built-in key') : 'off'} · Wikidata on · Deezer on · ListenBrainz on`;
  }],
  ['engine', 'How it picks', () => {
    // The closed section's one line: the last score, when there is one.
    try { const s = engineSummary(); if (Number.isFinite(s?.top1)) return `Right first time on ${Math.round(s.top1 * 100)}% of what you filed`; }
    catch { /* no score yet */ }
    return 'How picks are scored, and how well';
  }],
  ['history', 'History', () => 'Everything Betterfy wrote to Spotify, with undo'],
];

/** The screens whose modules answer a click on the page behind `v`: File is two. */
const actScreens = v => v === 'inbox' ? ['home', 'inbox'] : [v];

const settingsOpen = () => !!$('#settingsPanel')?.classList.contains('open');

/** One line of status for the File tab: "listening 37/412", or empty before listening has ever run. */
function listenStatus() {
  if (!listenEverRan()) return '';
  const done = LISTEN.done ?? 0, total = LISTEN.total ?? 0;
  // After its songs a run tidies up (tempo, keys, descriptions): say so, not "listening 1/1".
  const tidy = listenTidyText(LISTEN, '/');
  if (tidy) return `tidying up: ${tidy}`;
  if (LISTEN.state === 'running' && total) return `listening ${Math.min(done, total).toLocaleString()}/${total.toLocaleString()}`;
  const heard = listenHeard();
  return heard ? `${heard.toLocaleString()} heard` : '';
}

/** The strip at the top of Library's sub-screens, New playlists and Shuffle: the way back. */
function libBack(cur) {
  const n = cur === 'new' ? R.clusters.length : 0;
  return `<div class="libnav"><button class="b sm" data-go="lists">\u2190 Library</button>${n ? `<span class="c">${n > 999 ? '999+' : n}</span>` : ''}</div>`;
}

/* ---------- the playlist sheet (UI-E) ----------
 * Tapping a Library row opens #plSheet, built on the Settings sheet's own look and
 * the same scrim. S.plSheet is the open playlist's id. The router gives it a
 * history entry ("#/lists/pl:<id>") so back closes it; lists.mjs draws the body. */
function plSheetEl() {
  let el = $('#plSheet');
  if (!el) {
    el = document.createElement('div');
    el.id = 'plSheet'; el.className = 'settings plsheet';
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-hidden', 'true'); el.setAttribute('aria-label', 'Playlist');
    document.body.appendChild(el);
    // Wired once, when the sheet is first made.
    addEventListener('click', e => {
      if (e.target.closest?.('[data-plclose]') || (S.plSheet && e.target.id === 'scrim')) closePlSheet();
    });
    addEventListener('keydown', e => { if (e.key === 'Escape' && S.plSheet) closePlSheet(); });
  }
  return el;
}
function plSheetPaint() {
  if (!S.plSheet) return;
  const el = plSheetEl(), top = el.querySelector('.pls-body')?.scrollTop ?? 0;
  el.innerHTML = '<div class="grabber"></div>' + (SCREEN_MODS.lists.sheetHTML(screenCtx('lists'), S.plSheet) || '');
  const b = el.querySelector('.pls-body'); if (b) b.scrollTop = top;
  if (!b) closePlSheet();
}
let plOpener = null; // focus goes back here when the sheet closes
function openPlSheet(id) {
  if (!id) return;
  if (!S.plSheet) plOpener = document.activeElement;
  S.plSheet = id;
  plSheetPaint();
  plSheetEl().classList.add('open'); plSheetEl().setAttribute('aria-hidden', 'false');
  $('#scrim').classList.add('open');
  plSheetEl().setAttribute('aria-label', CFG[id]?.name ?? 'Playlist');
  plSheetEl().querySelector('[data-plclose]')?.focus();
  routeNote();
}
function closePlSheet() {
  if (!S.plSheet) return;
  const closedId = S.plSheet;
  S.plSheet = null;
  const el = plSheetEl();
  el.classList.remove('open'); el.setAttribute('aria-hidden', 'true');
  if (!settingsOpen()) $('#scrim').classList.remove('open');
  routeNote();
  const back = plOpener; plOpener = null;
  if (!settingsOpen()) (back?.isConnected ? back : document.querySelector('[data-act="plopen"][data-pl="' + CSS.escape(closedId) + '"]'))?.focus();
}

function underHoodHTML() {
  // Every source and engine part, on or off, at the top: always shown, never folded (app/helpers.js).
  return (typeof helpersPanelHTML === 'function' ? helpersPanelHTML() : '') + UH_SECTIONS.map(([name, title, sub]) => {
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
