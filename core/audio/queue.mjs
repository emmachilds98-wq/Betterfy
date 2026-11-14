// Audio priority queue — which tracks to listen to first.
//
// Hearing a track costs a Deezer lookup, two byte-range fetches, a decode and
// a model run: seconds per track on a phone, and a whole library is thousands.
// Most runs are interrupted (the page is closed, the budget runs out), so the
// order is the feature: whatever gets heard first should be what changes an
// answer this listener will see soonest. Five tiers, each one deduped against
// everything above it:
//
//   1. Tracks being played. "Played" means Spotify says so: an artist in
//      `recentlyActive` (short-term top artists + recently-played), or an
//      artist whose listening weight is above what the library floor alone
//      can give (listeningWeights() caps that floor at 1). The floor is how
//      much you have FILED, not evidence that anybody played anything, so it
//      orders tiers but never promotes a track into this one.
//   2. Unfiled liked songs: the inbox the filing suggestions are about.
//   3. Tracks by artists with no tags: where crowd tags say nothing and the
//      ear is the only signal there is.
//   4. Exemplars of each GENRE playlist, so every destination gets a sound
//      fingerprint early instead of the biggest playlist hogging the budget.
//      Picked round-robin across playlists (one from each, then the next...),
//      spread evenly through each playlist rather than its first N, because a
//      playlist's oldest additions are not what it is now (see findDrift).
//      Tracks already heard or queued above count toward a playlist's cap.
//   5. Everything else.
//
// Inside every tier, most-listened artists first (profile.mjs byListening,
// stable), so the weighting is the same one the tag-gap fetch uses.
//
// Ids whose stored record isCurrent() are skipped: a current record or an
// unexpired miss is an answer. A record from an old model or mel version, or a
// miss past its TTL, is not, and is queued again like any unheard track.
//
// Pure: takes the library, the listening numbers and the store's contents;
// never fetches, never writes. The worker and the page decide when to run it.

import { isCurrent } from './record.mjs';
import { byListening } from '../../profile.mjs';
import { mirrorPredicate } from '../playlists/mirror.mjs';

/** listeningWeights() gives the library floor at most this much per artist. */
const LIBRARY_FLOOR_MAX = 1;

/**
 * @param {object} lib                       { playlists: [{ id, tracks }], liked: [track] }
 * @param {object} [o]
 * @param {{weights?: Map<string, number>, recentlyActive?: Set<string>}|Map<string, number>} [o.listening]
 *        what getListening()/fetchListening() return; a bare weights Map is accepted too
 * @param {Iterable<string>} [o.filedIds]    track ids already filed; default: in any non-mirror playlist
 * @param {Iterable<string>} [o.untaggedArtistIds]
 * @param {Map<string, object>|Record<string, object>} [o.store]  track id -> AudioRecord or miss
 * @param {number} [o.budget]                max ids returned; default: no limit
 * @param {number} [o.exemplarsPerPlaylist]
 * @param {string} [o.mel]                   MEL_VERSION, passed to isCurrent()
 * @param {Iterable<string>} [o.targets]     ids of the genre playlists (the same `targets` the
 *        engine takes); default: every non-mirror playlist, as buildSpace() does
 * @param {(p: object) => boolean} [o.isMirror]  extra playlists the caller knows are mirrors
 * @param {number} [o.now]                   for isCurrent()'s miss TTL
 * @returns {string[]} Spotify track ids, most urgent first
 */
export function audioQueue(lib, { listening = null, filedIds = null, untaggedArtistIds = null, store = null,
                                  budget = Infinity, exemplarsPerPlaylist = 20, mel, targets = null,
                                  isMirror = null, now = Date.now() } = {}) {
  const limit = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : Infinity;
  if (limit === 0) return [];

  const weights = listening instanceof Map ? listening : (listening?.weights ?? new Map());
  const active = listening instanceof Map ? null : (listening?.recentlyActive ?? null);
  const mirror = mirrorPredicate(lib, { also: isMirror ?? undefined });
  const playlists = (lib?.playlists ?? []).filter(p => p?.id && !mirror(p));

  // Every distinct, analysable track once, in library order: liked, then playlists.
  const tracks = new Map();
  const add = t => { if (t?.id && !t.is_local && !tracks.has(t.id)) tracks.set(t.id, t); };
  for (const t of lib?.liked ?? []) add(t);
  for (const p of playlists) for (const t of p.tracks ?? []) add(t);

  const lookup = store instanceof Map ? id => store.get(id) : id => store?.[id];
  const heard = id => isCurrent(lookup(id), { mel, now });

  const names = t => (t.artists ?? []).map(a => a?.name).filter(Boolean);
  const weightOf = t => Math.max(0, ...names(t).map(n => weights.get?.(n) ?? 0));
  // byListening keys on a name; key it on the track id so a track with several
  // artists counts at its most-played one.
  const trackWeights = new Map([...tracks.values()].map(t => [t.id, weightOf(t)]));
  const ordered = list => byListening(list, trackWeights, t => t.id);

  const out = [], taken = new Set();
  const take = list => {
    for (const t of list) {
      if (out.length >= limit) return true;
      if (taken.has(t.id)) continue;
      taken.add(t.id);
      if (!heard(t.id)) out.push(t.id);
    }
    return out.length >= limit;
  };
  const all = [...tracks.values()];

  // 1. Being played.
  const played = t => names(t).some(n => active?.has?.(n) || (weights.get?.(n) ?? 0) > LIBRARY_FLOOR_MAX);
  if (take(ordered(all.filter(played)))) return out;

  // 2. Unfiled liked songs.
  const filed = filedIds ? new Set(filedIds)
    : new Set(playlists.flatMap(p => (p.tracks ?? []).map(t => t?.id).filter(Boolean)));
  const liked = (lib?.liked ?? []).map(t => tracks.get(t?.id)).filter(Boolean);
  if (take(ordered(liked.filter(t => !filed.has(t.id))))) return out;

  // 3. Untagged artists.
  const untagged = new Set(untaggedArtistIds ?? []);
  if (untagged.size && take(ordered(all.filter(t => (t.artists ?? []).some(a => a?.id && untagged.has(a.id))))))
    return out;

  // 4. Genre-playlist exemplars, round-robin.
  const genre = targets ? new Set(targets) : null;
  const lanes = [];
  for (const p of playlists) {
    if (genre && !genre.has(p.id)) continue;
    const own = [];
    for (const t of p.tracks ?? []) { const x = tracks.get(t?.id); if (x && !own.includes(x)) own.push(x); }
    // Already heard, or queued above, already counts toward this playlist's fingerprint.
    const have = own.filter(t => taken.has(t.id) || heard(t.id)).length;
    const want = Math.max(0, exemplarsPerPlaylist - have);
    const rest = own.filter(t => !taken.has(t.id) && !heard(t.id));
    lanes.push(spread(rest, want));
  }
  const robin = [];
  for (let i = 0; lanes.some(l => i < l.length); i++) for (const l of lanes) if (i < l.length) robin.push(l[i]);
  if (take(robin)) return out;

  // 5. Everything else.
  take(ordered(all));
  return out;
}

/** n items spaced evenly through list (first included), in list order. */
function spread(list, n) {
  if (n >= list.length) return list;
  if (n <= 0) return [];
  const step = list.length / n;
  return Array.from({ length: n }, (_, i) => list[Math.floor(i * step)]);
}
