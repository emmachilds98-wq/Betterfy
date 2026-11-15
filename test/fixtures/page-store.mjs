// The page's store (web/app/store.js, docs/BUILD-5-PLAN.md A3), cut from the
// built page, for tests that run slices of the page in a vm sandbox. Background
// jobs end with store.set() or repaint() now rather than render(), so a sandbox
// running one needs the real store beside its stubbed render().
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const PAGE = readFileSync(new URL('../../docs/index.html', import.meta.url), 'utf8');
const FROM = '/* ---------- the store: docs/BUILD-5-PLAN.md A3';
const TO = '/* ---------- end of the store ---------- */';

export const STORE_CODE = (() => {
  const i = PAGE.indexOf(FROM), j = PAGE.indexOf(TO, i);
  if (!(i > 0 && j > i)) throw new Error('the store was not found in docs/index.html — rebuild with npm run build:web');
  return PAGE.slice(i, j + TO.length);
})();

/**
 * Run the store in a vm context. By default a frame comes at once (so a
 * test's render count reads as it did when jobs called render() themselves)
 * unless the sandbox brings its own; `frames: []` queues them, run by hand. Fills in what the store
 * reads (view, LIB, R) as undefined/null when the sandbox has none.
 */
export function addStore(s, { frames = null } = {}) {
  s.console ??= console;
  if (!('view' in s)) s.view = undefined;
  if (!('LIB' in s)) s.LIB = null;
  if (!('R' in s)) s.R = null;
  if (frames) s.requestAnimationFrame = fn => { frames.push(fn); return frames.length; };
  else s.requestAnimationFrame ??= fn => { fn(); return 0; };
  vm.runInContext(STORE_CODE, s);
  return s;
}
