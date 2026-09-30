import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweep, fit, SWEEPS, PLAYLIST_SWEEPS } from '../core/benchmark/fit.mjs';
import { THRESHOLDS } from '../core/analysis/classify.mjs';
import { runBenchmark } from '../core/benchmark/run.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/*
 * §9: "Actual numerical weights must be validated using the benchmark
 * dataset." Every threshold in the engine is a declared prior until something
 * checks it. These are that something — and the honest half of the result is
 * that most of them are merely uncontradicted, which the sweep says out loud.
 */

test('a sweep restores the parameter it moved, even when the run throws', () => {
  const before = THRESHOLDS.MIN_LEADER_SHARE;
  sweep(SWEEPS.find(s => s.key === 'MIN_LEADER_SHARE'), () => { throw new Error('boom'); });
  assert.equal(THRESHOLDS.MIN_LEADER_SHARE, before,
    'a sensitivity analysis that leaves the engine mistuned would be a spectacular own goal');
});

test('no parameter is currently set to a value the benchmark scores worse at', () => {
  // The regression gate. Changing a threshold to something the benchmark
  // dislikes should fail the build rather than quietly cost accuracy.
  const { tracks, playlists } = fit();
  const mistuned = [...tracks, ...playlists].filter(r => !r.currentIsBest);
  assert.deepEqual(mistuned.map(r => `${r.name}=${r.current} scores ${r.points.find(p => p.value === r.current)?.passed}, best is ${r.best}`), []);
});

test('the sweep distinguishes a constrained parameter from an unconstrained one', () => {
  const { tracks, playlists } = fit();
  const all = [...tracks, ...playlists];
  assert.ok(all.some(r => !r.flat), 'nothing is constrained at all — the benchmark is not testing the weights');
  assert.ok(all.some(r => r.flat), 'nothing is flat — suspicious with only 12 cases; check the sweep ranges');
  for (const r of all) {
    assert.ok(r.points.length > 3, `${r.name} swept too few points to say anything`);
    assert.equal(typeof r.plateauWidth, 'number');
  }
});

test('the specificity gap between track and artist evidence is what the benchmark leans on hardest', () => {
  // This is the number §4.1's whole fix rests on, so it should be one the
  // benchmark actually has an opinion about.
  const r = fit().tracks.find(x => x.name === 'SPECIFICITY.artist');
  assert.ok(!r.flat, 'if this is flat, the benchmark is not exercising artist-vs-track evidence at all');
  assert.ok(r.worst < r.best);
});

/* ---------- the diagnostics CLI ---------- */

/**
 * A disposable library, in the shape snapshot.mjs writes. The CLI resolves
 * its imports relative to the script and its data relative to cwd, so it can
 * be run against a throwaway directory without copying the engine into it.
 */
function lab() {
  const dir = mkdtempSync(join(tmpdir(), 'bf-v3-'));
  const DAY = 86400000, NOW = Date.now();
  let n = 0;
  const pool = (key, name, prefix, count, released) =>
    Array.from({ length: count }, (_, i) => ({
      id: `t${++n}`, name: `${prefix} ${i}`, released,
      artists: [{ id: `${key}${i % 4}`, name: `${name} ${i % 4}` }],
      added_at: new Date(NOW - (500 + i) * DAY).toISOString(),
    }));
  const th = pool('th', 'TH Artist', 'TH', 30, '2021-01-01');
  const ju = pool('ju', 'Jungle Artist', 'JU', 20, '1996-01-01');
  const tags = {};
  for (const t of th) tags[t.artists[0].id] = { tags: [['tech house', 100], ['house', 60]], checkedAt: NOW };
  for (const t of ju) tags[t.artists[0].id] = { tags: [['jungle', 100], ['drum and bass', 80]], checkedAt: NOW };
  tags.th0 = { tags: [['schranz', 100]], checkedAt: NOW };

  writeFileSync(join(dir, 'library.json'), JSON.stringify({
    playlists: [
      { id: 'p-th', name: 'Tech House', tracks: th },
      { id: 'p-thfav', name: 'Tech House — Favourites', tracks: th.slice(0, 12) },
      { id: 'p-ju', name: 'Jungle', tracks: ju },
    ],
    liked: [], top_artists: { long_term: [] },
  }));
  writeFileSync(join(dir, 'tags-lastfm.json'), JSON.stringify(tags));
  return dir;
}

const runCli = (dir, args = []) =>
  execFileSync('node', [join(ROOT, 'analyse-v3.mjs'), ...args],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('the CLI runs the whole engine over a real library shape and writes a report', t => {
  const dir = lab();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = runCli(dir);

  assert.match(out, /=== TRACKS: 50 ===/);
  assert.match(out, /Tech House/);
  assert.match(out, /=== WORTH ASKING YOU ABOUT ===/);
  assert.ok(existsSync(join(dir, 'report-v3.json')));

  const report = JSON.parse(readFileSync(join(dir, 'report-v3.json'), 'utf8'));
  assert.equal(report.report.tracks, 50);
  assert.ok(report.versions.ontology);
  assert.equal(report.playlists.length, 3);
  // The §19 relationship the fixture is built to produce.
  assert.ok(report.relationships.some(r => r.kind === 'view'));
});

test('the CLI reports genre corroboration honestly when only one source exists', t => {
  const dir = lab();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = runCli(dir);
  // Spotify supplies an era for every dated track, so a naive "how many
  // providers said anything" reads 100% in every library and means nothing.
  assert.match(out, /genre corroborated by more than one independent source: 0 \(0\.0%\)/);
});

test('with no listening history, nothing is claimed to be heavily played', t => {
  const dir = lab();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = runCli(dir);
  assert.ok(!out.includes('you play this a lot'),
    'the library-size floor in listeningWeights is not evidence that anybody played anything');
});

test('--queue writes the rows a person would work through', t => {
  const dir = lab();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  runCli(dir, ['--queue']);
  const queue = JSON.parse(readFileSync(join(dir, 'review-queue.json'), 'utf8'));
  assert.ok(queue.tracks.length);
  assert.ok(queue.tracks.every(r => r.reasons.length), 'every row must say why it is being asked');
  assert.ok(queue.concepts.some(c => c.raw === 'schranz'));
  // Collapsed, not one row per track.
  assert.ok(queue.tracks.length < 50);
});

test('the CLI says what to do rather than failing obscurely with no library', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bf-v3-empty-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => runCli(dir), e => /snapshot\.mjs/.test(String(e.stderr)));
});
