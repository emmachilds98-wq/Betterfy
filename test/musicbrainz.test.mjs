import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractArtistMbid, resolveMbid, resolveMbids, extractGenresAndTags, fetchArtistGenres } from '../musicbrainz.mjs';

// Identity glue: an exact match on the Spotify URL MusicBrainz has on file for
// an artist, so there is no name-fuzziness for a same-named act to exploit.
// extractArtistMbid() is the pure parsing half — the two response shapes
// tried are both documented by MusicBrainz's ws/2 JSON; see musicbrainz.mjs
// for why this hasn't been checked against a live response from here.

test('an MBID is read from a flat relations array', () => {
  const json = { urls: [{ id: 'u1', resource: 'https://open.spotify.com/artist/x',
    relations: [{ type: 'free streaming', artist: { id: 'mbid-1', name: 'Example' } }] }] };
  assert.equal(extractArtistMbid(json), 'mbid-1');
});

test('an MBID is read from a nested relation-list, when that is the shape instead', () => {
  const json = { urls: [{ id: 'u1', resource: 'https://open.spotify.com/artist/x',
    'relation-list': [{ 'target-type': 'artist', relations: [{ artist: { id: 'mbid-2', name: 'Example' } }] }] }] };
  assert.equal(extractArtistMbid(json), 'mbid-2');
});

test('no url hit at all is not found, not a throw', () => {
  assert.equal(extractArtistMbid({ urls: [] }), null);
  assert.equal(extractArtistMbid({}), null);
  assert.equal(extractArtistMbid(null), null);
});

test('a url hit with no artist relation is not found', () => {
  const json = { urls: [{ id: 'u1', resource: 'x', relations: [{ type: 'wikidata' }] }] };
  assert.equal(extractArtistMbid(json), null);
});

/* ---------- the network half, with fetch mocked exactly like merge-tags.test.mjs ---------- */

test('resolveMbid sends an identifiable User-Agent built from the configured contact', async () => {
  const realFetch = globalThis.fetch;
  let seenUA, seenUrl;
  globalThis.fetch = async (url, opts) => {
    seenUrl = String(url); seenUA = opts?.headers?.['User-Agent'];
    return { json: async () => ({ urls: [{ relations: [{ artist: { id: 'mbid-3' } }] }] }) };
  };
  try {
    const mbid = await resolveMbid('spotify123', 'contact@example.com');
    assert.equal(mbid, 'mbid-3');
    assert.ok(seenUA.includes('contact@example.com'), 'the courtesy contact string is on every request');
    assert.ok(seenUrl.includes('open.spotify.com%2Fartist%2Fspotify123'), 'queries the exact Spotify artist URL');
  } finally { globalThis.fetch = realFetch; }
});

test('resolveMbid never throws — a network failure is just "not found"', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    assert.equal(await resolveMbid('x', 'c@example.com'), null);
  } finally { globalThis.fetch = realFetch; }
});

test('resolveMbids is a no-op with no contact string configured — no request at all', async () => {
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return { json: async () => ({}) }; };
  try {
    const out = await resolveMbids([['a', 'Artist A']], '');
    assert.deepEqual([...out.entries()], []);
    assert.equal(called, false);
  } finally { globalThis.fetch = realFetch; }
});

test('resolveMbids maps every pair that resolved, and omits the gaps', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const found = String(url).includes('a1');
    return { json: async () => (found ? { urls: [{ relations: [{ artist: { id: 'mbid-a1' } }] }] } : { urls: [] }) };
  };
  try {
    const out = await resolveMbids([['a1', 'Has One'], ['a2', 'Has None']], 'c@example.com');
    assert.deepEqual([...out.entries()], [['a1', 'mbid-a1']]);
  } finally { globalThis.fetch = realFetch; }
});

/* ---------- genres/tags: one more field on an identity already resolved ---------- */

test('genres and tags are folded into one tally, rescaled so the top entry is 100', () => {
  const json = {
    genres: [{ name: 'Jungle', count: 4 }, { name: 'Drum and Bass', count: 2 }],
    tags: [{ name: 'uk', count: 8 }, { name: 'jungle', count: 1 }], // lowercase dup of the genre above
  };
  const out = extractGenresAndTags(json);
  assert.deepEqual(out[0], ['uk', 100], 'the highest count of any entry leads, genre or tag alike');
  // "jungle" appears as both a genre (count 4) and a tag (count 1) — the
  // higher of the two wins rather than the two adding together, since they
  // describe the same fact about the artist, not two independent votes.
  const jungle = out.find(([name]) => name === 'jungle');
  assert.deepEqual(jungle, ['jungle', 50]);
});

test('an artist with neither genres nor tags comes back empty, not a throw', () => {
  assert.deepEqual(extractGenresAndTags({}), []);
  assert.deepEqual(extractGenresAndTags(null), []);
  assert.deepEqual(extractGenresAndTags({ genres: [], tags: [] }), []);
});

test('an entry with no name or a non-numeric count is skipped rather than corrupting the tally', () => {
  const json = { genres: [{ name: 'Jungle', count: 3 }, { count: 5 }, { name: 'Techno', count: 'lots' }] };
  assert.deepEqual(extractGenresAndTags(json), [['jungle', 100]]);
});

test('at most ten entries are kept, strongest first', () => {
  const genres = Array.from({ length: 15 }, (_, i) => ({ name: `g${i}`, count: i + 1 }));
  const out = extractGenresAndTags({ genres });
  assert.equal(out.length, 10);
  assert.equal(out[0][0], 'g14', 'the highest count leads');
});

test('fetchArtistGenres sends the same identifiable User-Agent, keyed on the resolved mbid', async () => {
  const realFetch = globalThis.fetch;
  let seenUrl, seenUA;
  globalThis.fetch = async (url, opts) => {
    seenUrl = String(url); seenUA = opts?.headers?.['User-Agent'];
    return { json: async () => ({ genres: [{ name: 'techno', count: 5 }] }) };
  };
  try {
    const tags = await fetchArtistGenres('mbid-123', 'contact@example.com');
    assert.deepEqual(tags, [['techno', 100]]);
    assert.ok(seenUrl.includes('mbid-123'));
    assert.ok(seenUrl.includes('inc=genres%2Btags') || seenUrl.includes('inc=genres+tags'));
    assert.ok(seenUA.includes('contact@example.com'));
  } finally { globalThis.fetch = realFetch; }
});

test('fetchArtistGenres never throws — a network failure is just "nothing here"', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    assert.deepEqual(await fetchArtistGenres('mbid-x', 'c@example.com'), []);
  } finally { globalThis.fetch = realFetch; }
});
