// Get `core/` onto the phone.
//
// The web build ships one self-contained HTML file: no module loader, no second
// request, nothing to serve but a page. That worked while the shared code was
// three flat files with no imports between them — `build-web.mjs` stripped the
// module syntax with a regex, concatenated the results, and order did not matter
// because there was no dependency to get wrong.
//
// `core/` is 34 modules with a real dependency graph, so that approach cannot
// work. Which is why **no part of the v3 engine has ever been able to reach the
// hosted app** — easy to mistake for a deliberate decision, since the engine was
// unwired for other reasons too.
//
// ---------------------------------------------------------------------------
// Why each module gets its own scope instead of being concatenated
//
// The first version of this bundler kept the flat approach and added a name
// collision check, on the theory that a duplicate should fail the build rather
// than silently let the second declaration win. Run against the real graph it
// refused immediately, and it was right to: **every provider adapter exports
// `toEvidence`.** That is not an accident to clean up, it is the provider
// interface working as designed — `lastfm`, `discogs`, `spotify`, `musicbrainz`
// and `legacy` each map their own response shape through a function of the same
// name, which is exactly what makes them interchangeable.
//
// Renaming five adapters to suit the bundler would have been the tail wagging
// the dog. So the bundler changed instead: each module is wrapped in its own
// function scope and returns its exports, and imports become destructuring from
// an already-built module. Same emitted-as-one-file property, no source changes,
// and duplicate names across modules stop being a hazard at all rather than
// being policed.
// ---------------------------------------------------------------------------
//
// What still fails the build, because neither has a correct output:
//
//   - an import cycle, since there is no order to emit one in
//   - a module importing `node:` anything, since it cannot run in a browser.
//     Detected rather than listed, because a hardcoded exclusion list goes
//     stale the first time somebody adds a module and nobody updates it.
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

export const BUNDLER_VERSION = '1.0.0';

/** `import { a, b } from './x.mjs';`, including the multi-line form —
 *  `core/engine.mjs` has one, and a single-line regex would have left half of
 *  it in the output as a syntax error. */
const IMPORT_RE = /^import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]\s*;?/gm;
/** `export { a, b } from './x.mjs';` — a dependency and an export at once. */
const REEXPORT_FROM_RE = /^export\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]\s*;?/gm;
/** `export { a, b };` over names already in scope. */
const REEXPORT_RE = /^export\s*\{([\s\S]*?)\}\s*;?\s*$/gm;
/** `export const|let|var|function|async function|class NAME`. */
const EXPORT_DECL_RE = /^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;

const names = s => s.split(',').map(x => x.trim()).filter(Boolean)
  // `a as b` binds locally as b, which is the name that must be returned.
  .map(x => (x.includes(' as ') ? x.split(/\s+as\s+/)[1].trim() : x));

/** The imports, re-exports and exported names of one module. */
export function moduleShape(src) {
  const imports = [];
  const exports = new Set();

  for (const [re, isExport] of [[IMPORT_RE, false], [REEXPORT_FROM_RE, true]]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const bound = names(m[1]);
      imports.push({ spec: m[2], names: bound });
      if (isExport) for (const n of bound) exports.add(n);
    }
  }

  EXPORT_DECL_RE.lastIndex = 0;
  let m;
  while ((m = EXPORT_DECL_RE.exec(src))) exports.add(m[1]);

  // Run last, and skip anything with `from` — those were handled above.
  REEXPORT_RE.lastIndex = 0;
  while ((m = REEXPORT_RE.exec(src))) {
    if (/\bfrom\b/.test(m[0])) continue;
    for (const n of names(m[1])) exports.add(n);
  }

  return { imports, exports: [...exports] };
}

/** Remove module syntax, leaving a body that is valid inside a function.
 *
 *  Handles `export async function`, which the original build did not — five
 *  modules use it, and each would have shipped as a syntax error. */
export function stripModuleSyntax(src) {
  return src
    .replace(IMPORT_RE, '')
    .replace(REEXPORT_FROM_RE, '')
    .replace(/^import\s*['"][^'"]+['"]\s*;?/gm, '')
    .replace(/^export\s+(async\s+)?(const|function|class|let|var)\b/gm, '$1$2')
    .replace(REEXPORT_RE, '');
}

const isRelative = spec => spec.startsWith('./') || spec.startsWith('../');

/**
 * Walk the graph from `entries`, emitting each module after everything it needs.
 *
 * `read` is injected so the resolver can be tested on graphs that do not exist
 * on disk — including a cyclic one, which by definition cannot be committed.
 */
export function resolveOrder(entries, { read = f => readFileSync(f, 'utf8') } = {}) {
  const order = [];
  const state = new Map();
  const stack = [];

  const visit = path => {
    const at = state.get(path);
    if (at === 'done') return;
    if (at === 'open') {
      const from = stack.indexOf(path);
      throw new Error(`Import cycle: ${[...stack.slice(from), path].join(' -> ')}`);
    }
    state.set(path, 'open');
    stack.push(path);

    const src = read(path);
    for (const { spec } of moduleShape(src).imports) {
      if (spec.startsWith('node:')) {
        throw new Error(`${path} imports ${spec}, which cannot run in a browser. `
          + 'Split the browser-safe part into its own module, or keep this one out of the bundle.');
      }
      if (!isRelative(spec)) continue;
      visit(normalize(join(dirname(path), spec)));
    }

    stack.pop();
    state.set(path, 'done');
    order.push(path);
  };

  for (const e of entries) visit(normalize(e));
  return order;
}

/**
 * Emit the whole graph as one classic script.
 *
 * `expose` names modules whose exports should also become globals, which is how
 * the existing page keeps working: its inline script calls `rank()` and
 * `trackVec()` as bare identifiers, and those came from a flat concatenation
 * that put them in the top-level scope. Everything else stays inside its module,
 * so `profile.mjs`'s `cosine` and `core/intrinsic/cooccurrence.mjs`'s `cosine`
 * coexist without either knowing about the other.
 *
 * @param {string[]} entries  repo-relative entry paths
 * @param {object}  [opts]
 * @param {string[]} [opts.expose]     modules whose exports become globals
 * @param {object}   [opts.namespace]  globalName -> module path
 */
export function bundleModules(entries, { read = f => readFileSync(f, 'utf8'),
                                         expose = [], namespace = {} } = {}) {
  const order = resolveOrder(entries, { read });

  const parts = [
    '/* Generated by bundler.mjs — do not edit here, edit the modules. */',
    'var __mod = Object.create(null);',
  ];

  for (const path of order) {
    const src = read(path);
    const { imports, exports } = moduleShape(src);

    // Bindings are deduplicated per module, and across specs, because a module
    // may legitimately pull the same name in twice. `core/ontology/index.mjs`
    // does exactly that: it imports from `./facets.mjs` *and* re-exports from
    // it, so a naive emitter declares `facetOf` twice and the bundle will not
    // parse. Merge by target module, then drop any name already bound.
    const bound = new Set();
    const bySpec = new Map();
    for (const i of imports) {
      if (!isRelative(i.spec) || !i.names.length) continue;
      const target = normalize(join(dirname(path), i.spec));
      if (!bySpec.has(target)) bySpec.set(target, []);
      for (const n of i.names) {
        if (bound.has(n)) continue;
        bound.add(n);
        bySpec.get(target).push(n);
      }
    }
    const binds = [...bySpec.entries()]
      .filter(([, ns]) => ns.length)
      .map(([target, ns]) => `const { ${ns.join(', ')} } = __mod[${JSON.stringify(target)}];`);

    parts.push(
      `/* ---- ${path} ---- */`,
      `__mod[${JSON.stringify(path)}] = (function () {`,
      ...binds,
      stripModuleSyntax(src).trim(),
      `return { ${exports.join(', ')} };`,
      '})();'
    );
  }

  for (const path of expose) {
    const p = normalize(path);
    if (!order.includes(p)) throw new Error(`Cannot expose ${path}: it is not in the bundle.`);
    parts.push(`Object.assign(globalThis, __mod[${JSON.stringify(p)}]);`);
  }
  for (const [global, path] of Object.entries(namespace)) {
    const p = normalize(path);
    if (!order.includes(p)) throw new Error(`Cannot namespace ${path}: it is not in the bundle.`);
    parts.push(`globalThis[${JSON.stringify(global)}] = __mod[${JSON.stringify(p)}];`);
  }

  return { code: parts.join('\n'), files: order, version: BUNDLER_VERSION };
}
