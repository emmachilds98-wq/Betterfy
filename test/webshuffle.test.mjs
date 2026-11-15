import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/*
 * The spaced shuffle is the most expensive thing this app computes, and once
 * "All Songs — Betterfy" became the default source it was being asked to do it
 * over the whole library. It picked the artist with the most tracks left by
 * scanning every artist, on every one of n placements — quadratic, and the
 * screen ran the whole thing again on every redraw. Measured on this build
 * before the rewrite: twelve thousand tracks took about twelve seconds of
 * blocked main thread, every time you opened Shuffle.
 *
 * What must not change is the answer: every track placed exactly once, and the
 * same artist and album spacing as before.
 */

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

function load() {
  const i = BUNDLE.indexOf('const rnd = a =>'), j = BUNDLE.indexOf('/* ---------- discovery: new by construction');
  assert.ok(i > 0 && j > i, 'shuffle block not found — rebuild with npm run build:web');
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(BUNDLE.slice(i, j).replace('const ALL_SONGS_NAME', 'var ALL_SONGS_NAME'), sandbox);
  return sandbox;
}

/** n tracks over `artists` artists and `albums` albums, round-robin. */
const library = (n, artists, albums = 40) => Array.from({ length: n }, (_, k) => ({
  id: 't' + k, name: 'Track ' + k, album: 'Album ' + (k % albums),
  artists: [{ name: 'Artist ' + (k % artists) }],
}));

test('every track is placed exactly once', () => {
  const app = load();
  const tracks = library(600, 90);
  const order = app.spacedShuffle(tracks);
  assert.equal(order.length, 600);
  assert.equal(new Set(order.map(t => t.id)).size, 600, 'nothing dropped and nothing repeated');
});

test('the same artist never lands back to back while another one is free', () => {
  const app = load();
  const order = app.spacedShuffle(library(400, 40));
  assert.equal(app.shuffleStats(order).adjacent, 0);
  assert.ok(app.shuffleStats(order).minGap >= 2, 'and never within a slot of itself');
});

test('one artist with everything still comes out whole, rather than stalling', () => {
  const app = load();
  const order = app.spacedShuffle(library(50, 1));
  assert.equal(order.length, 50, 'there is nothing to space it against, but it must still finish');
  assert.equal(new Set(order.map(t => t.id)).size, 50);
});

test('a two-artist library alternates rather than clumping', () => {
  const app = load();
  const order = app.spacedShuffle(library(60, 2));
  assert.equal(app.shuffleStats(order).adjacent, 0);
});

test('a library the size of a real one shuffles in well under a second', () => {
  const app = load();
  const tracks = library(12000, 4000, 900);
  const t0 = Date.now();
  const order = app.spacedShuffle(tracks);
  const ms = Date.now() - t0;
  assert.equal(order.length, 12000);
  // The old scan-every-artist loop took roughly twelve seconds here. A generous
  // ceiling: this is a guard against the quadratic coming back, not a benchmark.
  assert.ok(ms < 2000, `spacedShuffle took ${ms}ms for 12,000 tracks — the per-pick scan is back`);
});

test('the shuffle is cached against its source rather than recomputed on every redraw', async () => {
  const body = (await import('node:fs')).readFileSync(new URL('../web/screens/shuffle.mjs', import.meta.url), 'utf8');
  assert.match(body, /S\.shufCache\?\.id !== sel \|\| S\.shufCache\?\.n !== tracks\.length/,
    'a redraw for an unrelated reason must not re-shuffle the whole library');
  assert.match(body, /id="shufAgain"/, 'and re-rolling it is a deliberate button');
});

test('changing the source, or topping All Songs up, drops the cached order', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../web/screens/shuffle.mjs', import.meta.url), 'utf8');
  assert.match(src, /shufPl\(\{ S, render \}, el\) \{ S\.shufPl = el\.value; S\.shufCache = null;/);
  assert.match(src, /shufAgain\(\{ S, render \}\) \{ S\.shufCache = null;/);
  assert.match(BUNDLE, /S\.shufPl = pl\.id; S\.shufCache = null;/,
    'tracks just added to All Songs have to be able to reach the order');
});

test('rediscover puts what you have been playing last, still spaced, nothing lost', () => {
  const app = load();
  const tracks = library(200, 20);
  const hot = new Set(['Artist 0', 'Artist 1', 'Artist 2']);
  const order = app.shuffleOrder(tracks, { rediscover: hot });
  assert.equal(new Set(order.map(t => t.id)).size, 200);
  const firstHot = order.findIndex(t => hot.has(t.artists[0].name));
  assert.equal(firstHot, 200 - 30, 'the 30 tracks by those artists form the tail');
  assert.ok(order.slice(0, firstHot).every(t => !hot.has(t.artists[0].name)));
});

test('flow: neighbours get closer, artist spacing holds, nothing is dropped', () => {
  const app = load();
  const tracks = library(300, 60);
  // Sound is the parity of the track number: 1 for the same side, 0 otherwise.
  const near = (a, b) => (+a.id.slice(1) % 2 === +b.id.slice(1) % 2 ? 1 : 0);
  const plain = app.spacedShuffle(tracks), flowed = app.flowOrder(plain, near);
  assert.equal(new Set(flowed.map(t => t.id)).size, 300);
  const same = o => o.slice(1).filter((t, i) => near(o[i], t)).length;
  assert.ok(same(flowed) > same(plain) * 1.3, `${same(flowed)} vs ${same(plain)}`);
  const last = new Map(); let min = Infinity;
  flowed.forEach((t, i) => { const k = t.artists[0].name; if (last.has(k)) min = Math.min(min, i - last.get(k)); last.set(k, i); });
  assert.ok(min >= 3, 'the same artist is never within three slots');
  assert.equal(app.shuffleOrder(tracks, {}).length, 300);
});

test('flow is only offered once half the list has a sound reading or a genre tag', () => {
  const app = load();
  const tracks = library(10, 5).map(t => ({ ...t, artists: [{ id: 'x' + t.id, name: t.artists[0].name }] }));
  assert.equal(app.flowReady(tracks), false);
  app.TAGS = {}; for (const t of tracks.slice(0, 6)) app.TAGS[t.artists[0].id] = { tags: [['house', 10]] };
  assert.equal(app.flowReady(tracks), true);
});
