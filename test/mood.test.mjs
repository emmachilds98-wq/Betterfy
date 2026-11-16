// Mood "also fits" chips (core/intrinsic/mood.mjs, ENGINE-REVIEW layer 5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fitMoods, moodChips, moodInUse, moodLine, nearScore, MOOD_GATE } from '../core/intrinsic/mood.mjs';

const DIM = 32;
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5; }
const unit = v => { const n = Math.hypot(...v); return Float32Array.from(v, x => x / n); };
const dirOf = seed => { const r = rng(seed); return Array.from({ length: DIM }, r); };
const near = (d, seed, noise) => { const r = rng(seed); return unit(d.map(x => x + noise * r())); };

/** A "Late Night" mood playlist with one sound, genre playlists with others, and a few random tracks. */
function library({ moodN = 30, noise = 0.5 } = {}) {
  const index = new Map(), playlists = [];
  const moodDir = dirOf(11);
  const mk = (id, d, seed, n = noise) => { index.set(id, { emb: near(d, seed, n) }); return { id }; };
  playlists.push({ id: 'p-late', name: 'Late Night', tracks: Array.from({ length: moodN }, (_, i) => mk(`late-${i}`, moodDir, 100 + i)) });
  for (let g = 0; g < 4; g++) {
    const d = dirOf(500 + g);
    playlists.push({ id: `p-g${g}`, name: `Genre ${g}`, tracks: Array.from({ length: 40 }, (_, i) => mk(`g${g}-${i}`, d, 1000 * (g + 1) + i)) });
  }
  playlists.push({ id: 'p-gym', name: 'Gym', tracks: Array.from({ length: 5 }, (_, i) => mk(`gym-${i}`, dirOf(77), 9000 + i)) });
  const axis = { 'p-late': 'mood', 'p-gym': 'context' };
  return { lib: { playlists }, index, axisOf: id => axis[id] ?? 'genre', moodDir };
}

test('nearScore: mean of the k closest, never itself', () => {
  const a = unit([1, 0]), b = unit([0, 1]), c = unit([1, 1]);
  const m = [['a', a], ['b', b], ['c', c]];
  assert.ok(Math.abs(nearScore(a, m, 1, 'a') - Math.SQRT1_2) < 1e-6);
  assert.ok(Math.abs(nearScore(a, m, 2, 'a') - Math.SQRT1_2 / 2) < 1e-6);
  assert.equal(nearScore(a, [['a', a]], 3, 'a'), null);
});

test('a mood playlist with its own sound earns a chip, checked on held-out tracks; a small one does not', () => {
  const { lib, index, axisOf } = library();
  const fit = fitMoods(lib, index, axisOf);
  assert.deepEqual(fit.rows.map(r => r.id), ['p-late', 'p-gym'], 'only mood and context playlists');
  const late = fit.rows[0], gym = fit.rows[1];
  assert.equal(late.use, true, JSON.stringify(late));
  assert.ok(late.checked.precision >= MOOD_GATE.minPrecision);
  assert.ok(late.checked.n >= MOOD_GATE.minHits);
  assert.equal(gym.use, false);
  assert.match(gym.why, /only 5 of 12 heard/);
  assert.equal(moodInUse(fit), true);
  assert.equal(moodInUse({ rows: [gym] }), false);
});

test('a mood playlist that sounds like everything else earns nothing', () => {
  const { lib, index, axisOf } = library();
  // Late Night made of tracks from the genre playlists: no sound of its own.
  const mixed = lib.playlists.filter(p => p.id.startsWith('p-g')).flatMap(p => p.tracks.slice(0, 8));
  const lib2 = { playlists: lib.playlists.map(p => p.id === 'p-late' ? { ...p, tracks: mixed } : p) };
  const fit = fitMoods(lib2, index, axisOf);
  assert.equal(fit.rows[0].use, false, JSON.stringify(fit.rows[0]));
});

test('chips: a new track that sounds like the playlist gets one; one that does not, or is already in it, does not', () => {
  const { lib, index, axisOf, moodDir } = library();
  const fit = fitMoods(lib, index, axisOf);
  index.set('new-late', { emb: near(moodDir, 4242, 0.5) });
  index.set('new-other', { emb: near(dirOf(500), 4343, 0.5) });
  assert.deepEqual(moodChips('new-late', fit, index, lib).map(c => c.name), ['Late Night']);
  assert.deepEqual(moodChips('new-other', fit, index, lib), []);
  assert.deepEqual(moodChips('late-3', fit, index, lib), [], 'already in it');
  assert.deepEqual(moodChips('unheard', fit, index, lib), []);
  assert.deepEqual(moodChips('new-late', null, index, lib), []);
});

test('the Score line names each mood playlist and why it is or is not used', () => {
  const { lib, index, axisOf } = library();
  const line = moodLine(fitMoods(lib, index, axisOf));
  assert.match(line, /^Mood chips: 1 of 2 mood playlists earned an "also fits" chip\. Late Night \(right \d+% of \d+ held out\); Gym \(not used: only 5 of 12 heard\)\.$/);
  assert.equal(moodLine({ rows: [] }), '');
  assert.equal(fitMoods(lib, new Map(), axisOf).rows.length, 0);
});

test('File shows the chips as a separate group that only adds to the selection', () => {
  const src = readFileSync(new URL('../web/screens/inbox.mjs', import.meta.url), 'utf8');
  assert.match(src, /class="alsofits"/);
  assert.match(src, /Also fits \$\{esc\(m\.name\)\}/);
  assert.match(src, /data-act="selfile" data-selfile="\$\{esc\(m\.id\)\}"/);
});
