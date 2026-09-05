// A shuffle that actually feels shuffled: maximises spacing between tracks by
// the same artist and the same album, instead of uniform-random (which clumps)
// or Spotify's weighted shuffle (which clumps on purpose).
//
//   node shuffle.mjs "Techno Emma"            # dry run + quality stats
//   node shuffle.mjs "Techno Emma" --apply    # write to a shuffled playlist
//   node shuffle.mjs "Techno Emma" --play     # apply, then start playback
import { readFileSync } from 'node:fs';
import { api } from './spotify.mjs';
import { findOrCreate, replaceAll } from './write.mjs';
import { dedupe } from './norm.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply') || args.includes('--play');
const PLAY  = args.includes('--play');
const target = args.find(a => !a.startsWith('--'));

const lib = JSON.parse(readFileSync('library.json', 'utf8'));

let tracks, label;
if (!target || target.toLowerCase() === 'all') {
  const m = new Map();
  for (const p of lib.playlists) for (const t of p.tracks) if (t.id) m.set(t.id, t);
  for (const t of lib.liked) if (t?.id) m.set(t.id, t);
  tracks = dedupe([...m.values()]); label = 'Everything';
} else {
  const p = lib.playlists.find(x => x.name.toLowerCase() === target.toLowerCase())
        ?? lib.playlists.find(x => x.name.toLowerCase().includes(target.toLowerCase()));
  if (!p) { console.error(`No playlist matching "${target}".`); process.exit(1); }
  // de-dupe within the source so one track can't appear twice in the shuffle
  tracks = dedupe(p.tracks);
  label = p.name;
}

const rnd = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const artistOf = t => t.artists?.[0]?.name ?? '?';

/**
 * Greedy max-spacing interleave. At each step take the artist with the most
 * tracks still unplaced, skipping any artist used within the cooldown window.
 * Picking the largest bucket first is what stops a prolific artist bunching up
 * at the tail, which is the usual failure mode of naive shuffles.
 */
function spacedShuffle(items) {
  const buckets = new Map();
  for (const t of items) {
    const k = artistOf(t);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(t);
  }
  for (const v of buckets.values()) rnd(v);

  const cooldown = Math.max(1, Math.min(buckets.size - 1, Math.floor(buckets.size / 3), 12));
  const out = [], recentArtist = [], recentAlbum = [];

  while (out.length < items.length) {
    const avail = [...buckets.entries()].filter(([, v]) => v.length);
    // prefer artists outside the cooldown window; fall back if none qualify
    let pool = avail.filter(([k]) => !recentArtist.includes(k));
    if (!pool.length) pool = avail;

    const max = Math.max(...pool.map(([, v]) => v.length));
    let top = pool.filter(([, v]) => v.length === max);

    // among equals, avoid repeating a recent album
    const fresh = top.filter(([, v]) => !recentAlbum.includes(v.at(-1).album));
    if (fresh.length) top = fresh;

    const [key, list] = top[Math.floor(Math.random() * top.length)];
    const t = list.pop();
    out.push(t);

    recentArtist.push(key); if (recentArtist.length > cooldown) recentArtist.shift();
    recentAlbum.push(t.album); if (recentAlbum.length > 4) recentAlbum.shift();
  }
  return out;
}

/** Quality metric: how close together do same-artist tracks land? */
function stats(order) {
  const last = new Map(); const gaps = [];
  let adjacent = 0, within3 = 0;
  order.forEach((t, i) => {
    const k = artistOf(t);
    if (last.has(k)) {
      const g = i - last.get(k);
      gaps.push(g);
      if (g === 1) adjacent++;
      if (g <= 3) within3++;
    }
    last.set(k, i);
  });
  return {
    adjacent, within3,
    minGap: gaps.length ? Math.min(...gaps) : '-',
    avgGap: gaps.length ? (gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1) : '-',
  };
}

const naive = stats(rnd([...tracks]));
const order = spacedShuffle(tracks);
const good  = stats(order);

console.log(`"${label}" — ${tracks.length} tracks, ${new Set(tracks.map(artistOf)).size} artists\n`);
console.log('                       same-artist adjacent   within 3   min gap   avg gap');
console.log(`  uniform random              ${String(naive.adjacent).padStart(4)}        ${String(naive.within3).padStart(4)}      ${String(naive.minGap).padStart(4)}     ${naive.avgGap}`);
console.log(`  spaced shuffle              ${String(good.adjacent).padStart(4)}        ${String(good.within3).padStart(4)}      ${String(good.minGap).padStart(4)}     ${good.avgGap}`);

console.log('\nfirst 15:');
order.slice(0, 15).forEach((t, i) => console.log(`  ${String(i+1).padStart(3)}. ${artistOf(t)} — ${t.name}`));

if (!APPLY) { console.log('\nDRY RUN — nothing written. Add --apply to write, --play to start it.'); process.exit(0); }

const me = await api('/me');
const name = `🔀 ${label}`;
const pl = await findOrCreate(me.id, name, `Spaced shuffle of "${label}". Play with Spotify shuffle OFF.`);
await replaceAll(pl.id, order.map(t => `spotify:track:${t.id}`));
console.log(`\nwrote ${order.length} tracks to "${name}"`);

if (PLAY) {
  const devs = await api('/me/player/devices');
  const dev = devs.devices?.find(d => d.is_active) ?? devs.devices?.[0];
  if (!dev) { console.log('No open Spotify device — open the app and retry with --play.'); process.exit(0); }
  await api(`/me/player/shuffle?state=false&device_id=${dev.id}`, { method: 'PUT' });
  await api(`/me/player/play?device_id=${dev.id}`, {
    method: 'PUT', body: JSON.stringify({ context_uri: `spotify:playlist:${pl.id}` }),
  });
  console.log(`playing on ${dev.name} with Spotify shuffle disabled.`);
}
