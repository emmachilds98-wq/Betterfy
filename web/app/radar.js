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
/** The account check's last answer (BUILD-7 R1): { account, build, at, ok, missing, rows }. */
const RADAR_PROBE = 'radar:probe';

/** Read the stored radar once per session (and again after a sync), with no request. */
function radarLoad(force = false) {
  if (RADAR.loaded && !force) return Promise.resolve();
  return RADAR.loading ??= (async () => {
    try {
      RADAR.index = (await idb.get(RADAR_INDEX)) ?? null;
      RADAR.dismissed = new Set((await idb.get(RADAR_DISMISSED)) ?? []);
      RADAR.check = (await idb.get(RADAR_PROBE)) ?? null;
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
  // The same four reads Discover's listening seeds make, so they come from the
  // same kept answer (discover-engine.js fetchListeningRaw, a 4-hour TTL)
  // rather than being asked again. Only an answer kept before ids were kept
  // falls back to asking.
  let raw = null;
  try { raw = await fetchListeningRaw(); } catch { raw = null; }
  const top = {};
  for (const range of ['short_term', 'medium_term', 'long_term']) {
    const w = raw?.topWindows?.find(x => x.range === range);
    if (w?.ids) { top[range] = w.ids; continue; }
    try { top[range] = ((await sp(`/me/top/artists?limit=50&time_range=${range}`))?.items ?? []).map(a => ({ id: a.id, name: a.name })); }
    catch { top[range] = []; }
  }
  let recent = raw?.recentWho ?? null;
  if (!recent) {
    try { recent = ((await sp('/me/player/recently-played?limit=50'))?.items ?? []).map(p => ({ artists: p.track?.artists ?? [] })); }
    catch { recent = []; /* the library alone still makes a radar */ }
  }
  let weights;
  try { weights = (await getListening())?.weights; } catch { weights = undefined; }
  return { top, recent, weights };
}

/** Run a sync now. `deep`: `{ ids, years }` reads those artists further back ("older on demand"). */
async function radarStart({ deep = null, byHand = !!deep } = {}) {
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
      maxRequests: byHand ? RADAR_HAND : Math.max(20, RADAR_DAY - radarSpentToday()),
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
const RADAR_PROBE_EVERY = 30 * 864e5;
/* A request budget. The radar is by far the page's biggest spender (three
 * requests per artist per group, a thousand artists on a big library), and it
 * used to start by itself on every visit with no ceiling, all of it from the
 * app's one shared quota. Now a start by itself spends at most what is left of
 * RADAR_DAY today (counted by auth.js's meter, so reloads cannot reset it), and
 * one by hand at most RADAR_HAND; a stop for budget is a pause, and the next
 * start carries on with the artists still due, most listened first. */
const RADAR_DAY = 300, RADAR_HAND = 900;
const radarSpentToday = () => { const k = spStats().kinds; return (k['artists/albums'] ?? 0) + (k['albums/tracks'] ?? 0); };
const radarAutoOff = () => { try { return LS.getItem(RADAR_OFF_KEY) === 'off'; } catch { return false; } };

/** Start it. By hand, it also turns the automatic start back on. Resolves true once a read ran. */
async function radarGo({ byHand = false } = {}) {
  if (RADAR.running || !LIB) return false;
  if (byHand) { try { LS.removeItem(RADAR_OFF_KEY); } catch { /* private mode */ } }
  // A refused route holds the sync (R1). By hand, check again first: Spotify may answer now.
  if (radarHeld()) {
    if (!byHand) return false;
    await radarProbe();
    if (radarHeld()) return false;
  }
  await radarStart({ byHand });
  return true;
}

/** Called once by boot after the background lookups: waits, then starts unless turned off. */
async function radarAuto({ delay = RADAR_AUTO_DELAY_MS } = {}) {
  if (radarAutoOff()) return false;
  if (typeof navigator !== 'undefined' && navigator.connection?.saveData) return false;
  if (delay) await new Promise(r => setTimeout(r, delay));
  if (radarAutoOff() || RADAR.running) return false;
  if (radarSpentToday() >= RADAR_DAY) return false;
  // The account check first, once per account per build; a refused route stops here.
  await radarProbeAuto();
  return radarGo();
}

/* ---------- the account check runs by itself (BUILD-7 R1) ----------
 * Once per account per build, without a button: on the first Discover visit, or
 * just before the automatic start if Discover is never opened. Seven paced reads
 * through sp(), only while the page is visible, never on Data Saver. The answer
 * is kept in IndexedDB radar:probe and shown in Settings. */
const radarAccount = () => LIB?.user?.id ?? null;
/** True when this account's kept answer says a read the radar needs is refused. */
const radarHeld = () => !!RADAR.check && RADAR.check.ok === false && !!radarAccount() && RADAR.check.account === radarAccount();

let radarProbeAutoRun = null;
function radarProbeAuto() {
  return radarProbeAutoRun ??= (async () => {
    try {
      if (!LIB || (typeof navigator !== 'undefined' && navigator.connection?.saveData)) return;
      await radarLoad();
      await engineLoad();
      const BR = globalThis.BetterfyRadar;
      // Once per account, then once a month: it used to run again on every new
      // build, and builds ship most days, so it was seven reads a day for an
      // answer that only changes when Spotify changes the API.
      if (!BR?.probeDue) return;
      const kept = RADAR.check;
      const monthOld = !Number.isFinite(kept?.at) || Date.now() - kept.at > RADAR_PROBE_EVERY;
      if (!BR.probeDue(kept, { account: radarAccount(), build: kept?.build ?? '' }) && !monthOld) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        await new Promise(r => document.addEventListener('visibilitychange', function f() {
          if (document.visibilityState !== 'hidden') { document.removeEventListener('visibilitychange', f); r(); }
        }));
      }
      if (RADAR.probe?.running) return;
      await radarProbe({ quiet: true });
    } catch { /* the radar runs as before; the hand check stays */ }
    finally { radarProbeAutoRun = null; }
  })();
}

/** "Check it works on this account": the Phase 0 probe (core/release/probe.mjs) from the page,
 *  with this account's own sign-in, so nobody needs `node radar.mjs --probe`. Seven reads, one
 *  artist, nothing stored but the answer for this session. */
async function radarProbe({ quiet = false } = {}) {
  if (RADAR.probe?.running || !LIB) return;
  // By itself, a good answer only goes into Settings; the radar section shows a refusal.
  const shown = RADAR.probe;
  RADAR.probe = { running: true, rows: null, verdict: null, err: null, artist: null, quiet };
  radarPaint(true);
  try {
    await engineLoad();
    const BR = globalThis.BetterfyRadar;
    if (!BR?.probeEndpoints) throw new Error('the radar did not load');
    const artist = BR.artistSet(LIB, {})[0];
    if (!artist) throw new Error('your library names no artist yet');
    const rows = await BR.probeEndpoints(path => sp(path), artist.id);
    Object.assign(RADAR.probe, { rows, verdict: BR.probeVerdict(rows), table: BR.probeTable(rows), artist: artist.name });
    RADAR.check = BR.probeRecord(rows, { account: radarAccount(), build: BUILD, at: Date.now(), artist: artist.name });
    try { await idb.set(RADAR_PROBE, RADAR.check); } catch { /* kept for this session */ }
  } catch (e) {
    RADAR.probe.err = e?.message ?? String(e);
  } finally {
    RADAR.probe.running = false;
    if (quiet && (RADAR.probe.err || RADAR.probe.verdict?.ok)) RADAR.probe = shown ?? null;
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
    // The first Discover visit also runs the account check, when it is due.
    load: () => { if (!RADAR.loaded) radarLoad(); fire(radarProbeAuto()); },
    // This account's kept check said a read is refused: one line instead of a feed (R1).
    held: () => radarHeld(),
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
