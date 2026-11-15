// Which modules go into the page's two lazy bundles (docs/BUILD-5-PLAN.md A7).
//
// docs/engine.js and docs/audio.js used to be built from lists kept by hand in
// build-web.mjs (ENGINE_ENTRIES, its namespace map, ENGINE_SIDE), and every
// package that added a module edited the same lines of the same file. Now a
// module says which bundle it belongs to, in its own first line:
//
//   // @bundle engine order=110 global=BetterfyCalibrate
//
//   bundle   `engine` or `audio`. A module may carry one line for each.
//   global=  the name the page reaches it by (`BetterfyCalibrate.fit(...)`).
//            Optional: a module without one is still an entry, just unnamed.
//   order=   optional, an integer. It fixes nothing but where the module's
//            code sits in the built file — the bundler emits every module after
//            what it imports whatever the order — and exists so this
//            convention could replace the old lists without moving a byte of
//            what ships. Leave it off a new module: those sort after every
//            numbered one, by path.
//
// The line must start at column 0 and is taken out of the bundle again
// (bundler.mjs strips it like an import), so adding one changes nothing that
// ships except, of course, that the module is now in the bundle.
//
// The audio bundle is also a folder convention, as it always was: everything in
// core/audio/ and core/audio/dsp/ (mel.mjs and record.mjs are frozen, so they
// could not carry a line if they had to), plus core/intrinsic/audio*.mjs named
// automatically (audio-learn.mjs → BetterfyAudioLearnIntrinsic). A module in
// core/audio/ that says `@bundle engine` is a lookup over the sound space that
// ships in engine.js instead, so the sweep leaves it out of audio.js — that is
// what the old ENGINE_SIDE list said by hand.
//
// test/bundles.test.mjs checks that the committed docs/engine.js and
// docs/audio.js carry exactly what these lines declare, and that every
// Betterfy* name the page uses is declared somewhere.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const BUNDLES = ['engine', 'audio'];

/** Folders scanned for `// @bundle` lines, repo-relative. */
export const HEADER_ROOTS = ['core', 'web'];

const LINE_RE = /^\/\/ @bundle\b(.*)$/gm;
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/** Every `// @bundle` line in one module's source, parsed.
 *  @returns {{path: string, bundle: string, order: number|null, global: string|null}[]} */
export function parseHeaders(path, src) {
  const out = [];
  LINE_RE.lastIndex = 0;
  let m;
  while ((m = LINE_RE.exec(src))) {
    const [bundle, ...rest] = m[1].trim().split(/\s+/).filter(Boolean);
    if (!BUNDLES.includes(bundle))
      throw new Error(`${path}: \`// @bundle ${m[1].trim()}\` names no bundle — expected one of ${BUNDLES.join(', ')}`);
    const h = { path, bundle, order: null, global: null };
    for (const tok of rest) {
      const [k, v, extra] = tok.split('=');
      if (extra !== undefined || v === undefined || v === '') throw new Error(`${path}: bad @bundle option \`${tok}\``);
      if (k === 'order') {
        if (!/^-?\d+$/.test(v)) throw new Error(`${path}: @bundle order must be an integer, got \`${v}\``);
        h.order = Number(v);
      } else if (k === 'global') {
        if (!IDENT_RE.test(v)) throw new Error(`${path}: @bundle global \`${v}\` is not an identifier`);
        h.global = v;
      } else {
        throw new Error(`${path}: unknown @bundle option \`${k}\` (order=, global=)`);
      }
    }
    if (out.some(o => o.bundle === bundle)) throw new Error(`${path}: two \`// @bundle ${bundle}\` lines`);
    out.push(h);
  }
  return out;
}

/** Every .mjs file under `roots`, sorted, repo-relative with forward slashes. */
function walk(roots, { list, isDir }) {
  const files = [];
  const visit = dir => {
    for (const name of list(dir).sort()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = `${dir}/${name}`;
      if (isDir(p)) visit(p);
      else if (p.endsWith('.mjs')) files.push(p);
    }
  };
  for (const r of roots) visit(r);
  return files;
}

const fsOps = root => ({
  read: f => readFileSync(join(root, f), 'utf8'),
  list: d => { try { return readdirSync(join(root, d)); } catch { return []; } },
  isDir: p => statSync(join(root, p)).isDirectory(),
});

/** All headers in the tree. `read`/`list`/`isDir` are injectable for tests. */
export function scanHeaders({ root = '.', roots = HEADER_ROOTS, ...ops } = {}) {
  const io = { ...fsOps(root), ...ops };
  return walk(roots, io).flatMap(f => parseHeaders(f, io.read(f)));
}

/** One bundle's declared members, in emission order: by order=, then path. */
export function members(bundle, headers) {
  const hs = headers.filter(h => h.bundle === bundle).sort((a, b) =>
    (a.order ?? Infinity) - (b.order ?? Infinity) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Map();
  for (const h of hs) {
    if (!h.global) continue;
    if (seen.has(h.global)) throw new Error(`${h.global} is declared by both ${seen.get(h.global)} and ${h.path} in the ${bundle} bundle`);
    seen.set(h.global, h.path);
  }
  return hs;
}

const namespaceOf = hs => Object.fromEntries(hs.filter(h => h.global).map(h => [h.global, h.path]));

/** docs/engine.js: entries and globals, both from `// @bundle engine` lines. */
export function engineBundle({ headers = scanHeaders() } = {}) {
  const hs = members('engine', headers);
  return { entries: hs.map(h => h.path), namespace: namespaceOf(hs) };
}

const camel = f => f.replace(/^.*\//, '').replace(/\.m?js$/, '')
  .split(/[-_]/).map(w => w[0].toUpperCase() + w.slice(1)).join('');

/** docs/audio.js: `// @bundle audio` lines first, then the folder sweep. */
export function audioBundle({ headers = scanHeaders(), root = '.', list = fsOps(root).list } = {}) {
  const declared = members('audio', headers);
  const engineSide = new Set(headers.filter(h => h.bundle === 'engine').map(h => h.path));
  const audioSide = new Set(declared.map(h => h.path));
  const sweep = dir => list(dir).filter(f => /\.(mjs|js)$/.test(f)).sort().map(f => `${dir}/${f}`);
  const intrinsic = list('core/intrinsic').filter(f => /^audio.*\.mjs$/.test(f)).sort().map(f => `core/intrinsic/${f}`);
  const swept = [...sweep('core/audio').filter(f => !engineSide.has(f) || audioSide.has(f)),
                 ...sweep('core/audio/dsp'), ...intrinsic];
  const entries = [...declared.map(h => h.path), ...swept.filter(f => !audioSide.has(f))];
  const namespace = { ...namespaceOf(declared) };
  // core/intrinsic/audio.mjs → BetterfyAudioIntrinsic, audio-learn.mjs → BetterfyAudioLearnIntrinsic
  for (const f of intrinsic) {
    const g = `Betterfy${camel(f)}Intrinsic`;
    if (namespace[g] && namespace[g] !== f) throw new Error(`${g} is declared by ${namespace[g]} and also named for ${f}`);
    namespace[g] = f;
  }
  return { entries, namespace };
}
