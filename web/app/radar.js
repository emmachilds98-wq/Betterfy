/* ---------- Release Radar: the in-app sync (docs/RELEASE-RADAR-PLAN.md phase 5) ----------
 * The sync is core/release/sync.mjs, loaded with the lazy engine bundle as
 * BetterfyRadar only when somebody presses Start, and run inside the page's own
 * machinery rather than around it: every request goes through sp(), so it is
 * paced, sits out short 429s, and stops with sp()'s own honest message when
 * Spotify's quota is gone. Everything it reads is banked in IndexedDB as it
 * lands (radar:artist:{id}, radar:release:{key}, radar:index), so a stop, a
 * locked phone or a closed tab costs nothing already read, and Start picks up
 * where it stopped. The rows show while it runs; the status line never calls a
 * partial radar complete (web/screens/radar.mjs).
 *
 * Library artists only, no new scope (BUILD-6-PLAN §2.3): the artist set is
 * LIB's credited artists plus the top-artist windows and recently played that
 * the existing scopes already read, ordered by the same listening weights.
 * Nothing here leaves the device but artist and album ids sent to Spotify. */
const RADAR = { rows: [], byKey: new Map(), index: null, loaded: false, loading: null, running: false,
                progress: null, stopped: null, err: null, filter: 'all', artist: null, q: '', shown: 60,
                dismissed: new Set(), olderFor: new Set(), ctl: null, sugg: new Map(), suggFor: null };
/** Release keys the listener dismissed or filed from the radar: hidden from the feed for good. */
const RADAR_DISMISSED = 'radar:dismissed';
const RADAR_PREFIX = 'radar:release:';
const RADAR_ARTIST = 'radar:artist:';
const RADAR_INDEX = 'radar:index';

/** Read the stored radar once per session (and again after a sync), with no request. */
function radarLoad(force = false) {
  if (RADAR.loaded && !force) return Promise.resolve();
  return RADAR.loading ??= (async () => {
    try {
      RADAR.index = (await idb.get(RADAR_INDEX)) ?? null;
      RADAR.dismissed = new Set((await idb.get(RADAR_DISMISSED)) ?? []);
      const keys = ((await idb.keys()) ?? []).filter(k => typeof k === 'string' && k.startsWith(RADAR_PREFIX));
      for (const k of keys) {
        const r = await idb.get(k);
        if (r && (!RADAR.index || r.shape === RADAR.index.shape)) RADAR.byKey.set(r.key, r);
      }
      RADAR.rows = [...RADAR.byKey.values()];
    } catch (e) { RADAR.err = e?.message ?? String(e); }
    RADAR.loaded = true; RADAR.loading = null;
    store.touch('ui.discover');
  })();
}

let radarPaintAt = 0, radarPaintTimer = null;
/** Repaint Discover at most every 700ms while a sync streams rows in. */
function radarPaint(now = false) {
  clearTimeout(radarPaintTimer);
  const due = radarPaintAt + 700 - Date.now();
  if (now || due <= 0) { radarPaintAt = Date.now(); store.touch('ui.discover'); return; }
  radarPaintTimer = setTimeout(() => radarPaint(true), due);
}

/** Top artists (three windows) and recently played, with ids: the listening half of the artist set. */
async function radarListening() {
  const top = {};
  for (const range of ['short_term', 'medium_term', 'long_term']) {
    try { top[range] = ((await sp(`/me/top/artists?limit=50&time_range=${range}`))?.items ?? []).map(a => ({ id: a.id, name: a.name })); }
    catch { top[range] = []; }
  }
  let recent = [];
  try { recent = ((await sp('/me/player/recently-played?limit=50'))?.items ?? []).map(p => ({ artists: p.track?.artists ?? [] })); }
  catch { /* the library alone still makes a radar */ }
  let weights;
  try { weights = (await getListening())?.weights; } catch { weights = undefined; }
  return { top, recent, weights };
}

/** Run a sync now. `deep`: `{ ids, years }` reads those artists further back ("older on demand"). */
async function radarStart({ deep = null } = {}) {
  if (RADAR.running || !LIB) return;
  RADAR.running = true; RADAR.stopped = null; RADAR.err = null; RADAR.progress = null;
  RADAR.ctl = new AbortController();
  // A read of its own: sp()'s whole-read hold budget starts again, as it does for a library read.
  heldRun = 0;
  if (deep) for (const id of deep.ids ?? []) RADAR.olderFor.add(id);
  radarPaint(true);
  try {
    await radarLoad();
    await engineLoad();
    const BR = globalThis.BetterfyRadar;
    if (!BR) throw new Error('the radar did not load');
    const { top, recent, weights } = await radarListening();
    const artists = BR.artistSet(LIB, { top, recent, weights });
    const kv = {
      get: k => idb.get(k),
      // Only the radar's own keys are written (and each is declared in datakeys.js).
      set: async (k, v) => {
        if (k.startsWith(RADAR_PREFIX)) {
          await idb.set(`radar:release:${k.slice(RADAR_PREFIX.length)}`, v);
          RADAR.byKey.set(v.key, v); RADAR.rows = [...RADAR.byKey.values()]; radarPaint();
        } else if (k.startsWith(RADAR_ARTIST)) await idb.set(`radar:artist:${k.slice(RADAR_ARTIST.length)}`, v);
        else if (k === RADAR_INDEX) { await idb.set(RADAR_INDEX, v); RADAR.index = v; }
      },
      keys: () => idb.keys(),
    };
    // The library may have changed since the last read: re-judge owned and
    // reissue on what is stored (no request) before reading anything new.
    try { await BR.rescore(kv, LIB); } catch { /* the sync re-judges what it touches anyway */ }
    const r = await BR.syncRadar({ lib: LIB, artists, store: kv, get: path => sp(path), signal: RADAR.ctl.signal, deep,
      onProgress: p => { RADAR.progress = p; radarPaint(); } });
    RADAR.stopped = r.stopped;
    if (r.stopped && r.stopped.why !== 'aborted' && r.stopped.why !== 'budget') RADAR.err = r.stopped.message || null;
    if (r.errors && !r.stopped) toast(`${r.errors} artist${r.errors === 1 ? '' : 's'} could not be read; they are tried again next time.`);
  } catch (e) {
    RADAR.err = e?.message ?? String(e);
    RADAR.stopped = { why: 'error', message: RADAR.err };
    toast('The radar stopped: ' + RADAR.err);
  } finally {
    RADAR.running = false; RADAR.ctl = null; RADAR.sugg.clear();
    radarPaint(true);
  }
}

/** Stop. A Stop the listener presses also turns the automatic start off on this device,
 *  until they press Start again (bf_radar, like listening's offChosen). */
function radarStop({ byHand = true } = {}) {
  if (byHand) { try { LS.setItem(RADAR_OFF_KEY, 'off'); } catch { /* private mode */ } }
  RADAR.ctl?.abort();
}

/* ---------- the radar starts by itself (owner, 2026-11-18) ----------
 * Like every other source: on by default, started a while after the page opens
 * (after the tag lookups and the Engine's map, so the library's own reads come
 * first), never on Data Saver, and not again once the listener pressed Stop. The
 * first read is the account check: the separate "Check it works" button is only
 * offered once a read has failed, to say exactly what Spotify refused. After the
 * first read a start only asks about artists due a check, so it is cheap. */
const RADAR_OFF_KEY = 'bf_radar';
const RADAR_AUTO_DELAY_MS = 90_000;
const radarAutoOff = () => { try { return LS.getItem(RADAR_OFF_KEY) === 'off'; } catch { return false; } };

/** Start it. By hand, it also turns the automatic start back on. Resolves true once a read ran. */
async function radarGo({ byHand = false } = {}) {
  if (RADAR.running || !LIB) return false;
  if (byHand) { try { LS.removeItem(RADAR_OFF_KEY); } catch { /* private mode */ } }
  await radarStart();
  return true;
}

/** Called once by boot after the background lookups: waits, then starts unless turned off. */
async function radarAuto({ delay = RADAR_AUTO_DELAY_MS } = {}) {
  if (radarAutoOff()) return false;
  if (typeof navigator !== 'undefined' && navigator.connection?.saveData) return false;
  if (delay) await new Promise(r => setTimeout(r, delay));
  if (radarAutoOff() || RADAR.running) return false;
  return radarGo();
}

/** "Check it works on this account": the Phase 0 probe (core/release/probe.mjs) from the page,
 *  with this account's own sign-in, so nobody needs `node radar.mjs --probe`. Seven reads, one
 *  artist, nothing stored but the answer for this session. */
async function radarProbe() {
  if (RADAR.probe?.running || !LIB) return;
  RADAR.probe = { running: true, rows: null, verdict: null, err: null, artist: null };
  radarPaint(true);
  try {
    await engineLoad();
    const BR = globalThis.BetterfyRadar;
    if (!BR?.probeEndpoints) throw new Error('the radar did not load');
    const artist = BR.artistSet(LIB, {})[0];
    if (!artist) throw new Error('your library names no artist yet');
    const rows = await BR.probeEndpoints(path => sp(path), artist.id);
    Object.assign(RADAR.probe, { rows, verdict: BR.probeVerdict(rows), table: BR.probeTable(rows), artist: artist.name });
  } catch (e) {
    RADAR.probe.err = e?.message ?? String(e);
  } finally {
    RADAR.probe.running = false;
    radarPaint(true);
  }
}

/** Copy the probe's table, to paste where it is asked for. */
async function radarProbeCopy() {
  const t = RADAR.probe?.table;
  if (!t) return;
  try { await navigator.clipboard.writeText(`Radar check (${RADAR.probe.artist ?? ''})\n${t}`); toast('Copied.'); }
  catch { toast('Couldn’t copy. Select the table and copy it instead.'); }
}

/** Hide a release from the feed for good (on this device). */
async function radarDismiss(key, quiet = false) {
  RADAR.dismissed.add(key);
  try { await idb.set(RADAR_DISMISSED, [...RADAR.dismissed]); } catch { /* still hidden this session */ }
  if (!quiet) toast('Dismissed.', async () => { RADAR.dismissed.delete(key); await idb.set(RADAR_DISMISSED, [...RADAR.dismissed]); radarPaint(true); });
  radarPaint(true);
}

/** Where the File queue's own model would put a release: the same picks a File card gets
 *  (tags, else where you file this artist already). No request; null when it has no answer. */
function radarSuggest(row) {
  if (!R || !CFG || !LIB) return null;
  if (RADAR.suggFor !== R) { RADAR.sugg.clear(); RADAR.suggFor = R; }
  if (RADAR.sugg.has(row.key)) return RADAR.sugg.get(row.key);
  let best = null;
  try {
    const t = { id: 'radar:' + row.key, name: row.name, artists: row.artists ?? [] };
    const pick = backlogSuggest(t, LIB, CFG, TAGS, R.profiles, R.idf)[0];
    if (pick && CFG[pick.id]) best = { id: pick.id, name: CFG[pick.id].name ?? pick.name,
      why: pick.via === 'history' ? 'Where you already file this artist' : 'By its artist’s tags, the way File places a track' };
  } catch { best = null; }
  RADAR.sugg.set(row.key, best);
  return best;
}

/** Add a release's tracks to a playlist, logged and undoable like any other filing. */
async function radarFile(key, playlistId) {
  const r = RADAR.byKey.get(key);
  if (!r) return;
  try {
    let ids = (r.tracks ?? []).map(t => t.id).filter(Boolean);
    if (!ids.length) ids = ((await sp(`/albums/${encodeURIComponent(r.ids[0])}/tracks?market=from_token&limit=50`))?.items ?? []).map(t => t.id).filter(Boolean);
    if (!ids.length) throw new Error('Spotify listed no tracks for it');
    await addTracks(playlistId, ids);
    const name = CFG?.[playlistId]?.name ?? playlistId;
    await logAction({ op: 'add', playlistId, playlistName: name, trackIds: ids, reason: 'filed from radar' });
    const when = (await getLog())[0]?.at;
    await radarDismiss(key, true);
    toast(`Filed “${r.name}” in ${name}.`, () => undoAction(when));
  } catch (e) { toast('Failed: ' + (e?.message ?? e)); }
}

/** What web/screens/radar.mjs is given as ctx.radar. */
function radarCtx() {
  return {
    R: RADAR,
    now: () => Date.now(),
    load: () => { if (!RADAR.loaded) radarLoad(); },
    // Start by hand turns the automatic start back on; "older" reads go straight in.
    start: o => fire(o?.deep ? radarStart(o) : radarGo({ byHand: true })),
    stop: () => radarStop(),
    auto: () => !radarAutoOff(),
    probe: () => fire(radarProbe()),
    probeCopy: () => fire(radarProbeCopy()),
    dismiss: k => fire(radarDismiss(k)),
    file: (k, pl) => fire(radarFile(k, pl)),
    suggest: radarSuggest,
  };
}
