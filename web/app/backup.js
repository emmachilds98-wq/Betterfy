/* ---------- your data: backup, restore and wipe (BUILD-6 F7, F8) ----------
 * Settings › Listening and genre sources › Your data (screens/sources.mjs
 * draws it). Three things, none of which sends anything anywhere new:
 *
 *   Back up     a JSON file of your own playlists, built from the library copy
 *               the page already holds (plus one read of /me/playlists for the
 *               descriptions), saved to your device by the browser. No upload.
 *   Restore     read such a file, show what is in it and which of those
 *               playlists you still have, then make the picked ones as new
 *               private playlists: tracks added by id, by ISRC when an id no
 *               longer resolves. One History group, so one Undo. An existing
 *               playlist is never written to: ticking one that still exists
 *               makes a new "(restored)" copy beside it.
 *   Wipe        everything in DATA_KEYS (app/datakeys.js) on this device,
 *               except the theme, then back to the landing screen.
 *
 * The pieces that do the work take their dependencies as arguments, so
 * test/backup.test.mjs runs them against the fake Spotify server. */

const BACKUP_FORMAT = 'betterfy-playlists';
const BACKUP_VERSION = 1;
const BACKUP_LIMITS = { playlists: 2000, tracks: 11000 };   // a Spotify playlist holds at most 10,000
const RESTORED_SUFFIX = ' (restored)';

/** What the Your data section shows: idle | preview | working | done | error. */
const BK = { stage: 'idle', plan: null, file: '', progress: '', result: null, error: '', wipe: false, made: new Set() };

/**
 * The backup file for `lib` (the page's LIB: your own playlists only).
 * @param descriptions {id: description} when known; a playlist without one gets ''.
 */
function backupBuild(lib, descriptions = {}, now = new Date()) {
  return {
    format: BACKUP_FORMAT, version: BACKUP_VERSION, exported_at: now.toISOString(),
    user: { id: lib?.user?.id ?? null, name: lib?.user?.name ?? null },
    playlists: (lib?.playlists ?? []).map(p => ({
      id: p.id, name: p.name ?? '', description: descriptions[p.id] ?? '',
      tracks: (p.tracks ?? []).map(t => ({
        id: t.id ?? null, isrc: t.isrc ?? null, added_at: t.added_at ?? null,
        name: t.name ?? '', artists: (t.artists ?? []).map(a => a.name).filter(Boolean),
      })),
    })),
  };
}

const BK_ID_RE = /^[A-Za-z0-9]{22}$/, BK_ISRC_RE = /^[A-Za-z0-9]{12}$/;
const bkStr = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Read a backup file's text. Throws a sentence a listener can act on; keeps only the fields it knows. */
function backupParse(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error('That file is not a Betterfy backup (it is not JSON).'); }
  if (raw?.format !== BACKUP_FORMAT || !Array.isArray(raw.playlists))
    throw new Error('That file is not a Betterfy playlist backup.');
  if (!(raw.version >= 1 && raw.version <= BACKUP_VERSION))
    throw new Error('That backup was made by a newer Betterfy. Reload the page to update, then try again.');
  if (raw.playlists.length > BACKUP_LIMITS.playlists) throw new Error('That backup holds more playlists than Betterfy can restore at once.');
  return {
    format: BACKUP_FORMAT, version: raw.version, exported_at: bkStr(raw.exported_at, 40),
    user: { id: bkStr(raw.user?.id, 200) || null, name: bkStr(raw.user?.name, 200) || null },
    playlists: raw.playlists.map(p => ({
      id: bkStr(p?.id, 64), name: bkStr(p?.name, 100).trim() || 'Untitled', description: bkStr(p?.description, 300),
      tracks: (Array.isArray(p?.tracks) ? p.tracks : []).slice(0, BACKUP_LIMITS.tracks).map(t => ({
        id: BK_ID_RE.test(t?.id ?? '') ? t.id : null, isrc: BK_ISRC_RE.test(t?.isrc ?? '') ? t.isrc.toUpperCase() : null,
        added_at: bkStr(t?.added_at, 40) || null, name: bkStr(t?.name, 200),
        artists: Array.isArray(t?.artists) ? t.artists.filter(a => typeof a === 'string').slice(0, 10) : [],
      })),
    })),
  };
}

const plKey = s => String(s ?? '').trim().toLowerCase();

/**
 * One row per playlist in the backup: does it still exist (same id, or a
 * playlist of yours with the same name), and is it picked? Existing ones
 * start unticked.
 * @param current [{id, name}] the playlists you have now
 */
function restorePlan(backup, current = []) {
  const ids = new Set(current.map(p => p.id)), names = new Set(current.map(p => plKey(p.name)));
  return backup.playlists.map((src, i) => {
    const exists = ids.has(src.id) || names.has(plKey(src.name));
    return { i, src, name: src.name, n: src.tracks.length, usable: src.tracks.filter(t => t.id || t.isrc).length,
             exists, pick: !exists };
  });
}

/** Spotify's answer to a batch holding an id it cannot add (a removed track, a bad id). */
const isBadIdError = e => e?.status === 400 || /^400\b/.test(e?.message ?? '');

/**
 * Add `tracks` ([{id, isrc}]) to playlist `plId`, in order: by id, a hundred at
 * a time; a batch Spotify refuses is halved until the one track it refuses is
 * found, and that one is looked up by ISRC. Returns { ids, byIsrc, missing }:
 * the ids that landed, how many came from the ISRC lookup, and how many could
 * not be placed at all.
 */
async function restoreAdd(plId, tracks, { addChunk, findIsrc }) {
  const out = { ids: [], byIsrc: 0, missing: 0 };
  const viaIsrc = async t => {
    const id = t.isrc ? await findIsrc(t.isrc).catch(() => null) : null;
    if (!id || id === t.id) { out.missing++; return; }
    try { await addChunk(plId, [id]); out.ids.push(id); out.byIsrc++; }
    catch (e) { if (!isBadIdError(e)) throw e; out.missing++; }
  };
  const tryIds = async run => {
    try { await addChunk(plId, run.map(t => t.id)); out.ids.push(...run.map(t => t.id)); }
    catch (e) {
      if (!isBadIdError(e)) throw e;
      if (run.length === 1) return viaIsrc(run[0]);
      const h = Math.ceil(run.length / 2);
      await tryIds(run.slice(0, h)); await tryIds(run.slice(h));
    }
  };
  // Runs of tracks with an id go in batches; one with only an ISRC is looked up where it stands.
  let run = [];
  const flush = async () => { for (let k = 0; k < run.length; k += 100) await tryIds(run.slice(k, k + 100)); run = []; };
  for (const t of tracks) {
    if (t.id) { run.push(t); continue; }
    await flush();
    await viaIsrc(t);
  }
  await flush();
  return out;
}

/**
 * Make every picked row of `plan` as a new private playlist and fill it.
 * Each playlist is one `add` entry in History, all under one group, so a
 * single Undo takes the whole restore back.
 * @param deps { sp, addChunk, findIsrc, logAction, newGroup, onProgress? }
 */
async function restoreRun(plan, deps) {
  const group = deps.newGroup();
  const made = [];
  const picked = plan.filter(r => r.pick);
  for (const [k, r] of picked.entries()) {
    deps.onProgress?.(r.name, k / picked.length);
    const name = r.exists ? (r.name + RESTORED_SUFFIX).slice(0, 100) : r.name;
    const pl = await deps.sp('/me/playlists', { method: 'POST',
      body: JSON.stringify({ name, public: false, description: r.src.description || '' }) });
    const row = { id: pl.id, name, from: r.src.id, n: r.n, added: 0, byIsrc: 0, missing: 0, at: null };
    made.push(row);
    let got = { ids: [], byIsrc: 0, missing: 0 }, err = null;
    try { got = await restoreAdd(pl.id, r.src.tracks, deps); } catch (e) { err = e; }
    Object.assign(row, { added: got.ids.length, byIsrc: got.byIsrc, missing: got.missing + (r.n - r.usable) });
    // Logged even when the fill broke half way: the playlist exists, so Undo must know about it.
    row.at = await deps.logAction({ op: 'add', group, playlistId: pl.id, playlistName: name, trackIds: got.ids,
      created: true, reason: 'restored from backup' });
    if (err) { err.made = made; err.group = group; throw err; }
  }
  return { group, made };
}

/** Take a whole restore back: every track out (History's undo), then the playlists themselves. */
async function restoreUndoRun(group, { getLog, undoAction, sp }) {
  const steps = (await getLog()).filter(x => x.group === group && x.op === 'add');
  if (!steps.length) throw new Error('That restore is no longer in History.');
  await undoAction(steps[steps.length - 1].at).catch(e => { if (!/Already undone/.test(e.message)) throw e; });
  // DELETE /me/library with the playlist's URI is Spotify's "delete" for a playlist you own
  // (the old /followers route was removed in February 2026).
  for (const s of steps) await sp(`/me/library?uris=spotify:playlist:${s.playlistId}`, { method: 'DELETE' });
}

/**
 * Everything Betterfy keeps on this device, gone, except the theme: every
 * localStorage key DATA_KEYS lists (a prefix takes its whole family), any
 * other bf_* key left by an older build, the sign-in code in sessionStorage,
 * the "betterfy" key store, and the listening database.
 * @param env { LS, local, session, idb, indexedDB, keys }
 */
async function wipeRun({ LS, local, session, idb, indexedDB, keys = DATA_KEYS }) {
  const keep = new Set(keys.filter(k => k.keep).map(k => k.key));
  const present = [];
  try { for (let i = 0; i < (local?.length ?? 0); i++) present.push(local.key(i)); } catch { /* storage refused */ }
  const gone = new Set();
  for (const k of keys) {
    if (k.where !== 'local' || k.keep) continue;
    if (k.prefix) for (const p of present) { if (p?.startsWith(k.key) && !keep.has(p)) gone.add(p); }
    else gone.add(k.key);
  }
  for (const p of present) if (p?.startsWith('bf_') && !keep.has(p)) gone.add(p);
  for (const k of gone) { try { LS.removeItem(k); } catch {} try { local?.removeItem(k); } catch {} }
  try { session?.removeItem('bf_verifier'); } catch {}
  try { await idb.clear(); } catch {}
  // A database this page still has open blocks its deletion until the page
  // goes; the reload that follows closes it, and the deletion then completes.
  for (const k of keys) if (k.where === 'idb-db' && k.key !== 'betterfy') {
    await new Promise(done => {
      let r = null;
      try { r = indexedDB?.deleteDatabase(k.key); } catch { r = null; }
      if (!r) return done();
      r.onsuccess = r.onerror = r.onblocked = () => done();
      setTimeout(done, 1500);
    });
  }
  return [...gone];
}

/* ---- the page side: Settings › Your data ---- */

const bkRedraw = () => { try { render(); } catch { /* before the app is up */ } };

/** Save the backup file to this device. */
async function backupDownload() {
  if (!LIB?.playlists?.length) { toast('No playlists of yours to back up yet.'); return; }
  let desc = {};
  try {
    for (const p of await paged('/me/playlists?limit=50'))
      if (p?.id && p.owner?.id === LIB.user?.id && p.description) desc[p.id] = p.description;
  } catch { desc = {}; /* names and tracks still go in; descriptions are a nicety */ }
  const file = backupBuild(LIB, desc);
  const blob = new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `betterfy-playlists-${file.exported_at.slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  const n = file.playlists.reduce((s, p) => s + p.tracks.length, 0);
  toast(`Saved ${file.playlists.length} playlists (${n.toLocaleString()} tracks) to this device.`);
}

/** A file was picked: read it and show what restoring it would do. */
async function restoreStart(file) {
  if (!file) return;
  BK.wipe = false; BK.result = null; BK.error = '';
  try {
    if (file.size > 50e6) throw new Error('That file is too big to be a Betterfy backup.');
    const backup = backupParse(await file.text());
    const current = [...(LIB?.playlists ?? []).map(p => ({ id: p.id, name: p.name })), ...[...BK.made].map(name => ({ id: '', name }))];
    Object.assign(BK, { stage: 'preview', file: file.name ?? 'backup', backup, plan: restorePlan(backup, current) });
  } catch (e) { Object.assign(BK, { stage: 'error', error: e.message, plan: null }); }
  bkRedraw();
}

async function restoreGo() {
  if (BK.stage !== 'preview' || !BK.plan?.some(r => r.pick)) return;
  BK.stage = 'working'; BK.progress = 'Starting…'; bkRedraw();
  const deps = { sp, addChunk, logAction, newGroup,
    findIsrc: async isrc => (await sp(`/search?q=${encodeURIComponent('isrc:' + isrc)}&type=track&limit=1`))?.tracks?.items?.[0]?.id ?? null,
    onProgress: (name, f) => { BK.progress = `Making “${name}” (${Math.round(f * 100)}%)`; bkRedraw(); } };
  try {
    const res = await restoreRun(BK.plan, deps);
    res.made.forEach(m => BK.made.add(m.name));
    Object.assign(BK, { stage: 'done', result: res, plan: null });
    const n = res.made.reduce((s, m) => s + m.added, 0);
    toast(`Restored ${res.made.length} playlists, ${n.toLocaleString()} tracks, as private playlists.`, () => restoreUndo());
  } catch (e) {
    (e.made ?? []).forEach(m => BK.made.add(m.name));
    Object.assign(BK, { stage: 'error', error: 'Restore stopped: ' + e.message + (e.made?.length ? ' What was made so far is in History, with Undo.' : ''),
      result: e.made?.length ? { group: e.group, made: e.made } : null, plan: null });
  }
  bkRedraw();
}

async function restoreUndo() {
  const g = BK.result?.group;
  if (!g) return;
  try {
    await restoreUndoRun(g, { getLog, undoAction, sp });
    BK.result.made.forEach(m => BK.made.delete(m.name));
    Object.assign(BK, { stage: 'idle', result: null });
    toast('Restore undone: the restored playlists are gone.');
  } catch (e) { toast('Undo failed: ' + e.message); }
  bkRedraw();
}

function restoreCancel() { Object.assign(BK, { stage: 'idle', plan: null, backup: null, error: '' }); bkRedraw(); }

async function wipeThisDevice() {
  await wipeRun({ LS, idb, keys: DATA_KEYS,
    local: (() => { try { return window.localStorage; } catch { return null; } })(),
    session: (() => { try { return window.sessionStorage; } catch { return null; } })(),
    indexedDB: (() => { try { return window.indexedDB; } catch { return null; } })() });
  location.replace(REDIRECT);
}

// The Sources section is given these on top of what screens.js lists for it.
if (typeof SCREEN_CTX !== 'undefined' && SCREEN_CTX.sources) {
  const base = SCREEN_CTX.sources;
  SCREEN_CTX.sources = () => Object.assign(base(), {
    BK, DATA_KEYS, DATA_SERVICES, backupDownload, restoreGo, restoreUndo, restoreCancel, wipeThisDevice,
    myPlaylists: () => LIB?.playlists?.length ?? 0,
  });
}

// A file input fires `change`, which dispatchAct() leaves to checkboxes and
// selects, so the restore picker is wired here.
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('change', e => {
  if (e.target?.id !== 'bkFile') return;
  const f = e.target.files?.[0];
  e.target.value = '';
  fire(restoreStart(f));
});
