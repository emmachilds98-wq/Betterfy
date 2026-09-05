// Dump the full library to library.json. Run: node snapshot.mjs
import { writeFileSync } from 'node:fs';
import { api, paged } from './spotify.mjs';

const FIELDS = 'next,items(added_at,item(id,name,popularity,duration_ms,explicit,external_ids,track_number,album(id,name,release_date,album_type,total_tracks),artists(id,name)))';

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
for (const [i, p] of owned.entries()) {
  let items = [];
  try {
    items = await paged(`/playlists/${p.id}/items?limit=100&fields=${encodeURIComponent(FIELDS)}`);
  } catch (e) {
    console.error(`  !! ${p.name}: ${String(e.message).split('\n')[0]}`);
  }
  const tracks = items.filter(i => i.item?.id).map(i => ({ added_at: i.added_at, ...track(i.item) }));
  detailed.push({
    id: p.id, name: p.name, description: p.description,
    public: p.public, collaborative: p.collaborative,
    total: p.items?.total, tracks,
  });
  console.error(`  [${String(i + 1).padStart(2)}/${owned.length}] ${p.name} — ${tracks.length}`);
}

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
