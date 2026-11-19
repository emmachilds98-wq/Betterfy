// BUILD-8 W1: Wikidata coverage (retry-later bookkeeping, name fallback), and the
// MusicBrainz-in-the-page queue. The responders are fakes: what these prove is the
// bookkeeping and the count, not what the live services know (that is measured on
// an account, not in CI; see docs/BUILD-8-PLAN.md W1's progress row).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as W from '../core/sources/wikidata.mjs';
import * as M from '../core/sources/mb-web.mjs';
import { artistCoverage } from '../web/screens/sources.mjs';

const ID = n => String(n).padStart(22, 'Z');
const DAY = 24 * 60 * 60 * 1000;

test('wikidataTodo: never-asked and stale empties are asked; answered ones and other sources are not', () => {
  const now = 1e12;
  const cached = {
    [ID(1)]: { source: 'wikidata', tags: [['house', 100]], checkedAt: now - 400 * DAY },   // has genres: leave
    [ID(2)]: { source: 'wikidata', tags: [], checkedAt: now - 5 * DAY },                    // empty, fresh: leave
    [ID(3)]: { source: 'wikidata', tags: [], checkedAt: now - 60 * DAY },                   // empty, stale: ask again
    [ID(4)]: { source: 'lastfm', tags: [], checkedAt: now },                                // not Wikidata's entry: ask
  };
  assert.deepEqual(W.wikidataTodo([ID(1), ID(2), ID(3), ID(4), ID(5), ID(5)], cached, now), [ID(3), ID(4), ID(5)]);
});

test('a batch that was never answered is not written down, so it is asked next run', () => {
  // The fill only writes cached[id] for an answered batch (keyless.js); the todo
  // therefore still lists every artist of a 429'd batch.
  const asked = [ID(1), ID(2)];
  assert.deepEqual(W.wikidataTodo(asked, {}, 1), asked);
});

test('name fallback: exact unique label with an MBID wins; a shared name gets nothing; odd names never reach the query', () => {
  const row = (n, a, g) => ({ n: { value: n }, a: { value: a }, gl: { value: g } });
  const out = W.genresByName({ results: { bindings: [
    row('Skream', 'Q1', 'dubstep'), row('Skream', 'Q1', 'house music'),
    row('Nightmares', 'Q2', 'rock'), row('Nightmares', 'Q3', 'techno'),
  ] } });
  assert.deepEqual(out.genres.get('skream'), ['dubstep', 'house music']);
  assert.equal(out.genres.has('nightmares'), false);
  assert.deepEqual(W.genresByName('<html>'), { answered: false });
  const q = W.nameQuery(['Skream', 'Bad" } DROP', 'x']);
  assert.match(q, /"Skream"@en/);
  assert.ok(!q.includes('DROP') && !q.includes('"x"'));
  assert.match(q, /wdt:P434/);
});

test('fixture: id lookup alone vs id + name fallback, counted the way Settings counts', () => {
  // 100 artists. Wikidata links 4 by Spotify id (the owner's 4%); 14 more have an item
  // with an MBID and genres but no Spotify link and a unique name; 6 share a name.
  const ids = Array.from({ length: 100 }, (_, i) => ID(i));
  const name = id => `Artist ${Number(id.replace(/Z/g, '') || 0)}`;
  const byId = new Set(ids.slice(0, 4));
  const byName = new Set(ids.slice(4, 18));
  const ambiguous = new Set(ids.slice(18, 24));
  const run = useNames => {
    const extra = {};
    const asked = ids.filter(id => W.wikidataTodo([id], {}).length);
    const empties = [];
    for (const id of asked) {
      if (byId.has(id)) extra[id] = { source: 'wikidata', tags: W.genreTags(['house music']) };
      else { extra[id] = { source: 'wikidata', tags: [] }; empties.push(id); }
    }
    if (useNames) {
      const bindings = [];
      for (const id of empties) {
        if (byName.has(id)) bindings.push({ n: { value: name(id) }, a: { value: 'Q' + id }, gl: { value: 'techno' } });
        if (ambiguous.has(id)) for (const q of ['A', 'B']) bindings.push({ n: { value: name(id) }, a: { value: q + id }, gl: { value: 'rock' } });
      }
      const out = W.genresByName({ results: { bindings } });
      for (const id of empties) {
        const tags = W.genreTags(out.genres.get(W.nameKey(name(id))) ?? []);
        if (tags.length) extra[id] = { source: 'wikidata', tags, via: 'name' };
      }
    }
    return artistCoverage({ ids, extra });
  };
  const before = run(false), after = run(true);
  assert.equal(before.wikidataPct, 4);
  assert.equal(after.wikidataPct, 18, 'the 14 unique names are found, the 6 shared names are not');
  assert.ok(after.wikidataPct - before.wikidataPct >= 10, 'the +10 point bar, on this fixture');
});

test('artistCoverage counts MusicBrainz-filled artists on their own, not as Wikidata', () => {
  const cov = artistCoverage({ ids: [ID(1), ID(2)], extra: { [ID(1)]: { source: 'musicbrainz', tags: [['x', 1]] }, [ID(2)]: { source: 'musicbrainz', tags: [] } } });
  assert.equal(cov.musicbrainz, 1);
  assert.equal(cov.wikidata, 0);
});

/* ---------- MusicBrainz: parse, what to ask, and the queue ---------- */

const MBID = n => `a74b1b7f-71a5-4011-9441-d0b5e41${String(n).padStart(5, '0')}`;

test('ListenBrainz artist tags: curated genres win, scaled to the top vote; odd shapes are no answer', () => {
  const tg = (tag, count, genre_mbid) => ({ tag, count, genre_mbid });
  const out = M.tagsFrom([
    { artist_mbid: MBID(1), tag: { artist: [tg('Techno', 5, 'g1'), tg('house', 20, 'g2'), tg('seen live', 90, null), tg('x', 0, 'g3')] } },
    { artist_mbid: MBID(2), tag: { artist: [tg('british', 7, null)] } },
    { artist_mbid: MBID(3), tag: { artist: [] } },
    { artist_mbid: 'bad', tag: { artist: [tg('a', 1, 'g')] } },
  ]);
  assert.deepEqual(out.get(MBID(1)), [['house', 100], ['techno', 40]]);
  assert.deepEqual(out.get(MBID(2)), [['british', 100]]);
  assert.deepEqual(out.get(MBID(3)), []);
  assert.equal(out.size, 3);
  assert.equal(M.tagsFrom({ error: 'x' }), null);
  const u = M.tagsUrl([MBID(1), MBID(1), 'junk']);
  assert.ok(u.startsWith('https://api.listenbrainz.org/1/metadata/artist/?') && u.includes('inc=tag'));
  assert.ok(!u.includes('junk'));
});

test('mbTodo: needs an MBID and no tags, skips fresh answers, caps the run', () => {
  const now = 1e12, mbids = { a: MBID(1), b: MBID(2), c: 'nope', d: MBID(4), e: MBID(5) };
  const cached = { b: { source: 'musicbrainz', tags: [], checkedAt: now - DAY }, d: { source: 'musicbrainz', tags: [], checkedAt: now - 120 * DAY } };
  const todo = M.mbTodo(['a', 'b', 'c', 'd', 'e', 'f'], { mbidOf: id => mbids[id], hasTags: id => id === 'e', cached, now, cap: 5 });
  assert.deepEqual(todo.map(([id]) => id), ['a', 'd'], 'b asked yesterday, c has no MBID, e is tagged, f has no MBID');
  assert.equal(M.mbTodo(['a', 'd'], { mbidOf: id => mbids[id], hasTags: () => false, now, cap: 1 }).length, 1);
});

const src = readFileSync(new URL('../web/app/keyless.js', import.meta.url), 'utf8');
const code = src.slice(src.indexOf('const MB = {'), src.indexOf('const mbVisible'));

function mbSandbox(statuses) {
  const calls = [], waits = [];
  let t = 1_000_000;
  const ctx = vm.createContext({ BetterfyMbWeb: M, Error, Promise, calls, waits,
    Date: { now: () => t },
    setTimeout: (fn, ms) => { waits.push(ms); t += ms; fn(); },
    fetch: async url => { calls.push([url, t]); const s = statuses.shift() ?? 200;
      return { ok: s === 200, status: s, headers: { get: () => null }, json: async () => [] }; } });
  vm.runInContext(code + '\nthis.mbJson = mbJson; this.MB = MB;', ctx);
  return ctx;
}

test('MusicBrainz queue: requests are spaced apart', async () => {
  const c = mbSandbox([]);
  await Promise.all([c.mbJson('u1'), c.mbJson('u2'), c.mbJson('u3')]);
  assert.equal(c.calls.length, 3);
  assert.ok(c.calls[1][1] - c.calls[0][1] >= M.MB_SPACING_MS);
  assert.ok(c.calls[2][1] - c.calls[1][1] >= M.MB_SPACING_MS);
});

test('MusicBrainz queue: a 429 rests it for ten minutes, with no further requests', async () => {
  const c = mbSandbox([429]);
  await assert.rejects(c.mbJson('u1'), /answered 429/);
  await assert.rejects(c.mbJson('u2'), /busy/);
  assert.equal(c.calls.length, 1);
});

test('the page keeps MusicBrainz a bonus: it asks only with an MBID, a visible tab and Data Saver off', () => {
  const fill = src.slice(src.indexOf('async function fillFromMusicBrainz'));
  assert.match(fill, /mbVisible\(\)/);
  assert.match(fill, /saveData/);
  assert.match(fill, /mbTodo/);
});
