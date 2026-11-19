// F1: the Deezer name lookup for ISRC misses (docs/SOUND-ENGINE-PLAN.md), and F2's queue tiers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rejectReason, pickByName, cleanTitle, normTitle, searchUrl } from '../core/audio/namematch.mjs';
import { lookup, lookupByName } from '../core/audio/fetch.mjs';
import { hearingFunnel, funnelText } from '../core/audio/funnel.mjs';
import { audioQueue } from '../core/audio/queue.mjs';
import { isDeezerApiUrl } from '../core/sources/deezer.mjs';
import { makeRecord } from '../core/audio/record.mjs';

const want = { title: 'Midnight City', artists: ['M83'], durationMs: 243500 };
const hit = (o = {}) => ({ id: 1, title: 'Midnight City', artist: { name: 'M83' }, duration: 244, preview: 'https://p/1.mp3', readable: true, ...o });

test('accepts the same recording, ignoring harmless decorations', () => {
  assert.equal(rejectReason(want, hit()), null);
  assert.equal(rejectReason(want, hit({ title: 'Midnight City (Original Mix)' })), null);
  assert.equal(rejectReason(want, hit({ title: 'Midnight City - Remastered 2011' })), null);
  assert.equal(rejectReason({ ...want, title: 'Midnight City (feat. Someone)' }, hit()), null);
  assert.equal(rejectReason(want, hit({ artist: { name: 'm83' } })), null);
  assert.equal(rejectReason({ ...want, title: 'Beyoncé', artists: ['Beyoncé'] }, hit({ title: 'Beyonce', artist: { name: 'Beyonce' } })), null);
  assert.equal(rejectReason(want, hit({ duration: 243 })), null);
});

test('rejects remixes, live, edits and other versions on either side', () => {
  assert.equal(rejectReason(want, hit({ title: 'Midnight City (Eric Prydz Private Remix)' })), 'title');
  assert.equal(rejectReason(want, hit({ title: 'Midnight City (Live)' })), 'title');
  assert.equal(rejectReason(want, hit({ title: 'Midnight City', title_version: '(Acoustic)' })), 'title');
  assert.equal(rejectReason({ ...want, title: 'Midnight City - Radio Edit' }, hit()), 'title');
  assert.equal(rejectReason({ ...want, title: 'Midnight City (Live)' }, hit()), 'title');
  assert.equal(rejectReason({ ...want, title: 'Midnight City (Instrumental)' }, hit({ title: 'Midnight City (Karaoke)' })), 'title');
});

test('rejects the same title by another artist, and partial artist names', () => {
  assert.equal(rejectReason(want, hit({ artist: { name: 'Cover Band' } })), 'artist');
  assert.equal(rejectReason(want, hit({ artist: { name: 'M83 & Friends' } })), 'artist');
  assert.equal(rejectReason(want, hit({ title: 'Midnight', })), 'title');
});

test('rejects a duration more than a second apart, or unknown', () => {
  assert.equal(rejectReason(want, hit({ duration: 246 })), 'duration');
  assert.equal(rejectReason(want, hit({ duration: 200 })), 'duration');
  assert.equal(rejectReason({ ...want, durationMs: undefined }, hit()), 'duration');
  assert.equal(rejectReason(want, { id: 1 }), 'malformed');
});

test('pickByName: one master re-issued is fine, two different recordings are refused', () => {
  const reissue = pickByName(want, [hit({ id: 1 }), hit({ id: 2 }), hit({ id: 3, artist: { name: 'x' } })]);
  assert.equal(reissue.hit.id, 1);
  assert.deepEqual(pickByName(want, [hit({ id: 1, duration: 243 }), hit({ id: 2, duration: 244 })]), { none: true, ambiguous: true });
  assert.deepEqual(pickByName(want, [hit({ preview: '' })]), { none: true, noPreview: true });
  assert.deepEqual(pickByName(want, []), { none: true });
  assert.deepEqual(pickByName(want, null), { none: true });
});

test('titles: only same-recording suffixes are removed', () => {
  assert.equal(cleanTitle('Song (Original Mix)'), 'Song');
  assert.equal(cleanTitle('Song - 2011 Remaster'), 'Song');
  assert.equal(cleanTitle('Song (feat. A) (Original Mix)'), 'Song');
  assert.equal(cleanTitle('Song (VIP Mix)'), 'Song (VIP Mix)');
  assert.notEqual(normTitle('Song (Remix)'), normTitle('Song'));
});

test('the search address is pinned-host safe and quotes-free', () => {
  const u = searchUrl('Guns N\' Roses', 'Don\'t Cry (Original Mix)');
  assert.ok(isDeezerApiUrl(u), u);
  assert.ok(!/[" ]/.test(u));
  assert.ok(isDeezerApiUrl(searchUrl('M83', 'Midnight City')));
  assert.equal(isDeezerApiUrl('https://evil.example/search?q=%22'), false);
});

const search = data => ({ jsonp: async url => url.includes('/track/isrc') ? { error: { code: 800 } } : { data } });

test('lookup: an ISRC miss with names tries the search; without names it stays a miss', async () => {
  const deps = { ...search([hit()]), spotifyDurationMs: 243500 };
  const r = await lookup('GBXXX0000001', { ...deps, title: 'Midnight City', artists: ['M83'] });
  assert.equal(r.by, 'name'); assert.equal(r.deezerId, 1);
  assert.deepEqual(r.match, { title: 'Midnight City', artist: 'M83', deltaMs: 500 });
  assert.deepEqual(await lookup('GBXXX0000001', deps), { miss: 'NOT_ON_DEEZER' });
});

test('lookup: an ISRC hit never searches; a search failure is FAILED, not cached as a miss', async () => {
  let searched = 0;
  const jsonp = async url => { if (!url.includes('/track/isrc')) searched++; return url.includes('/track/isrc') ? { id: 9, duration: 244, preview: 'p', isrc: 'GBXXX0000001' } : { data: [] }; };
  const r = await lookup('GBXXX0000001', { jsonp, spotifyDurationMs: 243500, title: 'Midnight City', artists: ['M83'] });
  assert.equal(r.deezerId, 9); assert.equal(r.by, undefined); assert.equal(searched, 0);
  const down = { jsonp: async url => { if (url.includes('/track/isrc')) return { error: { code: 800 } }; throw new Error('frame'); } };
  assert.equal((await lookup('X1', { ...down, spotifyDurationMs: 1, title: 't', artists: ['a'] })).miss, 'FAILED');
  assert.equal((await lookupByName({ title: 't', artists: ['a'], durationMs: 1000 }, { jsonp: async () => ({ error: { code: 4 } }) })).miss, 'FAILED');
});

// Fixture measure with a fake Deezer: 300 library tracks, each pretending to miss its ISRC. The responder
// returns the real track among decoys (remix, live, other artist with the same title, same artist other song).
// Bars: same Deezer id on >= 97%, wrong track <= 1%. Her real library decides the real numbers.
test('measured on a fake Deezer: coverage and wrong-match rate', async () => {
  const N = 300, lib = [];
  for (let i = 0; i < N; i++) {
    const artist = `Artist ${i % 60}`, title = `Track ${i} ${['Blue', 'Night', 'Run'][i % 3]}`, dur = 150 + (i * 7) % 200;
    lib.push({ i, artist, title, dur, id: 1000 + i });
  }
  const deezerTitle = t => (t.i % 5 === 0 ? `${t.title} (Original Mix)` : t.i % 11 === 0 ? `${t.title} - Remastered 2015` : t.title);
  const jsonp = async url => {
    const q = decodeURIComponent(new URL(url).searchParams.get('q'));
    const artist = /artist:"([^"]*)"/.exec(q)[1];
    const t = lib.find(x => x.artist === artist && q.includes(`track:"${x.title}"`));
    if (!t) return { data: [] };
    const base = { artist: { name: t.artist }, preview: 'p', readable: true };
    const data = [
      { ...base, id: 5000 + t.i, title: `${t.title} (Remix)`, duration: t.dur },
      { ...base, id: 6000 + t.i, title: `${t.title} (Live)`, duration: t.dur + 40 },
      { ...base, id: 7000 + t.i, title: t.title, artist: { name: 'Somebody Else' }, duration: t.dur },
      { ...base, id: 8000 + t.i, title: `${t.title} 2`, duration: t.dur },
      { ...base, id: t.id, title: deezerTitle(t), duration: t.dur },
    ];
    if (t.i % 25 === 0) data.pop();    // some are genuinely not there
    return { data };
  };
  let same = 0, wrong = 0, notThere = 0;
  for (const t of lib) {
    const r = await lookupByName({ title: t.title, artists: [t.artist], durationMs: t.dur * 1000 + 300 }, { jsonp });
    if (t.i % 25 === 0) { notThere++; if (!r.miss) wrong++; continue; }
    if (r.deezerId === t.id) same++; else if (!r.miss) wrong++;
  }
  const found = N - notThere;
  assert.ok(same / found >= 0.97, `same ${same}/${found}`);
  assert.ok(wrong / N <= 0.01, `wrong ${wrong}`);
});

test('funnel counts records found by search', () => {
  const rec = (id, kind) => makeRecord({ id, isrc: 'X', activations: new Float32Array(400).fill(0.01), embeddings: new Float32Array(1280).fill(0.1), patches: 1,
    source: { kind, deezerId: 1, windows: [[0, 1]], seconds: 10 }, mel: '1.0.0', at: 1 });
  const f = hearingFunnel([{ id: 'a', isrc: 'X' }, { id: 'b', isrc: 'X' }], new Map([['a', rec('a', 'deezer-name')], ['b', rec('b', 'deezer-isrc')]]));
  assert.equal(f.foundBySearch, 1);
  assert.match(funnelText(f), /Heard 2 of 2\. Found by search: 1\./);
  assert.doesNotMatch(funnelText(hearingFunnel([{ id: 'b', isrc: 'X' }], new Map([['b', rec('b', 'deezer-isrc')]]))), /search/);
});

test('F2 queue: members of a playlist with under 12 heard come right after the unfiled songs', () => {
  const tr = (id, artist) => ({ id, artists: [{ name: artist, id: artist }] });
  const small = [tr('s1', 'A'), tr('s2', 'B')];
  const big = Array.from({ length: 14 }, (_, i) => tr('b' + i, 'C'));
  const more = [tr('m1', 'D'), tr('m2', 'D')];
  const rec = id => makeRecord({ id, isrc: 'X', activations: new Float32Array(400).fill(0.01), embeddings: new Float32Array(1280).fill(0.1), patches: 1,
    source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 1]], seconds: 10 }, mel: '1.0.0', at: 1 });
  const lib = { liked: [tr('u1', 'Z')], playlists: [{ id: 'p2', tracks: [...big, ...more] }, { id: 'p1', tracks: small }] };
  const store = new Map(big.map(t => [t.id, rec(t.id)]));
  // p2 has 14 heard (not small), p1 has 0 heard: its members come before p2's unheard ones
  const q = audioQueue(lib, { store, targets: ['p2'], leftovers: true });
  assert.deepEqual(q.slice(0, 3), ['u1', 's1', 's2']);
  assert.ok(!q.includes('b0'));
});
