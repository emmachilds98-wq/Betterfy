// Discovery that is new BY CONSTRUCTION: every artist and track you already
// own is subtracted before ranking, so nothing recycles your own library.
//
//   node discover.mjs                      # seeded from your top artists
//   node discover.mjs --like "Jungle & Breaks Emma"
//   node discover.mjs --like "Techno Emma" --n 40
import { readFileSync, writeFileSync } from 'node:fs';
import { env } from './env.mjs';
import { api } from './spotify.mjs';
import { Cache, sleep, retry } from './cache.mjs';
import { norm } from './norm.mjs';
import { ownsAnyOf } from './credits.mjs';

// Collaboration credits ('Shy FX & T Power', 'dwarde & Tim Reaper') must be
// split before the ownership test, or a seed artist re-enters as half of a duo.

const args = process.argv.slice(2);
const LIKE = args.includes('--like') ? args[args.indexOf('--like') + 1] : null;
const WANT = args.includes('--n') ? +args[args.indexOf('--n') + 1] : 30;

const lib = JSON.parse(readFileSync('library.json', 'utf8'));
const lfm = p => fetch('https://ws.audioscrobbler.com/2.0/?' + new URLSearchParams({
  ...p, api_key: env.LASTFM_API_KEY, format: 'json',
})).then(r => r.json());

// ---------- 1. everything you already have (the exclusion set) ----------
const ownedArtist = new Set(), ownedTrack = new Set();
const own = t => {
  for (const a of t?.artists ?? []) ownedArtist.add(norm(a.name));
  if (t?.name) ownedTrack.add(norm(t.artists?.[0]?.name ?? '') + '|' + norm(t.name));
};
for (const p of lib.playlists) p.tracks.forEach(own);
lib.liked.forEach(own);
for (const r of ['short_term','medium_term','long_term']) {
  lib.top_artists[r].forEach(a => ownedArtist.add(norm(a.name)));
  lib.top_tracks[r].forEach(own);
}
console.error(`exclusion set: ${ownedArtist.size} artists, ${ownedTrack.size} tracks`);

// ---------- 2. seeds ----------
let seeds;
if (LIKE) {
  const p = lib.playlists.find(x => x.name.toLowerCase().includes(LIKE.toLowerCase()));
  if (!p) { console.error(`No playlist matching "${LIKE}"`); process.exit(1); }
  const freq = new Map();
  for (const t of p.tracks) for (const a of t.artists ?? []) freq.set(a.name, (freq.get(a.name) ?? 0) + 1);
  seeds = [...freq].sort((a,b) => b[1]-a[1]).slice(0, 60).map(([name], i) => ({ name, w: 1 - i/80 }));
  console.error(`seeding from "${p.name}" — ${seeds.length} artists`);
} else {
  // weight by how high they rank, and favour recent listening
  const w = { short_term: 1.0, medium_term: 0.8, long_term: 0.6 };
  const acc = new Map();
  for (const r of Object.keys(w))
    lib.top_artists[r].forEach((a, i) =>
      acc.set(a.name, (acc.get(a.name) ?? 0) + w[r] * (1 - i / 60)));
  seeds = [...acc].sort((a,b) => b[1]-a[1]).slice(0, 60).map(([name, s]) => ({ name, w: s }));
  console.error(`seeding from your top artists — ${seeds.length}`);
}

// ---------- 3. similar artists you do NOT own ----------
const simCache = new Cache('cache-similar.json');
const cand = new Map();
for (const [i, s] of seeds.entries()) {
  let list = simCache.get(s.name);
  if (!list) {
    const r = await retry(() => lfm({ method: 'artist.getsimilar', artist: s.name, autocorrect: '1', limit: '50' }));
    list = (r.similarartists?.artist ?? []).map(a => [a.name, Number(a.match) || 0]);
    simCache.set(s.name, list);
    await sleep(200);
  }
  for (const [name, match] of list) {
    if (ownsAnyOf(name, ownedArtist)) continue;              // <- the hard filter
    const cur = cand.get(name) ?? { name, score: 0, via: [] };
    cur.score += match * s.w;
    if (cur.via.length < 3) cur.via.push(s.name);
    cand.set(name, cur);
  }
  if ((i+1) % 20 === 0) console.error(`  ${i+1}/${seeds.length} seeds`);
}
simCache.flush();
const ranked = [...cand.values()].sort((a,b) => b.score - a.score);
console.error(`candidate artists (none owned): ${ranked.length}`);

// ---------- 4. their tracks, minus anything you own ----------
const out = [];
for (const c of ranked) {
  if (out.length >= WANT) break;
  let top;
  try { top = await retry(() => lfm({ method: 'artist.gettoptracks', artist: c.name, limit: '4' })); }
  catch { continue; }
  await sleep(200);
  for (const t of top.toptracks?.track ?? []) {
    const key = norm(c.name) + '|' + norm(t.name);
    if (ownedTrack.has(key)) continue;
    out.push({ artist: c.name, track: t.name, score: +c.score.toFixed(3), via: c.via });
    break;                                              // one track per artist
  }
}

// ---------- 5. resolve to Spotify ----------
console.error(`resolving ${out.length} on Spotify...`);
for (const o of out) {
  try {
    const q = encodeURIComponent(`artist:${o.artist} track:${o.track}`);
    const r = await api(`/search?q=${q}&type=track&limit=1`);
    const hit = r.tracks?.items?.[0];
    if (hit) { o.spotify = hit.id; o.uri = hit.uri; o.album = hit.album?.name; o.released = hit.album?.release_date; }
  } catch {}
}

const found = out.filter(o => o.spotify);
console.log(`\n${found.length} NEW tracks — none by an artist already in your library\n`);
for (const [i, o] of found.entries())
  console.log(`${String(i+1).padStart(3)}. ${o.artist} — ${o.track}\n     ${(o.released??'').slice(0,4)}  via ${o.via.join(', ')}`);

writeFileSync('report-discover.json', JSON.stringify(found, null, 2));
console.log(`\nwrote report-discover.json`);
