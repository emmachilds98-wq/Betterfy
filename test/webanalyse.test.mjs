import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* lfmKey() precedence and the one-tap orchestration, loaded from the built page. */
const B = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const cut = (a, b) => { const i = B.indexOf(a), j = B.indexOf(b, i); assert.ok(i > 0 && j > i, `${a} not found — npm run build:web`); return B.slice(i, j); };

function load(ls = {}, defKey = '') {
  const store = { ...ls };
  const sb = { LS: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    setInterval, clearInterval, esc: s => s, console };
  vm.createContext(sb);
  vm.runInContext(`const DEFAULT_LFM_KEY = ${JSON.stringify(defKey)};\n` + cut('const lfmKey =', 'const mmss')
    + cut('const ANALYSE =', '/** The button. */') + '\nthis.lfmKey=lfmKey;this.analyseRun=analyseRun;this.analyseStatus=analyseStatus;', sb);
  return sb;
}

test('lfmKey: own key wins, then the shared default, then null', () => {
  assert.equal(load({ bf_lfm: 'mine' }, 'shared').lfmKey(), 'mine');
  assert.equal(load({}, 'shared').lfmKey(), 'shared');
  assert.equal(load({}, '').lfmKey(), null);
});

test('analyseStatus reads as one line', () => {
  const { analyseStatus } = load();
  assert.equal(analyseStatus({ tags: [120, 400], listen: { done: 37, total: 412 } }), 'Reading tags 120/400 · listening 37/412');
  assert.equal(analyseStatus({ tags: [0, 0], listen: null }), 'Starting…');
});

test('analyseRun starts listening, fills tags quietly, then routes to File', async () => {
  const { analyseRun } = load();
  const calls = [], seen = [];
  const out = await analyseRun({
    key: () => 'k', gaps: () => 5,
    listen: async () => calls.push('listen'),
    listenVM: () => ({ state: 'running', done: 3, total: 10 }),
    enrich: async o => { calls.push('enrich:' + o.quiet); o.onProgress(2, 5); o.onProgress(5, 5); },
    status: s => seen.push(s), go: v => calls.push('go:' + v),
  });
  assert.deepEqual(calls, ['listen', 'enrich:true', 'go:inbox']);
  assert.deepEqual({ ...out }, { tags: true, listen: true });
  assert.deepEqual([...seen.at(-1).tags], [5, 5]);
  assert.equal(seen.at(-1).running, false);
});

test('with no key it only listens, and a failed listen does not stop the route', async () => {
  const { analyseRun } = load();
  const calls = [];
  await analyseRun({ key: () => null, gaps: () => 9, listen: async () => { throw new Error('x'); },
    enrich: async () => calls.push('enrich'), go: v => calls.push(v) });
  assert.deepEqual(calls, ['inbox']);
});

test('analyseStatus names the genre and learning stages', () => {
  const { analyseStatus } = load();
  assert.equal(analyseStatus({ tags: [0, 0], listen: null, stage: 'genres' }), 'Looking up genres');
  assert.equal(analyseStatus({ tags: [400, 400], listen: { done: 3, total: 9 }, stage: 'learn' }),
    'Reading tags 400/400 · learning your playlists · listening 3/9');
  assert.equal(analyseStatus({ tags: [0, 0], listen: { state: 'paused' } }), 'Listening waits for Wi-Fi');
});

test('the automatic first run: genres, then tags, then the Engine map, and it stays on the screen it is on', async () => {
  const { analyseRun } = load();
  const calls = [], stages = [];
  const out = await analyseRun({
    key: () => 'k', gaps: () => 2,
    listen: async () => calls.push('listen'),
    genres: async () => calls.push('genres'),
    enrich: async () => calls.push('enrich'),
    learn: async () => { calls.push('learn'); return true; },
    status: s => stages.push(s.stage ?? '-'), go: v => calls.push('go:' + v),
  }, { route: false });
  assert.deepEqual(calls, ['listen', 'genres', 'enrich', 'learn']);
  assert.equal(out.learn, true);
  assert.ok(stages.includes('genres') && stages.includes('learn'), 'each stage shows on the strip');
  assert.equal(stages.at(-1), '-', 'the last status has no stage left');
});

test('a failed genre lookup or map does not stop the rest', async () => {
  const { analyseRun } = load();
  const calls = [];
  const out = await analyseRun({ key: () => 'k', gaps: () => 1, listen: async () => {},
    genres: async () => { throw new Error('wikidata'); }, enrich: async () => calls.push('enrich'),
    learn: async () => { throw new Error('worker'); }, go: () => {} }, { route: false });
  assert.deepEqual(calls, ['enrich']);
  assert.equal(out.tags, true);
  assert.equal(out.learn, false);
});
