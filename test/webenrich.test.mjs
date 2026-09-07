import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/*
 * Filling a tag gap costs a Last.fm request, and the answer is cached in
 * IndexedDB so it is only ever paid once. That makes it important which
 * answers are worth keeping: "Last.fm has nothing on this artist" is one, and
 * "that request failed" is not — but both arrive as an empty array, and both
 * used to be written down as the artist's permanent tag set. One bad minute of
 * signal froze every artist it touched as untaggable, for good, and the artist
 * was never asked about again on any later run.
 */

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

function slice(from, to, what) {
  const i = BUNDLE.indexOf(from), j = BUNDLE.indexOf(to);
  assert.ok(i > 0 && j > i, `${what} not found — rebuild with npm run build:web`);
  return BUNDLE.slice(i, j);
}

const lfmTags = names => ({ toptags: { tag: names.map(n => ({ name: n, count: 90 })) } });

/**
 * @param answers artist name -> a Last.fm body, or a thrown error for a
 *   request that never landed.
 */
function load({ artists = [], answers = {}, cache = {}, discogs = null } = {}) {
  const store = { tags_extra: JSON.parse(JSON.stringify(cache)) };
  const asked = [];
  const sandbox = {
    LIB: { playlists: [{ id: 'p1', name: 'House',
            tracks: artists.map((a, i) => ({ id: 't' + i, artists: [{ id: 'a-' + a, name: a }] })) }],
           liked: [] },
    CFG: {},
    TAGS: Object.fromEntries(Object.entries(cache).map(([k, v]) => [k, v])),
    LS: { getItem: k => (k === 'bf_lfm' ? 'lfm-key' : k === 'bf_discogs' ? discogs : null) },
    idb: { get: async k => JSON.parse(JSON.stringify(store[k] ?? null)),
           set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } },
    fetch: async url => {
      const name = decodeURIComponent(new URL(url).searchParams.get('artist'));
      asked.push(name);
      const a = answers[name];
      if (a instanceof Error) throw a;
      return { json: async () => a ?? lfmTags([]) };
    },
    getListening: async () => ({ weights: new Map() }),
    byListening: entries => entries,
    contributeTags: () => {},
    buildReports: () => ({}),
    toast: m => { sandbox.told = m; },
    stage: () => {},
    render: () => {},
    $: () => ({ hidden: false }),
    URLSearchParams, URL, setTimeout, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(slice('async function discogsTags(', "/* ---------- correcting one artist's tags", 'enrich block'), sandbox);
  return Object.assign(sandbox, { store: () => store.tags_extra, asked });
}

test('a real "no tags anywhere" answer is cached, so it costs nothing next time', async () => {
  const app = load({ artists: ['Nobody'], answers: { Nobody: lfmTags([]) } });
  await app.enrichMissing();
  assert.deepEqual(JSON.parse(JSON.stringify(app.store()['a-Nobody'])), { tags: [] });
});

test('a request that never landed is not cached as "this artist has no tags"', async () => {
  const app = load({ artists: ['Tim Reaper'], answers: { 'Tim Reaper': new TypeError('Load failed') } });
  await app.enrichMissing();
  assert.equal(app.store()['a-Tim Reaper'], undefined,
    'nothing is written down, so the next run asks again rather than believing a dropped connection');
  assert.match(app.told, /could not be reached/);
});

test('a Last.fm error body is a failure too, not an empty answer', async () => {
  // Last.fm answers an invalid key or a throttled client with HTTP 200 and an
  // { error, message } body — which parses fine and has no tags in it.
  const app = load({ artists: ['Dwarde'], answers: { Dwarde: { error: 29, message: 'Rate limit exceeded' } } });
  await app.enrichMissing();
  assert.equal(app.store()['a-Dwarde'], undefined);
});

test('a failed artist is picked up by a later run', async () => {
  const first = load({ artists: ['Blawan'], answers: { Blawan: new TypeError('Load failed') } });
  await first.enrichMissing();
  const again = load({ artists: ['Blawan'], answers: { Blawan: lfmTags(['techno']) },
                       cache: first.store() });
  await again.enrichMissing();
  assert.deepEqual(JSON.parse(JSON.stringify(again.store()['a-Blawan'].tags)), [['techno', 90]]);
});

test('the count on the button and the run agree about what is missing', async () => {
  // tagCoverage() counts an artist with an empty tag list as missing. The run
  // used to skip anything with an entry at all, so the button offered to fetch
  // tags for artists it then reported as "Nothing missing."
  const app = load({ artists: ['Nobody'], cache: { 'a-Nobody': { tags: [] } } });
  await app.enrichMissing();
  assert.doesNotMatch(app.told ?? '', /Nothing missing/);
  assert.match(app.told, /1 have no tags anywhere|no tags anywhere/);
});

test('Discogs styles arrive on the same 0-100 scale Last.fm uses', async () => {
  // Discogs counts releases, so a style on six of an artist's records came back
  // as 6 — and trackVec divides every count by 100. Left unscaled, an artist
  // filled from Discogs was an order of magnitude quieter than one from
  // Last.fm in every centroid they belong to, and inaudible next to a
  // Last.fm-tagged collaborator on the same track.
  const app = load({});
  app.fetch = async () => ({ json: async () => ({ results: [
    { style: ['Jungle', 'Breakbeat'] }, { style: ['Jungle'] }, { style: ['Jungle', 'Electro'] },
  ] }) });
  const tags = JSON.parse(JSON.stringify(await app.discogsTags('Tim Reaper', 'token')));
  assert.deepEqual(tags[0], ['jungle', 100], 'the commonest style is the top tag, as Last.fm reports it');
  assert.deepEqual(tags.slice(1).sort(), [['breakbeat', 33], ['electro', 33]]);
});

test('Discogs is only asked when Last.fm actually answered, and answered empty', async () => {
  const app = load({ artists: ['Ghost'], answers: { Ghost: new TypeError('Load failed') }, discogs: 'tok' });
  await app.enrichMissing();
  assert.ok(!app.asked.some(a => a === 'Ghost' && app.asked.length > 1),
    'a dropped Last.fm request is not a reason to spend a Discogs request too');
});
