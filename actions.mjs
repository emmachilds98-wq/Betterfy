// Every mutation to the Spotify library goes through here, and every mutation
// is written to an append-only log first. Given how carefully this library has
// been curated by hand, nothing should be irreversible.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { api } from './spotify.mjs';

const LOG = 'actions.log.jsonl';

/**
 * `txn` groups entries that must be undone together (e.g. a move is an add
 * plus a remove). Callers that don't care get one auto-generated per entry,
 * so every existing single-step action is still its own one-entry group.
 */
export function log(entry) {
  const row = { ...entry, at: new Date().toISOString(), txn: entry.txn ?? randomUUID() };
  appendFileSync(LOG, JSON.stringify(row) + '\n');
  return row;
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
export async function removeFrom(playlistId, playlistName, trackIds, reason, txn) {
  const before = await snapshotPlaylist(playlistId);
  const positions = {};
  before.forEach((t, i) => { if (trackIds.includes(t.id)) (positions[t.id] ??= []).push(i); });

  await call(playlistId, 'DELETE', { tracks: trackIds.map(id => ({ uri: `spotify:track:${id}` })) });
  log({ op: 'remove', playlistId, playlistName, trackIds, positions, reason, undoable: true, txn });
  return { removed: trackIds.length };
}

/** Add tracks to the end of a playlist. */
export async function addTo(playlistId, playlistName, trackIds, reason, txn) {
  for (const part of chunk(trackIds, 100))
    await call(playlistId, 'POST', { uris: part.map(id => `spotify:track:${id}`) });
  log({ op: 'add', playlistId, playlistName, trackIds, reason, undoable: true, txn });
  return { added: trackIds.length };
}

/**
 * Move one track between playlists as a single undoable unit: both the add
 * and the remove share a txn, so undo() reverses them together instead of
 * leaving the track stranded in both (or neither) playlist.
 */
export async function moveTrack(fromId, fromName, toId, toName, trackId, reason) {
  const txn = randomUUID();
  await addTo(toId, toName, [trackId], reason ?? `moved from ${fromName}`, txn);
  await removeFrom(fromId, fromName, [trackId], reason ?? `moved to ${toName}`, txn);
  return { from: fromName, to: toName, txn };
}

/** Unlike a track, recording enough to re-like it on undo. */
export async function unlikeTrack(trackId, trackMeta) {
  await api(`/me/tracks?ids=${trackId}`, { method: 'DELETE' });
  return log({ op: 'unlike', trackIds: [trackId], trackMeta, undoable: true });
}

/** Move a single item within a playlist without re-fetching between calls. */
export function moveInArray(arr, from, insertBefore) {
  const item = arr[from];
  const rest = [...arr.slice(0, from), ...arr.slice(from + 1)];
  const insertAt = insertBefore > from ? insertBefore - 1 : insertBefore;
  rest.splice(insertAt, 0, item);
  return rest;
}

/** Reverse a single logged action. */
export async function undo(entry) {
  if (entry.op === 'remove') {
    // Re-add, then move each back to the index it came from, tracking the
    // resulting order locally instead of re-fetching the playlist on every step.
    await call(entry.playlistId, 'POST', { uris: entry.trackIds.map(id => `spotify:track:${id}`) });
    let now = await snapshotPlaylist(entry.playlistId);
    for (const [id, idxs] of Object.entries(entry.positions ?? {})) {
      for (const target of idxs) {
        const from = now.findIndex(t => t.id === id);
        if (from >= 0 && from !== target) {
          await call(entry.playlistId, 'PUT', { range_start: from, insert_before: target, range_length: 1 });
          now = moveInArray(now, from, target);
        }
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
  if (entry.op === 'unlike') {
    await api(`/me/tracks?ids=${entry.trackIds[0]}`, { method: 'PUT' });
    log({ op: 'undo-unlike', of: entry.at, trackIds: entry.trackIds });
    return { restored: 1 };
  }
  if (entry.op === 'create-playlist') {
    // Spotify has no true delete for an owned playlist; unfollowing your own
    // playlist removes it from your library, which is what "undo create" means here.
    await api(`/playlists/${entry.playlistId}/followers`, { method: 'DELETE' });
    log({ op: 'undo-create-playlist', of: entry.at, playlistId: entry.playlistId });
    return { removed: entry.playlistName };
  }
  throw new Error(`Cannot undo "${entry.op}"`);
}

/**
 * Undo every undoable entry sharing a txn, newest first, as one unit — this
 * is what makes a two-step move (add then remove) reversible with one click.
 */
export async function undoTxn(txn) {
  // `e.txn ?? e.at` lets a log entry written before txns existed fall back to
  // its own timestamp as a group of one, instead of matching every other
  // txn-less entry in the log.
  const entries = history(2000).filter(e => (e.txn ?? e.at) === txn && e.undoable);
  if (!entries.length) throw new Error('No such action in the log');
  const results = [];
  for (const entry of entries) results.push({ entry, result: await undo(entry) });
  log({ op: 'undo-txn', of: txn, ops: entries.map(e => e.op) });
  return { txn, undone: results };
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

/**
 * Audition a track on the user's active device. This replaces whatever
 * playback context was active — Spotify's Web API has no "preview without
 * disturbing the queue" call; that needs the Web Playback SDK (tracked as a
 * future upgrade) to make this app its own device instead of hijacking one.
 */
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
