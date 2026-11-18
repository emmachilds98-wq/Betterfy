/* ---------- action log: every library change, reversible ---------- */
// Entries are found again by `at`, so two written in the same millisecond (a
// move's two steps on a fast connection) must not share one: a clash is
// nudged a millisecond past the newest entry. Returns the entry's `at`.
//
// `group` ties entries that are one action to the user — a move is an add
// and a remove — so undoAction() reverses them together and History shows
// them as one row.
async function logAction(entry) {
  const log = (await idb.get('actions')) ?? [];
  let at = new Date().toISOString();
  const last = log.at(-1)?.at;
  if (last && at <= last) at = new Date(Date.parse(last) + 1).toISOString();
  log.push({ at, ...entry });
  // Skips (BUILD-6 D2) are lightweight entries for the queue measure only: kept
  // in their own, smaller allowance so they can never push real changes out.
  const real = log.filter(x => x.op !== 'skip').slice(-500), skips = log.filter(x => x.op === 'skip').slice(-300);
  await idb.set('actions', log.length > 500 ? [...real, ...skips].sort((a, b) => (a.at < b.at ? -1 : 1)) : log);
  return at;
}
/** Newest first. Skips are the queue measure's, not History's, so they are
 *  left out unless asked for (`{ all: true }`). */
const getLog = async ({ all = false } = {}) =>
  ((await idb.get('actions')) ?? []).filter(x => all || x.op !== 'skip').reverse();
const newGroup = () => 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** True once an entry has been undone: `undoneAt` on the entry, or (for a log
 *  written before that existed) an `undo` entry pointing at it. */
const isUndone = (x, log) => !!x.undoneAt || log.some(u => u.op === 'undo' && u.of === x.at);

/**
 * Undo the entry logged at `at` — and, when it belongs to a group, every step
 * of that group, newest first, so a move comes back out whole: the remove is
 * reversed (the track goes back where it was, at its position), then the add
 * (it leaves the playlist it was moved to). Each step is marked `undoneAt` as
 * it succeeds, so a half-finished undo can be finished later and a finished
 * one is never offered or run again.
 */
async function undoAction(at) {
  const log = (await idb.get('actions')) ?? [];
  const e = log.find(x => x.at === at);
  if (!e) throw new Error('Not in the log any more');
  const steps = e.group ? log.filter(x => x.group === e.group && x.op !== 'undo') : [e];
  const todo = steps.filter(x => !isUndone(x, log));
  if (!todo.length) throw new Error('Already undone');
  for (const s of [...todo].reverse()) {
    await undoStep(s);
    const now = (await idb.get('actions')) ?? [];
    const hit = now.find(x => x.at === s.at);
    if (hit) { hit.undoneAt = new Date().toISOString(); await idb.set('actions', now); }
  }
  // A move also told the sound learner "here, not there"; undoing it takes that back.
  const mv = steps.find(x => x.move)?.move;
  if (mv && typeof unrecordMove === 'function') await unrecordMove(mv.trackId, mv.from, mv.to).catch(() => {});
  await logAction({ op:'undo', of:at, ...(e.group ? { ofGroup:e.group } : {}), playlistId:e.playlistId,
                    ...(mv ? { playlistName:`${mv.fromName ?? mv.from} → ${mv.toName ?? mv.to}` } : {}),
                    trackIds:e.trackIds });
}

/** Reverse one logged step against Spotify. */
async function undoStep(e) {
  if (e.op === 'remove') {
    await addTracks(e.playlistId, e.trackIds);
    // put each track back at the index it came from, rather than at the end
    for (const [id, idxs] of Object.entries(e.positions ?? {})) {
      for (const target of idxs) {
        const now = await playlistIds(e.playlistId);
        const from = now.indexOf(id);
        if (from >= 0 && from !== target)
          await plCall(e.playlistId, 'PUT', { range_start:from, insert_before:target, range_length:1 });
      }
    }
  } else if (e.op === 'add') {
    await delTracks(e.playlistId, e.trackIds);
    // a playlist this entry created (a backup restore) goes too, so undoing
    // from History leaves no empty playlist behind
    if (e.created) await sp(`/me/library?uris=spotify:playlist:${e.playlistId}`, { method: 'DELETE' });
  } else if (e.op === 'unlike') {
    await libraryCall('PUT', e.trackIds);
  } else if (e.op === 'like') {
    await libraryCall('DELETE', e.trackIds);
  } else if (e.op === 'rename') {
    await setPlaylistName(e.playlistId, e.from);
  } else throw new Error(`Cannot undo "${e.op}"`);
}

/**
 * Rename one of your playlists (Library's "Name" section): on Spotify, in the
 * library this page holds, and in History, where Undo puts the old name back.
 * Returns the History entry's `at`, or null when the name did not change.
 */
async function renamePlaylist(id, name, { reason = 'renamed' } = {}) {
  const to = String(name ?? '').trim().slice(0, 100);
  const p = LIB?.playlists?.find(x => x.id === id);
  if (!p) throw new Error('Not one of your playlists');
  if (!to) throw new Error('A playlist needs a name');
  const from = p.name;
  if (to === from) return null;
  await setPlaylistName(id, to);
  return logAction({ op:'rename', playlistId:id, playlistName:to, from, to, trackIds:[], reason });
}
/** PUT /playlists/{id} with a new name, then the same name here: the held library and the playlist's settings. */
async function setPlaylistName(id, name) {
  await sp(`/playlists/${id}`, { method:'PUT', body:JSON.stringify({ name }) });
  const p = LIB?.playlists?.find(x => x.id === id);
  if (p) p.name = name;
  if (typeof CFG !== 'undefined' && CFG?.[id]) CFG[id].name = name;
  try { if (LIB) await idb.set('library', LIB); } catch { /* kept for this session; the next read has it */ }
}

/**
 * Every slot in a playlist, in order: `{ id, isrc, pos }`.
 *
 * Both extras matter and neither is cosmetic. **Relinking**: Spotify swaps a
 * track for whichever pressing is playable in your market, so the id you POST
 * is often not the id you read back. The original used to come home under
 * `linked_from`, which Spotify removed from track objects in February 2026, so
 * a relinked track is now recognised by its ISRC — the recording's own id,
 * the same under either pressing (`external_ids`, restored in March 2026).
 * Matching on the visible id alone meant a relinked track looked missing on
 * every single refresh and was added again each time, which is exactly the
 * "it keeps re-adding what I already have" complaint.
 * **Positions**: a local file or a track pulled from Spotify entirely has no
 * id at all, and it still occupies a slot — so unusable items are kept as
 * blanks rather than skipped, otherwise every position after one of them is
 * off by one and a delete-by-position removes the wrong track.
 */
async function playlistEntries(id) {
  const out = [];
  let page = await sp(`/playlists/${id}/items?limit=100&fields=next,items(item(id,external_ids(isrc)))`);
  while (page) {
    for (const i of page.items ?? []) {
      const it = i.item ?? i.track;
      out.push({ id: it?.id ?? null, isrc: it?.external_ids?.isrc ?? null, pos: out.length });
    }
    if (!page.next) break;
    page = await sp(page.next);
  }
  return out;
}

async function playlistIds(id) {
  return (await playlistEntries(id)).map(e => e.id).filter(Boolean);
}

const chunk = (a,n) => Array.from({length:Math.ceil(a.length/n)},(_,i)=>a.slice(i*n,i*n+n));
async function plCall(id, method, body) {
  for (const seg of ['items','tracks']) {
    try { return await sp(`/playlists/${id}/${seg}`, { method, body:JSON.stringify(body) }); }
    catch (e) { if (!/^40[34]/.test(e.message) || seg === 'tracks') throw e; }
  }
}
/** Add one chunk. If the answer was lost (dropped, 5xx) the write may still have
 *  landed, so re-read the playlist and send only what is missing: no duplicates. */
async function addChunk(id, c) {
  const post = xs => plCall(id, 'POST', { uris: xs.map(x => 'spotify:track:' + x) });
  try { return await post(c); }
  catch (e) {
    if (!e.ambiguous) throw e;
    const have = new Set(await playlistIds(id));
    const missing = c.filter(x => !have.has(x));
    return missing.length ? post(missing) : null;
  }
}
async function addTracks(id, ids) {
  const out = [];
  for (const c of chunk(ids, 100)) out.push(await addChunk(id, c));   // one after another: no race on a snapshot
  return out;
}
/** Which of `ids` are really in the playlist now (null when it cannot be read). */
async function landedIn(id, ids) {
  try { const have = new Set(await playlistIds(id)); return ids.filter(x => have.has(x)); }
  catch { return null; }
}
/**
 * DELETE /playlists/{id}/items, for up to 100 `{ uri }` objects at a time.
 * Spotify's reference now documents the body as `{ items: [{ uri }] }`, max
 * 100; the old `{ tracks: [...] }` body is sent only if that one is refused
 * with a 400, for an endpoint that still wants the legacy form. Sent one
 * chunk after another, never in parallel, so no request races another's
 * snapshot.
 */
async function plDelete(id, objs) {
  let out = null;
  for (const part of chunk(objs, 100)) {
    try { out = await plCall(id, 'DELETE', { items: part }); }
    catch (e) { if (e.status !== 400 && !/^400/.test(e.message)) throw e; out = await plCall(id, 'DELETE', { tracks: part }); }
  }
  return out;
}
const delTracks = (id, ids) => plDelete(id, ids.map(x => ({ uri:'spotify:track:'+x })));

/** Spotify replaced PUT/DELETE /me/tracks?ids= with /me/library?uris= for a
 *  client ID created after Feb 2026; this page's own grandfathered id still
 *  serves the old form, so try the new path first and fall back like plCall
 *  does above for playlists. */
async function libraryCall(method, ids) {
  const uris = ids.map(x => 'spotify:track:' + x).join(',');
  try { return await sp('/me/library?uris=' + uris, { method }); }
  catch (e) { if (!/^40[34]/.test(e.message)) throw e; return await sp('/me/tracks?ids=' + ids.join(','), { method }); }
}

