import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { genreQuery, genresFrom, genreTags } from '../core/sources/wikidata.mjs';

/*
 * Keyless genres from Wikidata for artists nothing else has tagged
 * (docs/SMARTER-GENRES-PLAN.md §4.1c). The parser is pure; the fill runs from
 * the real built page against the real engine bundle, with Wikidata and Last.fm
 * scripted.
 */

const ID = n => `${'Z'.repeat(21)}${n}`;

test('genre query: ids are validated before they reach the query text', () => {
  const q = genreQuery([ID(1), '" } DROP', ID(1)]);
  assert.equal(q.match(new RegExp(ID(1), 'g')).length, 1);
  assert.ok(!q.includes('DROP'));
  assert.match(q, /wdt:P136/);
});

test('genres come back per artist, in order, without repeats', () => {
  const b = (s, g) => ({ s: { value: s }, gl: { value: g } });
  const out = genresFrom({ results: { bindings: [b(ID(1), 'house music'), b(ID(1), 'techno'), b(ID(1), 'house music'), b('bad', 'x')] } });
  assert.deepEqual(out.genres.get(ID(1)), ['house music', 'techno']);
  assert.equal(out.genres.size, 1);
  assert.deepEqual(genresFrom('<html>'), { answered: false });
});

test('labels read like crowd tags: "house music" is house, "heavy metal music" heavy metal, EDM is EDM', () => {
  assert.deepEqual(genreTags(['house music', 'UK garage', 'electronic dance music', 'House Music', 'heavy metal music']),
    [['house', 100], ['uk garage', 85], ['edm', 70], ['heavy metal', 55]]);
  assert.deepEqual(genreTags([]), []);
});

/* ---------- the fill, in the page ---------- */

const PAGE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const ENGINE = readFileSync(new URL('../docs/engine.js', import.meta.url), 'utf8');
const block = (() => {
  const i = PAGE.indexOf('async function discogsTags('), j = PAGE.indexOf("/* ---------- correcting one artist's tags");
  assert.ok(i > 0 && j > i, 'enrich block not found — rebuild with npm run build:web');
  return PAGE.slice(i, j);
})();

function load({ tags = {}, cache = {}, wikidata = {}, wikidataFails = false, lastfm = {} } = {}) {
  const store = { tags_extra: JSON.parse(JSON.stringify(cache)) };
  const asked = { wikidata: [], lastfm: [] };
  const artists = ['A', 'B', 'C', 'D'].map((x, i) => ({ id: ID(i), name: x }));
  const s = {
    LIB: { playlists: [{ id: 'p', name: 'House', tracks: artists.map((a, i) => ({ id: 't' + i, artists: [a] })) }], liked: [] },
    CFG: {},
    TAGS: JSON.parse(JSON.stringify({ ...cache, ...tags })),
    LS: { getItem: k => (k === 'bf_lfm' ? 'lfm-key' : null) },
    idb: { get: async k => JSON.parse(JSON.stringify(store[k] ?? null)), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } },
    corsJson: async (url, init) => {
      if (wikidataFails) throw new Error('offline');
      const q = new URLSearchParams(init.body).get('query');
      const ids = [...q.matchAll(/"([0-9A-Za-z]{22})"/g)].map(m => m[1]);
      asked.wikidata.push(...ids);
      return { results: { bindings: ids.flatMap(id => (wikidata[id] ?? []).map(g => ({ s: { value: id }, gl: { value: g } }))) } };
    },
    fetch: async url => {
      const name = decodeURIComponent(new URL(url).searchParams.get('artist'));
      asked.lastfm.push(name);
      return { json: async () => ({ toptags: { tag: (lastfm[name] ?? []).map(n => ({ name: n, count: 90 })) } }) };
    },
    engineLoad: async () => true,
    getListening: async () => ({ weights: new Map() }), byListening: e => e,
    contributeTags: () => {}, buildReports: () => ({ rebuilt: true }),
    toast: m => { s.told = m; }, stage: () => {}, render: () => {}, $: () => ({ hidden: false }),
    URLSearchParams, URL, setTimeout, console,
  };
  vm.createContext(s);
  vm.runInContext(ENGINE, s);
  vm.runInContext(block, s);
  return Object.assign(s, { store: () => store.tags_extra, asked });
}
const own = x => JSON.parse(JSON.stringify(x));

test('only artists with no tags at all are asked, and what is found is used straight away', async () => {
  const app = load({ tags: { [ID(0)]: { tags: [['jungle', 90]] } }, wikidata: { [ID(1)]: ['house music'], [ID(2)]: [] } });
  const found = await app.fillFromWikidata();
  assert.equal(found, 1);
  assert.deepEqual(app.asked.wikidata.sort(), [ID(1), ID(2), ID(3)], 'the tagged artist is never asked');
  assert.deepEqual(own(app.TAGS[ID(1)].tags), [['house', 100]]);
  assert.equal(app.store()[ID(1)].source, 'wikidata');
  assert.match(app.told, /Wikidata had genres for 1 of 3 untagged artists/);
});

test('an artist Wikidata does not know is remembered as asked, and not asked again until that is stale', async () => {
  const app = load();
  await app.fillFromWikidata();
  assert.equal(app.asked.wikidata.length, 4);
  app.asked.wikidata.length = 0;
  await app.fillFromWikidata();
  assert.equal(app.asked.wikidata.length, 0);
  // Six months on, a "nothing" answer is worth another look.
  for (const e of Object.values(app.store())) e.checkedAt -= 200 * 24 * 3600 * 1000;
  await app.idb.set('tags_extra', app.store());
  await app.fillFromWikidata();
  assert.equal(app.asked.wikidata.length, 4);
});

test('a request that failed is not written down as "nothing there"', async () => {
  const app = load({ wikidataFails: true });
  await app.fillFromWikidata();
  assert.deepEqual(own(app.store()), {});
  assert.match(app.told, /could not be reached/);
});

test('the background run with nothing left to ask makes no request and says nothing', async () => {
  const app = load({ tags: Object.fromEntries([0, 1, 2, 3].map(i => [ID(i), { tags: [['techno', 90]] }])) });
  assert.equal(await app.fillFromWikidata({ quiet: true }), 0);
  assert.equal(app.asked.wikidata.length, 0);
  assert.equal(app.told, undefined);
});

test('with a Last.fm key, Last.fm is still asked about Wikidata-filled artists, and wins when it has an answer', async () => {
  const app = load({ wikidata: { [ID(0)]: ['house music'], [ID(1)]: ['rock music'] },
                     lastfm: { A: ['deep house', 'house', 'chill'] } });
  await app.fillFromWikidata();
  await app.enrichMissing();
  assert.ok(app.asked.lastfm.includes('A') && app.asked.lastfm.includes('B'));
  assert.deepEqual(own(app.TAGS[ID(0)].tags).map(([t]) => t), ['deep house', 'house', 'chill'], 'Last.fm replaces it');
  assert.deepEqual(own(app.TAGS[ID(1)].tags), [['rock', 100]], 'an empty Last.fm answer keeps the Wikidata genre');
  assert.equal(app.store()[ID(1)].source, 'wikidata');
});
