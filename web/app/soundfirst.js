/* ===========================================================================
 * Sound-first filing (the owner's call, 2026-11-14)
 *
 * What a track sounds like decides where the File screen suggests it goes.
 * For a track listening has heard, the picks come from the engine with sound
 * leading (placements' `soundFirst`): each genre playlist's sound prototype
 * (the average of its own heard tracks), the nearest playlist by sound, and an artist
 * graph built from genre playlists only, so a mood or event playlist ("Sunday",
 * "Fabric 14 Sept") cannot vote on genre. An unheard track keeps the tag
 * engine's picks, unchanged.
 *
 * This overrides docs/AUDIO-BUILD-PLAN.md's gate for the File screen's picks:
 * the owner asked for sound to lead. The Score run still measures it (its
 * "with sound" row is now the sound-first engine), so the call can be checked.
 *
 * The space is built once listening has heard something, in the engine worker
 * (and cached), when the File screen is opened; tracks heard after that are
 * added without a rebuild (hearMore), and the space is rebuilt in the
 * background once noticeably more of the genre playlists has been heard.
 * Nothing here writes to Spotify: it only changes which playlists are offered.
 * ======================================================================== */
const SOUND = { status: 'idle', space: null, n: 0, targets: '', err: null, memo: null, byId: null, lib: null,
                idMemo: null, memb: null, names: null, namesLib: null, moodFit: null, moodMemo: new Map() };
/** Heard records worth a rebuild: a tenth more, and at least 20. */
const SOUND_REBUILD = n => Math.max(20, Math.round(n * 0.1));
const soundHeard = () => { let n = 0; for (const r of AUDIO.records?.values() ?? []) if (!r.miss) n++; return n; };

/** Start or refresh the sound-first space if it would help and isn't already
 *  under way. Cheap to call on every render: it returns at once unless work is due. */
function soundWarm() {
  if (SOUND.status === 'working' || !LIB) return;
  const on = audioSettings().on;
  if (!on && !AUDIO.records?.size) return;
  // The ear is part of the key (WP-C1): a Score run that picks another ear rebuilds.
  const ear = typeof engineEar === 'function' ? engineEar(AUDIO.records) : 'effnet';
  const targets = engineTargets().join() + (ear === 'effnet' ? '' : '|' + ear), n = soundHeard();
  if (SOUND.status === 'ready' && SOUND.targets === targets
      && (!AUDIO.records || n - SOUND.n < SOUND_REBUILD(SOUND.n))) return;
  // Failed on this same input: don't retry in a loop on every render.
  if (SOUND.status === 'error' && SOUND.n === n && SOUND.targets === targets) return;
  SOUND.status = 'working';
  fire(soundBuild(targets));
}

async function soundBuild(targets) {
  try {
    await engineLoad();
    await yieldToPaint();
    // One space for both screens: the Engine screen's, when it was learned for
    // these genre playlists and has heard nearly as much, else build (or revive) it.
    const shared = soundShareable(typeof ENG !== 'undefined' ? ENG.space : null, targets);
    const space = shared ?? (await engineSpace()).space;
    Object.assign(SOUND, { space: space?.audio ? space : null, n: soundHeard(), targets,
                           status: 'ready', err: null, memo: null, idMemo: null });
  } catch (e) {
    Object.assign(SOUND, { status: 'error', err: e?.message ?? String(e), n: soundHeard(), targets, memo: null });
  }
  store.touch('sound');
}

/** A space learned elsewhere that the File screen can use as it is: built for
 *  these genre playlists, with a sound layer, and short of fewer heard tracks
 *  than would trigger a rebuild. Tracks heard since are added by `soundHear`. */
function soundShareable(space, targets) {
  // The same test engineSpace() puts a cached space to.
  if (!space?.audio || targets !== engineTargets().join() || JSON.stringify(space.targets ?? null) !== JSON.stringify(engineTargets())) return null;
  const n = soundHeard();
  return n - space.audio.index.size < SOUND_REBUILD(space.audio.index.size) ? space : null;
}
/** The Engine screen learned a space: let the File screen use it rather than build its own. */
function soundAdopt(space) {
  const targets = engineTargets().join();
  if (SOUND.status === 'working' || !soundShareable(space, targets)) return;
  Object.assign(SOUND, { space, n: soundHeard(), targets, status: 'ready', err: null, memo: null, idMemo: null });
}

/** Heard since the space was built: let it be scored and matched now. */
function soundHear(id) {
  const space = SOUND.space, rec = AUDIO.records?.get(id);
  if (space?.audio && rec && !rec.miss && !space.audio.index.has(id)) BetterfyIntrinsic.hearMore(space, [rec]);
}

/* ---------- what a heard track is, and what it sounds like and mixes with ----------
 * core/audio/identify.mjs and match.mjs: genre › sub-genre and tempo from the
 * sound model's styles, the tracks in your genre playlists it sounds most like,
 * the artist's tags and a tempo check; then the filed tracks it sounds like and
 * the heard tracks it can be beatmatched with. Lookups on this account's own
 * heard tracks only. Null until the sound space is ready and the track is heard. */
function soundMembership() {
  const key = engineTargets().join();
  if (SOUND.memb?.key !== key || SOUND.memb.lib !== LIB)
    SOUND.memb = { key, lib: LIB, v: BetterfyMatch.genreMembership(LIB, { targets: engineTargets(), isMirror: isMirrorPlaylist }) };
  return SOUND.memb.v;
}
function soundTrackName(id) {
  if (SOUND.namesLib !== LIB) {
    SOUND.names = new Map();
    for (const t of [...(LIB.liked ?? []), ...(LIB.playlists ?? []).flatMap(p => p.tracks ?? [])])
      if (t?.id && !SOUND.names.has(t.id)) SOUND.names.set(t.id, { title: t.name ?? '', artist: (t.artists ?? []).map(a => a?.name).filter(Boolean).join(', ') });
    SOUND.namesLib = LIB;
  }
  return SOUND.names.get(id) ?? { title: id, artist: '' };
}
function soundIdOf(t) {
  const index = SOUND.space?.audio?.index;
  if (!t?.id || !index || !globalThis.BetterfyIdentify) return null;
  soundHear(t.id);
  const row = index.get(t.id);
  if (!row) return null;
  const key = `${t.id}|${index.size}|${engineTargets().join()}`;
  if (SOUND.idMemo?.key === key) return SOUND.idMemo.v;
  const memb = soundMembership();
  const neighbours = BetterfyMatch.filedNeighbours(t.id, index, memb, { k: 12 });
  if (SOUND.lib !== LIB) { SOUND.byId = new Map((LIB.liked ?? []).map(x => [x.id, x])); SOUND.lib = LIB; }
  const raw = SOUND.byId.get(t.id);
  const tags = [...new Set((raw?.artists ?? []).map(a => BetterfyGaps.artistGenre(TAGS?.[a?.id]?.tags)).filter(Boolean))];
  const id = BetterfyIdentify.identify(row.rec, { neighbours, tags, playlistName: pid => CFG[pid]?.name ?? pid, ...((typeof tuneIdentOpts === 'function' ? tuneIdentOpts() : null) ?? {}) });
  const mix = BetterfyMatch.mixesWith(t.id, index, { k: 5, bpm: id?.bpm?.value ?? null });
  const v = { id, neighbours: neighbours.slice(0, 5), mix };
  SOUND.idMemo = { key, v };
  return v;
}

/** Learn from a filing now (ENGINE-REVIEW layer 5): the track joins the
 *  playlist in the File and Engine spaces before the next card, so another
 *  track by that artist, or one that sounds like it, already counts it. The
 *  background rebuild replaces this with the exact space later. */
function learnNow(trackId, playlistIds) {
  if (!globalThis.BetterfyIntrinsic?.learnFiled) return;
  if (SOUND.lib !== LIB) { SOUND.byId = new Map((LIB.liked ?? []).map(x => [x.id, x])); SOUND.lib = LIB; }
  const raw = SOUND.byId.get(trackId);
  if (!raw) return;
  let changed = false;
  for (const space of new Set([SOUND.space, typeof ENG !== 'undefined' ? ENG.space : null].filter(Boolean)))
    for (const pid of [].concat(playlistIds)) changed = BetterfyIntrinsic.learnFiled(space, raw, pid) || changed;
  if (changed) { SOUND.memo = null; SOUND.idMemo = null; SOUND.moodMemo = new Map(); }
}

/** Mood "also fits" chips for one heard track (core/intrinsic/mood.mjs): the mood
 *  and context playlists this account's Score run fitted a threshold for, that the
 *  track clears and is not already in. [] until a Score run earned one. */
function moodChipsFor(t) {
  const fit = typeof ENG !== 'undefined' ? ENG.calib?.mood : null;
  const index = SOUND.space?.audio?.index;
  if (!t?.id || !fit || !index || typeof BetterfyMood === 'undefined' || !BetterfyMood.moodInUse(fit)) return [];
  const key = `${t.id}|${index.size}|${fit === SOUND.moodFit ? 1 : 0}`;
  if (SOUND.moodFit !== fit) { SOUND.moodFit = fit; SOUND.moodMemo = new Map(); }
  if (!SOUND.moodMemo.has(key)) SOUND.moodMemo.set(key, BetterfyMood.moodChips(t.id, fit, index, LIB));
  return SOUND.moodMemo.get(key);
}

/** Sound-led picks for one track on the File screen, or [] when it hasn't been
 *  heard, the space isn't ready, or sound can't tell (too few heard members). */
function soundPicks(t) {
  const space = SOUND.space;
  if (!t?.id || !space?.audio || !globalThis.BetterfyIntrinsic) return [];
  const rejected = FB[t.id]?.rejected ?? [];
  const key = `${t.id}|${rejected.join()}|${space.audio.index.size}`;
  if (SOUND.memo?.key === key) return SOUND.memo.picks;
  if (SOUND.lib !== LIB) { SOUND.byId = new Map((LIB.liked ?? []).map(x => [x.id, x])); SOUND.lib = LIB; }
  const raw = SOUND.byId.get(t.id);
  let picks = [];
  if (raw) {
    soundHear(t.id);
    const out = BetterfyIntrinsic.placements(raw, space, { limit: 3, soundFirst: (typeof tuneSoundFirst === 'function' ? tuneSoundFirst() : null) ?? true,
                                                         exclude: rejected.length ? new Set(rejected) : null });
    const W = { ...BetterfyIntrinsic.SOUND_FIRST_WEIGHTS, ...((typeof tuneSoundFirst === 'function' ? tuneSoundFirst() : null) ?? {}) };
    const tagIds = new Set((t.suggest ?? []).map(sg => sg.id));
    if (!out.declined) picks = (out.results ?? [])
      .filter(r => r.parts && ('audio' in r.parts || 'learned' in r.parts))
      .map((r, n) => {
        const p = r.parts, w = k => (Number.isFinite(p[k]) ? p[k] * W[k] : 0);
        return { id: r.playlistId, name: r.name, score: r.score, via: 'sound', axis: CFG[r.playlistId]?.axis ?? null,
                 // The band is the engine's verdict on its top pick only.
                 band: n === 0 ? out.band ?? null : null,
                 evidence: { sound: w('audio') + w('learned'), history: w('graph') + w('bridge') + w('registrant') },
                 tagsAgree: tagIds.has(r.playlistId) };
      });
  }
  SOUND.memo = { key, picks };
  return picks;
}

