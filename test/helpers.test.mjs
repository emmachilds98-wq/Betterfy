// "What's helping your picks" (web/screens/helpers.mjs, web/app/helpers.js):
// every source and engine part shows whether it is on, and a live check says
// whether each one answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { helperRows, helperSummary, helpersHTML, checkWords } from '../web/screens/helpers.mjs';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const DEFAULTS = { lib: { playlists: 40, liked: 1200 }, listening: { artists: 80 }, cov: { have: 900, total: 1000, pct: 90 },
  lfm: { key: true, own: false }, bridge: { on: true, deezerAsked: 500, deezerPct: 61, wikidataAsked: 700, wikidataPct: 33 },
  audio: { on: true, state: 'done', heard: 412 }, deep: { maest: true, clap: true }, discogs: false, engine: { status: 'ready' } };

test('with the defaults every part that improves picks reads as on, and Discogs as an optional extra', () => {
  const rows = helperRows(DEFAULTS);
  assert.deepEqual(rows.map(r => r.id), ['spotify', 'listening-history', 'shared', 'lastfm', 'wikidata', 'deezer', 'listenbrainz', 'sound', 'deep', 'engine', 'autoscore', 'discogs']);
  for (const r of rows.filter(x => x.id !== 'discogs')) assert.equal(r.on, true, `${r.id} is on`);
  assert.equal(rows.find(r => r.id === 'lastfm').status, 'On · built-in key');
  assert.match(rows.find(r => r.id === 'sound').did, /412 tracks heard/);
  assert.match(rows.find(r => r.id === 'deezer').did, /knows 61%/);
  const discogs = rows.find(r => r.id === 'discogs');
  assert.equal(discogs.status, 'Optional');
  assert.equal(helperSummary(rows), '11 of 11 on', 'an optional extra that is off does not count against');
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
  assert.equal(helperSummary(rows), '7 of 11 on', 'paused listening is still on');
  // Nothing known yet: still a full list, nothing invented.
  assert.equal(helperRows({}).length, 12);
  assert.equal(helperRows({}).find(r => r.id === 'spotify').status, 'Not read yet');
});

test('the live check adds one line per source and a count of what is not answering', () => {
  const rows = helperRows(DEFAULTS);
  const checks = { spotify: { ok: true, ms: 120 }, lastfm: { ok: false, err: 'Invalid API key' }, deezer: { running: true }, discogs: { skip: 'off, not asked' } };
  assert.equal(helperSummary(rows, checks), '11 of 11 on · 1 not answering');
  assert.equal(helperSummary(rows, { spotify: { ok: true } }), '11 of 11 on · all answering');
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
