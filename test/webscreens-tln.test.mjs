import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as TIDY from '../web/screens/tidy.mjs';
import * as LISTS from '../web/screens/lists.mjs';
import * as NEW from '../web/screens/new.mjs';

// Tidy, Playlists and New playlists as screen modules (docs/BUILD-5-PLAN.md A4):
// their actions, on fixture ctxs.

test('Tidy: choosing a section and a band repaint, and the band is remembered only on request', () => {
  let drawn = 0, saved = 0;
  const c = { S: {}, T: { rememberFilters: false }, render: () => drawn++, saveTheme: () => saved++ };
  TIDY.actions.section(c, { dataset: { tidy: 'cross' } });
  assert.equal(c.S.tidySec, 'cross');
  // Cross-filed's 2+…6+ row is gone (DESIGN-PLAN §7.7 C4): fixed at two or more.
  assert.equal(TIDY.actions.cmin, undefined);
  TIDY.actions.mfb(c, { dataset: { mfb: 'medium' } });
  assert.equal(saved, 0);
  c.T.rememberFilters = true;
  TIDY.actions.mfb(c, { dataset: { mfb: 'low' } });
  assert.deepEqual([c.S.mfBand, c.T.mfBand, saved, drawn], ['low', 'low', 1, 3]);
});

test('Playlists: setting an axis marks it set by you, stores it and recomputes the reports', async () => {
  const kept = new Map(), said = [];
  let rebuilt = 0, drawn = 0;
  const CFG = { p: { axis: 'genre', target: false, tracks: 20, name: 'Rollers', why: 'x' } };
  const c = { CFG, LS: { getItem: k => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, v) }, MIN_FOR_TARGET: 12,
    isMirrorPlaylist: () => false, rebuildReports: () => { rebuilt++; return {}; }, toast: m => said.push(m),
    render: () => drawn++, syncAxes: async () => false, store: { set() {} } };
  LISTS.actions.axis(c, { dataset: { ax: 'p' }, value: 'mood' });
  assert.deepEqual([CFG.p.axis, CFG.p.why, CFG.p.target], ['mood', 'set by you', false]);
  LISTS.actions.axis(c, { dataset: { ax: 'p' }, value: 'genre' });
  assert.equal(CFG.p.target, true, 'a genre playlist starts taking suggestions');
  LISTS.actions.target(c, { dataset: { tg: 'p' }, checked: false });
  assert.equal(CFG.p.target, false);
  assert.equal(JSON.parse(kept.get('bf_axes')).p.axis, 'genre');
  assert.deepEqual([rebuilt, drawn, said.length], [3, 3, 3]);
});

test('New playlists: a gap needs a name, then creates through gapsCreate', async () => {
  const made = [], said = [];
  const c = { GAPS: { gaps: [{ ids: ['a', 'b'] }] }, $: () => ({ value: '  ' }), toast: m => said.push(m),
    gapsCreate: async (n, ids) => made.push([n, ids]) };
  const el = { dataset: { gap: '0' }, disabled: false };
  await NEW.actions.gap(c, el);
  assert.deepEqual([made.length, said], [0, ['Give it a name first.']]);
  c.$ = () => ({ value: ' Donk ' });
  await NEW.actions.gap(c, el);
  assert.deepEqual(made, [['Donk', ['a', 'b']]]);
});

test('New playlists: a backlog group creates through gapsCreate, so it is in History with an Undo (F3)', async () => {
  const made = [], said = [];
  let drawn = 0;
  const g = { ids: ['x', 'y'], size: 2 };
  const c = { R: { clusters: [{ ids: ['q'] }, g] }, $: () => ({ value: ' Jungle ' }), toast: m => said.push(m), render: () => drawn++,
    gapsCreate: async (n, ids, why) => made.push([n, ids, why]) };
  await NEW.actions.cluster(c, { dataset: { cluster: '1' }, disabled: false });
  assert.deepEqual(made, [['Jungle', ['x', 'y'], 'group in your backlog']]);
  assert.deepEqual(c.R.clusters, [{ ids: ['q'] }]);
  assert.equal(drawn, 1);
});

test('New playlists › By sound: the Engine\'s "New genre?" groups (moved from Library, M5)', async () => {
  const esc = s => String(s ?? '');
  const COLD = { status: 'ready', active: new Set(['Hot']),
    newGenre: [{ ids: ['1', '2', '3', '4'], tracks: [{ artists: ['Hot'] }], suggest: { name: 'Donk' } }, { ids: ['5'] }] };
  const rows = NEW.engineGenreRows({ COLD, esc });
  assert.match(rows, /Donk\? <span class="tag snd">by sound<\/span> <span class="tag">4 tracks<\/span> <span class="tag ok">1 you're playing/);
  assert.match(rows, /<input id="newgnm0"[^>]*value="Donk">/);
  assert.equal(NEW.engineGenreRows({ COLD: { status: 'working' }, esc }), '');
  const made = [], confirmed = [];
  const c = { COLD, $: () => ({ value: 'Donk' }), toast() {}, render() {}, clapConfirm: async (ids, n) => confirmed.push(n),
    gapsCreate: async (n, ids, why) => made.push([n, ids, why]) };
  await NEW.actions.newg(c, { dataset: { newg: '0' } });
  assert.deepEqual(made, [['Donk', ['1', '2', '3', '4'], 'new genre']]);
  assert.deepEqual(confirmed, ['Donk']);
  assert.equal(COLD.newGenre.length, 1);
});
