// "What's helping your picks" (web/screens/helpers.mjs, web/app/helpers.js):
// every source and engine part shows whether it is on, and a live check says
// whether each one answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { helperRows, helperSummary, helpersHTML, checkWords, helperAttention } from '../web/screens/helpers.mjs';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const DEFAULTS = { lib: { playlists: 40, liked: 1200 }, listening: { artists: 80 }, cov: { have: 900, total: 1000, pct: 90 },
  lfm: { key: true, own: false }, bridge: { on: true, deezerAsked: 500, deezerPct: 61, wikidataAsked: 700, wikidataPct: 33 },
  audio: { on: true, state: 'done', heard: 412 }, deep: { maest: true, clap: true }, discogs: false, engine: { status: 'ready' },
  radar: { off: false, running: false, at: 1, artists: 640 } };

test('with the defaults every part that improves picks reads as on, and Discogs as an optional extra', () => {
  const rows = helperRows(DEFAULTS);
  assert.deepEqual(rows.map(r => r.id), ['spotify', 'listening-history', 'shared', 'lastfm', 'wikidata', 'deezer', 'listenbrainz', 'similar', 'sound', 'deep', 'engine', 'autoscore', 'radar', 'discogs']);
  for (const r of rows.filter(x => x.id !== 'discogs')) assert.equal(r.on, true, `${r.id} is on`);
  assert.equal(rows.find(r => r.id === 'lastfm').status, 'On · built-in key');
  assert.match(rows.find(r => r.id === 'sound').did, /412 tracks heard/);
  assert.match(rows.find(r => r.id === 'deezer').did, /knows 61%/);
  const discogs = rows.find(r => r.id === 'discogs');
  assert.equal(discogs.status, 'Optional');
  assert.equal(helperSummary(rows), '13 of 13 on', 'an optional extra that is off does not count against');
});

test('what is off or stuck says so, in words, and never shows a raw address', () => {
  const rows = helperRows({ ...DEFAULTS, lfm: { key: false }, bridge: { on: false },
    audio: { on: true, problem: 'couldn’t load the model' }, deep: { maest: false, clap: false } });
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(by.lastfm.status, 'Off');
  assert.equal(by.deezer.kind, 'off');
  assert.equal(by.listenbrainz.status, 'Off');
  assert.equal(by.sound.status, 'On · paused');
  assert.match(by.sound.did, /^Paused: couldn’t load the model/);
  assert.equal(by.deep.on, false);
  assert.equal(helperSummary(rows), '8 of 13 on', 'paused listening is still on');
  // Nothing known yet: still a full list, nothing invented.
  assert.equal(helperRows({}).length, 13, 'no radar state yet: no radar row');
  assert.equal(helperRows({}).find(r => r.id === 'spotify').status, 'Not read yet');
});

test('the live check adds one line per source and a count of what is not answering', () => {
  const rows = helperRows(DEFAULTS);
  const checks = { spotify: { ok: true, ms: 120 }, lastfm: { ok: false, err: 'Invalid API key' }, deezer: { running: true }, discogs: { skip: 'off, not asked' } };
  assert.equal(helperSummary(rows, checks), '13 of 13 on · 1 not answering');
  assert.equal(helperSummary(rows, { spotify: { ok: true } }), '13 of 13 on · all answering');
  const html = helpersHTML(rows, { checks, at: 1, esc });
  assert.match(html, /data-helper="spotify"[^]*?<span class="hcheck good">answering · 120 ms<\/span>/);
  assert.match(html, /class="hrow2 h-ok h-fail" data-helper="lastfm"[^]*?not answering: Invalid API key/);
  assert.match(html, /data-helper="deezer"[^]*?checking…/);
  assert.match(html, /data-hcheck>Check again</);
  assert.match(helpersHTML(rows, { esc }), /data-hcheck>Check they all answer</);
  assert.match(helpersHTML(rows, { esc, running: true }), /data-hcheck disabled>Checking…</);
  assert.equal(checkWords(null), '');
});

test('the page shows the list at the top of the Settings sheet and of Sources, and checks every source it lists', () => {
  const page = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
  assert.match(page, /return \(typeof helpersPanelHTML === 'function' \? helpersPanelHTML\(\) : ''\) \+ UH_SECTIONS/);
  assert.match(page, /\$\{helpersPanelHTML\(\)\}/);
  const glue = readFileSync(new URL('../web/app/helpers.js', import.meta.url), 'utf8');
  for (const id of ['spotify', 'lastfm', 'wikidata', 'deezer', 'listenbrainz', 'sound', 'discogs'])
    assert.match(glue, new RegExp(`\\n  ${id}: async`), `${id} has a live check`);
  assert.ok(!/LS\.setItem|idb\.set/.test(glue), 'a check stores nothing');
  assert.ok(!page.includes('Last.fm ${key ? \'connected\' : \'no key\'}'), 'the old "no key" line is gone');
});

test('the release radar is listed: on by itself, reading N of M while it runs, off only after a Stop (DESIGN-PLAN L5)', () => {
  const at = st => helperRows({ ...DEFAULTS, radar: st }).find(r => r.id === 'radar');
  assert.equal(at({ at: 1, artists: 640 }).status, 'On');
  assert.match(at({ at: 1, artists: 640 }).did, /640 artists checked/);
  assert.equal(at({}).status, 'On · starts soon');
  assert.equal(at({}).on, true);
  assert.equal(at({ running: true, done: 120, total: 640 }).status, 'On · reading 120 of 640');
  assert.equal(at({ running: true }).status, 'On · starting');
  const off = at({ off: true });
  assert.equal(off.status, 'Off since Stop');
  assert.equal(off.on, false);
  assert.equal(off.kind, 'off');
  const bad = at({ err: 'Spotify said no https://api.spotify.com/x', at: 1 });
  assert.equal(bad.kind, 'warn');
  assert.ok(!/https?:/.test(bad.did), 'no raw address');
});

test('the radar row shows its account check: when, and what Spotify refused (BUILD-7 R1)', () => {
  const at = st => helperRows({ ...DEFAULTS, radar: st }).find(r => r.id === 'radar');
  assert.equal(at({}).name, 'New releases (Radar)');
  assert.match(at({}).did, /checked by itself the first time/);
  const ok = at({ at: 1, artists: 9, check: { ok: true, missing: [], ago: '2 hours ago' } });
  assert.equal(ok.status, 'On');
  assert.match(ok.did, /Checked on this account 2 hours ago: Spotify answers everything it needs/);
  const no = at({ at: 1, check: { ok: false, missing: ['list', 'album'], ago: 'just now' } });
  assert.equal(no.kind, 'warn');
  assert.equal(no.status, 'On · Spotify isn’t sharing');
  assert.match(no.did, /refused list, album, so it waits/);
});

test('the panel folds to its header plus any row that asks for a look, and opens on tap (DESIGN-PLAN L5)', () => {
  const rows = helperRows(DEFAULTS);
  const html = helpersHTML(rows, { esc });
  assert.match(html, /<details class="helpers-fold" data-hfold>\s*<summary class="helpers-head"><h3 id="helpers-h">What's helping your picks<\/h3><span class="tag ok">13 of 13 on<\/span><\/summary>/);
  assert.ok(!/hlist-look/.test(html), 'nothing to look at: only the header shows');
  assert.equal((html.match(/data-helper=/g) ?? []).length, rows.length, 'the whole list is inside the fold');
  assert.match(helpersHTML(rows, { esc, open: true }), /data-hfold open>/);
  // A row that is off, stuck or not answering shows under the header, folded or not.
  const some = helperRows({ ...DEFAULTS, lfm: { key: false }, radar: { off: true } });
  const checks = { deezer: { ok: false, err: 'timeout' }, spotify: { ok: true } };
  assert.deepEqual(helperAttention(some, checks).map(r => r.id), ['lastfm', 'deezer', 'radar']);
  const folded = helpersHTML(some, { esc, checks });
  assert.match(folded, /<span class="tag warn">11 of 13 on · 1 not answering<\/span>/);
  const look = folded.slice(folded.indexOf('hlist-look'));
  assert.deepEqual([...look.matchAll(/data-helper="(\w+)"/g)].map(m => m[1]), ['lastfm', 'deezer', 'radar']);
  // Discogs off is an optional extra: never asks for a look.
  assert.ok(!helperAttention(helperRows(DEFAULTS)).some(r => r.id === 'discogs'));
});

// BUILD-7 Q1: accounts that cannot be scored yet are told why, with the number, never "first run soon".
test('the weekly check and learning rows say what they wait for on a library that cannot score yet', () => {
  const at = s => helperRows({ ...DEFAULTS, ...s });
  const none = at({ engine: { status: 'idle', targets: 0 }, auto: { at: null, filed: 0 } });
  const a0 = none.find(r => r.id === 'autoscore'), e0 = none.find(r => r.id === 'engine');
  assert.equal(a0.status, 'On · waiting');
  assert.equal(a0.kind, 'idle');
  assert.match(a0.did, /genre playlist/);
  assert.equal(e0.status, 'On · waiting');
  assert.match(e0.did, /mark one in Library/);
  const few = at({ engine: { status: 'ready', targets: 3 }, auto: { at: null, filed: 24, minFiled: 60 } }).find(r => r.id === 'autoscore');
  assert.equal(few.status, 'On · waiting');
  assert.match(few.did, /once 60 tracks are filed in your genre playlists \(24 so far\)/);
  // Enough filed, or a run already made: unchanged.
  assert.equal(at({ engine: { status: 'ready', targets: 3 }, auto: { at: null, filed: 600 } }).find(r => r.id === 'autoscore').status, 'On · first run soon');
  assert.equal(at({ engine: { status: 'ready', targets: 3 }, auto: { at: 1, ok: true, ago: '2 h ago', filed: 10 } }).find(r => r.id === 'autoscore').status, 'On · ran 2 h ago');
  assert.equal(at({ auto: { running: true, filed: 0 }, engine: { targets: 0 } }).find(r => r.id === 'autoscore').status, 'On · scoring now');
});
