/* ======================= similar artists, fetched in the background =======================
 * docs/NEXT-WORKPLAN.md package 2. Deezer's "fans also like" and ListenBrainz's
 * listening-session neighbours (the neighbour bridge, core/intrinsic/bridge.mjs)
 * used to be fetched only for the tracks a Score run scored, so File only had
 * them once somebody pressed Score, and only for those artists. Now they are
 * gathered quietly after the library loads (after Wikidata and Last.fm, which
 * share the request budget and write the tag cache), into the same per-artist
 * cache the Score run fills (BRIDGE_KEY), for every artist in the library:
 * artists of the liked songs waiting to be filed first, then the filed ones,
 * each group most-played first (inEnrichOrder). Saved after every chunk, so a
 * closed tab loses little and the next load carries on where it stopped.
 *
 * File uses what is gathered straight away:
 *  - heard tracks: the sound-led picks (soundPicks) are placed in a copy of
 *    the sound space with the bridge let in (withBridge), so a never-filed
 *    artist's track also hears where artists like them are filed;
 *  - tracks with no tag picks and no sound picks (an untagged artist nobody
 *    has heard yet): picks from where their similar artists are filed.
 *
 * Gate: the account's own Score run (bridgeVerdict, the plan's bar: never-filed
 * top-1 +5 points with no overall loss). A run that says the bridge does not
 * clear it switches it off for File; no run yet keeps it on (the owner's
 * library measured 11% -> 49%). `bf_bridge_off` switches all of it off.
 * The outside sources only ever say who sits near whom; the vote lands in this
 * account's own playlists. Nothing here writes to Spotify.
 * ======================================================================== */
const BRIDGE_WARM = { running: false, asked: 0, total: 0, at: null, err: null, quota: false,
                      raw: null, bridge: null, ver: 0, loaded: false,
                      spaceFor: null, spaceVer: -1, spaced: null, base: null, baseStatus: 'idle', drawn: 0,
                      memo: new Map(), memoVer: -1, likedFor: null, liked: null };
/** Artists looked up per save. */
const BRIDGE_WARM_CHUNK = 40;
/** The last Score run's verdict on similar artists, for File. */
const BRIDGE_GATE_KEY = 'bf_bridge_gate';

/** The account's own Score verdict, or null when it has never been scored with them. */
function bridgeGate() {
  try { return JSON.parse(LS.getItem(BRIDGE_GATE_KEY) || 'null'); } catch { return null; }
}

/** Keep the Score run's verdict (web/screens/engine.mjs bridgeVerdict). A run
 *  without similar artists says nothing about them, so the last verdict stays. */
function bridgeGateRemember(v) {
  try {
    if (!v?.mine?.withBridge || typeof SCREEN_MODS === 'undefined' || !SCREEN_MODS.engine?.bridgeVerdict) return;
    const g = SCREEN_MODS.engine.bridgeVerdict(v);
    if (!g) return;
    LS.setItem(BRIDGE_GATE_KEY, JSON.stringify({ pass: g.pass, lift: +(g.lift ?? 0).toFixed(4),
                                                 overall: +(g.overall ?? 0).toFixed(4), at: Date.now() }));
    BRIDGE_WARM.spaceFor = null; BRIDGE_WARM.ver++;
  } catch { /* not remembered: File keeps the default, on */ }
}

/** The bridge File may use right now, or null. */
function bridgeForFile() {
  if (!BRIDGE_WARM.bridge || (typeof bridgeOn === 'function' && !bridgeOn())) return null;
  return bridgeGate()?.pass === false ? null : BRIDGE_WARM.bridge;
}

/** Let gathered lookups into File (and the blend, when that is on). */
function bridgeWarmSet(raw) {
  const has = !!raw && Object.keys(raw).length > 0;
  BRIDGE_WARM.raw = has ? raw : null;
  BRIDGE_WARM.bridge = has && LIB ? BetterfyBridge.bridgeFrom(raw, LIB) : null;
  BRIDGE_WARM.ver++; BRIDGE_WARM.spaceFor = null;
  if (typeof BLEND !== 'undefined' && BLEND.status === 'ready' && typeof blendSetBridge === 'function') blendSetBridge(raw);
  if (typeof SOUND !== 'undefined') SOUND.memo = null;
  // Redraw File at most every 15 s while lookups land, so a card does not jump under a thumb.
  const now = Date.now();
  if (typeof view !== 'undefined' && view === 'inbox' && now - BRIDGE_WARM.drawn > 15000) { BRIDGE_WARM.drawn = now; render(); }
}

/** What this device already remembers, once, without asking anything. */
async function bridgeWarmLoad() {
  if (BRIDGE_WARM.loaded) return;
  BRIDGE_WARM.loaded = true;
  let raw = null;
  try { raw = (await idb.get(BRIDGE_KEY))?.raw ?? null; } catch { raw = null; }
  if (raw) bridgeWarmSet(raw);
}

/** Who to look up, in the order that helps File most: the first-billed artists
 *  of liked songs waiting to be filed, then everyone filed (their ids and MBIDs
 *  are what map a neighbour back exactly), each group most-played first. */
async function bridgeWarmArtists() {
  const waiting = new Set((R?.backlog ?? []).map(b => b.id));
  const liked = LIB.liked ?? [];
  const unfiled = liked.filter(t => waiting.has(t.id));
  const filed = [...liked.filter(t => !waiting.has(t.id)), ...(LIB.playlists ?? []).flatMap(p => p.tracks ?? [])];
  const out = new Map(await inEnrichOrder(BetterfyBridge.sourceArtists(unfiled), ([, a]) => a.name));
  for (const [id, a] of await inEnrichOrder(BetterfyBridge.sourceArtists(filed), ([, a]) => a.name)) {
    const seen = out.get(id);
    if (!seen) out.set(id, { ...a });
    else if (!seen.isrc && a.isrc) out.set(id, { ...seen, isrc: a.isrc });
  }
  return out;
}

/** Whether an artist still needs asking: no fresh Deezer answer (when an ISRC
 *  can reach them) or no fresh Wikidata/MusicBrainz answer. */
function bridgeDue(raw, sid, a, now) {
  const ttl = BetterfyBridgeFetch.TTL_MS;
  const fresh = at => Number.isFinite(at) && now - at < ttl;
  return (!!a?.isrc && !fresh(raw?.[sid]?.deezerAt)) || !fresh(raw?.[sid]?.mbidAt);
}

/** Gather similar artists for the whole library, quietly, resumably. */
async function bridgeWarm() {
  if (BRIDGE_WARM.running || !LIB || !bridgeOn()) return;
  BRIDGE_WARM.running = true; BRIDGE_WARM.err = null; BRIDGE_WARM.quota = false;
  try {
    await engineLoad();
    await bridgeWarmLoad();
    // Data saver asks for no background downloads: use what is remembered, ask nothing.
    if (typeof navigator !== 'undefined' && navigator.connection?.saveData) return;
    const artists = await bridgeWarmArtists();
    let raw = BRIDGE_WARM.raw ?? {};
    const now = Date.now();
    const todo = [...artists].filter(([sid, a]) => bridgeDue(raw, sid, a, now));
    BRIDGE_WARM.total = artists.size; BRIDGE_WARM.asked = artists.size - todo.length;
    for (let i = 0; i < todo.length; i += BRIDGE_WARM_CHUNK) {
      // Switched off, or a Score run or File's blend is filling the same cache: stop; the next load resumes.
      if (!bridgeOn() || (typeof ENG !== 'undefined' && ENG.valRunning)
          || (typeof BLEND !== 'undefined' && BLEND.fetching)) break;
      const chunk = new Map(todo.slice(i, i + BRIDGE_WARM_CHUNK));
      // Start from what is stored now, so answers a Score run or Discover saved meanwhile are kept.
      try { raw = (await idb.get(BRIDGE_KEY))?.raw ?? raw; } catch { /* the copy in hand */ }
      const { raw: next, stats } = await BetterfyBridgeFetch.gatherBridge(chunk,
        { deezer: deezerJsonp, json: corsJson, cache: raw });
      raw = next;
      try { await idb.set(BRIDGE_KEY, { at: Date.now(), raw }); } catch { /* still used this session */ }
      BRIDGE_WARM.asked += [...chunk].filter(([sid, a]) => !bridgeDue(raw, sid, a, Date.now())).length;
      bridgeWarmSet(raw);
      if (typeof underHoodRefresh === 'function') { try { underHoodRefresh(); } catch { /* not open */ } }
      if (stats?.quota) { BRIDGE_WARM.quota = true; break; }
    }
  } catch (e) {
    BRIDGE_WARM.err = e?.message ?? String(e);
  } finally {
    BRIDGE_WARM.running = false; BRIDGE_WARM.at = Date.now();
  }
}

/** A space with the bridge let in, kept until the bridge or the space changes.
 *  The space passed in is left alone (withBridge copies it). */
function bridgedSpace(space) {
  const b = space ? bridgeForFile() : null;
  if (!b) return space;
  if (BRIDGE_WARM.spaceFor === space && BRIDGE_WARM.spaceVer === BRIDGE_WARM.ver) return BRIDGE_WARM.spaced;
  const spaced = BetterfyBridge.withBridge(space, b);
  Object.assign(BRIDGE_WARM, { spaceFor: space, spaceVer: BRIDGE_WARM.ver, spaced });
  return spaced;
}
/** A filing changed where artists live: work the homes out again on the next pick. */
const bridgeSpaceStale = () => { BRIDGE_WARM.spaceFor = null; BRIDGE_WARM.memoVer = -1; };
/** The memo key part that changes whenever File's bridge does. */
const bridgeVer = () => (bridgeForFile() ? BRIDGE_WARM.ver : -1);

/** The space bridge-only picks are placed in: the sound space or the Engine's
 *  when one is ready, else one learned once (cached by engineSpace). */
function bridgeBaseSpace() {
  if (typeof SOUND !== 'undefined' && SOUND.space) return SOUND.space;
  const targets = JSON.stringify(engineTargets());
  if (typeof ENG !== 'undefined' && ENG.status === 'ready' && ENG.space
      && JSON.stringify(ENG.space.targets ?? null) === targets) return ENG.space;
  if (BRIDGE_WARM.base && JSON.stringify(BRIDGE_WARM.base.targets ?? null) === targets) return BRIDGE_WARM.base;
  if (BRIDGE_WARM.baseStatus === 'idle') {
    BRIDGE_WARM.baseStatus = 'working';
    fire((async () => {
      try {
        await engineLoad();
        BRIDGE_WARM.base = (await engineSpace()).space ?? null;
        BRIDGE_WARM.baseStatus = BRIDGE_WARM.base ? 'ready' : 'error';
      } catch { BRIDGE_WARM.base = null; BRIDGE_WARM.baseStatus = 'error'; }
      BRIDGE_WARM.spaceFor = null;
      if (typeof view !== 'undefined' && view === 'inbox') render();
    })());
  }
  return null;
}

/** Picks for a track nothing else can place (no tags, not heard): where the
 *  artists like this one are filed. [] when the bridge knows none of them. */
function bridgePicks(t) {
  if (!t?.id || !bridgeForFile() || !globalThis.BetterfyIntrinsic) return [];
  const known = (t.artists ?? []).some(a => a?.id && BRIDGE_WARM.bridge.neighbours?.[a.id]?.length);
  if (!known) return [];
  const base = bridgeBaseSpace();
  if (!base) return [];
  if (BRIDGE_WARM.likedFor !== LIB) { BRIDGE_WARM.liked = new Map((LIB.liked ?? []).map(x => [x.id, x])); BRIDGE_WARM.likedFor = LIB; }
  const raw = BRIDGE_WARM.liked.get(t.id);
  if (!raw) return [];
  const rejected = FB[t.id]?.rejected ?? [];
  const spaced = bridgedSpace(base);
  if (BRIDGE_WARM.memoVer !== BRIDGE_WARM.ver || BRIDGE_WARM.memoFor !== spaced) {
    BRIDGE_WARM.memo = new Map(); BRIDGE_WARM.memoVer = BRIDGE_WARM.ver; BRIDGE_WARM.memoFor = spaced;
  }
  const key = `${t.id}|${rejected.join()}`;
  if (BRIDGE_WARM.memo.has(key)) return BRIDGE_WARM.memo.get(key);
  const out = BetterfyIntrinsic.placements(raw, spaced, { limit: Infinity, exclude: rejected.length ? new Set(rejected) : null });
  const picks = (out.results ?? [])
    .filter(r => (r.parts?.bridge ?? 0) > 0 && CFG[r.playlistId]?.target && !rejected.includes(r.playlistId))
    .slice(0, 3)
    .map(r => ({ id: r.playlistId, name: CFG[r.playlistId]?.name ?? r.name, axis: CFG[r.playlistId]?.axis ?? null,
                 via: 'blend', untagged: true, similar: true, score: r.score,
                 filed: (r.parts?.graph ?? 0) > 0 }));
  BRIDGE_WARM.memo.set(key, picks);
  return picks;
}

/** For Settings: "N of M artists looked up". */
function bridgeWarmState() {
  return { asked: BRIDGE_WARM.asked, total: BRIDGE_WARM.total, running: BRIDGE_WARM.running,
           quota: BRIDGE_WARM.quota, err: BRIDGE_WARM.err, usedInFile: !!bridgeForFile(),
           gate: bridgeGate()?.pass ?? null };
}
