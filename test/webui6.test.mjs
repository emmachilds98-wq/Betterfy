import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { installTidy } from './tidyctx.mjs';
import { installNew } from './newctx.mjs';
import * as ENGINE from '../web/screens/engine.mjs';

// UI-6 (docs/UI-BUILD-PLAN.md): Tidy's band filter in Sure/Likely/Unsure, real
// empty states, New playlists' one proposal card, and the Engine's paired
// with/without bars with the gate drawn as a line. Run out of the built page.

const PAGE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
function slice(from, to) {
  const i = PAGE.indexOf(from), j = PAGE.indexOf(to, i);
  assert.ok(i > 0 && j > i, `${from} not found — rebuild with node build-web.mjs`);
  return PAGE.slice(i, j);
}
const esc = x => String(x ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function tidy(R, extra = {}) {
  const s = { esc, thumbHTML: () => '', cmpTable: () => '', tagChips: () => '', tagEditorHTML: () => '',
    LISTENING_CACHE: { recentlyActive: new Set() }, LISTENING_PENDING: true, getListening: async () => null,
    render: () => {}, R, ...extra };
  vm.createContext(s);
  installTidy(s, slice);
  return s;
}
const mf = (i, confidence) => ({ id: 't' + i, title: 'T' + i, artist: 'A', current: 'P', currentPlaylistId: 'p',
  currentScore: 0.2, confidence, suggest: [{ id: 'q', name: 'Q', score: 0.8 }], tags: [] });

test('the misfile filter speaks Sure / Likely / Unsure, keeping high/medium/low underneath', () => {
  const s = tidy({ misfiled: [mf(1, 'high'), mf(2, 'medium'), mf(3, 'medium'), mf(4, 'low')], within: [], across: [] });
  const html = vm.runInContext('secMisfile()', s);
  assert.match(html, /data-mfb="high"><span class="band band-sure">Sure<\/span> <span class="n">1</);
  assert.match(html, /data-mfb="medium"><span class="band band-likely">Likely<\/span> <span class="n">2</);
  assert.match(html, /data-mfb="low"><span class="band band-unsure">Unsure<\/span> <span class="n">1</);
  assert.match(html, /aria-pressed="true" data-act="mfb" data-mfb="high"/);
  assert.ok(!/>high \(/.test(html), 'the old words are gone');
});

test("UI-2's bandChip is used when it draws something", () => {
  const s = tidy({ misfiled: [mf(1, 'high')], within: [], across: [] },
    { bandChip: b => `<span class="band X">${b}</span>` });
  assert.match(vm.runInContext('secMisfile()', s), /<span class="band X">HIGH<\/span>/);
});

test('an empty band is a compact empty state; nothing misfiled at all is a full one with no filter', () => {
  let s = tidy({ misfiled: [mf(1, 'low')], within: [], across: [] });
  let html = vm.runInContext('secMisfile()', s);
  assert.match(html, /class="empty-state compact"/);
  assert.match(html, /<b>Nothing Sure<\/b>/);
  s = tidy({ misfiled: [], within: [], across: [] });
  html = vm.runInContext('secMisfile()', s);
  assert.match(html, /class="empty-state"><span class="es-mark" aria-hidden="true">(<i><\/i>){5}/);
  assert.match(html, /Everything fits where it is/);
  assert.ok(!/data-mfb/.test(html), 'no filter over nothing');
  assert.ok(!/class="empty"/.test(html), 'the old grey box is gone');
});

test('no repeats at all is one empty state, not two under two headings', () => {
  const html = vm.runInContext('secDupes()', tidy({ misfiled: [], within: [], across: [] }));
  assert.equal(html.match(/class="empty-state/g).length, 1);
  assert.ok(!/<h2>/.test(html));
  assert.match(html, /No repeats/);
});

test('cross-filed: an empty state when nothing is, and every track in two or more listed (§7.7 C4)', () => {
  assert.match(vm.runInContext('secCross()', tidy({ misfiled: [], within: [], across: [] })), /Nothing cross-filed/);
  const two = { title: 'X', artist: 'A', placements: [1, 2].map(n => ({ playlistId: 'p' + n, trackId: 't', playlist: 'P' + n, axis: 'g' })) };
  const html = vm.runInContext('secCross()', tidy({ misfiled: [], within: [], across: [two] }));
  assert.doesNotMatch(html, /empty-state|data-act="cmin"/);
  assert.match(html, /data-act="xpl" data-xpl="p1"/);
});

// ---- New playlists ----
function newScreen({ gaps = [], splits = [], clusters = [], status = 'ready' } = {}) {
  const s = { esc, Set, Map, R: { clusters }, fire: () => {}, render: () => {}, BetterfyGaps: { MIN_GAP: 8 } };
  vm.createContext(s);
  installNew(s, slice);
  vm.runInContext('(o) => Object.assign(GAPS, o)', s)({ status, gaps, splits, untagged: 0, homeless: 0, for: s.R });
  return s;
}

test('three empty sections collapse into one empty state that still names each', () => {
  const html = vm.runInContext('vNew()', newScreen());
  assert.equal(html.match(/class="empty-state/g).length, 1);
  assert.match(html, /Nothing to propose yet/);
  for (const t of ['Genres with no playlist', 'Playlists that are two genres', 'Groups in your backlog'])
    assert.match(html, new RegExp(`<strong>${t}:</strong>`));
  assert.ok(!/<h2/.test(html), 'no headings over nothing');
});

test('some empty: the full sections draw, the empty ones fold into one compact line', () => {
  const gaps = [{ label: 'Donk', size: 15, artists: ['a'], played: 0 }];
  const html = vm.runInContext('vNew()', newScreen({ gaps }));
  assert.match(html, /<h2 class="newsec">Genres with no playlist<\/h2>/);
  assert.match(html, /empty-state compact/);
  assert.match(html, /<strong>Playlists that are two genres:<\/strong>/);
  assert.ok(!/<h2 class="newsec">Groups in your backlog/.test(html));
});

const card = (s, p) => s.proposalCard(p);

test('one proposal card shape for all three kinds, with the attributes the handler reads', () => {
  const s = newScreen();
  const between = [{ id: 'a', name: 'Drum & Bass' }, { id: 'b', name: 'Bass' }];
  const h = card(s, { kind: 'hybrid', i: 0, name: 'Bassline / Dubstep', size: 10, mixed: 3, artists: ['x'], between,
    samples: [{ title: 'One', artist: 'X' }, { title: 'Two', artist: 'Y' }] });
  assert.match(h, /class="row prop prop-hybrid"/);
  assert.match(h, /Bassline \/ Dubstep <span class="tag snd">by sound<\/span> <span class="tag">10 tracks/);
  assert.match(h, /id="sndh0"[^>]*value="Bassline \/ Dubstep"/);
  assert.match(h, /data-sndh="0"/);
  assert.match(h, /<ol class="prop-eg"><li><b>One<\/b>/);
  assert.match(h, /3 of them change style partway through/);

  const o = card(s, { kind: 'new', i: 2, size: 6, nearest: { name: 'Bass' }, artists: [] });
  assert.match(o, /class="row prop prop-new"/);
  assert.match(o, /New genre\? <span class="tag snd">by sound/);
  assert.match(o, /id="sndo2"[^>]*placeholder="Name it">/);

  const p = card(s, { kind: 'pick', i: 0, size: 4, between, artists: [] });
  assert.match(p, /Drum &amp; Bass or Bass\? <span class="tag snd">by sound<\/span> <span class="tag">4 tracks/);
  assert.match(p, /data-sndp="0:0">Add to Drum &amp; Bass<\/button> <button class="b sm" data-act="sndp" data-sndp="0:1">Add to Bass</);
  assert.match(card(s, { kind: 'pick', i: 0, size: 4, between, filedTo: ['Bass'] }), /<span class="tag ok">added to Bass<\/span>/);
  assert.match(card(s, { kind: 'hybrid', i: 0, name: 'N', size: 1, between, done: true }), /<span class="tag ok">created<\/span>/);
});

test('no proposal, no markup', () => {
  const s = newScreen();
  for (const x of [null, undefined, {}, { kind: 'other' }]) assert.equal(card(s, x), '');
});

// ---- Engine ----
const p = x => x == null ? '—' : Math.round(x * 100) + '%';
const run = (gate, nfWith = 0.5) => ({ mine: { top1: 0.6, scored: 200, neverFiled: { scored: 40, top1: 0.4 },
  withAudio: { top1: 0.62, heard: 150, heardNeverFiled: 30, changed: 12, neverFiled: { top1: nfWith }, gate } } });

test('the score card pairs without/with bars and draws the gate at +5 on never-filed artists', () => {
  const html = ENGINE.audioCard(run({ pass: true, text: 'ok', bar: { minLift: 0.05 } }), p, esc);
  assert.equal(html.match(/class="pair"/g).length, 2);
  assert.match(html, /Adding how it sounds/);
  assert.match(html, /--v:0\.4000[\s\S]*--v:0\.5000/);
  assert.match(html, /class="gate met" style="--g:0\.4500" title="\+5 points"/, 'the line sits 5 points above without');
  assert.match(html, /The bar it has to clear: <b>\+5 points<\/b>/);
  assert.match(html, /\+10 points/);
  assert.match(html, /Helps, so it now has a say\./);
  assert.match(html, /<span class="tag ok">passed<\/span>/);
});

test('a lift short of the bar leaves the gate line unmet and says so', () => {
  const html = ENGINE.audioCard(run({ pass: false, text: 'short', bar: { minLift: 0.05 } }, 0.42), p, esc);
  assert.match(html, /class="gate " style="--g:0\.4500"/);
  assert.match(html, /Not yet, so it only shows\./);
});

test('scored without sound: no card at all', () => {
  assert.equal(ENGINE.audioCard({ mine: { top1: 0.6 } }, p, esc), '');
  assert.equal(ENGINE.audioCard(null, p, esc), '');
});
