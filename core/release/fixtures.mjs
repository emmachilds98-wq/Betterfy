// Hand-built Spotify responses for Release Radar, one per accuracy problem in
// docs/RELEASE-RADAR-PLAN.md §4, and the scorer that turns them into the
// per-problem numbers the PR quotes. Offline, like core/benchmark/fixtures.mjs.
//
// The shapes follow Spotify's reference as of the February 2026 changes
// (album_group, available_markets, label and popularity gone; `/albums/{id}`
// lists simplified tracks with no ISRC; `/tracks/{id}` carries `external_ids`).
// They are built by hand, not captured: Phase 0 (the owner's step) re-checks
// them against a fresh Development Mode app.
import { syncRadar, memoryStore, loadReleases } from './sync.mjs';
import { artistSet } from './artists.mjs';
import { parseDate, dateLabel, groupKey, DAY_MS } from './dates.mjs';
import { VARIOUS_ARTISTS_ID } from './normalise.mjs';

export const NOW = Date.UTC(2026, 10, 16, 12);   // 16 November 2026
export const LATER = NOW + 40 * DAY_MS;

const A = {
  aster: { id: 'art_aster', name: 'Aster' },
  brook: { id: 'art_brook', name: 'Brook' },
  other: { id: 'art_other', name: 'Other Guy' },
  burial1: { id: 'art_burial_1', name: 'Burial' },
  burial2: { id: 'art_burial_2', name: 'Burial' },
  afx: { id: 'art_afx', name: 'AFX' },
  aphex: { id: 'art_aphex', name: 'Aphex Twin' },
  delta: { id: 'art_delta', name: 'Delta' },
  va: { id: VARIOUS_ARTISTS_ID, name: 'Various Artists' },
};

const tr = (id, name, ms, isrc, artists) => ({ id, name, duration_ms: ms, isrc, artists });

/** The catalogue: albums (with their full tracks) and which group each artist lists them under. */
export function catalogue() {
  const albums = {
    // §4.1: day, month and year precision.
    alb_glow: { name: 'Glow', release_date: '2026-10-02', release_date_precision: 'day', album_type: 'single',
      artists: [A.aster], tracks: [tr('t_glow', 'Glow', 201000, 'GBAAA2600001', [A.aster])] },
    alb_shapes: { name: 'Night Shapes', release_date: '2026-06', release_date_precision: 'month', album_type: 'single',
      artists: [A.aster], tracks: [tr('t_sh1', 'Shape One', 240000, 'GBAAA2600010', [A.aster]),
        tr('t_sh2', 'Shape Two', 250000, 'GBAAA2600011', [A.aster]), tr('t_sh3', 'Shape Three', 260000, 'GBAAA2600012', [A.aster]),
        tr('t_sh4', 'Shape Four', 270000, 'GBAAA2600013', [A.aster])] },
    // Spotify's own reference pairs "1981-12" with `year`: the coarser one wins.
    alb_notes: { name: 'Field Notes', release_date: '2025-07', release_date_precision: 'year', album_type: 'album',
      artists: [A.aster], tracks: [tr('t_fn1', 'Notes I', 300000, 'GBAAA2500001', [A.aster]),
        tr('t_fn2', 'Notes II', 310000, 'GBAAA2500002', [A.aster])] },
    // §4.2: one release, two market ids, a week apart.
    alb_twin_gb: { name: 'Twin', release_date: '2026-09-12', release_date_precision: 'day', album_type: 'single',
      artists: [A.aster], tracks: [tr('t_twin_gb', 'Twin', 190000, 'GBAAA2600020', [A.aster])] },
    alb_twin_us: { name: 'Twin', release_date: '2026-09-19', release_date_precision: 'day', album_type: 'single',
      artists: [A.aster], tracks: [tr('t_twin_us', 'Twin', 190000, 'GBAAA2600020', [A.aster])] },
    // §4.2 across artists: one joint single seen through both.
    alb_pair: { name: 'Pair', release_date: '2026-05-05', release_date_precision: 'day', album_type: 'single',
      artists: [A.aster, A.brook], tracks: [tr('t_pair', 'Pair', 205000, 'GBAAA2600030', [A.aster, A.brook])] },
    // §4.4: a remaster sharing ISRCs with the 1996 tracks the library owns.
    alb_oldways_rm: { name: 'Old Ways (2026 Remaster)', release_date: '2026-04-10', release_date_precision: 'day',
      album_type: 'album', artists: [A.aster], tracks: [
        tr('t_ow1_rm', 'River - 2026 Remaster', 280000, 'GBAAA9600001', [A.aster]),
        tr('t_ow2_rm', 'Stone - 2026 Remaster', 300500, 'GBAAA9600002', [A.aster]),
        tr('t_ow3_rm', 'Sky - 2026 Remaster', 260000, 'GBAAA9600003', [A.aster]),
        tr('t_ow4_rm', 'Bonus Demo', 180000, 'GBAAA2600099', [A.aster])] },
    // §4.4 weak: a best-of whose library copies have no ISRC at all.
    alb_collected: { name: 'Collected', release_date: '2026-02-20', release_date_precision: 'day', album_type: 'compilation',
      artists: [A.aster], tracks: [
        tr('t_co1', 'Ember', 220000, 'GBAAA0500001', [A.aster]), tr('t_co2', 'Ash', 230000, 'GBAAA0500002', [A.aster]),
        tr('t_co3', 'Coal', 240000, 'GBAAA0500003', [A.aster]), tr('t_co4', 'Spark', 210000, 'GBAAA0500004', [A.aster])] },
    // §4.4 control: re-recordings under the old titles, new ISRCs. Not a reissue.
    alb_again: { name: 'Ways Again', release_date: '2025-11-30', release_date_precision: 'day', album_type: 'album',
      artists: [A.aster], tracks: [
        tr('t_ag1', 'River', 280800, 'GBAAA2500050', [A.aster]), tr('t_ag2', 'Stone', 301000, 'GBAAA2500051', [A.aster]),
        tr('t_ag3', 'New Song', 200000, 'GBAAA2500052', [A.aster]), tr('t_ag4', 'Another', 210000, 'GBAAA2500053', [A.aster])] },
    // Outside the two-year window.
    alb_debut: { name: 'Debut', release_date: '2010-03-01', release_date_precision: 'day', album_type: 'album',
      artists: [A.aster], tracks: [tr('t_debut', 'First', 200000, 'GBAAA1000001', [A.aster])] },
    // §4.3: a remix of Brook on someone else's single, and a Various Artists compilation.
    alb_kilo: { name: 'Kilo (Brook Remix)', release_date: '2026-08-01', release_date_precision: 'day', album_type: 'single',
      artists: [A.other], tracks: [tr('t_kilo', 'Kilo - Brook Remix', 330000, 'GBAAA2600040', [A.other, A.brook])] },
    alb_va: { name: 'Summer Jungle 2026', release_date: '2026-07-01', release_date_precision: 'day', album_type: 'compilation',
      artists: [A.va], total_tracks: 30, tracks: [tr('t_va1', 'Brook Track', 300000, 'GBAAA2600041', [A.brook])] },
    // §4.4 control: "Remastered" in the title, nothing of it owned. Not a reissue:
    // the verdict comes from your library, never from the title's vocabulary.
    alb_brand: { name: 'Brand (Remastered)', release_date: '2026-10-10', release_date_precision: 'day', album_type: 'album',
      artists: [A.brook], tracks: [tr('t_br1', 'Brand One', 250000, 'GBAAA2600090', [A.brook]),
        tr('t_br2', 'Brand Two', 250000, 'GBAAA2600091', [A.brook]), tr('t_br3', 'Brand Three', 250000, 'GBAAA2600092', [A.brook]),
        tr('t_br4', 'Brand Four', 250000, 'GBAAA2600093', [A.brook])] },
    alb_brook: { name: 'Brook LP', release_date: '2026-03-03', release_date_precision: 'day', album_type: 'album',
      artists: [A.brook], tracks: [tr('t_bl1', 'Brook One', 250000, 'GBAAA2600050', [A.brook]),
        tr('t_bl2', 'Brook Two', 250000, 'GBAAA2600051', [A.brook])] },
    // §4.7: two people called Burial; one release credited to two aliases.
    alb_rain: { name: 'Rain', release_date: '2026-01-15', release_date_precision: 'day', album_type: 'single',
      artists: [A.burial1], tracks: [tr('t_rain', 'Rain', 400000, 'GBAAA2600060', [A.burial1])] },
    alb_stone: { name: 'Stone Mass', release_date: '2026-02-15', release_date_precision: 'day', album_type: 'single',
      artists: [A.burial2], tracks: [tr('t_stone', 'Stone Mass', 180000, 'USAAA2600061', [A.burial2])] },
    alb_joint: { name: 'Joint', release_date: '2026-09-01', release_date_precision: 'day', album_type: 'single',
      artists: [A.aphex, A.afx], tracks: [tr('t_joint', 'Joint', 210000, 'GBAAA2600070', [A.aphex, A.afx])] },
    // §4.5: an old-in-the-world album by an artist new to this listener.
    alb_delta_old: { name: 'Back Catalogue', release_date: '2025-01-10', release_date_precision: 'day', album_type: 'album',
      artists: [A.delta], tracks: [tr('t_d1', 'Old One', 200000, 'GBAAA2500070', [A.delta])] },
  };
  const groups = {
    art_aster: { album: ['alb_oldways_rm', 'alb_again', 'alb_notes', 'alb_debut', 'alb_collected'],
                 single: ['alb_glow', 'alb_twin_gb', 'alb_twin_us', 'alb_shapes', 'alb_pair'], appears_on: [] },
    art_brook: { album: ['alb_brand', 'alb_brook'], single: ['alb_pair'], appears_on: ['alb_kilo', 'alb_va'] },
    art_burial_1: { album: [], single: ['alb_rain'], appears_on: [] },
    art_burial_2: { album: [], single: ['alb_stone'], appears_on: [] },
    art_afx: { album: [], single: ['alb_joint'], appears_on: [] },
    art_aphex: { album: [], single: ['alb_joint'], appears_on: [] },
    art_delta: { album: ['alb_delta_old'], single: [], appears_on: [] },
  };
  return { albums, groups };
}

/** Add a release later (for the second sync in §4.5). */
export function addRelease(cat, artistId, group, id, album) {
  cat.albums[id] = album;
  cat.groups[artistId][group].unshift(id);
}

const lt = (id, name, ms, isrc, artists, album, albumId, released, trackNo, albumTracks) =>
  ({ id, name, duration_ms: ms, isrc, artists, album, albumId, released, trackNo, albumTracks });

/** The listener's library, in library.json's shape. */
export function library() {
  const ow = (id, name, ms, isrc, no) => lt(id, name, ms, isrc, [A.aster], 'Old Ways', 'alb_oldways_96', '1996-05-01', no, 3);
  const co = (id, name, ms, no) => lt(id, name, ms, undefined, [A.aster], 'Embers', 'alb_embers_05', '2005-09-09', no, 4);
  return {
    playlists: [
      { id: 'pl_main', name: 'Main', tracks: [
        ow('t_ow1', 'River', 280300, 'GBAAA9600001', 1), ow('t_ow2', 'Stone', 300900, 'GBAAA9600002', 2),
        ow('t_ow3', 'Sky', 259500, 'GBAAA9600003', 3),
        co('t_em1', 'Ember', 220500, 1), co('t_em2', 'Ash', 229000, 2), co('t_em3', 'Coal', 241000, 3),
        lt('t_glow', 'Glow', 201000, 'GBAAA2600001', [A.aster], 'Glow', 'alb_glow', '2026-10-02', 1, 1),
        lt('t_sh2', 'Shape Two', 250000, 'GBAAA2600011', [A.aster], 'Night Shapes', 'alb_shapes', '2026-06', 2, 4),
        lt('t_bl0', 'Brook Old', 250000, 'GBAAA2000050', [A.brook], 'Brook Early', 'alb_brook_early', '2020-01-01', 1, 1),
        lt('t_rain0', 'Old Rain', 400000, 'GBAAA1900060', [A.burial1], 'Rain Early', 'alb_rain_early', '2019-01-01', 1, 1),
        lt('t_stone0', 'Old Stone', 180000, 'USAAA1900061', [A.burial2], 'Stone Early', 'alb_stone_early', '2019-01-01', 1, 1),
        lt('t_afx0', 'Analogue Bubblebath', 300000, 'GBAAA9100001', [A.afx], 'Analogue Bubblebath', 'alb_ab', '1991-01-01', 1, 1),
      ] },
    ],
    liked: [
      lt('t_aphex0', 'Xtal', 290000, 'GBAAA9200001', [A.aphex], 'SAW 85-92', 'alb_saw', '1992-11-09', 1, 13),
    ],
    top_artists: { short_term: [A.aster, A.brook], medium_term: [A.aster], long_term: [A.aphex] },
    recently_played: [{ id: 't_x', name: 'X', artists: [A.delta] }],
  };
}

const simplifiedAlbum = (id, a) => ({
  album_type: a.album_type, total_tracks: a.total_tracks ?? a.tracks.length, external_urls: { spotify: '' },
  href: `https://api.spotify.com/v1/albums/${id}`, id, images: [{ url: `https://i.scdn.co/image/${id}`, height: 300, width: 300 }],
  name: a.name, release_date: a.release_date, release_date_precision: a.release_date_precision, type: 'album',
  uri: `spotify:album:${id}`, artists: a.artists.map(x => ({ id: x.id, name: x.name, type: 'artist' })),
});
const simplifiedTrack = t => ({ id: t.id, name: t.name, duration_ms: t.duration_ms, track_number: 1, type: 'track',
  artists: t.artists.map(x => ({ id: x.id, name: x.name, type: 'artist' })) });

/**
 * A fake Spotify GET over a catalogue: `/artists/{id}/albums` (one group per
 * request, newest first, 10 a page, `next` as an absolute URL),
 * `/albums/{id}`, `/tracks/{id}`; `/albums?ids=` and `/tracks?ids=` answer 404,
 * as the removed endpoints are documented to. `calls` records every path.
 */
export function fakeGet(cat, { fail = {} } = {}) {
  const calls = [];
  const err = (status, message) => Object.assign(new Error(`${status} ${message}`), { status });
  const get = async path => {
    calls.push(path);
    const u = new URL(path, 'https://api.spotify.com/v1/');
    const p = u.pathname.replace(/^\/v1/, '');
    let m;
    if (fail[p]) throw err(fail[p], 'injected');
    if ((m = /^\/artists\/([^/]+)\/albums$/.exec(p))) {
      const id = decodeURIComponent(m[1]);
      const want = (u.searchParams.get('include_groups') ?? 'album,single').split(',');
      const limit = +(u.searchParams.get('limit') ?? 5);
      if (limit > 10) throw err(400, 'Invalid limit');
      const offset = +(u.searchParams.get('offset') ?? 0);
      const g = cat.groups[id];
      if (!g) throw err(404, 'Resource not found');
      const ids = want.flatMap(w => [...(g[w] ?? [])].sort((x, y) =>
        parseDate(cat.albums[y].release_date).ts - parseDate(cat.albums[x].release_date).ts));
      const items = ids.slice(offset, offset + limit).map(x => simplifiedAlbum(x, cat.albums[x]));
      const more = offset + limit < ids.length;
      const q = new URLSearchParams(u.searchParams); q.set('offset', String(offset + limit));
      return { href: u.href, items, limit, offset, total: ids.length, previous: null,
               next: more ? `https://api.spotify.com/v1${p}?${q}` : null };
    }
    if (p === '/albums' || p === '/tracks') throw err(404, 'Service not found');
    if ((m = /^\/albums\/([^/]+)$/.exec(p))) {
      const id = decodeURIComponent(m[1]), a = cat.albums[id];
      if (!a) throw err(404, 'Resource not found');
      return { ...simplifiedAlbum(id, a), tracks: { items: a.tracks.map(simplifiedTrack), total: a.tracks.length, next: null } };
    }
    if ((m = /^\/tracks\/([^/]+)$/.exec(p))) {
      const id = decodeURIComponent(m[1]);
      for (const [aid, a] of Object.entries(cat.albums)) {
        const t = a.tracks.find(x => x.id === id);
        if (t) return { ...simplifiedTrack(t), album: simplifiedAlbum(aid, a), external_ids: { isrc: t.isrc } };
      }
      throw err(404, 'Resource not found');
    }
    throw err(404, 'Service not found');
  };
  return { get, calls };
}

/** Run the fixture sync: cold at NOW, then a second sync 40 days later (past Delta's 30-day
 *  cadence, stretched by at most 25%) with one new single. */
export async function runFixtures() {
  const cat = catalogue(), lib = library(), store = memoryStore();
  const artists = artistSet(lib);
  const f1 = fakeGet(cat);
  const first = await syncRadar({ lib, artists, store, get: f1.get, now: NOW });
  const cold = new Map((await loadReleases(store)).map(r => [r.key, r]));
  addRelease(cat, 'art_delta', 'single', 'alb_delta_new', { name: 'Fresh', release_date: '2026-12-20',
    release_date_precision: 'day', album_type: 'single', artists: [A.delta],
    tracks: [tr('t_d2', 'Fresh', 200000, 'GBAAA2600080', [A.delta])] });
  const f2 = fakeGet(cat);
  const second = await syncRadar({ lib, artists, store, get: f2.get, now: LATER });
  const rows = await loadReleases(store);
  return { cat, lib, artists, store, first, second, cold, rows, calls: [f1.calls, f2.calls] };
}

/**
 * The per-problem accuracy: for each of §4.1–4.7, `{ correct, total, misses }`.
 * Every check is a labelled expectation about one fixture release.
 */
export async function scoreFixtures() {
  const run = await runFixtures();
  const { rows, artists } = run;
  const byName = n => rows.filter(r => r.name === n);
  const one = n => byName(n)[0];
  const out = {};
  const check = (problem, label, ok) => {
    const s = out[problem] ??= { correct: 0, total: 0, misses: [] };
    s.total++; if (ok) s.correct++; else s.misses.push(label);
  };
  const lbl = r => r && dateLabel(parseDate(r.releaseDate, r.precision));

  // §4.1 date precision: shown exactly as given, grouped and sorted without invented precision.
  check('4.1', 'day label', lbl(one('Glow')) === '2 October 2026');
  check('4.1', 'month label', lbl(one('Night Shapes')) === 'June 2026');
  check('4.1', 'year label (precision wins over a longer string)', lbl(one('Field Notes')) === '2025');
  check('4.1', 'month-only grouped under its month', groupKey(parseDate(one('Night Shapes')?.releaseDate, one('Night Shapes')?.precision)) === '2026-06');
  check('4.1', 'year-only sorts below every dated 2025 release', (() => {
    const fn = one('Field Notes'), again = one('Ways Again');
    return fn && again && fn.ts < again.ts && fn.ts > parseDate('2024-12-31').ts;
  })());

  // §4.2 market dedupe: one row per release, every id kept, the earliest date kept.
  check('4.2', 'two market ids are one row', byName('Twin').length === 1);
  check('4.2', 'both ids kept', (one('Twin')?.ids ?? []).length === 2);
  check('4.2', 'earliest date kept', one('Twin')?.releaseDate === '2026-09-12');
  check('4.2', 'joint single through two artists is one row', byName('Pair').length === 1);

  // §4.3 lanes.
  check('4.3', 'remix on another artist\'s single is a feature', one('Kilo (Brook Remix)')?.lane === 'features');
  check('4.3', 'VA compilation is a feature, flagged', one('Summer Jungle 2026')?.lane === 'features' && one('Summer Jungle 2026')?.various === true);
  check('4.3', 'own album is main', one('Brook LP')?.lane === 'main');
  check('4.3', 'joint single is main', one('Pair')?.lane === 'main');
  check('4.3', 'no main row is a VA compilation', rows.filter(r => r.lane === 'main').every(r => !r.various));

  // §4.4 reissues.
  check('4.4', 'remaster with shared ISRCs is a reissue, by ISRC', one('Old Ways (2026 Remaster)')?.reissue === true && one('Old Ways (2026 Remaster)')?.reissueBasis === 'isrc');
  check('4.4', 'best-of of ISRC-less library tracks is a reissue, weak', one('Collected')?.reissue === true && one('Collected')?.reissueBasis === 'weak');
  check('4.4', 're-recordings with new ISRCs are not a reissue', one('Ways Again')?.reissue === false);
  check('4.4', 'a new single you own is not a reissue', one('Glow')?.reissue === false);
  check('4.4', 'a new EP you own part of is not a reissue', one('Night Shapes')?.reissue === false);
  check('4.4', 'no title vocabulary: "Remastered" with nothing owned is not a reissue', one('Brand (Remastered)')?.reissue === false);

  // §4.5 new to you vs new in the world.
  const coldDelta = run.cold.get(one('Back Catalogue')?.key);
  check('4.5', 'first sighting stored', coldDelta?.firstSeenAt === NOW);
  check('4.5', 'cold-sync sightings are flagged as such', coldDelta?.seenCold === true);
  check('4.5', 'a later release carries the later sighting', one('Fresh')?.firstSeenAt === LATER && !one('Fresh')?.seenCold);
  check('4.5', 'first sighting survives a re-read', one('Back Catalogue')?.firstSeenAt === NOW);

  // §4.6 owned.
  check('4.6', 'single you own: all', one('Glow')?.owned === 'all');
  check('4.6', 'EP with one of four: some', one('Night Shapes')?.owned === 'some');
  check('4.6', 'unowned single: none', one('Twin')?.owned === 'none');
  check('4.6', 'reissue of what you own: all three old tracks owned, bonus not', one('Old Ways (2026 Remaster)')?.owned === 'some');
  check('4.6', 'owned is a marker, not a filter: owned rows still stored', !!one('Glow'));

  // §4.7 an id is not a person.
  const burials = artists.filter(a => a.name === 'Burial');
  check('4.7', 'two ids named Burial stay two artists', burials.length === 2);
  check('4.7', 'both flagged homonym', burials.every(a => a.homonym));
  check('4.7', 'their releases are separate rows', !!one('Rain') && !!one('Stone Mass'));
  check('4.7', 'a release credited to two aliases is one row, via both', byName('Joint').length === 1 && (one('Joint')?.via ?? []).length === 2);
  return { scores: out, run };
}
