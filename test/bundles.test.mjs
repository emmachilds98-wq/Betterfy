import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { parseHeaders, members, scanHeaders, engineBundle, audioBundle } from '../web/bundles.mjs';
import { bundleModules, stripModuleSyntax } from '../bundler.mjs';

/* The lazy bundles are declared by a `// @bundle` line in each module
 * (docs/BUILD-5-PLAN.md A7, web/bundles.mjs) instead of by lists in
 * build-web.mjs. These are the guards that replace reading the list: a header
 * that goes missing, or one that appears, shows up as a difference against the
 * committed docs/engine.js and docs/audio.js, which are always rebuilt. */

const ROOT = new URL('..', import.meta.url).pathname;
const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const headers = scanHeaders({ root: ROOT });

/* ---------- the convention itself ---------- */

test('a header names a bundle, and optionally an order and a global', () => {
  const src = '// @bundle engine order=30 global=BetterfyThing\n// @bundle audio\n// What it is.\nexport const a = 1;\n';
  assert.deepEqual(parseHeaders('core/x.mjs', src), [
    { path: 'core/x.mjs', bundle: 'engine', order: 30, global: 'BetterfyThing' },
    { path: 'core/x.mjs', bundle: 'audio', order: null, global: null },
  ]);
  // Only at column 0: a mention inside a doc comment is not a header.
  assert.deepEqual(parseHeaders('core/y.mjs', ' * e.g. `// @bundle engine`\n  // @bundle engine\n'), []);
});

test('a mistyped header fails the build instead of quietly dropping a module', () => {
  assert.throws(() => parseHeaders('a.mjs', '// @bundle engin global=X\n'), /names no bundle/);
  assert.throws(() => parseHeaders('a.mjs', '// @bundle\n'), /names no bundle/);
  assert.throws(() => parseHeaders('a.mjs', '// @bundle engine globl=X\n'), /unknown @bundle option/);
  assert.throws(() => parseHeaders('a.mjs', '// @bundle engine order=ten\n'), /integer/);
  assert.throws(() => parseHeaders('a.mjs', '// @bundle engine global=1x\n'), /not an identifier/);
  assert.throws(() => parseHeaders('a.mjs', '// @bundle engine BetterfyX\n'), /bad @bundle option/);
  assert.throws(() => parseHeaders('a.mjs', '// @bundle engine\n// @bundle engine global=X\n'), /two/);
});

test('members sort by order, then unnumbered ones by path, and a global is declared once', () => {
  const hs = [
    { path: 'core/z.mjs', bundle: 'engine', order: null, global: 'BetterfyZ' },
    { path: 'core/b.mjs', bundle: 'engine', order: 20, global: 'BetterfyB' },
    { path: 'core/a.mjs', bundle: 'engine', order: null, global: null },
    { path: 'core/c.mjs', bundle: 'engine', order: 10, global: 'BetterfyC' },
    { path: 'core/d.mjs', bundle: 'audio', order: 1, global: 'BetterfyD' },
  ];
  assert.deepEqual(members('engine', hs).map(h => h.path), ['core/c.mjs', 'core/b.mjs', 'core/a.mjs', 'core/z.mjs']);
  assert.deepEqual(engineBundle({ headers: hs }).namespace,
    { BetterfyC: 'core/c.mjs', BetterfyB: 'core/b.mjs', BetterfyZ: 'core/z.mjs' });
  assert.throws(() => members('engine', [...hs, { path: 'core/y.mjs', bundle: 'engine', order: null, global: 'BetterfyB' }]),
    /BetterfyB is declared by both/);
});

test('the header line is stripped, so it costs the shipped bundle nothing', () => {
  const body = '// What it is.\nexport const a = 1;\n';
  assert.equal(stripModuleSyntax('// @bundle engine order=1 global=BetterfyA\n' + body), stripModuleSyntax(body));
  const files = { 'a.mjs': '// @bundle engine global=BetterfyA\n' + body };
  const plain = { 'a.mjs': body };
  const opt = r => ({ read: f => r[f], namespace: { BetterfyA: 'a.mjs' } });
  assert.equal(bundleModules(['a.mjs'], opt(files)).code, bundleModules(['a.mjs'], opt(plain)).code);
});

test('the audio sweep leaves out a core/audio module that says @bundle engine', () => {
  const dirs = { 'core/audio': ['a.mjs', 'b.mjs', 'mel.mjs'], 'core/audio/dsp': ['k.mjs'], 'core/intrinsic': ['audio-x.mjs', 'space.mjs'] };
  const hs = [
    { path: 'web/audio/index.mjs', bundle: 'audio', order: 10, global: 'BetterfyAudio' },
    { path: 'core/audio/b.mjs', bundle: 'engine', order: null, global: 'BetterfyB' },
  ];
  const a = audioBundle({ headers: hs, list: d => dirs[d] ?? [] });
  assert.deepEqual(a.entries, ['web/audio/index.mjs', 'core/audio/a.mjs', 'core/audio/mel.mjs',
                               'core/audio/dsp/k.mjs', 'core/intrinsic/audio-x.mjs']);
  assert.deepEqual(a.namespace, { BetterfyAudio: 'web/audio/index.mjs', BetterfyAudioXIntrinsic: 'core/intrinsic/audio-x.mjs' });
});

/* ---------- the real tree ---------- */

/** The modules and globals a built bundle carries, in the order it carries them. */
const shapeOf = code => ({
  modules: [...code.matchAll(/^\/\* ---- (.+) ---- \*\/$/gm)].map(m => m[1]),
  globals: [...code.matchAll(/^globalThis\["([\w$]+)"\] = __mod\["([^"]+)"\];$/gm)].map(m => `${m[1]} = ${m[2]}`),
});
const shapeFrom = ({ entries, namespace }) => ({
  modules: bundleModules(entries, { namespace }).files,
  globals: Object.entries(namespace).map(([g, p]) => `${g} = ${p}`),
});

for (const [file, bundle] of [['docs/engine.js', engineBundle], ['docs/audio.js', audioBundle]]) {
  test(`${file} carries exactly the modules and globals the @bundle lines declare`, () => {
    const built = shapeOf(read(file));
    const declared = shapeFrom(bundle({ headers }));
    const hint = `— a \`// @bundle\` line went missing or was added; if you meant it, rebuild with node build-web.mjs`;
    assert.deepEqual(declared.globals, built.globals, `${file}'s globals differ from the headers ${hint}`);
    assert.deepEqual(declared.modules, built.modules, `${file}'s modules differ from the headers ${hint}`);
  });
}

test('every Betterfy* name the page and the engine worker use is declared by a bundle', () => {
  const declared = new Set([...Object.keys(engineBundle({ headers }).namespace),
                            ...Object.keys(audioBundle({ headers }).namespace)]);
  const sources = ['docs/app.template.html',
    ...readdirSync(new URL('../web/app/', import.meta.url)).filter(f => f.endsWith('.js')).map(f => `web/app/${f}`),
    ...readdirSync(new URL('../web/screens/', import.meta.url)).filter(f => f.endsWith('.js')).map(f => `web/screens/${f}`)];
  const used = new Map();
  for (const f of sources) for (const [g] of read(f).matchAll(/\bBetterfy[A-Z][\w$]*/g)) used.set(g, f);
  assert.ok(used.size >= 15, `found only ${used.size} names — has the page moved?`);
  for (const [g, f] of used) assert.ok(declared.has(g), `${f} uses ${g}, which no \`// @bundle\` line declares`);

  const engine = new Set(Object.keys(engineBundle({ headers }).namespace));
  for (const [g] of read('docs/engine-worker.js').matchAll(/\bBetterfy[A-Z][\w$]*/g))
    assert.ok(engine.has(g), `the engine worker uses ${g}, which no \`// @bundle engine\` line declares`);
});

test('every declared global is a Betterfy* name, and only core/ and web/audio modules declare one', () => {
  for (const h of headers) {
    if (h.global) assert.match(h.global, /^Betterfy[A-Z]/, `${h.path}: ${h.global}`);
    assert.match(h.path, /^(core|web\/audio)\//, `${h.path} carries a @bundle line`);
  }
});

test('the sound-space lookups stay out of audio.js, and so does the genre ontology', () => {
  const engineSide = headers.filter(h => h.bundle === 'engine' && h.path.startsWith('core/audio/')).map(h => h.path);
  assert.ok(engineSide.length >= 6, 'identify, match, misfit, plprofile, order and discover at least');
  const { files } = bundleModules(...(({ entries, namespace }) => [entries, { namespace }])(audioBundle({ headers })));
  for (const f of engineSide) assert.ok(!files.includes(f), `${f} is engine-side but ended up in audio.js`);
  assert.deepEqual(files.filter(f => f.startsWith('core/ontology/')), [], 'audio.js pulls in the ontology');
});
