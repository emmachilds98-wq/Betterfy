/* ---------- offline: the cached shell and the decision queue (BUILD-6 F6) ----------
 * Two things, both for a listener on a train:
 *
 * 1. The service worker (web/sw.js, built to docs/sw.js) keeps the page's shell
 *    so a reload with no signal opens the app, not a browser error. It is
 *    registered here, and a new one found waiting is offered through the
 *    existing update bar (version.js's checkForUpdate), never forced.
 *
 * 2. Decisions made with no connection (File's filings and unlikes, Tidy's
 *    removals and moves) are kept in IndexedDB instead of failing, and applied
 *    once each when the page is next open and online. Not Background Sync: iOS
 *    Safari and Firefox have none, so it could not be promised to everyone.
 *
 * How the queue sits on the existing write path, without touching it: the
 * writes in actionlog.js (addTracks, plDelete, libraryCall) are wrapped. With
 * no connection a write is queued and returns as if it had gone through, so the
 * screen carries on exactly as it does online and its History entry is written
 * as usual, marked `queued` until the write lands. Replay re-reads each
 * playlist and sends only what is still missing (or still there, for a
 * removal), so a decision is applied once however often replay runs. Undoing a
 * decision that has not been sent yet just takes it out of the queue. */

const OFFLINE_QUEUE = 'offline_queue';
const OFFLINE = { n: 0, busy: false, unlogged: [], reg: null };
const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
/** A failure that is the connection, not Spotify saying no (auth.js: NET_LOST is status 0). */
const lostNet = e => !!e && e.status === 0;
const queueRead = async () => (await idb.get(OFFLINE_QUEUE)) ?? [];
async function queueWrite(q) { await idb.set(OFFLINE_QUEUE, q); offlineShow(q.length); }

async function enqueue(item) {
  const q = await queueRead();
  const it = { id: 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), queuedAt: new Date().toISOString(), ...item };
  q.push(it);
  await queueWrite(q);
  OFFLINE.unlogged.push(it);
  return it;
}

/* The originals, for replay and for anything online. */
const ONLINE_WRITE = { addTracks, plDelete, libraryCall, playlistIds, logAction, undoAction };

/** Send it now, or keep it: with no connection, or when the connection drops
 *  under the write (replay re-reads first, so a write that did land is not repeated). */
async function sendOrKeep(item, send) {
  if (isOffline()) { await enqueue(item); return null; }
  try { return await send(); }
  catch (e) { if (!lostNet(e)) throw e; await enqueue(item); return null; }
}

addTracks = function (id, ids) {
  return sendOrKeep({ op: 'add', playlistId: id, trackIds: [...ids] }, () => ONLINE_WRITE.addTracks(id, ids));
};
// Only plain `{ uri }` removals (Tidy's): a removal by position (the shuffle's
// prune) depends on a snapshot that will be stale by the time it is replayed.
plDelete = function (id, objs) {
  if (!objs.every(o => o && Object.keys(o).length === 1 && /^spotify:track:/.test(o.uri))) return ONLINE_WRITE.plDelete(id, objs);
  return sendOrKeep({ op: 'remove', playlistId: id, trackIds: objs.map(o => o.uri.slice(14)) }, () => ONLINE_WRITE.plDelete(id, objs));
};
libraryCall = function (method, ids) {
  if (method !== 'DELETE') return ONLINE_WRITE.libraryCall(method, ids);
  return sendOrKeep({ op: 'unlike', trackIds: [...ids] }, () => ONLINE_WRITE.libraryCall(method, ids));
};
// Tidy reads a playlist before a removal, for the positions undo puts tracks
// back at. Offline, the library this device already holds is that read.
playlistIds = async function (id) {
  if (isOffline()) {
    const p = (typeof LIB !== 'undefined' && LIB?.playlists || []).find(x => x.id === id);
    if (p) return (p.tracks ?? []).map(t => t?.id).filter(Boolean);
  }
  return ONLINE_WRITE.playlistIds(id);
};

const sameIds = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
/** The History entry for a queued write is written as usual, marked `queued`. */
logAction = async function (entry) {
  const i = OFFLINE.unlogged.findIndex(it => it.op === entry.op && sameIds(it.trackIds, entry.trackIds ?? [])
                                         && (it.op === 'unlike' || it.playlistId === entry.playlistId));
  if (i < 0) return ONLINE_WRITE.logAction(entry);
  const [it] = OFFLINE.unlogged.splice(i, 1);
  const at = await ONLINE_WRITE.logAction({ ...entry, queued: it.id });
  const q = await queueRead(), hit = q.find(x => x.id === it.id);
  if (hit) { hit.at = at; await queueWrite(q); }
  return at;
};

/** Undo of a decision still in the queue: drop it from the queue rather than
 *  reversing a write Spotify never saw. Anything already sent is undone as before. */
undoAction = async function (at) {
  const log = (await idb.get('actions')) ?? [];
  const e = log.find(x => x.at === at);
  const steps = !e ? [] : e.group ? log.filter(x => x.group === e.group && x.op !== 'undo') : [e];
  const q = await queueRead(), waiting = new Set(q.map(x => x.id));
  const held = steps.filter(x => x.queued && waiting.has(x.queued) && !isUndone(x, log));
  if (!held.length) return ONLINE_WRITE.undoAction(at);
  const drop = new Set(held.map(x => x.queued));
  await queueWrite(q.filter(x => !drop.has(x.id)));
  const when = new Date().toISOString();
  for (const x of log) if (held.includes(x)) x.undoneAt = when;
  await idb.set('actions', log);
  const rest = steps.filter(x => !held.includes(x) && !isUndone(x, log));
  if (rest.length) return ONLINE_WRITE.undoAction(rest[0].at);
  const mv = steps.find(x => x.move)?.move;
  if (mv && typeof unrecordMove === 'function') await unrecordMove(mv.trackId, mv.from, mv.to).catch(() => {});
  await ONLINE_WRITE.logAction({ op: 'undo', of: at, ...(e.group ? { ofGroup: e.group } : {}), playlistId: e.playlistId, trackIds: e.trackIds });
};

/** Send one queued decision, sending only what Spotify does not hold yet. */
async function replayOne(it) {
  if (it.op === 'unlike') return ONLINE_WRITE.libraryCall('DELETE', it.trackIds);
  const have = new Set(await ONLINE_WRITE.playlistIds(it.playlistId));
  if (it.op === 'add') {
    const missing = it.trackIds.filter(x => !have.has(x));
    if (missing.length) await ONLINE_WRITE.addTracks(it.playlistId, missing);
  } else if (it.op === 'remove') {
    const there = it.trackIds.filter(x => have.has(x));
    if (there.length) await ONLINE_WRITE.plDelete(it.playlistId, there.map(x => ({ uri: 'spotify:track:' + x })));
  }
}

/** Mark the History entry: sent (or, for one Spotify refused, why not). */
async function settleLog(it, patch) {
  if (!it.at) return;
  const log = (await idb.get('actions')) ?? [];
  const hit = log.find(x => x.at === it.at && x.queued === it.id);
  if (!hit) return;
  delete hit.queued;
  Object.assign(hit, patch);
  await idb.set('actions', log);
}

/** Apply every queued decision, oldest first, once each. Stops at the first
 *  connection failure and keeps the rest for next time. */
async function replayQueue() {
  if (OFFLINE.busy || isOffline()) return 0;
  if (typeof token === 'function') { try { if (!(await token())) return 0; } catch { return 0; } }
  OFFLINE.busy = true;
  let sent = 0;
  const refused = [];
  try {
    for (;;) {
      const q = await queueRead();
      const it = q[0];
      if (!it || isOffline()) break;
      try {
        await replayOne(it);
        await settleLog(it, { syncedAt: new Date().toISOString() });
        sent++;
      } catch (e) {
        if (lostNet(e) || e.status === 429 || e.status >= 500 || isOffline()) break;
        // Spotify said no (a playlist deleted since, say): it never will say
        // yes, so it leaves the queue, and History says why.
        refused.push(it);
        await settleLog(it, { syncFailed: e.message });
      }
      const now = await queueRead();
      await queueWrite(now.filter(x => x.id !== it.id));
    }
  } finally { OFFLINE.busy = false; }
  if (sent) toast(`Synced ${sent} ${sent === 1 ? 'decision' : 'decisions'} made offline.`);
  if (refused.length) toast(`Spotify refused ${refused.length} ${refused.length === 1 ? 'decision' : 'decisions'} made offline. History says which.`);
  return sent;
}

/** The "N decisions waiting to sync" line. Drawn on its own, outside every screen. */
function offlineShow(n) {
  OFFLINE.n = n;
  if (typeof document === 'undefined') return;
  let el = document.getElementById('syncWait');
  if (!n) { if (el) el.hidden = true; return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'syncWait'; el.className = 'syncwait'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.hidden = false;
  el.textContent = `${n} ${n === 1 ? 'decision' : 'decisions'} waiting to sync` + (isOffline() ? ' · offline' : '');
}

/* ---------- the service worker ---------- */
async function swRegister() {
  const sw = typeof navigator !== 'undefined' && navigator.serviceWorker;
  if (!sw || !/^https?:$/.test(location.protocol)) return;
  try {
    const hadOne = !!sw.controller;
    const reg = OFFLINE.reg = await sw.register('sw.js', { scope: './' });
    // A worker from another build has taken over (offline.js's sw.js skips
    // waiting): offer the newer page with the bar version.js already has.
    sw.addEventListener('message', ev => {
      const m = ev.data || {};
      if (m.type === 'bf-sw' && m.build && m.build !== BUILD && hadOne) checkForUpdate(true).catch(() => {});
    });
    reg.addEventListener('updatefound', () => { if (hadOne) setTimeout(() => checkForUpdate(true).catch(() => {}), 500); });
    // "Update now" deletes every cache; ask for the shell back.
    (await sw.ready).active?.postMessage({ type: 'warm' });
  } catch { /* no worker: the page works exactly as it did without one */ }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('online', () => { offlineShow(OFFLINE.n); replayQueue().catch(() => {}); });
  window.addEventListener('offline', () => offlineShow(OFFLINE.n));
  window.addEventListener('load', () => {
    swRegister();
    queueRead().then(q => offlineShow(q.length)).catch(() => {});
    // Open and online: whatever was decided offline goes now.
    setTimeout(() => replayQueue().catch(() => {}), 1500);
  });
}
