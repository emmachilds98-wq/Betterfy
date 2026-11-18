import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_FILES } from '../web/manifest.mjs';

// A3 of docs/archive/BUILD-5-PLAN.md: background jobs write a store slice; only the
// mounted screen that watches it repaints. They never call render() blind.
const read = f => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');
const RENDER = /(?<![\w.$])render\s*\(/;

// Files that are background jobs through and through: not one render() call.
const BACKGROUND = ['app/audio.js', 'app/clap.js', 'app/engine.js', 'app/keyless.js', 'app/listening.js',
  'app/soundfirst.js', 'app/sync-tags.js', 'app/sync.js', 'app/tagfix.js', 'app/tagshare.js', 'app/cache.js'];

test('background files never call render() directly', () => {
  for (const f of BACKGROUND) {
    assert.ok(APP_FILES.includes(f), `${f} is not in the manifest`);
    const bad = stripComments(read(f)).split('\n').filter(l => RENDER.test(l));
    assert.deepEqual(bad, [], `${f} calls render(); write a store slice instead (store.set/touch)`);
  }
});

test('no render() inside a promise callback, timer or fire() in any page script', () => {
  for (const f of APP_FILES) {
    const bad = stripComments(read(f)).split('\n')
      .filter(l => RENDER.test(l) && /\.then\(|\.catch\(|\bfire\(|setTimeout\(|setInterval\(/.test(l));
    assert.deepEqual(bad, [], `${f}: a background callback calls render(); use store.touch(...)`);
  }
});

test('store: get/set/on/touch, and a slice repaints only the screens that watch it', () => {
  const calls = [];
  const make = v => new Function('view', 'document', 'render', `${read('app/store.js')}\nreturn store;`)(
    v, { getElementById: () => ({}) }, () => calls.push(v));
  const store = make('engine');
  store.set('eng', { n: 1 });
  assert.deepEqual(store.get('eng'), { n: 1 });
  assert.equal(calls.length, 1, 'eng repaints the engine screen');
  store.touch('sound'); store.touch('ui.home');
  assert.equal(calls.length, 1, 'sound and ui.home do not repaint engine');
  store.touch('ui.engine');
  assert.equal(calls.length, 2);
  let seen = 0; const off = store.on('player', () => seen++);
  store.touch('player'); off(); store.touch('player');
  assert.equal(seen, 1);
  assert.equal(calls.length, 2, 'player repaints nothing by itself');
});
