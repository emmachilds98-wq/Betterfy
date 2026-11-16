// What a Release Radar sync costs in requests, on a simulated library
// (docs/RELEASE-RADAR-PLAN.md §3; BUILD-6-PLAN §5.1 M8). Runs the real
// syncRadar() against fixtures.mjs's fake Spotify over a generated catalogue,
// so the count is what the code asks for, not arithmetic about it.
//
// The catalogue is synthetic and its shape is a declared assumption until
// Phase 0 measures a real account (the owner's step, radar.mjs --measure):
//   activity  25% of artists released within 90 days, 35% within 2 years,
//             40% longer ago
//   catalogue albums 0-12, singles 0-40, appears_on 0-25 per artist, spread
//             over a 1-25 year career ending at the newest release
//   library   1-6 owned tracks per artist, from releases before the window;
//             3% of active artists have an in-window remaster of one of them
import { syncRadar, memoryStore } from './sync.mjs';
import { fakeGet } from './fixtures.mjs';
import { DAY_MS } from './dates.mjs';
import { SEC_PER_REQUEST } from './plan.mjs';

/** A small seeded PRNG (mulberry32), so every run of the simulation is the same run. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = ts => new Date(ts).toISOString().slice(0, 10);

/** A generated catalogue + library for `n` artists, as fixtures.mjs shapes them. */
export function simulatedWorld(n = 1000, { now = Date.UTC(2026, 10, 16), seed = 7 } = {}) {
  const r = rng(seed);
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const albums = {}, groups = {}, artists = [];
  const libTracks = [];
  let nAlb = 0, nTr = 0;
  const mkAlbum = (artist, type, ts, tracks, extraArtist = null) => {
    const id = `sa${nAlb++}`;
    const who = extraArtist ? [extraArtist, artist] : [artist];
    albums[id] = { name: `${artist.name} ${type} ${id}`, release_date: iso(ts), release_date_precision: 'day',
      album_type: type === 'appears' ? 'single' : type, artists: who,
      tracks: Array.from({ length: tracks }, (_, i) => ({ id: `st${nTr}`, name: `Song ${nTr++}`,
        duration_ms: 180000 + i * 7000, isrc: `SIM${String(nTr).padStart(9, '0')}`, artists: who })) };
    return id;
  };
  for (let i = 0; i < n; i++) {
    const a = { id: `sim_art_${i}`, name: `Sim Artist ${i}` };
    artists.push(a);
    const u = r();
    const newest = now - (u < 0.25 ? int(1, 89) : u < 0.60 ? int(90, 729) : int(730, 6000)) * DAY_MS;
    const career = int(1, 25) * 365 * DAY_MS;
    const when = () => newest - Math.floor(r() * career);
    const g = { album: [], single: [], appears_on: [] };
    const nAlbums = int(0, 12), nSingles = int(0, 40), nApp = int(0, 25);
    g.single.push(mkAlbum(a, 'single', newest, 1));
    for (let k = 0; k < nAlbums; k++) g.album.push(mkAlbum(a, 'album', when(), int(6, 14)));
    for (let k = 0; k < nSingles; k++) g.single.push(mkAlbum(a, 'single', when(), int(1, 3)));
    for (let k = 0; k < nApp; k++) g.appears_on.push(mkAlbum(a, 'appears', when(), 1, { id: `sim_host_${i}_${k}`, name: 'Host' }));
    groups[a.id] = g;
    // The listener owns a few tracks from older releases.
    const old = [...g.album, ...g.single].filter(id => Date.parse(albums[id].release_date) < now - 730 * DAY_MS);
    for (let k = 0, m = int(1, 6); k < m && old.length; k++) {
      const id = old[int(0, old.length - 1)], al = albums[id], t = al.tracks[0];
      libTracks.push({ id: t.id, name: t.name, duration_ms: t.duration_ms, isrc: t.isrc, artists: [a],
        album: al.name, albumId: id, released: al.release_date, trackNo: 1, albumTracks: al.tracks.length });
      if (u < 0.25 && r() < 0.03) {
        const rid = `sa${nAlb++}`;
        albums[rid] = { ...al, name: al.name + ' (Remaster)', release_date: iso(newest),
          tracks: al.tracks.map(x => ({ ...x, id: x.id + 'r' })) };
        g.album.unshift(rid);
      }
    }
    // With no older release to own, they own the newest single.
    if (!old.length) {
      const al = albums[g.single[0]], t = al.tracks[0];
      libTracks.push({ id: t.id, name: t.name, duration_ms: t.duration_ms, isrc: t.isrc, artists: [a],
        album: al.name, albumId: g.single[0], released: al.release_date, trackNo: 1, albumTracks: 1 });
    }
  }
  const lib = { playlists: [{ id: 'sim', name: 'Sim', tracks: libTracks }], liked: [] };
  const set = artists.map((a, i) => ({ ...a, sources: ['playlist'], tracks: 1, weight: n - i }));
  return { cat: { albums, groups }, lib, artists: set };
}

/**
 * Cold sync of `n` artists, then a re-sync an hour later (nothing due), then
 * one sync a day for `days` days (the cadence at work). Request counts are
 * what syncRadar actually asked the fake for.
 */
export async function simulate({ n = 1000, days = 90, now = Date.UTC(2026, 10, 16), seed = 7,
                                 secPerRequest = SEC_PER_REQUEST } = {}) {
  const { cat, lib, artists } = simulatedWorld(n, { now, seed });
  const store = memoryStore();
  const f = fakeGet(cat);
  const cold = await syncRadar({ lib, artists, store, get: f.get, now });
  const mainOnly = await syncRadar({ lib, artists, store: memoryStore(), get: fakeGet(cat).get, now,
                                     groups: ['album', 'single'] });
  const hour = await syncRadar({ lib, artists, store, get: f.get, now: now + 3600e3 });
  const daily = [];
  for (let d = 1; d <= days; d++) daily.push((await syncRadar({ lib, artists, store, get: f.get, now: now + d * DAY_MS })).requests);
  const sum = xs => xs.reduce((a, b) => a + b, 0);
  const minutes = k => Math.round(k * secPerRequest / 6) / 10;
  return {
    artists: n,
    cold: { ...cold, minutes: minutes(cold.requests) },
    coldMainOnly: { requests: mainOnly.requests, byKind: mainOnly.byKind, minutes: minutes(mainOnly.requests) },
    noChange: { requests: hour.requests },
    daily: { first7: daily.slice(0, 7), mean: Math.round(sum(daily) / daily.length),
             max: Math.max(...daily), last30mean: Math.round(sum(daily.slice(-30)) / Math.min(30, daily.length)),
             perWeek: Math.round(sum(daily.slice(-28)) / 4) },
    secPerRequest,
  };
}
