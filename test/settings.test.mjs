// The Settings sheet's structure (web/screens/settings.mjs, web/app/shell.js): one list of
// collapsible sections in a fixed order, each with a one-line status while closed, in plain words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SECTIONS, OPEN_BY_DEFAULT, sectionSummaries, sectionHTML, listeningSummary, scoreSummary, dataSummary,
  historySummary, appearanceSummary, aboutSummary, plainProblem } from '../web/screens/settings.mjs';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

test('the sections run in one fixed order, Listening is the one open by default, Disconnect is last', () => {
  assert.deepEqual(SECTIONS.map(s => s.id), ['engine', 'sources', 'helpers', 'data', 'history', 'appearance', 'about']);
  assert.deepEqual(OPEN_BY_DEFAULT, ['sources']);
  assert.equal(SECTIONS[0].title, 'Your score & how it picks');
  // The routes #/sources, #/engine and #/history land on a section of the same name.
  for (const id of ['sources', 'engine', 'history']) assert.ok(SECTIONS.some(s => s.id === id), id);
  const tpl = readFileSync(new URL('../docs/app.template.html', import.meta.url), 'utf8');
  const at = id => tpl.indexOf(`id="${id}"`);
  assert.ok(at('uhBody') < at('uh-appearance-h') && at('uh-appearance-h') < at('uh-about-h') && at('uh-about-h') < at('disconnect'), 'Disconnect comes last');
  assert.doesNotMatch(tpl.slice(tpl.indexOf('class="settings-body"')), /style="/, 'no inline styles in the sheet');
  for (const id of ['btnUpdate', 'settingsResync', 'resetTheme', 'modeGroup', 'swatches', 'compactToggle', 'rememberToggle'])
    assert.ok(at(id) > 0, `${id} is still there`);
});

test('Listening reads "on, heard N of M" and says what it is waiting for', () => {
  assert.equal(listeningSummary({ on: true, state: 'done', heard: 7161, library: 9000 }), 'On, heard 7,161 of 9,000');
  assert.equal(listeningSummary({ on: true, heard: 7161 }), 'On, heard 7,161', 'no total known: no "of"');
  assert.equal(listeningSummary({ on: false, heard: 500 }), 'Off');
  assert.equal(listeningSummary({ on: true, state: 'running', done: 37, total: 412, heard: 100, library: 500 }), 'On, listening 37 of 412 · heard 100 of 500');
  assert.equal(listeningSummary({ on: true, reason: 'waiting for Wi-Fi', heard: 5, library: 10 }), 'On, waiting for Wi-Fi · heard 5 of 10');
  assert.equal(listeningSummary({ on: true }), 'On, nothing heard yet');
});

test('the other closed lines', () => {
  assert.equal(scoreSummary({ top1: 0.623 }), 'Right first time on 62% of what you filed');
  assert.match(scoreSummary({}), /^Not scored yet/);
  assert.equal(scoreSummary({ running: true, top1: 0.5 }), 'Scoring now…');
  assert.equal(dataSummary({ playlists: 1200 }), 'Kept on this device · 1,200 playlists to back up');
  assert.equal(dataSummary({}), 'Kept on this device');
  assert.match(historySummary({}), /with undo$/);
  assert.equal(historySummary({ count: 1 }), '1 thing Betterfy wrote to Spotify, each with undo');
  assert.equal(appearanceSummary({ mode: 'dark', accent: 'Ember' }), 'Nightshift · Ember');
  assert.equal(appearanceSummary({ mode: 'system' }), 'System');
  assert.equal(aboutSummary({ build: '__BUILD__' }), 'Updates and library re-read', 'an unstamped build shows no placeholder');
  assert.match(aboutSummary({ build: 'a1b2c3' }), /^Build a1b2c3/);
});

test('sectionSummaries gives every section a line, and never an internal name', () => {
  const sums = sectionSummaries({ score: { top1: 0.5 }, listening: { on: true, heard: 3, library: 9 }, helpers: '13 of 13 on · all answering',
    data: { playlists: 4 }, history: {}, appearance: { mode: 'light', accent: 'Sage' }, about: { build: 'x1' } });
  assert.deepEqual(Object.keys(sums), ['engine', 'sources', 'helpers', 'data', 'history', 'appearance', 'about']);
  for (const [id, line] of Object.entries(sums)) {
    assert.ok(line.length > 0, `${id} has a line`);
    assert.doesNotMatch(line, /ARMS_|UNDECIDED|undefined|NaN|bf_/, `${id} is plain words`);
  }
  assert.equal(sums.helpers, '13 of 13 on · all answering');
  assert.doesNotThrow(() => sectionSummaries(), 'works before the page has anything');
});

test('a failure is shown in plain words, never as a stack or an address', () => {
  assert.match(plainProblem('Failed to fetch dynamically imported module: https://x.example/maest.js'), /^couldn’t download the listening model/);
  assert.doesNotMatch(plainProblem('Failed to fetch https://x.example/a.js'), /http/);
  assert.equal(plainProblem(''), '');
  assert.equal(plainProblem('Array buffer allocation failed'), 'this device ran out of memory');
});

test('a closed section is a button with aria-expanded and no body; an open one has a labelled region', () => {
  const shut = sectionHTML({ id: 'data', title: 'Your data', summary: 'Kept on this device', open: false, body: '<p>x</p>', mod: 'sources', esc });
  assert.match(shut, /data-uhtoggle="data" aria-expanded="false" aria-controls="uh-data-b"/);
  assert.match(shut, /Kept on this device/);
  assert.doesNotMatch(shut, /uhbody|<p>x<\/p>/);
  const open = sectionHTML({ id: 'data', title: 'Your data', summary: 'Kept on this device', open: true, body: '<p>x</p>', mod: 'sources', esc });
  assert.match(open, /class="uh open"/);
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /id="uh-data-b" role="region" aria-labelledby="uh-data-h" data-uh="sources"><p>x<\/p>/);
});
