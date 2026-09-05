// Every mutation to the Spotify library goes through here, and every mutation
// is written to an append-only log first. Given how carefully this library has
// been curated by hand, nothing should be irreversible.
//
// Related mutations are grouped into a transaction, so an operation that takes
// more than one API call — a move is an add plus a remove — is undone as the
// single thing the user thinks it is, rather than half of it.
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { api } from './spotify.mjs';

const LOG = 'actions.log.jsonl';

let currentTxn = null;

/**
 * Group everything `fn` logs under one transaction id.
 * `label` is what the History view shows for the group.
 */
export async function transaction(label, fn) {
  const outer = currentTxn;
  // Nested calls join the transaction already open rather than starting one.
  currentTxn = outer ?? { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, label };
  try {
    return await fn();
  } finally {
    currentTxn = outer;
  }
}

export function log(entry) {
  const row = { at: new Date().toISOString(), ...entry };
  if (currentTxn) { row.txn = currentTxn.id; row.txnLabel = currentTxn.label; }
  appendFileSync(LOG, JSON.stringify(row) + '\n');
  return row;
}

function readLog() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/** Raw log entries, newest first. */
export function history(limit = 200) {
  return readLog().slice(-limit).reverse();
}

/**
 * The log as the user thinks of it: one row per transaction, newest first.
 * A row is undoable when every step in it is and nothing has already
 * reversed it.
 */
export function historyGrouped(limit = 200) {
  const entries = readLog();
  // What has already been undone: an undo names the transaction, or for an
  // ungrouped step the timestamp, it reversed.
  const undoneTxns = new Set(), undoneAts = new Set();
  for (const e of entries) {
    if (!e.op.startsWith('undo')) continue;
    if (e.ofTxn) undoneTxns.add(e.ofTxn);
    if (e.of) undoneAts.add(e.of);
  }

  const rows = [];
  const byTxn = new Map();
  for (const e of entries) {
    if (e.op.startsWith('undo')) {
      rows.push({ at: e.at, op: 'undo', reason: e.ofTxn ?? e.of, steps: [e], undoable: false, trackIds: [] });
      continue;
    }
    if (!e.txn) {
      rows.push({ ...e, steps: [e], undoable: !!e.undoable && !undoneAts.has(e.at) });
      continue;
    }
    let row = byTxn.get(e.txn);
    if (!row) {
      row = { at: e.at, txn: e.txn, op: e.txnLabel ?? e.op, steps: [], undoable: !undoneTxns.has(e.txn) };
      byTxn.set(e.txn, row);
      rows.push(row);
    }
    row.steps.push(e);
    row.playlistName ??= e.playlistName;
    row.reason ??= e.reason;
    if (!e.undoable) row.undoable = false;
  }
  for (const r of rows) r.trackIds ??= [...new Set(r.steps.flatMap(s => s.trackIds ?? []))];
  return rows.slice(-limit).reverse();
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
 * Records every position each id occupied, so the removal can be undone in
 * place — Spotify's delete-by-uri takes out all copies, not just the first.
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
  // Sequential, not parallel: chunks appended concurrently arrive in whatever
  // order the network settles, which silently scrambles an ordered write.
  for (const part of chunk(trackIds, 100))
    await call(playlistId, 'POST', { uris: part.map(id => `spotify:track:${id}`) });
  log({ op: 'add', playlistId, playlistName, trackIds, reason, undoable: true });
  return { added: trackIds.length };
}

/**
 * Work out how to put removed tracks back where they were, given the playlist
 * as it stands now. Pure, so the index arithmetic is testable without a
 * network: re-added copies land at the end, then each walks back to its
 * recorded index, and the running order is simulated locally so the playlist
 * only has to be read once.
 *
 * Spotify's reorder takes `insert_before` as an index into the list *before*
 * the item is lifted out, so moving something later needs target + 1.
 */
export function planRestore(existingIds, positions) {
  const copies = [];
  for (const [id, idxs] of Object.entries(positions ?? {}))
    for (const target of idxs) copies.push({ id, target });
  copies.sort((a, b) => a.target - b.target);

  const order = existingIds.map(id => ({ id }));
  order.push(...copies);

  const moves = [];
  for (const c of copies) {
    // The playlist may have shrunk since the removal; a target past the end
    // just means "as late as it can go".
    const target = Math.min(c.target, order.length - 1);
    const from = order.indexOf(c);
    if (from === target) continue;
    moves.push({ from, insertBefore: from < target ? target + 1 : target });
    order.splice(from, 1);
    order.splice(target, 0, c);
  }
  return { ids: copies.map(c => c.id), moves, order: order.map(o => o.id) };
}

/** Reverse one logged step. */
async function undoStep(entry) {
  if (entry.op === 'remove') {
    const existing = (await snapshotPlaylist(entry.playlistId)).map(t => t.id);
    // Fall back to one copy per id for entries logged before positions existed.
    const positions = entry.positions ?? Object.fromEntries(entry.trackIds.map(id => [id, [existing.length]]));
    const plan = planRestore(existing, positions);
    for (const part of chunk(plan.ids, 100))
      await call(entry.playlistId, 'POST', { uris: part.map(id => `spotify:track:${id}`) });
    for (const m of plan.moves)
      await call(entry.playlistId, 'PUT', { range_start: m.from, insert_before: m.insertBefore, range_length: 1 });
    return { restored: plan.ids.length };
  }
  if (entry.op === 'add') {
    await call(entry.playlistId, 'DELETE', { tracks: entry.trackIds.map(id => ({ uri: `spotify:track:${id}` })) });
    return { removed: entry.trackIds.length };
  }
  if (entry.op === 'unlike') {
    await api(`/me/tracks?ids=${entry.trackIds.join(',')}`, { method: 'PUT' });
    return { reliked: entry.trackIds.length };
  }
  if (entry.op === 'like') {
    await api(`/me/tracks?ids=${entry.trackIds.join(',')}`, { method: 'DELETE' });
    return { unliked: entry.trackIds.length };
  }
  if (entry.op === 'create-playlist') {
    // A playlist can't be deleted over the API; unfollowing is how Spotify's
    // own clients remove one, and it disappears from the library the same way.
    await api(`/playlists/${entry.playlistId}/followers`, { method: 'DELETE' });
    return { removedPlaylist: entry.playlistName };
  }
  throw new Error(`Cannot undo "${entry.op}"`);
}

/**
 * Reverse a logged action. Given any step of a transaction, the whole
 * transaction comes back — in reverse order, so an add-then-remove move
 * unwinds without the track ever being in neither playlist.
 */
export async function undo(entry) {
  const steps = entry.txn
    ? readLog().filter(e => e.txn === entry.txn && !e.op.startsWith('undo'))
    : [entry];

  const results = [];
  for (const step of [...steps].reverse()) results.push(await undoStep(step));

  log({ op: 'undo', of: entry.at, ofTxn: entry.txn ?? null, steps: steps.length });
  return { undone: steps.length, results };
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
 * Audition a track on the user's device.
 * This replaces whatever is playing — `/me/player/play` with `uris` sets a new
 * context, it does not queue — so the UI has to say so.
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
