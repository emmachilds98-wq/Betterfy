import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  moduleShape, stripModuleSyntax, resolveOrder, bundleModules, BUNDLER_VERSION,
} from '../bundler.mjs';
import { placementAccuracy } from '../core/validate/loo.mjs';
import { buildSpace, placements } from '../core/intrinsic/space.mjs';

/** A graph that exists only in memory, so cycles and node: imports can be
 *  tested without committing a broken module to the repo. */
const fakeGraph = files => path => {
  if (!(path in files)) throw new Error(`no such fake module: ${path}`);
  return files[path];
};

/* ---------- parsing ---------- */

test('moduleShape reads named imports, both re-export forms, and export async function', () => {
  const src = [
    "import { a, b } from './x.mjs';",
    "import {\n  c,\n  d,\n} from './y.mjs';",
    "export { e, f } from './z.mjs';",
    'export const g = 1;',
    'export function h() {}',
    'export async function i() {}',
    'export class J {}',
    'const k = 2;',
    'export { k };',
  ].join('\n');

  const shape = moduleShape(src);
  assert.deepEqual(shape.imports.map(i => i.spec).sort(), ['./x.mjs', './y.mjs', './z.mjs']);
  assert.deepEqual(shape.imports.find(i => i.spec === './y.mjs').names, ['c', 'd'],
    'a multi-line import must be read whole — core/engine.mjs has one');
  // `export { e, f } from` is a dependency AND an export.
  assert.ok(shape.exports.includes('e') && shape.exports.includes('f'));
  for (const n of ['g', 'h', 'i', 'J', 'k']) {
    assert.ok(shape.exports.includes(n), `${n} should be exported`);
  }
});

test('an aliased import binds under its local name', () => {
  const shape = moduleShape("import { a as b } from './x.mjs';");
  assert.deepEqual(shape.imports[0].names, ['b'], 'the local name is the one that must be declared');
});

test('stripModuleSyntax leaves a body valid inside a function', () => {
  const out = stripModuleSyntax([
    "import { a } from './x.mjs';",
    "export { b } from './y.mjs';",
    'export const c = 1;',
    'export async function d() { return 1; }',
    'export class E {}',
    'export { c };',
  ].join('\n'));

  assert.ok(!/^\s*import\b/m.test(out), 'no import may survive');
  assert.ok(!/^export\b/m.test(out), 'no export may survive');
  assert.match(out, /const c = 1;/);
  assert.match(out, /async function d\(\)/, 'export async function must keep its async');
  assert.match(out, /class E \{\}/);
  // It must actually parse as a function body.
  assert.doesNotThrow(() => new Function(out));
});

/* ---------- ordering and refusals ---------- */

test('dependencies are emitted before the modules that need them', () => {
  const order = resolveOrder(['a.mjs'], { read: fakeGraph({
    'a.mjs': "import { b } from './b.mjs';\nexport const a = b;",
    'b.mjs': "import { c } from './c.mjs';\nexport const b = c;",
    'c.mjs': 'export const c = 1;',
  })});
  assert.deepEqual(order, ['c.mjs', 'b.mjs', 'a.mjs']);
});

test('a diamond is emitted once, in a valid order', () => {
  const order = resolveOrder(['top.mjs'], { read: fakeGraph({
    'top.mjs': "import { l } from './left.mjs';\nimport { r } from './right.mjs';\nexport const t = l + r;",
    'left.mjs': "import { base } from './base.mjs';\nexport const l = base;",
    'right.mjs': "import { base } from './base.mjs';\nexport const r = base;",
    'base.mjs': 'export const base = 1;',
  })});
  assert.equal(order.filter(f => f === 'base.mjs').length, 1, 'a shared dependency is emitted once');
  assert.ok(order.indexOf('base.mjs') < order.indexOf('left.mjs'));
  assert.equal(order.at(-1), 'top.mjs');
});

test('a cycle fails the build and names the loop', () => {
  assert.throws(() => resolveOrder(['a.mjs'], { read: fakeGraph({
    'a.mjs': "import { b } from './b.mjs';\nexport const a = 1;",
    'b.mjs': "import { a } from './a.mjs';\nexport const b = 1;",
  })}), /Import cycle:.*a\.mjs/);
});

test('a node: import fails the build rather than shipping something that cannot run', () => {
  assert.throws(() => resolveOrder(['a.mjs'], { read: fakeGraph({
    'a.mjs': "import { readFileSync } from 'node:fs';\nexport const a = 1;",
  })}), /cannot run in a browser/);
});

test('a bare specifier is left alone — it is somebody else\'s problem, not a missing file', () => {
  assert.doesNotThrow(() => resolveOrder(['a.mjs'], { read: fakeGraph({
    'a.mjs': "import { x } from 'some-package';\nexport const a = 1;",
  })}));
});

test('a name imported and re-exported from the same module is bound exactly once', () => {
  // core/ontology/index.mjs does this, and a naive emitter declares the name
  // twice, which does not parse.
  const { code } = bundleModules(['idx.mjs'], { read: fakeGraph({
    'idx.mjs': "import { f, g } from './f.mjs';\nexport { f } from './f.mjs';\nexport const both = f + g;",
    'f.mjs': 'export const f = 1;\nexport const g = 2;',
  })});
  assert.equal((code.match(/const \{ [^}]*\bf\b/g) ?? []).length, 1,
    'the same name must not be declared twice in one module scope');
  assert.doesNotThrow(() => new Function(code));
});

test('exposing or namespacing a module that is not in the bundle fails loudly', () => {
  const read = fakeGraph({ 'a.mjs': 'export const a = 1;' });
  assert.throws(() => bundleModules(['a.mjs'], { read, expose: ['missing.mjs'] }), /Cannot expose/);
  assert.throws(() => bundleModules(['a.mjs'], { read, namespace: { X: 'missing.mjs' } }), /Cannot namespace/);
});

/* ---------- the real graph ---------- */

const ENTRIES = ['core/engine.mjs', 'core/intrinsic/space.mjs', 'core/validate/loo.mjs',
                 'profile.mjs', 'norm.mjs', 'credits.mjs'];

/** Build the real bundle and return its module table, without touching
 *  globalThis — a test that pollutes the global scope makes every later test in
 *  the process a liar. */
function runBundle() {
  const { code, files } = bundleModules(ENTRIES);
  const mod = new Function(`${code}\nreturn __mod;`)();
  return { mod, files };
}

test('the real engine graph bundles, parses and runs', () => {
  const { mod, files } = runBundle();
  assert.ok(files.length > 25, `expected the whole graph, got ${files.length} modules`);
  assert.equal(typeof mod['core/engine.mjs'].profileLibrary, 'function');
  assert.equal(typeof mod['core/intrinsic/space.mjs'].placements, 'function');
  assert.equal(typeof mod['profile.mjs'].rank, 'function');
  assert.ok(BUNDLER_VERSION);
});

test('every provider adapter keeps its own toEvidence — the interface survives bundling', () => {
  // This is the case that killed the flat-concatenation design: five adapters
  // each export a function of the same name, on purpose, because that is what
  // makes them interchangeable.
  const { mod } = runBundle();
  for (const p of ['lastfm', 'discogs', 'spotify', 'musicbrainz']) {
    assert.equal(typeof mod[`core/sources/${p}.mjs`].toEvidence, 'function',
      `${p} must keep its own toEvidence`);
  }
  // `legacy` is the exception, and correctly so: it reads v1's caches rather
  // than a live provider response, so it exports cacheToEvidence /
  // entryToEvidence instead. Asserted rather than assumed, because the first
  // version of this test claimed five adapters share the name and only four do.
  assert.equal(typeof mod['core/sources/legacy.mjs'].cacheToEvidence, 'function');
  assert.equal(mod['core/sources/legacy.mjs'].toEvidence, undefined);
  const { toEvidence: lastfm } = mod['core/sources/lastfm.mjs'];
  const { toEvidence: discogs } = mod['core/sources/discogs.mjs'];
  assert.notEqual(lastfm, discogs, 'and they must be different functions, not one shadowing the other');
});

test('v1 and v3 can both define cosine without either shadowing the other', () => {
  const { mod } = runBundle();
  const a = mod['profile.mjs'].cosine;
  const b = mod['core/intrinsic/cooccurrence.mjs'].cosine;
  assert.equal(typeof a, 'function');
  assert.equal(typeof b, 'function');
  assert.notEqual(a, b);
});

test('PARITY: the bundled engine produces byte-identical output to the imported one', () => {
  // Without this, the bundle could differ from what every test in the suite
  // actually exercises, and the phone would run code nothing had verified.
  const lib = { playlists: [
    { id: 'p1', name: 'One', tracks: Array.from({ length: 8 }, (_, i) => ({
      id: `a${i}`, name: `a${i}`, artists: [{ id: 'x1' }, { id: 'x2' }],
      albumType: 'single', albumTracks: 2, released: '2020-01-01',
      duration_ms: 400000 + i * 1000, isrc: `GBAAA24${String(10000 + i).slice(0, 5)}`,
      popularity: 40 + i, added_at: '2025-01-01T12:00:00Z' })) },
    { id: 'p2', name: 'Two', tracks: Array.from({ length: 8 }, (_, i) => ({
      id: `b${i}`, name: `b${i}`, artists: [{ id: 'y1' }, { id: 'y2' }],
      albumType: 'album', albumTracks: 12, released: '2005-01-01',
      duration_ms: 200000 + i * 1000, isrc: `GBBBB24${String(20000 + i).slice(0, 5)}`,
      popularity: 70 + i, added_at: '2025-02-01T12:00:00Z' })) },
    { id: 'p3', name: 'Both', tracks: [] },
  ]};
  lib.playlists[2].tracks = [...lib.playlists[0].tracks.slice(0, 4), ...lib.playlists[1].tracks.slice(0, 4)];

  const { mod } = runBundle();
  const bundled = mod['core/intrinsic/space.mjs'];
  const bundledLoo = mod['core/validate/loo.mjs'];

  // Ranked placement for one track, through both paths.
  const track = lib.playlists[0].tracks[5];
  const mine = placements(track, buildSpace(lib));
  const theirs = bundled.placements(track, bundled.buildSpace(lib));
  assert.deepEqual(JSON.parse(JSON.stringify(theirs)), JSON.parse(JSON.stringify(mine)));

  // And the whole harness, which exercises far more of the graph.
  assert.deepEqual(
    JSON.parse(JSON.stringify(bundledLoo.placementAccuracy(lib, { folds: 3 }))),
    JSON.parse(JSON.stringify(placementAccuracy(lib, { folds: 3 }))),
  );
});

test('the bundle carries no module syntax that a classic script would choke on', () => {
  const { code } = bundleModules(ENTRIES);
  // Anchored to line starts, so the word appearing inside a comment is fine.
  assert.ok(!/^\s*import\s+[{'"]/m.test(code), 'a surviving import would be a syntax error');
  assert.ok(!/^export\s/m.test(code), 'a surviving export would be a syntax error');
});

test('musicbrainz stays in the bundle, because it no longer drags node: in with it', () => {
  // The adapter used to re-export the root module's resolver purely as a
  // convenience nothing consumed, and that one line put node:fs in the graph.
  const { files } = runBundle();
  assert.ok(files.includes('core/sources/musicbrainz.mjs'));
  assert.ok(!files.includes('cache.mjs'), 'cache.mjs is Node-only and must not be reachable');
  assert.ok(!readFileSync('core/sources/musicbrainz.mjs', 'utf8').includes("from '../../musicbrainz.mjs'"),
    'the re-export that blocked bundling must stay gone');
});
