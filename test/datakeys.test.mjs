// The key registry (BUILD-6 F7): web/app/datakeys.js must list every key the
// page writes to localStorage, sessionStorage, IndexedDB or Firestore, each
// with a reason. This scans the page's source for storage writes and fails on
// any key that is not declared there, so a new key cannot ship without a row
// on the "Your data" list (and without "Wipe this device" knowing about it).
//
// What counts as a write:
//   localStorage / sessionStorage / LS / ls?.  setItem(k) and removeItem(k)
//   the page's idb helper                      idb.set(k), idb.del(k)  (c.idb too)
//   IndexedDB itself                           indexedDB.open(db), createObjectStore(s), deleteDatabase(db)
//   Firestore                                  every documents/<path> URL and syncDoc(method, path)
// A key may be a string literal, a template literal (its fixed head is a
// prefix), a constant defined anywhere in the scanned code (A.CHECKS_KEY,
// c.SPACE_KEY resolve too), a one-line key-maker such as PART('index'), or an
// expression built from those (`(dj ? 'bf_mix_' : 'bf_shuf_') + id`). Anything
// the scanner cannot reduce to declared keys is itself a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname;

export function loadRegistry() {
  const box = {};
  vm.createContext(box);
  vm.runInContext(readFileSync(join(ROOT, 'web/app/datakeys.js'), 'utf8') + '\n;this.DATA_KEYS = DATA_KEYS; this.DATA_SERVICES = DATA_SERVICES;', box);
  return { keys: JSON.parse(JSON.stringify(box.DATA_KEYS)), services: JSON.parse(JSON.stringify(box.DATA_SERVICES)) };
}

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(m?js|cjs)$/.test(f)) out.push(p);
  }
  return out;
}

// The page is web/ plus the parts of core/ it bundles; scanning all of core/
// costs nothing and catches a core module that starts writing storage.
const FILES = [...walk(join(ROOT, 'web')), ...walk(join(ROOT, 'core'))].filter(f => !f.endsWith('web/app/datakeys.js'));
const SRC = new Map(FILES.map(f => [relative(ROOT, f), readFileSync(f, 'utf8')]));
// The storage wrappers themselves: their setItem(k, v) / put(v, k) pass a
// parameter through and are not writes of a key of their own.
const WRAPPERS = { 'web/app/storage.js': ['k'], 'web/app/cache.js': ['k'], 'web/audio/store.mjs': ['rec'] };

/** Text of the call's first argument starting at `i` (just past the open paren), with nesting. */
function firstArg(src, i) {
  let depth = 0, q = null, out = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (q) { out += c; if (c === '\\') { out += src[++i]; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; continue; }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) { if (depth === 0) break; depth--; }
    if (c === ',' && depth === 0) break;
    out += c;
  }
  return out.trim();
}

/** Every `const|let NAME = <rhs>` (and `export const`, and `, NAME = ` continuations) in the scanned code. */
const DEFS = new Map();
for (const [file, src] of SRC) {
  for (const m of src.matchAll(/(?:\bconst|\blet|\bvar|,)\s+([A-Za-z_$][\w$]*)\s*=\s*(?!=)/g)) {
    const rhs = firstArg(src, m.index + m[0].length).split('\n')[0].replace(/;\s*$/, '');
    (DEFS.get(m[1]) ?? DEFS.set(m[1], []).get(m[1])).push({ file, rhs });
  }
}

/**
 * Reduce a key expression to [{ key, prefix }], or null when it cannot be.
 * `file` prefers a definition from the same file when a name is defined twice.
 */
function resolve(expr, file, seen = new Set()) {
  expr = expr.trim().replace(/^\((.*)\)$/s, '$1').trim();
  let m;
  if ((m = expr.match(/^(['"])((?:\\.|(?!\1).)*)\1$/s))) return [{ key: m[2], prefix: false }];
  if ((m = expr.match(/^`([^`$]*)`$/s))) return [{ key: m[1], prefix: false }];
  if ((m = expr.match(/^`([^`$]*)\$\{/s))) return m[1] ? [{ key: m[1], prefix: true }] : null;
  // A name, possibly reached through an object: LS key constants, A.CHECKS_KEY, c.SPACE_KEY.
  if ((m = expr.match(/^(?:[A-Za-z_$][\w$]*\??\.)*([A-Za-z_$][\w$]*)$/))) {
    const name = m[1];
    if (seen.has(name)) return null;
    const defs = DEFS.get(name) ?? [];
    const d = defs.find(x => x.file === file) ?? (defs.length === 1 ? defs[0] : defs.find(x => /^['"`]/.test(x.rhs)));
    return d ? resolve(d.rhs, d.file, new Set([...seen, name])) : null;
  }
  // A key-maker: PART('index') where `const PART = id => 'part:' + id`.
  if ((m = expr.match(/^([A-Za-z_$][\w$]*)\((.*)\)$/s))) {
    const d = (DEFS.get(m[1]) ?? []).find(x => x.file === file) ?? DEFS.get(m[1])?.[0];
    const body = d?.rhs.match(/=>\s*(.*)$/s)?.[1];
    return body ? resolve(body, d.file, new Set([...seen, m[1]])) : null;
  }
  // Anything else built from literals: each literal is a key, and a prefix when something is appended to it.
  const lits = [...expr.matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)];
  if (!lits.length) return null;
  const glued = /\+/.test(expr);
  return lits.map(l => ({ key: l[2], prefix: glued }));
}

const lineOf = (src, i) => src.slice(0, i).split('\n').length;

/** Every storage write in the scanned code: { kind, file, line, expr, keys }. */
export function scanWrites() {
  const found = [];
  // A removal can only take data away, so a removal whose key is a loop
  // variable (dropping every part:* key found) is fine; a write never is.
  const add = (kind, file, src, i, expr, removal = false, keys = resolve(expr, file)) => {
    if (WRAPPERS[file]?.includes(expr)) return;
    if (!keys && removal) return;
    found.push({ kind, file, line: lineOf(src, i), expr, keys });
  };
  const isRemoval = call => /removeItem|del\(|deleteDatabase/.test(call);
  for (const [file, src] of SRC) {
    // Comments mention calls in prose; blank them (keeping offsets) so they are not counted.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, s => s.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (s, a) => a + ' '.repeat(s.length - a.length));
    for (const m of code.matchAll(/\b(?:LS|ls|localStorage|sessionStorage|real|storage|local|session)\??\.(?:setItem|removeItem)(?:\?\.)?\(/g))
      add('local', file, code, m.index, firstArg(code, m.index + m[0].length), isRemoval(m[0]));
    for (const m of code.matchAll(/\bidb\.(?:set|del)\(/g))
      add('idb', file, code, m.index, firstArg(code, m.index + m[0].length), isRemoval(m[0]));
    for (const m of code.matchAll(/\bindexedDB\??\.(?:open|deleteDatabase)\(/g))
      add('idb-db', file, code, m.index, firstArg(code, m.index + m[0].length), isRemoval(m[0]));
    for (const m of code.matchAll(/\bcreateObjectStore\(/g))
      add('idb-store', file, code, m.index, firstArg(code, m.index + m[0].length));
    for (const m of code.matchAll(/syncDoc\(\s*'([A-Z]+)'\s*,\s*/g)) {
      const path = firstArg(code, m.index + m[0].length);
      add('firestore', file, code, m.index, path, false, [{ key: path, prefix: false }]);
    }
    for (const m of code.matchAll(/documents\/([A-Za-z]+)[^`'"]*/g))
      found.push({ kind: 'firestore', file, line: lineOf(code, m.index), expr: m[0], keys: [{ key: m[0].slice('documents/'.length), prefix: false }] });
  }
  return found;
}

/** A Firestore path as a pattern: `${x}` and {x} are one segment, a create's ?documentId= names the doc. */
const fsPath = p => p.replace(/^`|`$/g, '')
  .replace(/\?documentId=[^&]*/, '/{}').replace(/\?.*$/, '').replace(/\$\{[^}]*\}|\{[^}]*\}/g, '{}').replace(/\/+$/, '');
const fsMatch = (declared, used) => {
  const a = fsPath(declared).split('/'), b = fsPath(used).split('/');
  return a.length === b.length && a.every((s, i) => s === '{}' || s === b[i]);
};

function declaredFor(kind, key, prefix, reg) {
  if (kind === 'firestore') return reg.some(r => r.where === 'firestore' && fsMatch(r.key, key));
  if (kind === 'idb-db') return reg.some(r => r.where === 'idb-db' && r.key === key);
  if (kind === 'idb-store') return reg.some(r => r.where === 'idb-db' && r.stores?.includes(key));
  // A prefix write is covered only by a declared prefix at least as wide; an exact key by itself or a prefix.
  return reg.some(r => r.where === kind && (prefix ? r.prefix && key.startsWith(r.key)
    : r.key === key || (r.prefix && key.startsWith(r.key))));
}

test('every registry row is complete and every key is unique', () => {
  const { keys, services } = loadRegistry();
  assert.ok(keys.length >= 40, `the registry lists ${keys.length} keys`);
  const seen = new Set();
  for (const k of keys) {
    assert.ok(['local', 'idb', 'idb-db', 'firestore'].includes(k.where), `${k.key}: where`);
    assert.ok(typeof k.key === 'string' && k.key, 'a key');
    assert.ok(typeof k.why === 'string' && k.why.length >= 15, `${k.key}: a reason a listener can read`);
    assert.ok(k.group, `${k.key}: a group`);
    assert.ok(typeof k.name === 'string' && k.name.length >= 3 && k.name.length <= 40 && !/^bf_|_/.test(k.name), `${k.key}: a plain name for Settings › Your data`);
    const id = k.where + ':' + k.key;
    assert.ok(!seen.has(id), `${id} listed twice`);
    seen.add(id);
  }
  assert.deepEqual(keys.filter(k => k.keep).map(k => k.key), ['betterfy-theme'], 'only the theme survives a wipe');
  for (const s of ['Spotify', 'Last.fm', 'Deezer', 'Discogs', 'Wikidata', 'ListenBrainz', 'MusicBrainz'])
    assert.ok(services.some(x => x.name === s), `${s} is on the services list`);
  assert.ok(services.some(x => /Firestore/.test(x.name) && /tag/i.test(x.name)), 'the shared tag table is on the services list');
});

test('the scanner finds the writes it is meant to (it has not gone blind)', () => {
  const w = scanWrites();
  const has = (kind, key) => w.some(x => x.kind === kind && x.keys?.some(k => k.key === key));
  assert.ok(w.length >= 80, `found ${w.length} writes`);
  assert.ok(has('local', 'bf_tok'), 'a literal LS key');
  assert.ok(has('local', 'betterfy-theme'), 'a key held in a constant');
  assert.ok(has('local', 'bf_audio'), 'a key written through ls?.setItem?.() in web/audio');
  assert.ok(has('local', 'bf_verifier') && w.some(x => x.expr === "'bf_verifier'" && /auth\.js/.test(x.file)), 'sessionStorage');
  assert.ok(has('local', 'bf_mix_') && has('local', 'bf_shuf_'), 'an expression of two prefixes');
  assert.ok(has('idb', 'part:'), 'a key-maker, PART(id)');
  assert.ok(has('idb', 'labelchecks'), 'a constant reached through an object (A.CHECKS_KEY)');
  assert.ok(has('idb', 'engine-space-g'), 'a constant reached through ctx (c.SPACE_KEY)');
  assert.ok(has('idb-db', 'betterfy') && has('idb-db', 'betterfy-audio') && has('idb-store', 'audio_v1'), 'IndexedDB databases and stores');
  assert.ok(w.some(x => x.kind === 'firestore' && x.keys[0].key.startsWith('tagContributions')) && w.some(x => x.kind === 'firestore' && /state/.test(x.expr)), 'Firestore paths');
});

test('every key the page writes is in the registry (web/app/datakeys.js)', () => {
  const { keys } = loadRegistry();
  const missing = [];
  for (const w of scanWrites()) {
    if (!w.keys) { missing.push(`${w.file}:${w.line} ${w.kind} write whose key cannot be worked out: ${w.expr}`); continue; }
    for (const k of w.keys) if (!declaredFor(w.kind, k.key, k.prefix, keys))
      missing.push(`${w.file}:${w.line} ${w.kind} "${k.key}"${k.prefix ? ' (prefix)' : ''} — add it to DATA_KEYS with a reason`);
  }
  assert.deepEqual(missing, []);
});

test('the scanner itself: undeclared, unresolvable and wrapper cases', () => {
  const reg = [{ where: 'local', key: 'bf_a' }, { where: 'local', key: 'bf_p_', prefix: true },
    { where: 'firestore', key: 'groups/{g}/state/{doc}' }, { where: 'idb-db', key: 'db', stores: ['s'] }];
  assert.equal(declaredFor('local', 'bf_a', false, reg), true);
  assert.equal(declaredFor('local', 'bf_b', false, reg), false, 'an undeclared key fails');
  assert.equal(declaredFor('local', 'bf_p_x', false, reg), true, 'a key under a declared prefix');
  assert.equal(declaredFor('local', 'bf_p_', true, reg), true, 'a declared prefix');
  assert.equal(declaredFor('local', 'bf_', true, reg), false, 'a wider prefix than the one declared fails');
  assert.equal(declaredFor('idb', 'bf_a', false, reg), false, 'the right store matters');
  assert.equal(declaredFor('firestore', '`groups/${id}/state/feedback`', false, reg), true);
  assert.equal(declaredFor('firestore', '`groups/${id}/members?documentId=${u}`', false, reg), false);
  assert.equal(declaredFor('idb-store', 's', false, reg), true);
  assert.deepEqual(resolve("'x'", 'f'), [{ key: 'x', prefix: false }]);
  assert.deepEqual(resolve('`p:${id}`', 'f'), [{ key: 'p:', prefix: true }]);
  assert.equal(resolve('someUnknownName', 'f'), null, 'a name with no definition is unresolvable');
  assert.equal(resolve('k + v', 'f'), null, 'an expression with no literal is unresolvable');
});

test('no stale rows: every registry key is written somewhere, or marked readOnly', () => {
  const { keys } = loadRegistry();
  const w = scanWrites();
  const stale = keys.filter(r => !r.readOnly && !w.some(x => (x.keys ?? []).some(k =>
    r.where === 'firestore' ? x.kind === 'firestore' && fsMatch(r.key, k.key)
      : r.where === 'idb-db' ? x.kind === 'idb-db' && k.key === r.key
      : x.kind === r.where && (k.key === r.key || (r.prefix && k.key.startsWith(r.key))))));
  assert.deepEqual(stale.map(r => r.where + ':' + r.key), []);
});

test('Your data shows each key by its plain name only, never the raw bf_ key', async () => {
  const { yourDataHTML } = await import('../web/screens/sources.mjs');
  const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  const { keys, services } = loadRegistry();
  const html = yourDataHTML({ esc, DATA_KEYS: keys, DATA_SERVICES: services });
  assert.match(html, /<dt>Your Spotify sign-in <span class="sub">[^<]*<\/span><\/dt>/);
  assert.doesNotMatch(html, /bkraw/, 'no raw key as small print');
  assert.match(html, /<h4>How it picks<\/h4>/);
});
