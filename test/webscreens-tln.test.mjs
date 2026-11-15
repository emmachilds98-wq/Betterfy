import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as TIDY from '../web/screens/tidy.mjs';
import * as LISTS from '../web/screens/lists.mjs';
import * as NEW from '../web/screens/new.mjs';

// Tidy, Playlists and New playlists as screen modules (docs/BUILD-5-PLAN.md A4):
// their actions, on fixture ctxs.

test('Tidy: choosing a section and the cross-filed threshold repaint, and the threshold is remembered only on request', () => {
  let drawn = 0, saved = 0;
  const c = { S: {}, T: { rememberFilters: false }, render: () => drawn++, saveTheme: () => saved++ };
  TIDY.actions.section(c, { dataset: { tidy: 'cross' } });
  assert.equal(c.S.tidySec, 'cross');
  TIDY.actions.cmin(c, { dataset: { cmin: '4' } });
  assert.equal(c.S.crossMin, 4);
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
