import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// UI-G: the FLIP helper in web/app/motion.js (a classic script), run in a
// sandbox with a fake list of rows.

function load(reduced = false) {
  const ctx = { document: {}, matchMedia: () => ({ matches: reduced }), addEventListener() {} };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../web/app/motion.js', import.meta.url), 'utf8')
    + '\nthis.flipRecord = flipRecord; this.flipPlay = flipPlay; this.skeleton = skeleton;', ctx);
  return ctx;
}

function rows(tops) {
  const calls = [];
  const els = Object.entries(tops).map(([k, y]) => ({
    k, y,
    getAttribute: () => k,
    getBoundingClientRect() { return { left: 0, top: this.y }; },
    animate(frames, opts) { calls.push({ k, frames, opts }); },
  }));
  const root = { querySelectorAll: () => els, ownerDocument: { documentElement: {}, defaultView: { getComputedStyle: () => ({ getPropertyValue: () => ' linear(0,1) ' }) } } };
  return { root, els, calls };
}

test('rows that moved are animated from their old place, on the spring', () => {
  const { flipRecord, flipPlay } = load();
  const { root, els, calls } = rows({ a: 0, b: 40, c: 80 });
  const before = flipRecord(root);
  els[0].y = 80; els[2].y = 0; // a and c swap
  assert.equal(flipPlay(root, before), 2);
  const a = calls.find(c => c.k === 'a');
  assert.equal(a.frames[0].transform, 'translate(0px, -80px)');
  assert.equal(a.frames[1].transform, 'none');
  assert.equal(a.opts.easing, 'linear(0,1)');
  assert.ok(!calls.some(c => c.k === 'b'), 'b did not move');
});

test('a row that is new (no earlier place) is left to CSS', () => {
  const { flipRecord, flipPlay } = load();
  const { root, els, calls } = rows({ a: 0 });
  const before = flipRecord(root);
  els.push({ k: 'n', getAttribute: () => 'n', getBoundingClientRect: () => ({ left: 0, top: 9 }), animate: () => calls.push('n') });
  assert.equal(flipPlay(root, before), 0);
  assert.equal(calls.length, 0);
});

test('reduced motion plays nothing', () => {
  const { flipRecord, flipPlay } = load(true);
  const { root, els, calls } = rows({ a: 0, b: 40 });
  const before = flipRecord(root);
  els[0].y = 40; els[1].y = 0;
  assert.equal(flipPlay(root, before), 0);
  assert.equal(calls.length, 0);
});

test('no earlier record, or a root without rows, is a no-op', () => {
  const { flipRecord, flipPlay } = load();
  assert.equal(flipPlay(null, null), 0);
  assert.equal(flipRecord(null).size, 0);
});

test('skeleton shapes', () => {
  const { skeleton } = load();
  assert.equal(skeleton('rows', 3).split('sk-row').length - 1, 3);
  assert.equal(skeleton('card').split('class="sk-card"').length - 1, 1);
});
