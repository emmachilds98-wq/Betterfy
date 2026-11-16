// Release Radar from the command line (docs/RELEASE-RADAR-PLAN.md phases 0-3).
//
// The same sync the page runs (core/release/sync.mjs), against your own token,
// so its cost can be measured on a real account before anything is built on
// it, and its feed inspected without touching the app.
//
//   node radar.mjs --probe                  Phase 0: re-check the endpoints the radar
//                                           needs on this app, and print what answered
//   node radar.mjs --measure [--artists N]  Phase 0: a cold sync of the first N artists
//                                           (most listened first); prints requests and
//                                           minutes, and the 1,000-artist extrapolation
//   node radar.mjs --measure --resume       carry on from radar-state.json
//   node radar.mjs --feed [--all]           the feed from radar-state.json, newest first
//   node radar.mjs --selftest               offline: fixture accuracy per §4 problem and
//                                           the simulated 1,000-artist request budget
//
// Options: --years 2 (window), --main-only (skip the features lane), --budget N
// (stop after N requests), --state FILE (default radar-state.json),
// --token TOKEN or RADAR_TOKEN=... (a bare access token; otherwise auth.mjs's
// .tokens.json is used through spotify.mjs). The artist set comes from
// library.json (`node snapshot.mjs`).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { artistSet } from './core/release/artists.mjs';
import { syncRadar, memoryStore, loadReleases } from './core/release/sync.mjs';
import { planTasks, estimate, KEY, PAGE_LIMIT } from './core/release/plan.mjs';
import { parseDate, dateLabel, cutoffTs, inWindow } from './core/release/dates.mjs';

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] != null ? args[i + 1] : d; };

const STATE = opt('--state', 'radar-state.json');
const YEARS = +opt('--years', 2);

/** A Spotify GET that throws errors with `.status`, from a bare token or spotify.mjs. */
async function makeGet() {
  const bare = opt('--token', process.env.RADAR_TOKEN);
  if (bare) {
    return async function get(path) {
      const url = path.startsWith('http') ? path : `https://api.spotify.com/v1${path}`;
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(url, { headers: { authorization: `Bearer ${bare}` } });
        if (res.status === 429 && attempt < 5) {
          const wait = (Number(res.headers.get('retry-after')) || 2) * 1000;
          console.error(`  rate limited, waiting ${wait / 1000}s`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        const body = await res.json().catch(() => null);
        if (!res.ok) throw Object.assign(new Error(`${res.status} ${body?.error?.message ?? ''}`), { status: res.status, body });
        return body;
      }
    };
  }
  const { api } = await import('./spotify.mjs');
  return async path => {
    try { return await api(path); }
    catch (e) { throw Object.assign(e, { status: +(/^(\d{3}) /.exec(e.message)?.[1] ?? 0) }); }
  };
}

function readLibrary() {
  if (!existsSync('library.json')) throw new Error('No library.json: run `node snapshot.mjs` first.');
  return JSON.parse(readFileSync('library.json', 'utf8'));
}

function fileStore(resume) {
  const init = resume && existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null;
  const s = memoryStore(init);
  s.flush = () => writeFileSync(STATE, JSON.stringify(s.toJSON()));
  return s;
}

async function probe() {
  const lib = readLibrary();
  const get = await makeGet();
  const artist = artistSet(lib)[0];
  if (!artist) throw new Error('library.json names no artist');
  const rows = [];
  const tryGet = async (label, path, look = () => '') => {
    try { const b = await get(path); rows.push([label, 'ok', look(b)]); return b; }
    catch (e) { rows.push([label, String(e.status || 'error'), String(e.message).split('\n')[0].slice(0, 70)]); return null; }
  };
  console.error(`probing with ${artist.name} (${artist.id})\n`);
  const page = await tryGet(`albums, limit=${PAGE_LIMIT}`, `/artists/${artist.id}/albums?include_groups=single&market=from_token&limit=${PAGE_LIMIT}`,
    b => {
      const items = b?.items ?? [];
      const ts = items.map(i => parseDate(i.release_date, i.release_date_precision).ts);
      const sorted = ts.every((t, i) => i === 0 || t <= ts[i - 1]);
      return `${items.length} items, total ${b?.total}, newest first: ${sorted}, album_group present: ${items.some(i => 'album_group' in i)}`;
    });
  await tryGet('albums, limit=50 (cap check)', `/artists/${artist.id}/albums?include_groups=single&market=from_token&limit=50`,
    b => `${b?.items?.length} items: the 10 cap is lifted`);
  await tryGet('albums, all groups at once', `/artists/${artist.id}/albums?include_groups=album,single,appears_on&market=from_token&limit=${PAGE_LIMIT}`,
    b => `${b?.items?.length} items`);
  const first = page?.items?.[0]?.id, second = page?.items?.[1]?.id ?? first;
  const album = first ? await tryGet('album detail /albums/{id}', `/albums/${first}?market=from_token`,
    b => `${b?.tracks?.items?.length} tracks, track ISRCs present: ${(b?.tracks?.items ?? []).some(t => t.external_ids?.isrc)}`) : null;
  if (first) await tryGet('several albums /albums?ids=', `/albums?ids=${first},${second}`, b => `${b?.albums?.length} albums: still served`);
  const tid = album?.tracks?.items?.[0]?.id;
  if (tid) await tryGet('track /tracks/{id}', `/tracks/${tid}?market=from_token`, b => `ISRC: ${b?.external_ids?.isrc ?? 'absent'}`);
  if (tid) await tryGet('several tracks /tracks?ids=', `/tracks?ids=${tid}`, b => `${b?.tracks?.length} tracks: still served`);
  const w = Math.max(...rows.map(r => r[0].length));
  for (const [l, s, n] of rows) console.log(`${l.padEnd(w)}  ${s.padEnd(5)}  ${n}`);
  console.log('\nExpected on a Development Mode app created after February 2026: the first, fourth and sixth');
  console.log('answer ok; limit=50 and both batch endpoints refuse. Paste this table into the PR.');
}

async function measure() {
  const lib = readLibrary();
  const get = await makeGet();
  const all = artistSet(lib);
  const n = Math.min(all.length, +opt('--artists', all.length));
  const artists = all.slice(0, n);
  const store = fileStore(flag('--resume'));
  const groups = flag('--main-only') ? ['album', 'single'] : undefined;
  const now = Date.now();
  const states = new Map();
  for (const a of artists) states.set(a.id, await store.get(KEY.artist(a.id)));
  const est = estimate(planTasks(artists, states, now, { groups }), { artists: n });
  console.error(`${all.length} artists in the library; syncing ${n}. Estimate: ~${est.requests} requests, ~${est.minutes} min.\n`);
  const t0 = Date.now();
  let shown = 0;
  const r = await syncRadar({ lib, artists, store, get, now, years: YEARS, groups,
    maxRequests: +opt('--budget', Infinity),
    onProgress: p => { if (p.done - shown >= 25 || p.done === p.total) { shown = p.done;
      console.error(`  ${p.done}/${p.total} groups · ${p.requests} requests · ${((Date.now() - t0) / 60000).toFixed(1)} min`); store.flush(); } } });
  store.flush();
  const min = (Date.now() - t0) / 60000;
  const per = r.requests / Math.max(1, n);
  console.log(JSON.stringify({ artists: n, ...r, minutes: +min.toFixed(2),
    requestsPerArtist: +per.toFixed(2), secondsPerRequest: +(min * 60 / Math.max(1, r.requests)).toFixed(3),
    extrapolated1000: { requests: Math.round(per * 1000), minutes: +(min / Math.max(1, n) * 1000).toFixed(1) } }, null, 2));
  if (r.stopped) console.error(`\nStopped early (${r.stopped.why}): run again with --resume to carry on.`);
}

async function feed() {
  const store = fileStore(true);
  const cut = cutoffTs(Date.now(), YEARS);
  const rows = (await loadReleases(store))
    .filter(r => flag('--all') || (r.lane === 'main' && !r.reissue && inWindow(parseDate(r.releaseDate, r.precision), cut)))
    .sort((a, b) => b.ts - a.ts);
  for (const r of rows.slice(0, +opt('--limit', 60))) {
    const marks = [r.albumType !== 'album' ? r.albumType.toUpperCase() : '', r.lane === 'features' ? 'FEATURE' : '',
      r.reissue ? `REISSUE(${r.reissueBasis})` : '', r.owned !== 'none' ? `owned:${r.owned}` : ''].filter(Boolean).join(' ');
    console.log(`${dateLabel(parseDate(r.releaseDate, r.precision)).padEnd(18)} ${r.artists.map(a => a.name).join(', ')} — ${r.name}  ${marks}`);
  }
  console.error(`\n${rows.length} rows`);
}

async function selftest() {
  const { scoreFixtures } = await import('./core/release/fixtures.mjs');
  const { simulate } = await import('./core/release/simulate.mjs');
  const { scores } = await scoreFixtures();
  console.log('Fixture accuracy, per docs/RELEASE-RADAR-PLAN.md §4 problem:');
  for (const [k, s] of Object.entries(scores))
    console.log(`  §${k}  ${s.correct}/${s.total}${s.misses.length ? '  missed: ' + s.misses.join('; ') : ''}`);
  const sim = await simulate({ n: +opt('--artists', 1000), days: +opt('--days', 90) });
  console.log(`\nSimulated ${sim.artists}-artist library (core/release/simulate.mjs), at ${sim.secPerRequest}s a request:`);
  console.log(`  cold sync           ${sim.cold.requests} requests (${sim.cold.byKind.list} list, ${sim.cold.byKind.detail} track lists, ${sim.cold.byKind.probe} ISRC probes), ~${sim.cold.minutes} min`);
  console.log(`  cold, main lane only ${sim.coldMainOnly.requests} requests, ~${sim.coldMainOnly.minutes} min`);
  console.log(`  re-sync an hour on  ${sim.noChange.requests} requests`);
  console.log(`  daily re-sync       mean ${sim.daily.mean}, max ${sim.daily.max}, ${sim.daily.perWeek} a week (cadence)`);
}

const run = flag('--probe') ? probe : flag('--measure') ? measure : flag('--feed') ? feed : flag('--selftest') ? selftest : null;
if (!run) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 25).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
} else {
  run().catch(e => { console.error(e.message); process.exit(1); });
}
