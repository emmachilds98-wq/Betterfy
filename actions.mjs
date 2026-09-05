// Every mutation to the Spotify library goes through here, and every mutation
// is written to an append-only log first. Given how carefully this library has
// been curated by hand, nothing should be irreversible.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { api } from './spotify.mjs';

const LOG = 'actions.log.jsonl';

export function log(entry) {
  appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

export function history(limit = 200) {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean).slice(-limit).reverse();
}

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/** Spotify renamed /tracks to /items; try the new path and fall back. */
async function call(playlistId, method, body) {
  for (const seg of ['items', 'tracks']) {
    try {
      return await api(`/playlists/${playlistId}/${seg}`, { method, body: JSON.stringify(body) });
    } catch (e) {
      if (!/^40[34]/.test(e.message) || seg === 'tracks') throw e;
    }
  }
}

/**
 * Remove specific track ids from one playlist.
 * Records the positions so the removal can be undone in place.
 */
export async function removeFrom(playlistId, playlistName, trackIds, reason) {
  const before = await snapshotPlaylist(playlistId);
  const positions = {};
  before.forEach((t, i) => { if (trackIds.includes(t.id)) (positions[t.id] ??= []).push(i); });

  await call(playlistId, 'DELETE', { tracks: trackIds.map(id => ({ uri: `spotify:track:${id}` })) });
  log({ op: 'remove', playlistId, playlistName, trackIds, positions, reason, undoable: true });
  return { removed: trackIds.length };
}

/** Add tracks to the end of a playlist. */
export async function addTo(playlistId, playlistName, trackIds, reason) {
  for (const part of chunk(trackIds, 100))
    await call(playlistId, 'POST', { uris: part.map(id => `spotify:track:${id}`) });
  log({ op: 'add', playlistId, playlistName, trackIds, reason, undoable: true });
  return { added: trackIds.length };
}

/** Reverse a logged action. */
export async function undo(entry) {
  if (entry.op === 'remove') {
    // Re-add, then move each back to the index it came from.
    await call(entry.playlistId, 'POST', { uris: entry.trackIds.map(id => `spotify:track:${id}`) });
    for (const [id, idxs] of Object.entries(entry.positions ?? {})) {
      for (const target of idxs) {
        const now = await snapshotPlaylist(entry.playlistId);
        const from = now.findIndex(t => t.id === id);
        if (from >= 0 && from !== target)
          await call(entry.playlistId, 'PUT', { range_start: from, insert_before: target, range_length: 1 });
      }
    }
    log({ op: 'undo-remove', of: entry.at, playlistId: entry.playlistId, trackIds: entry.trackIds });
    return { restored: entry.trackIds.length };
  }
  if (entry.op === 'add') {
    await call(entry.playlistId, 'DELETE', { tracks: entry.trackIds.map(id => ({ uri: `spotify:track:${id}` })) });
    log({ op: 'undo-add', of: entry.at, playlistId: entry.playlistId, trackIds: entry.trackIds });
    return { removed: entry.trackIds.length };
  }
  throw new Error(`Cannot undo "${entry.op}"`);
}

export async function snapshotPlaylist(id) {
  const out = [];
  let page = await api(`/playlists/${id}/items?limit=100&fields=next,items(item(id))`);
  while (page) {
    for (const i of page.items) if (i.item?.id) out.push({ id: i.item.id });
    if (!page.next) break;
    page = await api(page.next);
  }
  return out;
}

/* ---------------- playback ---------------- */

export async function devices() {
  const d = await api('/me/player/devices');
  return d.devices ?? [];
}

/** Audition a track on the user's active device, without disturbing a queue. */
export async function playTrack(trackId, deviceId) {
  const list = await devices();
  const dev = deviceId ? list.find(d => d.id === deviceId) : (list.find(d => d.is_active) ?? list[0]);
  if (!dev) throw new Error('No open Spotify device — open Spotify and try again.');
  await api(`/me/player/play?device_id=${dev.id}`, {
    method: 'PUT', body: JSON.stringify({ uris: [`spotify:track:${trackId}`] }),
  });
  return { device: dev.name };
}

export const pause = () => api('/me/player/pause', { method: 'PUT' }).catch(() => null);
