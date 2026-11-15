/* ===================== UI ===================== */
let LIB = null, CFG = null, TAGS = null, RAW_TAGS = null, R = null, view = 'home';
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

// Bar order, which is also swipe order: swiping left and right on a phone
// walks this list, so the gesture and the tab bar agree on what comes next.
const VORDER = ['home','inbox','tidy','discover','shuffle','new','lists','engine','history','sources'];
// The five colours of the mark, one per screen — see the [data-v=…] rules in
// the stylesheet, which have to agree with this.
const VHUE = { home:'accent', inbox:'m0', tidy:'m1', discover:'m3', shuffle:'m4',
               new:'m2', lists:'m4', engine:'m2', history:'m3', sources:'m1' };
const VTITLE = { home:'Home', inbox:'File', tidy:'Tidy', discover:'Discover', shuffle:'Shuffle',
                 new:'New playlists', lists:'Playlists', engine:'Engine', history:'History',
                 sources:'Sources' };
// The three that live behind "More" rather than on the bar.
const SECONDARY = new Set(['new','lists','engine','history','sources']);
let toastT;
function toast(msg, undoFn) {
  const el = $('#toast');
  el.innerHTML = esc(msg) + (undoFn ? ' <button id="undoBtn">Undo</button>' : '');
  el.hidden = false;
  if (undoFn) $('#undoBtn').onclick = async () => { try { await undoFn(); toast('Restored.'); } catch(e){ toast('Undo failed: '+e.message); } };
  clearTimeout(toastT); toastT = setTimeout(() => el.hidden = true, undoFn ? 9000 : 3200);
}

