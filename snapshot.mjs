// Dump the library to library.json. Run: node snapshot.mjs
//
// Incremental by default. Spotify gives every playlist a snapshot_id that
// changes whenever its contents do, so a playlist whose id still matches the
// last run is copied across untouched instead of being paged through again.
// On a large library that is the difference between minutes and seconds.
// Pass --full to re-read everything regardless.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { api, paged } from './spotify.mjs';

const FULL = process.argv.includes('--full');
const previous = existsSync('library.json')
  ? JSON.parse(readFileSync('library.json', 'utf8')) : null;
const before = new Map((previous?.playlists ?? []).map(p => [p.id, p]));

const FIELDS = 'next,items(added_at,item(id,name,popularity,duration_ms,explicit,external_ids,track_number,album(id,name,release_date,album_type,total_tracks,images),artists(id,name)))';

const track = t => t && ({
  id: t.id,
  name: t.name,
  artists: (t.artists ?? []).map(a => ({ id: a.id, name: a.name })),
  album: t.album?.name,
  albumId: t.album?.id,
  albumType: t.album?.album_type,          // single | album | compilation
  albumTracks: t.album?.total_tracks,
  trackNo: t.track_number,
  released: t.album?.release_date,
  art: t.album?.images?.at(-1)?.url,       // smallest image; the rows show it at 40px
  duration_ms: t.duration_ms,
  explicit: t.explicit,
  isrc: t.external_ids?.isrc,              // the recording's global identity
  popularity: t.popularity,
});

const me = await api('/me');
console.error(`user: ${me.display_name} (${me.id})`);

const playlists = await paged('/me/playlists?limit=50');
const owned = playlists.filter(p => p.owner?.id === me.id);
console.error(`playlists: ${playlists.length} (${owned.length} owned, ${playlists.length - owned.length} followed)\n`);

const detailed = [];
let reused = 0;
for (const [i, p] of owned.entries()) {
  const cached = before.get(p.id);
  const label = `  [${String(i + 1).padStart(2)}/${owned.length}] ${p.name}`;

  // Unchanged contents: keep the tracks, but take the current name and flags,
  // which can change without touching snapshot_id.
  if (!FULL && cached?.snapshot_id && cached.snapshot_id === p.snapshot_id) {
    detailed.push({
      ...cached,
      name: p.name, description: p.description,
      public: p.public, collaborative: p.collaborative,
    });
    reused++;
    console.error(`${label} — ${cached.tracks.length} (unchanged)`);
    continue;
  }

  let items = [];
  try {
    items = await paged(`/playlists/${p.id}/items?limit=100&fields=${encodeURIComponent(FIELDS)}`);
  } catch (e) {
    console.error(`  !! ${p.name}: ${String(e.message).split('\n')[0]}`);
    // Don't let a transient failure silently empty a playlist in the snapshot.
    if (cached) { detailed.push(cached); continue; }
  }
  const tracks = items.filter(i => i.item?.id).map(i => ({ added_at: i.added_at, ...track(i.item) }));
  detailed.push({
    id: p.id, name: p.name, description: p.description,
    public: p.public, collaborative: p.collaborative,
    snapshot_id: p.snapshot_id,
    total: p.tracks?.total ?? p.items?.total ?? tracks.length,
    tracks,
  });
  console.error(`${label} — ${tracks.length}`);
}
console.error(`\n${reused} playlists unchanged since the last snapshot, ${owned.length - reused} re-read`);

const saved = await paged('/me/tracks?limit=50');
console.error(`\nliked songs: ${saved.length}`);

const topTracks = {}, topArtists = {};
for (const range of ['short_term', 'medium_term', 'long_term']) {
  topTracks[range] = (await paged(`/me/top/tracks?limit=50&time_range=${range}`)).map(track);
  topArtists[range] = (await paged(`/me/top/artists?limit=50&time_range=${range}`))
    .map(a => ({ id: a.id, name: a.name, genres: a.genres, popularity: a.popularity }));
}
console.error(`top artists: ${topArtists.long_term.length} long-term`);

const recent = await paged('/me/player/recently-played?limit=50');
console.error(`recently played: ${recent.length}`);

// needs user-follow-read, which the current token lacks — non-fatal
let following = [];
try { following = await paged('/me/following?type=artist&limit=50', 'artists'); }
catch { console.error('following: skipped (needs re-auth for user-follow-read)'); }

writeFileSync('library.json', JSON.stringify({
  captured_at: new Date().toISOString(),
  user: { id: me.id, name: me.display_name },
  playlists: detailed,
  followed_playlists: playlists.filter(p => p.owner?.id !== me.id)
    .map(p => ({ id: p.id, name: p.name, owner: p.owner?.display_name, total: p.items?.total })),
  liked: saved.map(i => ({ added_at: i.added_at, ...track(i.track ?? i.item) })),
  top_tracks: topTracks,
  top_artists: topArtists,
  recently_played: recent.map(i => ({ played_at: i.played_at, ...track(i.track ?? i.item) })),
  following: following.map(a => ({ id: a.id, name: a.name, genres: a.genres })),
}, null, 2));

const n = detailed.reduce((s, p) => s + p.tracks.length, 0);
console.error(`\nwrote library.json — ${detailed.length} playlists, ${n} filed tracks`);
if (reused && !FULL) console.error('(run with --full to re-read every playlist)');
