import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, dateLabel, shortLabel, groupKey, groupLabel, cutoffTs, inWindow, DAY_MS } from '../core/release/dates.mjs';
import { normaliseItem, mergeRelease, releaseKey, VARIOUS_ARTISTS_ID, SHAPE } from '../core/release/normalise.mjs';
import { artistSet, disambiguator } from '../core/release/artists.mjs';
import { recheckAfter, isDue, planTasks, newArtistState, estimate, spreadOf, KEY, CADENCE, FEATURES_SLOWER, SPREAD } from '../core/release/plan.mjs';
import { libraryIndex, verdict, matchTrack, DURATION_SLACK_MS } from '../core/release/library.mjs';
import { syncRadar, memoryStore, loadReleases, rescore } from '../core/release/sync.mjs';
import { scoreFixtures, catalogue, library, fakeGet, NOW } from '../core/release/fixtures.mjs';
import { simulate } from '../core/release/simulate.mjs';

// Release Radar, phases 1-3 (docs/RELEASE-RADAR-PLAN.md; BUILD-6-PLAN §4.2 RR).

/* ---- §4.1 dates ---- */

test('a date is shown exactly as precisely as Spotify gave it', () => {
  assert.equal(dateLabel(parseDate('2026-03-12', 'day')), '12 March 2026');
  assert.equal(dateLabel(parseDate('2026-03', 'month')), 'March 2026');
  assert.equal(dateLabel(parseDate('2026', 'year')), '2026');
  assert.equal(shortLabel(parseDate('2026-03-12', 'day')), '12 Mar');
  assert.equal(shortLabel(parseDate('2026-03', 'month')), 'Mar 2026');
});

test('when the string and the precision disagree, the coarser wins', () => {
  // Spotify's own reference sample: "1981-12" with precision "year".
  const p = parseDate('1981-12', 'year');
  assert.equal(p.precision, 'year'); assert.equal(dateLabel(p), '1981');
  // A string too short for its claimed precision cannot be read finer.
  assert.equal(parseDate('2026', 'day').precision, 'year');
  assert.equal(parseDate('2026-03', 'day').precision, 'month');
});

test('an imprecise date never sorts above a precise one from the same period', () => {
  const jan1 = parseDate('2026-01-01', 'day'), year = parseDate('2026', 'year');
  const mar1 = parseDate('2026-03-01', 'day'), mar = parseDate('2026-03', 'month');
  const dec = parseDate('2025-12-31', 'day');
  assert.ok(year.ts < jan1.ts && year.ts > dec.ts, 'year-only sits between 2025 and every dated 2026 release');
  assert.ok(mar.ts < mar1.ts && mar.ts > parseDate('2026-02-28', 'day').ts, 'month-only sits below its month');
});

test('group keys and headers: months for day and month precision, the year on its own otherwise', () => {
  assert.equal(groupKey(parseDate('2026-03-12', 'day')), '2026-03');
  assert.equal(groupKey(parseDate('2026-03', 'month')), '2026-03');
  assert.equal(groupKey(parseDate('2026', 'year')), '2026');
  assert.equal(groupLabel('2026-03'), 'March 2026');
  assert.equal(groupLabel('2026'), '2026, month not given');
  assert.equal(groupLabel('unknown'), 'Date not given');
});

test('unreadable dates are not ok, sort last and are never in a window', () => {
  for (const raw of ['', null, '0000', 'soon']) {
    const p = parseDate(raw, 'day');
    assert.equal(p.ok, false); assert.equal(p.ts, -Infinity);
    assert.equal(inWindow(p, 0), false);
    assert.equal(dateLabel(p), 'date unknown');
  }
});

test('the window is judged on the period end: a year-only release is in a window that starts that November', () => {
  const cut = cutoffTs(NOW, 2);
  assert.equal(new Date(cut).toISOString().slice(0, 10), '2024-11-16');
  assert.equal(inWindow(parseDate('2024', 'year'), cut), true);
  assert.equal(inWindow(parseDate('2024-10', 'month'), cut), false);
  assert.equal(inWindow(parseDate('2024-11', 'month'), cut), true);
  assert.equal(inWindow(parseDate('2024-11-15', 'day'), cut), false);
});

/* ---- §4.2, §4.3 normalisation ---- */

const item = (o = {}) => ({ id: 'x1', type: 'album', name: 'Thing', release_date: '2026-05-01', release_date_precision: 'day',
  album_type: 'single', total_tracks: 1, artists: [{ id: 'a', name: 'A' }], images: [], ...o });

test('the lane comes from the album\'s own artists, since album_group is gone', () => {
  assert.equal(normaliseItem(item(), { artistId: 'a' }).lane, 'main');
  assert.equal(normaliseItem(item({ artists: [{ id: 'b' }, { id: 'a' }] }), { artistId: 'a' }).lane, 'main', 'a credited co-artist is main');
  assert.equal(normaliseItem(item({ artists: [{ id: 'b' }] }), { artistId: 'a' }).lane, 'features');
  const va = normaliseItem(item({ artists: [{ id: VARIOUS_ARTISTS_ID }, { id: 'a' }] }), { artistId: 'a' });
  assert.equal(va.lane, 'features'); assert.equal(va.various, true);
  // album_group, were it still sent, changes nothing.
  assert.equal(normaliseItem(item({ album_group: 'appears_on' }), { artistId: 'a' }).lane, 'main');
});

test('the dedupe key is normalised name, year, track count and primary artist', () => {
  const a = normaliseItem(item({ id: 'gb', name: 'Twin (feat. Someone)' }), { artistId: 'a' });
  const b = normaliseItem(item({ id: 'us', name: 'TWIN', release_date: '2026-05-08' }), { artistId: 'a' });
  assert.equal(a.key, b.key);
  assert.notEqual(a.key, normaliseItem(item({ total_tracks: 3 }), { artistId: 'a' }).key, 'a deluxe is another release');
  assert.notEqual(a.key, normaliseItem(item({ release_date: '1996-05-01' }), { artistId: 'a' }).key, 'a reissue years later is another row');
  assert.equal(releaseKey({ name: 'X', year: 2026, totalTracks: 2, primaryArtistId: 'p' }), 'x|2026|2|p');
});

test('merging keeps the earliest date, every id, main over features, and the first sighting', () => {
  const a = { ...normaliseItem(item({ id: 'us', release_date: '2026-05-08' }), { artistId: 'a', at: 200 }), owned: 'all' };
  const b = normaliseItem(item({ id: 'gb', artists: [{ id: 'a' }] }), { artistId: 'z', at: 100 });
  const m = mergeRelease(a, b);
  assert.deepEqual(m.ids.sort(), ['gb', 'us']);
  assert.equal(m.releaseDate, '2026-05-01');
  assert.equal(m.lane, 'main');
  assert.equal(m.firstSeenAt, 100);
  assert.deepEqual(m.via.sort(), ['a', 'z']);
  assert.equal(m.owned, 'all', 'a fresh sighting does not wipe a verdict');
});

test('items that are not albums are dropped', () => {
  assert.equal(normaliseItem(null), null);
  assert.equal(normaliseItem({ name: 'no id' }), null);
  assert.equal(normaliseItem(item({ type: 'track' }), { artistId: 'a' }), null);
});

/* ---- §2, §4.7 the artist set ---- */

test('the artist set: every credited id across playlists, liked, top and recent, Various Artists excluded', () => {
  const lib = {
    playlists: [{ tracks: [{ id: 't1', artists: [{ id: 'a', name: 'A' }, { id: 'feat', name: 'Feat' }] },
                           { id: 't2', artists: [{ id: VARIOUS_ARTISTS_ID, name: 'Various Artists' }] }] }],
    liked: [{ id: 't3', artists: [{ id: 'a', name: 'A' }, { id: 'l', name: 'Liked Only' }] }],
    top_artists: { short_term: [{ id: 'top', name: 'Top Only' }] },
    recently_played: [{ artists: [{ id: 'r', name: 'Recent Only' }] }],
  };
  const set = artistSet(lib);
  assert.deepEqual(set.map(a => a.id).sort(), ['a', 'feat', 'l', 'r', 'top']);
  assert.equal(set[0].id, 'top', 'listening first: the short-term top artist outranks anything merely filed');
  assert.deepEqual(set.find(a => a.id === 'a').sources, ['playlist', 'liked']);
  assert.equal(set.find(a => a.id === 'a').tracks, 2);
});

test('§4.7: two ids with one name stay two artists, flagged, with a way to tell them apart', () => {
  const lib = library();
  const burials = artistSet(lib).filter(a => a.name === 'Burial');
  assert.equal(burials.length, 2);
  assert.ok(burials.every(a => a.homonym));
  assert.deepEqual(burials[0].alsoIds, [burials[1].id]);
  assert.notEqual(disambiguator(burials[0].id, lib), disambiguator(burials[1].id, lib));
  assert.equal(artistSet(lib).find(a => a.name === 'Aster').homonym, false);
});

test('§4.7: a collaboration that is its own id is watched as that id and flagged', () => {
  const set = artistSet({ playlists: [{ tracks: [{ id: 't', artists: [{ id: 'duo', name: 'Shy FX & T Power' }] }] }] });
  assert.equal(set[0].collab, true);
  assert.equal(set.length, 1, 'never resolved to member ids by name');
});

/* ---- §3 the planner ---- */

test('cadence: 7 days within 90 days of a release, 30 within two years, 90 otherwise', () => {
  const now = NOW;
  assert.equal(recheckAfter(now - 10 * DAY_MS, now), 7 * DAY_MS);
  assert.equal(recheckAfter(now - 400 * DAY_MS, now), 30 * DAY_MS);
  assert.equal(recheckAfter(now - 3000 * DAY_MS, now), 90 * DAY_MS);
  assert.equal(recheckAfter(null, now), 90 * DAY_MS, 'nothing found: the slowest');
  assert.equal(CADENCE.length, 3);
});

test('the spread stretches an interval by at most 25%, the same for an id every time; features wait twice as long', () => {
  for (const id of ['a', 'b', 'art_aster', '0LyfQWJT6nXafLPZqxe9Of']) {
    const s = spreadOf(id);
    assert.ok(s >= 0 && s < 1); assert.equal(spreadOf(id), s);
    const r = recheckAfter(NOW - DAY_MS, NOW, { id });
    assert.ok(r >= 7 * DAY_MS && r <= 7 * DAY_MS * (1 + SPREAD));
    assert.equal(recheckAfter(NOW - DAY_MS, NOW, { id, group: 'appears_on' }), r * FEATURES_SLOWER);
  }
});

test('isDue: never read, older shape, a failed group, or past the interval', () => {
  const st = { ...newArtistState({ id: 'a' }), checked: { album: NOW }, lastReleaseTs: NOW - DAY_MS };
  assert.equal(isDue(null, 'album', NOW), true);
  assert.equal(isDue({ ...st, shape: SHAPE - 1 }, 'album', NOW), true);
  assert.equal(isDue(st, 'album', NOW + DAY_MS), false);
  assert.equal(isDue(st, 'album', NOW + 9 * DAY_MS), true);
  assert.equal(isDue(st, 'single', NOW), true, 'a group never read');
  assert.equal(isDue({ ...st, errors: { album: { at: NOW } } }, 'album', NOW), true);
});

test('planTasks: every artist\'s own releases first, in listening order, then the features lane', () => {
  const artists = [{ id: 'a' }, { id: 'b' }];
  const t = planTasks(artists, new Map(), NOW);
  assert.deepEqual(t.map(x => `${x.artistId}:${x.group}`),
    ['a:album', 'a:single', 'b:album', 'b:single', 'a:appears_on', 'b:appears_on']);
  assert.deepEqual(planTasks(artists, new Map(), NOW, { groups: ['single'] }).map(x => x.artistId), ['a', 'b']);
  const est = estimate(t);
  assert.ok(est.requests >= t.length && est.minutes >= 1);
});

test('storage keys carry the radar: prefix', () => {
  assert.equal(KEY.artist('x'), 'radar:artist:x');
  assert.equal(KEY.release('k'), 'radar:release:k');
  assert.equal(KEY.index, 'radar:index');
});

/* ---- §4.4, §4.6 verdicts ---- */

test('a weak match needs the same artist, title and version, and a duration within 2s', () => {
  const idx = libraryIndex({ playlists: [{ tracks: [
    { id: 'l1', name: 'River', duration_ms: 200000, artists: [{ id: 'a' }], released: '1990-01-01' },
    { id: 'l2', name: 'River (Dub Mix)', duration_ms: 300000, artists: [{ id: 'a' }], released: '1990-01-01' }] }] });
  const m = rt => matchTrack({ id: 'n', artists: ['a'], ...rt }, ['a'], idx).map(x => x.row.t.id);
  assert.deepEqual(m({ name: 'River - 2011 Remaster', ms: 200000 + DURATION_SLACK_MS }), ['l1']);
  assert.deepEqual(m({ name: 'River', ms: 200000 + DURATION_SLACK_MS + 1 }), []);
  assert.deepEqual(m({ name: 'River (Dub Mix)', ms: 300000 }), ['l2'], 'a version matches only itself');
  assert.deepEqual(matchTrack({ id: 'n', name: 'River', ms: 200000, artists: ['b'] }, ['b'], idx), [], 'another artist');
});

test('without a track list, owned comes from the library\'s own copies of that release', () => {
  const lib = { playlists: [{ tracks: [
    { id: 'l1', name: 'One', artists: [{ id: 'a' }], album: 'EP', albumId: 'ep_us', released: '2026-01-01', trackNo: 1, albumTracks: 3 }] }] };
  const idx = libraryIndex(lib);
  const rec = normaliseItem(item({ id: 'ep_gb', name: 'EP', release_date: '2026-01-01', total_tracks: 3 }), { artistId: 'a' });
  assert.equal(verdict(rec, idx).owned, 'some', 'recognised by the market-independent key');
  assert.equal(verdict({ ...rec, ids: ['ep_us'], key: 'other' }, idx).owned, 'some', 'and by id');
  assert.equal(verdict({ ...rec, key: 'other' }, idx).owned, 'none');
});

test('the page\'s library (no album id, no track count) still recognises a release you own part of', () => {
  const lib = { playlists: [], liked: [
    { id: 'l1', name: 'One', artists: [{ id: 'a', name: 'A' }], album: 'EP', albumType: 'single', released: '2026-01-01', duration_ms: 1 }] };
  const rec = normaliseItem(item({ id: 'ep', name: 'EP', release_date: '2026-01-01', total_tracks: 3 }), { artistId: 'a' });
  assert.equal(verdict(rec, libraryIndex(lib)).owned, 'some');
  assert.equal(verdict({ ...rec, name: 'Other' }, libraryIndex(lib)).owned, 'none');
});

test('a probe that returns a different ISRC drops the match: a re-recording is not a reissue', () => {
  const lib = { playlists: [{ tracks: [1, 2].map(i =>
    ({ id: 'o' + i, name: 'S' + i, duration_ms: 1000 * i, isrc: 'OLD' + i, artists: [{ id: 'a' }], albumId: 'old', released: '1999-01-01' })) }] };
  const idx = libraryIndex(lib);
  const rec = { ...normaliseItem(item({ id: 'new', total_tracks: 2, release_date: '2026-01-01' }), { artistId: 'a' }),
    tracks: [1, 2].map(i => ({ id: 'n' + i, name: 'S' + i, ms: 1000 * i, artists: ['a'] })) };
  assert.equal(verdict(rec, idx).reissue, true); assert.equal(verdict(rec, idx).reissueBasis, 'weak');
  assert.equal(verdict({ ...rec, probes: { n1: 'OLD1', n2: 'OLD2' } }, idx).reissueBasis, 'isrc');
  assert.equal(verdict({ ...rec, probes: { n1: 'NEW1', n2: 'NEW2' } }, idx).reissue, false);
});

test('owning a release from the release itself is not a reissue of it', () => {
  const lib = { playlists: [{ tracks: [{ id: 'n1', name: 'S', duration_ms: 1000, isrc: 'I', artists: [{ id: 'a' }], albumId: 'new', released: '2026-01-01' }] }] };
  const rec = { ...normaliseItem(item({ id: 'new', release_date: '2026-01-01' }), { artistId: 'a' }),
    tracks: [{ id: 'n1', name: 'S', ms: 1000, artists: ['a'] }] };
  const v = verdict(rec, libraryIndex(lib));
  assert.equal(v.owned, 'all'); assert.equal(v.reissue, false);
});

/* ---- the sync, on the hand-built fixtures ---- */

test('fixture accuracy: every check of every §4 problem passes', async () => {
  const { scores } = await scoreFixtures();
  assert.deepEqual(Object.keys(scores), ['4.1', '4.2', '4.3', '4.4', '4.5', '4.6', '4.7']);
  for (const [k, s] of Object.entries(scores)) {
    assert.ok(s.total >= 4, `§${k} has at least four checks`);
    assert.equal(s.correct, s.total, `§${k} missed: ${s.misses.join('; ')}`);
  }
});

test('the sync asks only for what survives February 2026: one group a request, at most 10 a page, no batch endpoints', async () => {
  const { run } = await scoreFixtures();
  const calls = run.calls.flat();
  assert.ok(calls.length > 0);
  for (const c of calls) {
    assert.doesNotMatch(c, /\/(albums|tracks)\?ids=/, 'the batch endpoints are gone');
    assert.match(c, /market=from_token/, 'every request pins the market');
    const u = new URL(c, 'https://api.spotify.com/v1/');
    if (/\/albums$/.test(u.pathname)) {
      assert.equal(u.searchParams.get('include_groups').split(',').length, 1);
      assert.ok(+u.searchParams.get('limit') <= 10);
    }
  }
});

test('a second sync inside every cadence asks for nothing', async () => {
  const cat = catalogue(), lib = library(), store = memoryStore(), artists = artistSet(lib);
  await syncRadar({ lib, artists, store, get: fakeGet(cat).get, now: NOW });
  const again = await syncRadar({ lib, artists, store, get: fakeGet(cat).get, now: NOW + 3600e3 });
  assert.equal(again.requests, 0);
  assert.equal(again.complete, true);
});

test('resumable: a sync stopped by its budget carries on where it stopped, and the total is no higher', async () => {
  const cat = catalogue(), lib = library(), artists = artistSet(lib);
  const wholeStore = memoryStore();
  const whole = await syncRadar({ lib, artists, store: wholeStore, get: fakeGet(cat).get, now: NOW });
  const store = memoryStore();
  const a = await syncRadar({ lib, artists, store, get: fakeGet(cat).get, now: NOW, maxRequests: 7 });
  assert.equal(a.stopped.why, 'budget'); assert.equal(a.complete, false);
  const idx = await store.get(KEY.index);
  assert.equal(idx.complete, false, 'a partial radar is never stored as complete');
  assert.ok((await loadReleases(store)).length > 0, 'and what was read is usable');
  const b = await syncRadar({ lib, artists, store, get: fakeGet(cat).get, now: NOW + 60e3 });
  assert.equal(b.complete, true);
  assert.ok(a.requests + b.requests <= whole.requests + 2, `${a.requests}+${b.requests} vs ${whole.requests}`);
  const names = async st => (await loadReleases(st)).map(r => `${r.key}:${r.owned}:${r.reissue}`).sort();
  assert.deepEqual(await names(store), await names(wholeStore), 'the same radar as one uninterrupted sync');
});

test('resumable at every possible stopping point: the radar always ends the same', async () => {
  const cat = catalogue(), lib = library(), artists = artistSet(lib);
  const ref = memoryStore();
  const whole = await syncRadar({ lib, artists, store: ref, get: fakeGet(cat).get, now: NOW });
  const names = async st => (await loadReleases(st)).map(r => `${r.key}:${r.owned}:${r.reissue}:${r.reissueBasis}`).sort();
  const want = await names(ref);
  for (let cut = 1; cut < whole.requests; cut++) {
    const store = memoryStore();
    const a = await syncRadar({ lib, artists, store, get: fakeGet(cat).get, now: NOW, maxRequests: cut });
    const b = await syncRadar({ lib, artists, store, get: fakeGet(cat).get, now: NOW + 60e3 });
    assert.equal(b.complete, true, `stopped after ${cut}`);
    assert.deepEqual(await names(store), want, `stopped after ${cut}`);
    assert.ok(a.requests + b.requests <= whole.requests + 2, `stopped after ${cut}: ${a.requests}+${b.requests}`);
  }
});

test('one artist failing never fails the run; it is due again next time', async () => {
  const cat = catalogue(), lib = library(), store = memoryStore(), artists = artistSet(lib);
  const f = fakeGet(cat, { fail: { '/artists/art_brook/albums': 500 } });
  const r = await syncRadar({ lib, artists, store, get: f.get, now: NOW });
  assert.equal(r.stopped, null);
  assert.ok(r.errors >= 1);
  assert.equal(r.complete, false);
  const st = await store.get(KEY.artist('art_brook'));
  assert.ok(st.errors.album);
  assert.ok((await loadReleases(store)).some(x => x.name === 'Glow'), 'everyone else was read');
  const next = await syncRadar({ lib, artists, store, get: fakeGet(cat).get, now: NOW + 60e3 });
  assert.equal(next.requests > 0 && next.complete, true);
  assert.ok((await loadReleases(store)).some(x => x.name === 'Brook LP'));
});

test('a 429 that sp() gave up on, or a dead sign-in, stops the run and keeps what was read', async () => {
  for (const status of [429, 401]) {
    const cat = catalogue(), lib = library(), store = memoryStore(), artists = artistSet(lib);
    const f = fakeGet(cat, { fail: { '/artists/art_brook/albums': status } });
    const r = await syncRadar({ lib, artists, store, get: f.get, now: NOW });
    assert.equal(r.stopped.why, status === 429 ? 'rate-limit' : 'signed-out');
    assert.ok(r.done < r.total);
    assert.ok((await loadReleases(store)).length > 0);
  }
});

test('an abort signal stops cleanly', async () => {
  const cat = catalogue(), lib = library(), artists = artistSet(lib);
  const ctl = new AbortController(); ctl.abort();
  const r = await syncRadar({ lib, artists, store: memoryStore(), get: fakeGet(cat).get, now: NOW, signal: ctl.signal });
  assert.equal(r.stopped.why, 'aborted'); assert.equal(r.requests, 0);
});

test('older on demand: one artist read further back, nobody else re-read', async () => {
  const cat = catalogue(), lib = library(), store = memoryStore(), artists = artistSet(lib);
  await syncRadar({ lib, artists, store, get: fakeGet(cat).get, now: NOW });
  assert.ok(!(await loadReleases(store)).some(r => r.name === 'Debut'));
  const f = fakeGet(cat);
  await syncRadar({ lib, artists, store, get: f.get, now: NOW + 60e3, deep: { ids: ['art_aster'], years: 30 } });
  assert.ok((await loadReleases(store)).some(r => r.name === 'Debut'));
  assert.ok(f.calls.every(c => c.includes('art_aster') || /\/(albums|tracks)\/[^/?]+\?/.test(c)), f.calls.join('\n'));
});

test('rescore re-judges ownership after the library changes, without a request', async () => {
  const cat = catalogue(), lib = library(), store = memoryStore(), artists = artistSet(lib);
  await syncRadar({ lib, artists, store, get: fakeGet(cat).get, now: NOW });
  const twin = (await loadReleases(store)).find(r => r.name === 'Twin');
  assert.equal(twin.owned, 'none');
  lib.liked.push({ id: 't_twin_gb', name: 'Twin', artists: [{ id: 'art_aster', name: 'Aster' }], album: 'Twin', albumId: 'alb_twin_gb', released: '2026-09-12', trackNo: 1, albumTracks: 1 });
  assert.ok(await rescore(store, lib) >= 1);
  assert.equal((await loadReleases(store)).find(r => r.name === 'Twin').owned, 'all');
});

/* ---- §3's budget, on a simulated 1,000-artist library (BUILD-6 M8) ---- */

test('request budget: 1,000 artists cold, an hour later, and day by day', async () => {
  const s = await simulate({ n: 1000, days: 60 });
  // The printed budget. A regression above it fails here.
  assert.ok(s.cold.requests <= 3800, `cold ${s.cold.requests}`);
  assert.ok(s.coldMainOnly.requests <= 2700, `main lane ${s.coldMainOnly.requests}`);
  assert.equal(s.noChange.requests, 0);
  assert.ok(s.daily.mean <= 80, `daily mean ${s.daily.mean}`);
  assert.ok(s.daily.max <= 400, `daily max ${s.daily.max}`);
  assert.equal(s.cold.complete, true);
});
