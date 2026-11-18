/* ---------- the shell: four tabs and the Settings sheet (docs/archive/BUILD-5-PLAN.md §4.1, UI-D) ----------
 * File, Tidy, Discover and Library are the tabs. Everything else is the Settings
 * sheet, one list of collapsible sections (web/screens/settings.mjs has the order,
 * the words and the markup): Your score & how it picks, Listening, What's helping
 * your picks, Your data, History, Appearance, About & updates, then Disconnect.
 * Each shows a one-line status while closed. The first five are drawn here from the
 * screen modules (sources.mjs, engine.mjs, history.mjs, unchanged in what they do);
 * Appearance and About are markup in the page template, wired once, and only
 * shown or hidden here. dispatchAct() (screens.js) finds a section's actions through
 * its [data-uh] wrapper. The routes #/sources, #/engine and #/history open the
 * section of that name (LEGACY_VIEWS, used by go() and the router). */

/** Section ids that are open now. Several can be open; the default is Listening. */
const uhSet = () => (S.uhSet ??= new Set(SCREEN_MODS.settings?.OPEN_BY_DEFAULT ?? ['sources']));
const uhIsOpen = name => uhSet().has(name);
/** The screen modules whose sections are open: what store changes should repaint. */
const uhOpenMods = () => (SCREEN_MODS.settings?.SECTIONS ?? []).filter(x => x.mod && uhIsOpen(x.id)).map(x => x.mod);

/** Tracks in the library, each once: the "M" in "heard N of M". */
let UH_LIBN = { lib: null, n: 0 };
function libTrackCount() {
  if (!LIB) return 0;
  if (UH_LIBN.lib === LIB && UH_LIBN.at === (LIB.liked?.length ?? 0)) return UH_LIBN.n;
  const ids = new Set();
  for (const t of LIB.liked ?? []) ids.add(t.id);
  for (const p of LIB.playlists ?? []) for (const t of p.tracks ?? []) ids.add(t.id);
  UH_LIBN = { lib: LIB, at: LIB.liked?.length ?? 0, n: ids.size };
  return ids.size;
}

/** One plain snapshot of the page for the sections' closed lines. */
function uhSnapshot() {
  const snap = {};
  try { const m = engineSummary(); snap.score = { top1: m?.top1, running: !!m?.running }; } catch { snap.score = {}; }
  try {
    const set = audioSettings(), vm = AUDIO.vm ?? {};
    snap.listening = { on: !!set.on, state: vm.state, reason: vm.reason, done: vm.done, total: vm.total, heard: listenHeard() || vm.heard || 0, library: libTrackCount() };
  } catch { snap.listening = {}; }
  try { snap.helpers = SCREEN_MODS.helpers.helperSummary(helperRowsNow(), HELPERS.checks); } catch { snap.helpers = ''; }
  snap.data = { playlists: LIB?.playlists?.length ?? 0 };
  snap.history = { count: Array.isArray(S.history) ? S.history.length : null };
  snap.appearance = { mode: T?.mode, accent: $('#accentName')?.textContent || null };
  snap.about = { build: typeof BUILD === 'string' ? BUILD : '' };
  return snap;
}

/** The sections' closed lines, by id. */
const uhSummaries = () => SCREEN_MODS.settings.sectionSummaries(uhSnapshot());

/** The score line that heads the first section: the number, and the two things to do with it. */
function uhScoreLine(sum) {
  const known = typeof ENG !== 'undefined' && !!ENG.val?.mine;
  if (!known && !/^Right first time/.test(sum)) return '';   // nothing to point at yet: the section's own words say what it waits for
  return `<div class="scoreline"><b class="scoretxt">${esc(sum)}</b>
    <div class="rowbtns"><button class="b sm" type="button" data-uhscroll="score">See results</button>${known ? '<button class="b sm" type="button" data-act="copy">Copy results</button>' : ''}</div></div>`;
}

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

/** The body of one drawn section (only called while it is open). */
function uhBody(id) {
  const strip = h => h.replace(/^\s*<h1>[^<]*<\/h1>/, '');   // the module's page heading is the section title here
  const ctx = n => screenCtx(n);
  switch (id) {
    case 'engine': return uhScoreLine(uhSummaries().engine) + strip(SCREEN_MODS.engine.view(ctx('engine')));
    case 'sources': return SCREEN_MODS.sources.listeningHTML(ctx('sources'));
    case 'helpers': return SCREEN_MODS.sources.sourcesHTML(ctx('sources'));
    case 'data': { const c = ctx('sources'); return c.DATA_KEYS ? SCREEN_MODS.sources.yourDataHTML({ ...c, bare: true }) : ''; }
    case 'history': return strip(SCREEN_MODS.history.view(ctx('history')));
    default: return '';
  }
}

function underHoodHTML() {
  const sums = uhSummaries(), M = SCREEN_MODS.settings;
  return M.SECTIONS.filter(x => !x.fixed).map(x => {
    const open = uhIsOpen(x.id);
    let body = '';
    if (open) { try { body = uhBody(x.id); } catch (e) { body = `<p class="hint">Couldn’t draw this: ${esc(e.message)}</p>`; } }
    return M.sectionHTML({ id: x.id, title: x.title, summary: sums[x.id], open, body, mod: x.mod, esc });
  }).join('');
}

/** Refresh only the closed lines, in place: listening ticks every few seconds and must not repaint a section. */
function uhSummaryTick() {
  if (!settingsOpen()) return;
  const sums = uhSummaries();
  for (const [id, text] of Object.entries(sums)) {
    const line = document.querySelector(`[data-uhsec="${id}"] > .uhhead .uhs`);
    if (line && line.textContent !== text) line.textContent = text;
  }
}

/** The sections that are markup in the template: show or hide each, and keep its closed line current. */
function uhSyncFixed() {
  const sums = uhSummaries();
  for (const x of SCREEN_MODS.settings.SECTIONS.filter(y => y.fixed)) {
    const box = document.querySelector(`[data-uhsec="${x.id}"]`); if (!box) continue;
    const open = uhIsOpen(x.id);
    box.classList.toggle('open', open);
    box.querySelector('[data-uhtoggle]')?.setAttribute('aria-expanded', String(open));
    const body = box.querySelector('.uhbody'); if (body) body.hidden = !open;
    const line = box.querySelector('.uhs'); if (line) line.textContent = sums[x.id];
  }
}

/** Repaint the sections while the sheet is up. Keeps the sheet's scroll where it was. */
function underHoodRefresh() {
  const host = $('#uhBody');
  if (!host || !settingsOpen()) return;
  const scroller = host.closest('.settings-body'), top = scroller?.scrollTop ?? 0;
  const focusId = document.activeElement?.closest?.('#uhBody') ? document.activeElement.id : '';
  host.innerHTML = underHoodHTML();
  uhSyncFixed();
  if (scroller) scroller.scrollTop = top;
  if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
}

/** Load what the open sections need, then paint. The sheet calls this each time it opens. */
async function underHoodOpen() {
  if (uhIsOpen('history')) S.history = await getLog();
  underHoodRefresh();
  if (S.uhJump) {
    S.uhJump = false;
    document.querySelector(`[data-uhsec="${S.uhOpen}"]`)?.scrollIntoView({ block: 'start' });
  }
}

/** Open the Settings sheet on one of its sections (or just open it with none). */
function openUnderHood(section) {
  if (section && SCREEN_MODS.settings?.SECTIONS.some(x => x.id === section)) { uhSet().add(section); S.uhOpen = section; S.uhJump = true; }
  if (settingsOpen()) underHoodOpen(); else openSettings(true);
}

document.addEventListener('click', guard(async e => {
  const sc = e.target.closest?.('[data-uhscroll]');
  if (sc) {   // "See results": the Score card inside the open score section
    const h = [...document.querySelectorAll('[data-uh="engine"] h2')].find(x => /any better/i.test(x.textContent));
    h?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  const t = e.target.closest?.('[data-uhtoggle]');
  if (!t) return;
  const name = t.dataset.uhtoggle, set = uhSet();
  if (set.has(name)) set.delete(name); else { set.add(name); S.uhOpen = name; }
  await underHoodOpen();
  document.getElementById(`uh-${name}-h`)?.focus({ preventScroll: true });
}));
