// Node-side fetch for real listening behaviour — how much you actually play
// an artist, not just how much of them you have filed. The combining logic
// (listeningWeights) lives in profile.mjs so the browser build can share it
// instead of reimplementing the weighting by hand a second time; this module
// is only the Spotify-call half, which the two environments can't share
// since Node reads spotify.mjs's token-refreshing api() and the browser reads
// its own fetch wrapper.
import { api } from './spotify.mjs';
import { listeningWeights } from './profile.mjs';

const WINDOWS = [['short_term', 3], ['medium_term', 2], ['long_term', 1.5]];

/**
 * `{ weights, recentlyActive }` — weights for prioritising which artist's
 * tag gap to fill first, recentlyActive (a Set of artist names from the
 * short-term window and recently-played) for noting when a "misfiled" track
 * is one you're actually playing right now. Every call is independently
 * best-effort: no listening history, an expired token, or being offline all
 * degrade to weights of 0 rather than failing the script that called this.
 */
export async function fetchListening(lib) {
  const topWindows = [];
  for (const [range, weight] of WINDOWS) {
    try {
      const r = await api(`/me/top/artists?limit=50&time_range=${range}`);
      topWindows.push({ range, weight, items: (r?.items ?? []).map(a => a.name) });
    } catch { /* one window failing (or no auth at all) still leaves the others */ }
  }
  let recentArtists = [];
  try {
    const r = await api('/me/player/recently-played?limit=50');
    recentArtists = (r?.items ?? []).flatMap(p => (p.track?.artists ?? []).map(a => a.name));
  } catch { /* ditto */ }

  const libraryArtists = [];
  for (const p of lib.playlists) for (const t of p.tracks) for (const a of t.artists ?? []) libraryArtists.push(a.name);
  for (const t of lib.liked ?? []) for (const a of t.artists ?? []) libraryArtists.push(a.name);

  const weights = listeningWeights({ topWindows, recentArtists, libraryArtists });
  const shortTerm = topWindows.find(w => w.range === 'short_term')?.items ?? [];
  const recentlyActive = new Set([...shortTerm, ...recentArtists]);
  return { weights, recentlyActive };
}
