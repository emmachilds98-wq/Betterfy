import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Radar from '../web/screens/radar.mjs';
import * as Discover from '../web/screens/discover.mjs';
import { scoreFixtures, NOW, library } from '../core/release/fixtures.mjs';

// Release Radar's section of Discover (docs/RELEASE-RADAR-PLAN.md §6, phase 4).

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const emptyState = (t, b, o = {}) => `<div class="empty-state"><b>${t}</b><p>${b}</p>${o.acts ?? ''}</div>`;

async function rows() { return (await scoreFixtures()).run.rows; }
const state = (o = {}) => ({ rows: [], index: null, running: false, progress: null, stopped: null, err: null,
  filter: 'all', artist: null, q: '', shown: 60, dismissed: new Set(), olderFor: new Set(), ...o });
const ctx = (R, o = {}) => ({ esc, emptyState, LIB: library(), render: () => {},
  radar: { R, now: () => NOW + 41 * 864e5, suggest: () => null, start() {}, stop() {}, dismiss() {}, file() {} }, ...o });
const names = rs => rs.map(r => r.name);

test('All is the main lane without reissues or features; each lives under its own chip', async () => {
  const rs = await rows(), now = NOW + 41 * 864e5;
  const all = names(Radar.feedRows(rs, { now }));
  assert.ok(all.includes('Glow') && all.includes('Fresh'));
  assert.ok(!all.includes('Old Ways (2026 Remaster)') && !all.includes('Collected'), 'reissues out of the default feed');
  assert.ok(!all.includes('Kilo (Brook Remix)') && !all.includes('Summer Jungle 2026'), 'features out of the chronology');
  assert.deepEqual(names(Radar.feedRows(rs, { now, filter: 'reissues' })).sort(), ['Collected', 'Old Ways (2026 Remaster)']);
  assert.deepEqual(names(Radar.feedRows(rs, { now, filter: 'features' })).sort(), ['Kilo (Brook Remix)', 'Summer Jungle 2026']);
  assert.ok(names(Radar.feedRows(rs, { now, filter: 'unheard' })).every(n => n !== 'Glow'), 'Unheard leaves out what you own');
  assert.ok(Radar.feedRows(rs, { now, filter: 'singles' }).every(r => r.albumType === 'single'));
  assert.ok(Radar.feedRows(rs, { now, filter: 'albums' }).every(r => r.albumType !== 'single'));
  assert.deepEqual(names(Radar.feedRows(rs, { now, filter: 'month' })), ['Fresh'], 'December 2026');
  assert.deepEqual(names(Radar.feedRows(rs, { now, artistId: 'art_burial_2' })), ['Stone Mass']);
  assert.ok(!names(Radar.feedRows(rs, { now, dismissed: new Set([rs.find(r => r.name === 'Glow').key]) })).includes('Glow'));
});

test('newest first, under month headers that never invent a month', async () => {
  const rs = Radar.feedRows(await rows(), { now: NOW + 41 * 864e5 });
  for (let i = 1; i < rs.length; i++) assert.ok(rs[i - 1].ts >= rs[i].ts);
  const groups = Radar.groupByMonth(rs);
  assert.equal(groups[0].label, 'December 2026');
  assert.ok(groups.some(g => g.label === '2025, month not given'), 'the year-only album has its own header');
  assert.ok(groups.find(g => g.label === 'June 2026').rows.some(r => r.name === 'Night Shapes'));
});

test('the status line never calls a partial radar complete', () => {
  const ix = { at: NOW, artists: 1042, done: 400, total: 3126, coldDone: false, stopped: null };
  assert.equal(Radar.statusLine(state({ running: true, progress: { phase: 'main', done: 800, total: 3126, artistsDone: 412, artistsTotal: 1042 } })).text,
    'Reading 412 of 1,042 artists');
  assert.equal(Radar.statusLine(state({ running: true, progress: { phase: 'main', done: 1, total: 2, artistsDone: 1, artistsTotal: 1 } })).complete, false);
  const stopped = Radar.statusLine(state({ index: { ...ix, stopped: { why: 'rate-limit' } }, err: 'quota used up' }));
  assert.equal(stopped.complete, false);
  assert.match(stopped.text, /Stopped after 400 of 3,126 checks: Spotify asked for a pause \(quota used up\)\. Start again picks up/);
  assert.equal(Radar.statusLine(state({ index: ix })).complete, false, 'a cold sync not yet through');
  const done = Radar.statusLine(state({ index: { ...ix, coldDone: true, at: NOW - 2 * 3600e3 } }), NOW);
  assert.deepEqual([done.complete, done.text], [true, '1,042 artists · last checked 2 hours ago']);
});

test('never synced: an explainer, one Start button, an honest estimate', () => {
  const html = Radar.radarView(ctx(state()));
  assert.match(html, /data-act="rrStart"/);
  assert.match(html, /about <b>\d+ minutes?<\/b>\. You can keep/);
  assert.doesNotMatch(html, /rr-feed/);
});

test('syncing with nothing yet: skeleton rows, not a spinner; with rows: the partial note', async () => {
  const R = state({ running: true, progress: { phase: 'main', done: 1, total: 20, artistsDone: 1, artistsTotal: 10 } });
  assert.match(Radar.radarView(ctx(R, { skeleton: () => '<div class="sk-wrap"></div>' })), /sk-wrap/);
  const html = Radar.radarView(ctx({ ...R, rows: await rows(), index: { at: NOW, done: 1, total: 20 } }));
  assert.match(html, /Not the whole radar yet: still reading/);
  assert.match(html, /data-act="rrStop"/);
});

test('rows: date as given, type pills, a quiet owned marker, File only with a pick, and dismiss', async () => {
  const rs = await rows();
  const R = state({ rows: rs, index: { at: NOW, artists: 9, done: 1, total: 1, coldDone: true } });
  const html = Radar.radarView(ctx(R, { radar: { ...ctx(R).radar, suggest: r => r.name === 'Glow' ? { id: 'pl1', name: 'Garage', why: 'x' } : null } }));
  const row = n => html.slice(html.indexOf(`>${n}`) - 900, html.indexOf(`>${n}`) + 900);
  assert.match(row('Glow'), /<time datetime="2026-10-02">2 Oct<\/time><span class="rr-own">owned<\/span>/);
  assert.match(row('Glow'), /data-act="rrFile"[^>]*data-pl="pl1"[^>]*>File → Garage/);
  assert.match(row('Night Shapes'), /EP<\/span>/);
  assert.match(row('Night Shapes'), /own some/);
  assert.doesNotMatch(row('Twin').slice(800, 1700), /rr-own/, 'absence is silent');
  assert.match(html, /data-act="rrDismiss"/);
  assert.doesNotMatch(html, /rr-feat|Features and remixes/, 'no features fold under All (C5): the Features chip shows them');
  assert.match(html, /aria-pressed="true">All</);
});

test('filtered to nothing says so and offers the way back', async () => {
  const R = state({ rows: await rows(), filter: 'reissues', artist: 'art_burial_1', index: { at: NOW, coldDone: true, done: 1, total: 1 } });
  const html = Radar.radarView(ctx(R));
  assert.match(html, /No reissues spotted for Burial/);
  assert.match(html, /data-act="rrFilter" data-f="all" data-clear="1"/);
});

test('synced, nothing new: "Nothing new since", not an empty page', () => {
  const R = state({ rows: [], index: { at: Date.UTC(2026, 2, 4), coldDone: true, done: 3, total: 3, artists: 1 } });
  assert.match(Radar.radarView(ctx(R)), /Nothing new since 4 March/);
});

test('the feed is windowed', async () => {
  const first = (await rows()).find(r => r.name === 'Glow');
  const many = Array.from({ length: 150 }, (_, i) => ({ ...first, key: 'k' + i, name: 'R' + i, reissue: false, lane: 'main' }));
  const html = Radar.radarView(ctx(state({ rows: many, index: { at: NOW, coldDone: true, done: 1, total: 1, artists: 1 } })));
  assert.equal((html.match(/class="rr-row"/g) ?? []).length, Radar.PAGE);
  assert.match(html, /Show more \(90 left\)/);
});

test('artist search: normalised, prefix first, at most eight', () => {
  const a = ['Burial', 'Burial', 'Aster', 'Asterix', 'The Aster Band', ...Array.from({ length: 20 }, (_, i) => 'Aster ' + i)].map((name, i) => ({ id: 'i' + i, name }));
  const hits = Radar.artistMatches(a, 'ASTER');
  assert.equal(hits.length, 8);
  assert.ok(hits.slice(0, 7).every(h => h.name.startsWith('Aster')));
  assert.deepEqual(Radar.artistMatches(a, ''), []);
});

test('Discover draws the radar first when the page gives one, and nothing extra when not', () => {
  const base = { S: { discover: [] }, LIB: library(), CFG: {}, esc, lfmKey: () => '', emptyState, discListenOn: () => false,
    soundSearchHTML: () => '', discSoundLine: () => '', discFitHTML: () => '' };
  const without = Discover.view(base);
  assert.doesNotMatch(without, /rr|Release radar/);
  const html = Discover.view({ ...base, ...ctx(state()) });
  assert.ok(html.indexOf('Release radar') < html.indexOf('Find new music'), 'radar is the first section');
  assert.ok(Discover.actions.rrStart && Discover.actions.discRun);
});
