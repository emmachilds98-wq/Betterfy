// Score + Tune by itself (docs/NEXT-WORKPLAN.md package 1): every branch of the
// pure scheduler, the Engine screen's line, and that the page wires it up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autoScoreWhy, autoScoreLine, autoScoreStatus, agoWords, AUTOSCORE } from '../core/review/autoscore.mjs';

const H = 3600e3, D = 24 * H, NOW = Date.UTC(2026, 10, 16, 22);
const base = { now: NOW, heard: 0, filed: 500, listening: null, busy: false };
const ran = (ago, o = {}) => ({ at: NOW - ago, heard: 0, why: 'first', ok: true, ...o });

test('first: never scored here and enough filed', () => {
  assert.equal(autoScoreWhy({ ...base, last: null }), 'first');
  assert.equal(autoScoreWhy({ ...base, last: null, filed: AUTOSCORE.minFiled - 1 }), null, 'too little filed to score');
  assert.equal(autoScoreWhy({ ...base, last: null, listening: 'running' }), 'first', 'a first run does not wait for listening');
  assert.equal(autoScoreWhy({ ...base, last: { junk: 1 } }), 'first', 'a record with no time reads as never');
});

test('never while a Score, Tune or analysis run is going', () => {
  assert.equal(autoScoreWhy({ ...base, last: null, busy: true }), null);
  assert.equal(autoScoreWhy({ ...base, last: ran(30 * D), busy: true }), null);
});

test('listened: listening finished and heard 50+ more', () => {
  assert.equal(autoScoreWhy({ ...base, last: ran(H, { heard: 100 }), heard: 150, listening: 'done' }), 'listened');
  assert.equal(autoScoreWhy({ ...base, last: ran(H, { heard: 100 }), heard: 149, listening: 'done' }), null);
  assert.equal(autoScoreWhy({ ...base, last: ran(H, { heard: 100 }), heard: 150, listening: 'paused' }), null, 'paused is not done');
});

test('heard: 200+ more and 25%+ more, even mid-listen', () => {
  assert.equal(autoScoreWhy({ ...base, last: ran(H, { heard: 400 }), heard: 600 }), 'heard');
  assert.equal(autoScoreWhy({ ...base, last: ran(H, { heard: 1000 }), heard: 1200 }), null, '200 more but only 20% more');
  assert.equal(autoScoreWhy({ ...base, last: ran(H, { heard: 400 }), heard: 600, listening: 'running' }), 'heard');
  assert.equal(autoScoreWhy({ ...base, last: ran(H, { heard: 400 }), heard: 599, listening: 'running' }), null);
});

test('waits while listening runs, unless the last run is a week old', () => {
  assert.equal(autoScoreWhy({ ...base, last: ran(6 * D, { heard: 100 }), heard: 160, listening: 'running' }), null);
  assert.equal(autoScoreWhy({ ...base, last: ran(7 * D, { heard: 100 }), heard: 120, listening: 'running' }), 'weekly');
});

test('weekly: seven days since the last run, by hand or by itself', () => {
  assert.equal(autoScoreWhy({ ...base, last: ran(7 * D) }), 'weekly');
  assert.equal(autoScoreWhy({ ...base, last: ran(7 * D - 1) }), null);
  assert.equal(autoScoreWhy({ ...base, last: ran(7 * D, { why: 'manual' }) }), 'weekly');
  assert.equal(autoScoreWhy({ ...base, last: ran(2 * D, { why: 'manual' }) }), null, 'a run by hand resets the clock');
});

test('a failed run is not retried for 6 hours, then for the same reason', () => {
  assert.equal(autoScoreWhy({ ...base, last: ran(5 * H, { ok: false, why: 'listened' }) }), null);
  assert.equal(autoScoreWhy({ ...base, last: ran(6 * H, { ok: false, why: 'listened' }) }), 'listened');
  assert.equal(autoScoreWhy({ ...base, last: ran(6 * H, { ok: false, why: 'manual' }) }), 'weekly');
  assert.equal(autoScoreWhy({ ...base, last: ran(6 * H, { ok: false }), busy: true }), null);
});

test('the Engine screen line says when it ran, why, and when it runs next', () => {
  assert.equal(autoScoreLine(ran(2 * H, { why: 'listened' }), NOW),
    'Last scored 2 h ago, after listening finished. Runs again by itself when listening finishes or has heard 200+ more tracks, or in 7 days.');
  assert.match(autoScoreLine(ran(6.5 * D, { why: 'weekly' }), NOW), /on its weekly check\. .* or in a day\.$/);
  assert.match(autoScoreLine(ran(H, { why: 'manual' }), NOW), /when you ran it/);
  assert.match(autoScoreLine(null, NOW), /^Runs by itself a minute after the app opens/);
  assert.match(autoScoreLine(null, NOW, { filed: 12 }), /once 60 tracks are filed .* \(12 so far\)/);
  assert.match(autoScoreLine(ran(H, { ok: false }), NOW), /didn't finish\. It tries again by itself in about 5 h/);
  assert.match(autoScoreLine(ran(H), NOW, { running: true }), /^Scoring and tuning by itself now/);
  assert.equal(autoScoreStatus(null, NOW), 'On · first run soon');
  assert.equal(autoScoreStatus(ran(3 * D), NOW), 'On · scored 3 days ago');
  assert.equal(agoWords(30e3), 'just now');
  assert.equal(agoWords(20 * 60e3), '20 min ago');
  assert.equal(agoWords(D), 'yesterday');
});

test('the page runs it: bundled, in the manifest, started from boot, noted on a run by hand, key registered', () => {
  assert.match(readFileSync('build-web.mjs', 'utf8'), /'core\/review\/autoscore\.mjs'/);
  assert.match(readFileSync('web/manifest.mjs', 'utf8'), /'app\/analyse\.js',\n  'app\/autoscore\.js',/);
  assert.match(readFileSync('web/app/boot.js', 'utf8'), /autoScoreStart\(\)/);
  assert.match(readFileSync('web/app/engine.js', 'utf8'), /autoScoreNote\('manual'/);
  assert.match(readFileSync('web/app/datakeys.js', 'utf8'), /key:'bf_autoscore'/);
  const page = readFileSync('web/app/autoscore.js', 'utf8');
  assert.match(page, /engineValidate\(\)[\s\S]*engineTune\(\)[\s\S]*tuneApply\(\)/, 'Score, then Tune, then keep what cleared');
  assert.match(page, /saveData/, 'skipped with Data Saver on');
  assert.match(page, /document\.hidden/, 'only while the tab is in front');
});
