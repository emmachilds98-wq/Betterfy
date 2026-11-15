/* ======================= tags and the engine, blended on File =======================
 * docs/SMARTER-GENRES-PLAN.md phase 1. The Score run fits one weight between
 * today's tag engine and the account-native engine with similar artists
 * (core/validate/blend.mjs), on this account's own held-out filing. Only when
 * that run says the blend beats the tag engine — by a point of top-1, with
 * similar artists on — do the File screen's picks come from the blend.
 * Otherwise nothing here does anything: no engine download, no lookups, and
 * `blendPicks` hands back the very array it was given (test/webblend.test.mjs).
 *
 * Off, or never scored, or no similar artists remembered on this device, or
 * `bf_bridge_off`: today's picks, byte for byte.
 *
 * While it is on, the similar-artist lookups for the tracks waiting to be filed
 * are gathered in the background, artists you actually play first (Spotify's
 * top artists over three windows and recently played, the same fetch Discover
 * makes and caches), into the same per-artist cache the Score run fills.
 * Heard tracks still lead with sound (soundPicks); the blend replaces the tag
 * engine's picks underneath them. Nothing here writes to Spotify.
 * ======================================================================== */
const BLEND_KEY = 'engine-blend';
const BLEND = { status: 'idle', rec: null, base: null, space: null, native: null, targets: '', memo: new Map(), ver: 0,
                fetching: false, gated: null, gatedFor: null, liked: null, likedFor: null, err: null };
/** Similar-artist lookups gathered per save: small enough that a closed tab loses little. */
const BLEND_CHUNK = 40;

/** What a stored fit is only valid for: this blend and this engine. */
const blendStamp = () => `${BetterfyBlend.BLEND_VERSION}/${BetterfyPersist.ENGINE_STAMP}`;

/** Keep the Score run's blend for the File screen, or forget the last one when
 *  this run had none (no tags loaded): the newest score is the one that counts. */
async function blendRemember(v) {
  const b = v && !v.error ? v.blend : null;
  try {
    if (!b) await idb.del(BLEND_KEY);
    else await idb.set(BLEND_KEY, { stamp: blendStamp(), targets: engineTargets(), at: Date.now(),
      weight: b.weight, beatsTags: !!b.beatsTags, withBridge: !!b.withBridge, scored: b.scored,
      // Fitted on top of this engine's fitted weights (core/validate/weights.mjs):
      // the File screen must then rank with those same weights, or not at all.
      ...(b.nativeFitted ? { nativeFitted: true } : {}),
      top1: b.top1, top3: b.top3, tags: b.tags, neverFiled: b.neverFiled ?? null });
  } catch { /* not remembered: File keeps today's picks, which is the safe side */ }
  blendForget();
}

/** Start again from the stored record on the next File render. */
function blendForget() {
  Object.assign(BLEND, { status: 'idle', rec: null, base: null, space: null, native: null, err: null });
  BLEND.memo.clear(); BLEND.ver++;
}

/** Whether File's picks come from the blend right now. */
function blendActive() {
  return BLEND.status === 'ready' && !!BLEND.space && !!BLEND.rec?.beatsTags && bridgeOn()
    && BLEND.targets === engineTargets().join();
}

/** Cheap to call on every render: it only does work once, and only for an
 *  account whose stored Score says the blend is ahead. */
function blendWarm() {
  if (BLEND.status !== 'idle' || !LIB) return;
  BLEND.status = 'checking';
  fire(blendStart());
}

async function blendStart() {
  try {
    const rec = await idb.get(BLEND_KEY);
    const targets = engineTargets();
    // The cheap checks first, so an account it doesn't apply to never fetches engine.js.
    if (!rec?.beatsTags || !rec.withBridge || !bridgeOn()
        || JSON.stringify(rec.targets ?? null) !== JSON.stringify(targets)) { BLEND.status = 'off'; return; }
    const raw = (await idb.get(BRIDGE_KEY))?.raw ?? null;
    await engineLoad();
    if (rec.stamp !== blendStamp()) { BLEND.status = 'off'; return; }
    // A blend weight fitted on top of the engine's fitted weights is only
    // right with those weights; without them (forgotten, or another engine
    // version) it is not used at all.
    let native = null;
    if (rec.nativeFitted) {
      await weightsLoad();
      native = fittedWeights('bridge');
      if (!native) { BLEND.status = 'off'; return; }
    }
    const learned = typeof ENG !== 'undefined' && ENG.space
      && JSON.stringify(ENG.space.targets ?? null) === JSON.stringify(targets) ? ENG.space : null;
    const base = learned ?? (await engineSpace()).space;
    if (!base) { BLEND.status = 'off'; return; }
    Object.assign(BLEND, { rec, base, native, targets: targets.join(), status: 'ready', err: null });
    blendSetBridge(raw);
    if (view === 'inbox') render();
    fire(blendFetch());
  } catch (e) {
    Object.assign(BLEND, { status: 'error', err: e?.message ?? String(e), space: null });
  }
}

/** Let the remembered lookups into the space. No lookups remembered: no blend. */
function blendSetBridge(raw) {
  const has = !!raw && Object.keys(raw).length > 0;
  BLEND.space = has && BLEND.base ? BetterfyBridge.withBridge(BLEND.base, BetterfyBridge.bridgeFrom(raw, LIB)) : null;
  BLEND.memo.clear(); BLEND.ver++;
}

/** Artist name → how much you play them: top artists over three windows,
 *  weighted as Discover weights them, and recently played. Empty on failure. */
async function blendListening() {
  const w = new Map();
  try {
    const d = typeof fetchListeningRaw === 'function' ? await fetchListeningRaw() : null;
    for (const win of d?.topWindows ?? []) (win.items ?? []).forEach((name, i, all) => {
      const k = String(name ?? '').toLowerCase();
      if (k) w.set(k, (w.get(k) ?? 0) + (win.weight ?? 1) * (1 - i / all.length));
    });
    for (const name of d?.recentArtists ?? []) {
      const k = String(name ?? '').toLowerCase();
      if (k) w.set(k, (w.get(k) ?? 0) + 1);
    }
  } catch { /* no listening: the queue's own order */ }
  return w;
}

/** Gather similar artists for the tracks waiting to be filed, in the background,
 *  most-played artists first, saving after every chunk so nothing is asked twice. */
async function blendFetch() {
  if (BLEND.fetching || !bridgeOn() || !R?.backlog?.length) return;
  BLEND.fetching = true;
  try {
    const listen = await blendListening();
    const liked = new Map((LIB.liked ?? []).map(t => [t.id, t]));
    const playOf = t => Math.max(0, ...(t.artists ?? []).map(a => listen.get(String(a?.name ?? '').toLowerCase()) ?? 0));
    const tracks = R.backlog.map(b => liked.get(b.id)).filter(Boolean)
      .map((t, i) => ({ t, i, w: playOf(t) })).sort((a, b) => b.w - a.w || a.i - b.i).map(x => x.t);
    const artists = BetterfyBridge.sourceArtists(tracks);
    let raw = (await idb.get(BRIDGE_KEY))?.raw ?? {};
    const ttl = BetterfyBridgeFetch.TTL_MS, now = Date.now();
    const fresh = at => Number.isFinite(at) && now - at < ttl;
    const todo = [...artists].filter(([sid, a]) => (a.isrc && !fresh(raw[sid]?.deezerAt)) || !fresh(raw[sid]?.mbidAt));
    for (let i = 0; i < todo.length; i += BLEND_CHUNK) {
      // Switched off, or a Score run is filling the same cache: stop, and pick
      // up from what was saved next time.
      if (!bridgeOn() || (typeof ENG !== 'undefined' && ENG.valRunning) || BLEND.status !== 'ready') break;
      const { raw: next, stats } = await BetterfyBridgeFetch.gatherBridge(new Map(todo.slice(i, i + BLEND_CHUNK)),
        { deezer: deezerJsonp, json: corsJson, cache: raw });
      raw = next;
      try { await idb.set(BRIDGE_KEY, { at: Date.now(), raw }); } catch { /* still used this session */ }
      blendSetBridge(raw);
      if (view === 'inbox') render();
      if (stats.quota) break;
    }
  } catch { /* a lookup run that fails costs the lookups, never the picks */ }
  BLEND.fetching = false;
}

/** The gated tags buildReports scores with, worked out once per tag table. */
function blendTags() {
  if (BLEND.gatedFor !== TAGS) { BLEND.gated = gateTags(TAGS, tagGate(TAGS)); BLEND.gatedFor = TAGS; }
  return BLEND.gated;
}

/**
 * The File screen's picks for one track, given today's (`tagPicks`, the
 * backlogSuggest output). Blend off: `tagPicks` itself, untouched. On: the
 * blended ranking's best three, minus anything rejected for this track. A
 * track with no tags at all is ranked by the engine and similar artists alone.
 */
function blendPicks(t, tagPicks) {
  blendWarm();
  if (!t?.id || !blendActive()) return tagPicks;
  const rejected = FB[t.id]?.rejected ?? [];
  const key = `${t.id}|${rejected.join()}|${BLEND.ver}`;
  if (BLEND.memo.has(key)) return BLEND.memo.get(key);
  if (BLEND.likedFor !== LIB) { BLEND.liked = new Map((LIB.liked ?? []).map(x => [x.id, x])); BLEND.likedFor = LIB; }
  const raw = BLEND.liked.get(t.id);
  let picks = tagPicks;
  if (raw) {
    const tagRanked = R?.profiles && TAGS ? rank(raw, blendTags(), R.profiles, R.idf, { top: Infinity }) : [];
    const nat = BetterfyIntrinsic.placements(raw, BLEND.space,
      BLEND.native ? { limit: Infinity, weights: BLEND.native } : { limit: Infinity }).results ?? [];
    const w = BLEND.rec.weight;
    const ranked = BetterfyBlend.blendScores(tagRanked, nat, w)
      .filter(([id]) => CFG[id]?.target && !rejected.includes(id));
    if (ranked.length) {
      const tagRaw = new Map(tagRanked.map(b => [b.id, b.score]));
      const natRow = new Map(nat.map(r => [r.playlistId, r]));
      // The weight actually used: a side with nothing to say drops out.
      const wt = !tagRaw.size ? 0 : !natRow.size ? 1 : w;
      picks = ranked.slice(0, 3).map(([id]) => ({
        id, name: CFG[id]?.name ?? natRow.get(id)?.name ?? id, axis: CFG[id]?.axis ?? null, via: 'blend',
        // Shown as a fit, so it is the mix of the two raw scores, not the
        // rescaled one the order comes from (whose leader is always near 100%).
        score: +(wt * (tagRaw.get(id) ?? 0) + (1 - wt) * (natRow.get(id)?.score ?? 0)).toFixed(4),
        untagged: !tagRaw.size,
        similar: (natRow.get(id)?.parts?.bridge ?? 0) > 0 }));
    }
  }
  BLEND.memo.set(key, picks);
  return picks;
}

/* ---------- this engine's own weights, fitted to this account ----------
 * core/validate/weights.mjs: the Score run fits how much the artist graph,
 * the label, the record's shape and similar artists each count, on this
 * account's own held-out filing, nested over the folds. Kept per set of genre
 * playlists and engine version (like the blend above, not per library
 * fingerprint, so filing a track doesn't throw it away), and used for placing
 * (the Engine screen's comparison, File's blend) only where the held-out top-1
 * beat the default weights by a point. Nothing stored, or a fit that didn't
 * win: every placement is made exactly as before, with no `weights` passed. */
const WFIT_KEY = 'engine-weights';
/** `undefined` until read from storage; null when there is nothing to use. */
const WFIT = { rec: undefined };
const wfitStamp = () => `${BetterfyWeightFit.WEIGHT_FIT_VERSION}/${BetterfyPersist.ENGINE_STAMP}`;

/** Read the stored fit once (needs the engine bundle for its stamp). */
async function weightsLoad() {
  if (WFIT.rec !== undefined) return WFIT.rec;
  let rec = null;
  try { rec = (await idb.get(WFIT_KEY)) ?? null; } catch { rec = null; }
  if (rec && (typeof BetterfyWeightFit === 'undefined' || rec.stamp !== wfitStamp())) rec = null;
  return (WFIT.rec = rec);
}

/** The fitted weights for 'plain' (the engine alone) or 'bridge' (with similar
 *  artists), or null: not fitted, not ahead by a point, or other playlists. */
function fittedWeights(kind) {
  const rec = WFIT.rec, v = rec?.[kind];
  if (!v?.use || !v.weights) return null;
  if (JSON.stringify(rec.targets ?? null) !== JSON.stringify(engineTargets())) return null;
  return v.weights;
}

/** `opts` for placements(), with the fitted weights when there are any to use
 *  and `opts` itself otherwise, so a default placement is the same call as before. */
function withFittedWeights(opts, kind) {
  const w = fittedWeights(kind);
  return w ? { ...opts, weights: w } : opts;
}

/** Keep the Score run's fit, or forget the last one when this run had none. */
async function weightsRemember(v) {
  const f = v && !v.error ? v.weights : null;
  const keep = x => (x ? { use: !!x.use, weights: x.weights, multipliers: x.multipliers,
                           scored: x.scored, default: x.default, fitted: x.fitted } : null);
  const rec = f?.plain ? { stamp: wfitStamp(), targets: engineTargets(), at: Date.now(),
                           plain: keep(f.plain), bridge: keep(f.bridge) } : null;
  try {
    if (!rec) await idb.del(WFIT_KEY);
    else await idb.set(WFIT_KEY, rec);
  } catch { /* not remembered: it still applies until the page is closed */ }
  WFIT.rec = rec;
}

/** Forget the fit ("Forget and learn again"). */
async function weightsForget() {
  try { await idb.del(WFIT_KEY); } catch {}
  WFIT.rec = null;
}
