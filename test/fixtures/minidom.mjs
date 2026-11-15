// A small DOM, enough to run web/app/patch.mjs without jsdom. It copies the
// two browser behaviours the patcher has to work around: moving or removing a
// node blurs it if it holds focus, and resets the scroll offsets in its
// subtree. Markup is kept raw (no entity decoding), which is all the tests need.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

class Node {
  constructor(doc, type) { this.ownerDocument = doc; this.nodeType = type; this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get nextSibling() {
    const p = this.parentNode; if (!p) return null;
    return p.childNodes[p.childNodes.indexOf(this) + 1] || null;
  }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument; }
  get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
  _detach() {
    const p = this.parentNode; if (!p) return;
    const doc = this.ownerDocument;
    if (doc.activeElement && contains(this, doc.activeElement)) doc.activeElement = doc.body;
    walk(this, n => { n.scrollTop = 0; n.scrollLeft = 0; });
    p.childNodes.splice(p.childNodes.indexOf(this), 1);
    this.parentNode = null;
    doc.ops.push(['detach', this]);
  }
  insertBefore(node, ref) {
    if (ref && ref.parentNode !== this) throw new Error('ref is not a child');
    if (node === ref) return node;
    node._detach();
    const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(i, 0, node);
    node.parentNode = this;
    return node;
  }
  appendChild(node) { return this.insertBefore(node, null); }
  removeChild(node) { if (node.parentNode !== this) throw new Error('not a child'); node._detach(); return node; }
}

class CharNode extends Node {
  constructor(doc, type, value) { super(doc, type); this.nodeValue = value; }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : ''; }
  get outerHTML() { return this.nodeType === 3 ? this.nodeValue : `<!--${this.nodeValue}-->`; }
}

class Element extends Node {
  constructor(doc, tag) {
    super(doc, 1); this.tagName = tag.toUpperCase(); this.attributes = [];
    this.scrollTop = 0; this.scrollLeft = 0;
  }
  getAttribute(n) { const a = this.attributes.find(x => x.name === n); return a ? a.value : null; }
  hasAttribute(n) { return this.attributes.some(x => x.name === n); }
  setAttribute(n, v) {
    const a = this.attributes.find(x => x.name === n);
    if (a) a.value = String(v); else this.attributes.push({ name: n, value: String(v) });
    this.ownerDocument.ops.push(['attr', this, n]);
  }
  removeAttribute(n) { this.attributes = this.attributes.filter(x => x.name !== n); }
  querySelectorAll(sel) {
    const names = sel.split(',').map(s => s.trim().replace(/^\[|\]$/g, ''));
    const out = [];
    for (const c of this.childNodes) walk(c, n => { if (n.nodeType === 1 && names.some(x => n.hasAttribute(x))) out.push(n); });
    return out;
  }
  focus() { this.ownerDocument.activeElement = this; }
  get type() { return (this.getAttribute('type') || 'text').toLowerCase(); }
  get value() { return this._value ?? (this.tagName === 'TEXTAREA' ? this.textContent : this.getAttribute('value') ?? ''); }
  set value(v) { this._value = String(v); }
  get checked() { return this._checked ?? this.hasAttribute('checked'); }
  set checked(v) { this._checked = !!v; }
  get selected() { return this._selected ?? this.hasAttribute('selected'); }
  set selected(v) { this._selected = !!v; }
  get selectionStart() { if (!this._textual()) throw new Error('no selection'); return this._sel?.[0] ?? this.value.length; }
  get selectionEnd() { if (!this._textual()) throw new Error('no selection'); return this._sel?.[1] ?? this.value.length; }
  get selectionDirection() { return this._sel?.[2] ?? 'none'; }
  setSelectionRange(s, e, d = 'none') { if (!this._textual()) throw new Error('no selection'); this._sel = [s, e, d]; }
  _textual() { return this.tagName === 'TEXTAREA' || (this.tagName === 'INPUT' && !['checkbox', 'radio'].includes(this.type)); }
  get innerHTML() { return this.childNodes.map(c => c.outerHTML).join(''); }
  set innerHTML(html) {
    for (const c of [...this.childNodes]) c._detach();
    const host = this.tagName === 'TEMPLATE' ? (this.content = new Fragment(this.ownerDocument)) : this;
    parse(this.ownerDocument, html, host);
  }
  get outerHTML() {
    const t = this.tagName.toLowerCase();
    const attrs = this.attributes.map(a => ` ${a.name}="${a.value}"`).join('');
    return VOID.has(t) ? `<${t}${attrs}>` : `<${t}${attrs}>${this.innerHTML}</${t}>`;
  }
}

class Fragment extends Node { constructor(doc) { super(doc, 11); } }

class Document extends Node {
  constructor() {
    super(null, 9); this.ownerDocument = this; this.ops = [];
    this.documentElement = this.appendChild(new Element(this, 'html'));
    this.body = this.documentElement.appendChild(new Element(this, 'body'));
    this.activeElement = this.body;
  }
  createElement(tag) { return new Element(this, tag); }
}

function walk(n, f) { f(n); for (const c of n.childNodes) walk(c, f); }
function contains(root, n) { for (; n; n = n.parentNode) if (n === root) return true; return false; }

const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parse(doc, html, host) {
  const stack = [host];
  const top = () => stack[stack.length - 1];
  const re = /<!--([\s\S]*?)-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+|<)/g;
  for (const m of html.matchAll(re)) {
    if (m[1] != null) top().appendChild(new CharNode(doc, 8, m[1]));
    else if (m[2]) {
      const t = m[2].toUpperCase();
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName === t) { stack.length = i; break; }
    } else if (m[3]) {
      const el = new Element(doc, m[3]);
      for (const a of m[4].matchAll(ATTR)) el.attributes.push({ name: a[1].toLowerCase(), value: a[2] ?? a[3] ?? a[4] ?? '' });
      top().appendChild(el);
      if (!VOID.has(m[3].toLowerCase())) stack.push(el);
    } else {
      const last = top().lastChild;
      if (last && last.nodeType === 3) last.nodeValue += m[5];
      else top().appendChild(new CharNode(doc, 3, m[5]));
    }
  }
  doc.ops.length = 0;
}

/** A fresh document and a <div> in its body holding `html`. */
export function mount(html = '') {
  const doc = new Document();
  const el = doc.body.appendChild(doc.createElement('div'));
  el.innerHTML = html;
  return { doc, el };
}
