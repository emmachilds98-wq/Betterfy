/* ===================== UI ===================== */
let LIB = null, CFG = null, TAGS = null, RAW_TAGS = null, R = null, view = 'inbox';
const S = { inboxAt:0, crossMin:3, mfBand:'high', moved:new Set(), editingArtist:null,
            fileSel:new Set(), fileSelFor:null, shown:{} };

/* How many rows of a long Tidy list are drawn. These lists used to stop dead at
 * 60 or 80 — a library with 300 repeats showed 60 and gave no way to reach the
 * rest, so most of what the tool found was unreachable. Rows are still drawn a
 * page at a time, because thousands of rows of buttons is its own problem on a
 * phone, but the rest is now one tap away rather than nowhere. Keyed by list,
 * and by the list's current filter, so changing the filter starts from the top. */
const TIDY_PAGE = 60;
const shownOf = key => S.shown[key] ?? TIDY_PAGE;
function moreButton(key, total) {
  const n = shownOf(key);
  if (total <= n) return '';
  const next = Math.min(TIDY_PAGE, total - n);
  return `<div class="rowbtns" style="margin-top:12px"><button class="b sm" data-more="${esc(key)}">Show ${next} more
    <span class="mono" style="color:var(--ink-3)">· ${n.toLocaleString()} of ${total.toLocaleString()}</span></button></div>`;
}

// Bar order: the four tabs, which is also swipe order. Swiping left and right on a phone
// walks this list, so the gesture and the tab bar agree on what comes next.
// New playlists, Shuffle and Engine follow Library: they are reached from it, and a
// swipe on from Library lands on them. Sources, Engine and History are not screens:
// they are sections of the Settings sheet (app/shell.js). Engine was a Library
// screen from Wave F until 2026-11-18, when it went back to Settings (owner's ask)
// and Library kept one line of its score.
const TABS = ['inbox','tidy','discover','lists'];
const VORDER = [...TABS, 'new', 'shuffle'];
// The five colours of the mark, one per screen — see the [data-v=…] rules in
// the stylesheet, which have to agree with this.
const VHUE = { inbox:'m0', tidy:'m1', discover:'m3', lists:'m4', new:'m2', shuffle:'m4', engine:'m2' };
const VTITLE = { inbox:'File', tidy:'Tidy', discover:'Discover', lists:'Library',
                 new:'New playlists', shuffle:'Shuffle', engine:'How it picks' };
// Screens that sit under another tab on the bar.
const TAB_OF = { new:'lists', shuffle:'lists' };
const tabOf = v => TAB_OF[v] ?? v;
// Old screen names and where they went: Home became File; Sources and History
// became sections of the Settings sheet, and so did Engine. go() and the router use it.
const LEGACY_VIEWS = {
  home:    { view: 'inbox' },
  sources: { section: 'sources' },
  engine:  { section: 'engine' },
  history: { section: 'history' },
};
/* ---------- ⓘ: "how this works" lives behind a button, not in the page ----------
 * One shared helper (docs/archive/BUILD-5-PLAN.md §4.1, UI-F). A screen puts infoBtn()
 * next to its heading with the title and body; tapping it opens the small
 * #infoSheet (web/app/sheet.js). The body is kept by id so the markup stays one
 * short attribute. Screen modules receive it through screenCtx() as ctx.infoBtn. */
const INFO = {};
function infoBtn(id, title, html) {
  INFO[id] = { title, html };
  return `<button class="info" type="button" data-info="${esc(id)}" aria-label="${esc(title)}: how this works">\u24D8</button>`;
}
let toastT;
function toast(msg, undoFn, action) {
  const el = $('#toast');
  // Every Undo toast also says where the full log is: the Settings sheet's History.
  el.innerHTML = esc(msg) + (undoFn ? ' <button id="undoBtn">Undo</button> <button id="histBtn">History</button>' : '');
  el.hidden = false;
  if (undoFn) $('#undoBtn').onclick = async () => { try { await undoFn(); toast('Restored.'); } catch(e){ toast('Undo failed: '+e.message); } };
  if (undoFn) $('#histBtn').onclick = () => { el.hidden = true; openUnderHood('history'); };
  if (action) {
    el.insertAdjacentHTML('beforeend', ` <button id="actBtn">${esc(action.label)}</button>`);
    $('#actBtn').onclick = () => { el.hidden = true; action.run(); };
  }
  clearTimeout(toastT); toastT = setTimeout(() => el.hidden = true, action ? 20000 : undoFn ? 9000 : 3200);
}

