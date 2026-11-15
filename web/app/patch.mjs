// A5 of docs/BUILD-5-PLAN.md: the keyed patcher.
//
// patch(el, html) makes el's children match `html` while reusing the nodes it
// already has, so a re-render after a click no longer throws away the focused
// input, its caret, or a scrolled list. Children are matched by `data-key`
// when they carry one, and by position (same tag) when they don't.
//
// The page still does a full innerHTML render on a screen change or a sync;
// patch() is for re-renders of the screen already showing (A4 wires it in).
//
// Rules a screen can rely on:
//   - A child with data-key="k" is the same node before and after, wherever it
//     moves, as long as its tag is unchanged. Keys only need to be unique among
//     siblings. A duplicate key gets a fresh node.
//   - The focused element keeps focus and its selection, even when a reorder
//     moves it (browsers blur a node on move); its `value` is never overwritten.
//   - Scroll offsets are kept on `el` itself and on every element with a
//     data-key or a data-keep-scroll attribute (browsers reset scroll on move).
//   - data-patch="skip" on the new markup leaves that element's existing
//     attributes and subtree alone (a playing <audio>, a third-party widget).
//
// It needs only the plain DOM (template, insertBefore, attributes), so the
// tests run it against a small fake DOM, not jsdom.

const ELEMENT = 1, TEXT = 3, COMMENT = 8;

const keyOf = n => (n.nodeType === ELEMENT ? n.getAttribute('data-key') : null);
const sameKind = (a, b) => a.nodeType === b.nodeType
  && (a.nodeType !== ELEMENT || a.tagName === b.tagName);
const contains = (root, n) => { for (; n; n = n.parentNode) if (n === root) return true; return false; };

/** Patch el's children to match html. Returns el. */
export function patch(el, html) {
  const doc = el.ownerDocument;
  const tpl = doc.createElement('template');
  tpl.innerHTML = html;
  const saved = remember(el, doc);
  // Rows that opt in with data-flip slide to their new place (motion.js).
  const flip = typeof globalThis.flipRecord === 'function' ? globalThis.flipRecord(el) : null;
  morphChildren(el, tpl.content, saved.active);
  restore(saved, doc);
  if (flip && flip.size) globalThis.flipPlay(el, flip);
  return el;
}

/** Note focus, caret and scroll offsets, which moving a node would lose. */
function remember(el, doc) {
  const active = doc.activeElement && doc.activeElement !== doc.body
    && contains(el, doc.activeElement) ? doc.activeElement : null;
  let sel = null;
  if (active) {
    try {
      if (typeof active.selectionStart === 'number') {
        sel = [active.selectionStart, active.selectionEnd, active.selectionDirection || 'none'];
      }
    } catch { /* inputs like checkbox throw on selectionStart */ }
  }
  const scrolls = [];
  const note = n => { if (n.scrollTop || n.scrollLeft) scrolls.push([n, n.scrollTop, n.scrollLeft]); };
  note(el);
  for (const n of el.querySelectorAll('[data-key],[data-keep-scroll]')) note(n);
  return { el, active, sel, scrolls };
}

function restore({ el, active, sel, scrolls }, doc) {
  for (const [n, top, left] of scrolls) {
    if (!contains(el, n)) continue;
    if (n.scrollTop !== top) n.scrollTop = top;
    if (n.scrollLeft !== left) n.scrollLeft = left;
  }
  if (!active || !contains(el, active)) return;
  if (doc.activeElement !== active) active.focus({ preventScroll: true });
  if (sel && typeof active.setSelectionRange === 'function') {
    try { active.setSelectionRange(sel[0], sel[1], sel[2]); } catch { /* not a text input */ }
  }
}

function morphChildren(from, to, active) {
  const keyed = new Map();
  for (let c = from.firstChild; c; c = c.nextSibling) {
    const k = keyOf(c);
    if (k != null && !keyed.has(k)) keyed.set(k, c);
  }
  // Everything before `cur` is already in its final place.
  let cur = from.firstChild;
  for (let n = to.firstChild; n;) {
    const next = n.nextSibling;
    const k = keyOf(n);
    let match = null;
    if (k != null) {
      match = keyed.get(k) || null;
      if (match) keyed.delete(k);
      if (match && !sameKind(match, n)) match = null;
    } else if (cur && keyOf(cur) == null && sameKind(cur, n)) {
      match = cur;
    }
    if (match) {
      if (match === cur) cur = cur.nextSibling;
      else from.insertBefore(match, cur);
      morphNode(match, n, active);
    } else {
      from.insertBefore(n, cur); // adopts the new node out of the template
    }
    n = next;
  }
  // Whatever is left was not asked for.
  while (cur) { const nx = cur.nextSibling; from.removeChild(cur); cur = nx; }
}

function morphNode(a, b, active) {
  if (a.nodeType === TEXT || a.nodeType === COMMENT) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  if (b.getAttribute('data-patch') === 'skip') return;
  syncAttributes(a, b);
  const tag = a.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION') {
    syncFormState(a, b, a === active);
    if (tag === 'TEXTAREA') return; // its text is its value
  }
  morphChildren(a, b, active);
}

function syncAttributes(a, b) {
  const want = b.attributes;
  for (let i = 0; i < want.length; i++) {
    const { name, value } = want[i];
    if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  }
  const have = a.attributes;
  for (let i = have.length - 1; i >= 0; i--) {
    const { name } = have[i];
    if (!b.hasAttribute(name)) a.removeAttribute(name);
  }
}

/** Attributes don't move a live control's state; set the properties too. */
function syncFormState(a, b, focused) {
  const tag = a.tagName;
  if (tag === 'OPTION') {
    const on = b.hasAttribute('selected');
    if (a.selected !== on) a.selected = on;
    return;
  }
  if (tag === 'INPUT' && (a.type === 'checkbox' || a.type === 'radio')) {
    const on = b.hasAttribute('checked');
    if (a.checked !== on) a.checked = on;
    return;
  }
  if (focused || tag === 'SELECT') return; // the person is typing; SELECT follows its options
  const v = tag === 'TEXTAREA' ? b.textContent : (b.getAttribute('value') ?? '');
  if (a.value !== v) a.value = v;
}
