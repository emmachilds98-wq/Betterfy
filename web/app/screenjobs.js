/* ---------- Tidy, Playlists and New playlists: the jobs and helpers the screen modules call ----------
 * The screens themselves are web/screens/{tidy,lists,new}.mjs (docs/BUILD-5-PLAN.md A4); what stays
 * here is what other files call (emptyState, tagCoverage, playlistMixes) and the long-running
 * state and jobs (sound misfits, playlist profiles, the gaps proposals). Their ctx is SCREEN_CTX in
 * app/screens.js. */

/** UI-1's empty state: the mark's five bars at rest, a title, one line, and
 *  optionally what to do about it. `compact` sits inside a list or a card. */
function emptyState(title, body, { compact = false, acts = '' } = {}) {
  return `<div class="empty-state${compact ? ' compact' : ''}"><span class="es-mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><div class="es-body"><b>${esc(title)}</b><p>${body}</p></div>${
    acts ? `<div class="es-acts">${acts}</div>` : ''}</div>`;
}

/* ---------- Tidy by sound: core/audio/misfit.mjs ----------
 * Filed tracks whose sound strongly disagrees with their playlist ("sounds
 * like Jungle, sits in House"): the heard tracks each one sounds most like sit
 * mostly in another of your genre playlists, and its sound ID doesn't place it
 * where it is. Worked out in the engine worker from the heard records, and
 * measured there on tracks you filed yourself (planted in the wrong playlist,
 * held out). The section only exists once listening has heard something;
 * without it Tidy draws exactly what it always did. Moves use the same Move
 * button, History entry and undo as "Wrong place"; "Keep here" (recordKeep, in
 * both tiers) is a "not that playlist" verdict plus "it belongs here", so the
 * track is offered as wrong there by neither tier again. */
const TSOUND = { status: 'idle', key: '', res: null, err: null };
const tidySoundKey = () => `${soundHeard()}|${engineTargets().join()}|${Object.values(FB).reduce((n, f) => n + (f.rejected?.length ?? 0), 0)}|${LIB?.playlists?.length ?? 0}`;
// Guarded: the page tests run Tidy in a sandbox without the audio or engine parts.
const tidySoundReady = () => typeof AUDIO !== 'undefined' && typeof soundHeard === 'function' && typeof engineTargets === 'function';
const tidySoundOn = () => tidySoundReady() && !!LIB && soundHeard() > 0;
function tidySoundRows() {
  // Not a move you turned down, and not a track you said to keep where it is
  // (Keep here in either tier: FB.kept).
  return (TSOUND.res?.rows ?? []).filter(x => !(FB[x.id]?.rejected ?? []).includes(x.to) && !(FB[x.id]?.kept ?? []).includes(x.from));
}
const tidySoundCount = () => tidySoundRows().length;
/** Load the heard records if listening is on, and work the moves out when they've changed. Cheap when nothing is due. */
function tidySoundWarm() {
  if (!tidySoundReady() || !LIB || TSOUND.status === 'working') return;
  if (!AUDIO.records) { if (audioSettings().on && TSOUND.status === 'idle') { TSOUND.status = 'working'; fire(tidySoundLoad()); } return; }
  if (!tidySoundOn()) return;
  const key = tidySoundKey();
  if (TSOUND.key === key && (TSOUND.status === 'ready' || TSOUND.status === 'error')) return;
  TSOUND.status = 'working';
  fire(tidySoundBuild(key));
}
async function tidySoundLoad() {
  try { await engineAudio(); } catch { /* no records: Tidy stays as it was */ }
  TSOUND.status = 'idle';
  if (tidySoundOn()) store.touch('ui.tidy');
}
async function tidySoundBuild(key) {
  try {
    await engineLoad();
    const audio = await engineAudio();
    let res = null;
    if (audio) {
      try { res = (await inEngineWorker('misfits', { lib: LIB, audio: engineAudioIn(audio) }))?.result ?? null; }
      catch { res = null; }
      if (!res) {
        await yieldToPaint();
        res = BetterfyMisfit.soundMisfitsFor(LIB, engineAudioIn(audio), { targets: engineTargets(), isMirror: isMirrorPlaylist });
      }
    }
    Object.assign(TSOUND, { status: 'ready', key, res, err: null });
  } catch (e) {
    Object.assign(TSOUND, { status: 'error', key, err: e?.message ?? String(e) });
  }
  store.touch('ui.tidy');
}

/* ---------- Playlists: mixes, sound profiles, splits ---------- */
// at all — a silent guess, not a real signal, and the one worth confirming.

/* The facet mix of every playlist, for the Playlists screen. A full pass over
 * every track, so it is cached against the library it was built from rather
 * than recomputed on each of the many redraws this screen gets. */
let MIXCACHE = null;
function playlistMixes() {
  const stamp = LIB?.captured_at + '/' + (LIB?.playlists.length ?? 0);
  if (MIXCACHE?.stamp === stamp) return MIXCACHE;
  const mix = new Map();
  for (const p of LIB.playlists) mix.set(p.id, facetMix(p.tracks, TAGS));
  // The same measurement over the library as one pile — the baseline every
  // playlist above is read against, and the honest answer to "how much of my
  // genre data is actually genre".
  const base = facetMix(LIB.playlists.filter(p => !isMirrorPlaylist(p)).flatMap(p => p.tracks ?? []), TAGS);
  MIXCACHE = { stamp, mix, base };
  return MIXCACHE;
}

/* ---------- sound slot on Playlists ----------
 * profile(playlistId) → ProfileVM | null: one playlist's sound profile, from
 * WP-B2's adapter once listening has heard something. With no records it is
 * null, and every row renders exactly as it would with no sound layer at all
 * (docs/UI-BUILD-PLAN.md §3 rule 3). The Listening settings themselves live
 * on Sources, in the card audioPanelHTML() draws. */
const LISTS_SOUND = {
  profile: id => {
    if (!AUDIO.records || !globalThis.BetterfyAudio) return null;
    const p = LIB.playlists.find(x => x.id === id);
    let vm = BetterfyAudio.profileVM(p, AUDIO.records, AUDIO.labels);
    // What its heard members are, by genre, and the tempo they settle on
    // (core/audio/plprofile.mjs). Until that is worked out, the model's styles.
    const pp = listsProfiles()?.get(id);
    if (vm && pp) vm = { ...vm, ...(pp.mix.length ? { styles: pp.mix.slice(0, 3).map(m => [m.name, m.share]) } : {}),
                         ...(pp.bpm ? { bpm: pp.bpm } : {}) };
    return BetterfyAudio.withProfileEnergy && typeof labelsShownNow === 'function'
      ? BetterfyAudio.withProfileEnergy(vm, p, AUDIO.records, labelsShownNow()) : vm;
  },
};

/* ---------- playlist sound profiles and "two genres?" ----------
 * Each playlist's heard members, named by genre the way the File card names a
 * track, but with the playlist's own tracks left out of their library votes,
 * so a House playlist that is a third jungle can't vouch for itself. Worked
 * out a few tracks at a time between frames, once per change in what has been
 * heard; the screen redraws when it is done. Lookups on this account's own
 * heard tracks only. No records, no engine: nothing here runs or shows. */
const LPROF = { key: null, pr: null, out: null, busy: false, made: new Set(), loading: false };
/** Milliseconds of work per slice, so the screen stays responsive. */
const LPROF_SLICE_MS = 12;

function listsProfiles() {
  if (!AUDIO.records?.size || !LIB) return null;
  if (!globalThis.BetterfyPlProfile) {
    // The engine bundle is fetched on demand; fetch it and draw again.
    if (!LPROF.loading && typeof engineLoad === 'function') {
      LPROF.loading = true;
      fire(Promise.resolve(engineLoad()).then(() => { store.touch('ui.lists'); }, () => {}));
    }
    return null;
  }
  const targets = typeof engineTargets === 'function' ? engineTargets() : null;
  const key = `${AUDIO.records.size}|${LIB.captured_at}|${LIB.playlists.length}|${(targets ?? []).join()}`;
  if (LPROF.key !== key) {
    LPROF.key = key;
    LPROF.out = null;
    const genreOf = a => globalThis.BetterfyGaps?.artistGenre ? BetterfyGaps.artistGenre(TAGS?.[a?.id]?.tags) : null;
    LPROF.pr = BetterfyPlProfile.createProfiler(LIB, AUDIO.records, {
      targets, isMirror: isMirrorPlaylist,
      tagsOf: t => (t?.artists ?? []).map(genreOf).filter(Boolean),
      playlists: LIB.playlists.filter(p => !isMirrorPlaylist(p)).map(p => p.id),
    });
    listsProfileRun(key);
  }
  return LPROF.out;
}

function listsProfileRun(key) {
  if (LPROF.busy) return;
  LPROF.busy = true;
  const slice = () => {
    if (LPROF.key !== key) { LPROF.busy = false; if (LPROF.pr) listsProfileRun(LPROF.key); return; }
    const t0 = Date.now();
    let done = false;
    try { while (!(done = LPROF.pr.step(4)) && Date.now() - t0 < LPROF_SLICE_MS); }
    catch { done = true; }
    if (!done) return void setTimeout(slice, 0);
    LPROF.busy = false;
    try { LPROF.out = LPROF.pr.result(); } catch { LPROF.out = null; }
    store.touch('ui.lists');
  };
  setTimeout(slice, 0);
}

/** Genre playlists that sound like two genres, with the half that would move. */
function listsSplits() {
  const out = listsProfiles();
  if (!out) return [];
  return LIB.playlists.filter(p => CFG[p.id]?.axis === 'genre' && out.get(p.id)?.split)
    .map(p => ({ p, split: out.get(p.id).split }));
}

/** Make the playlist a split proposes, holding the half that sounds like the other genre. */
async function listsSplitMake(id) {
  const p = LIB.playlists.find(x => x.id === id), split = listsProfiles()?.get(id)?.split;
  if (!p || !split || LPROF.made.has(id)) return;
  const name = BetterfyPlProfile.splitName(p.name, split);
  const pl = await sp('/me/playlists', { method:'POST', body:JSON.stringify({ name, public:false }) });
  await addTracks(pl.id, split.move.ids);
  LPROF.made.add(id);
  toast(`Created “${name}” with ${split.move.ids.length} tracks. Nothing was taken out of “${p.name}”.`);
  render();
}

/** Artists with genre tags, for Home, Playlists and the Sources screen's ctx. */
function tagCoverage() {
  const ids = new Set();
  for (const p of LIB.playlists) for (const t of p.tracks) for (const a of t.artists ?? []) if (a.id) ids.add(a.id);
  for (const t of LIB.liked) for (const a of t.artists ?? []) if (a.id) ids.add(a.id);
  const have = [...ids].filter(id => TAGS[id]?.tags?.length).length;
  return { total: ids.size, have, missing: ids.size - have, pct: ids.size ? Math.round(100*have/ids.size) : 0 };
}

/* ======================= gaps: docs/SMARTER-GENRES-PLAN.md, phase 3 =======================
 * "Make new playlists where I'm not covering genres." Two proposals on top of the
 * backlog clusters this screen always had: genres you have music in but no genre
 * playlist for, and genre playlists that are really two genres. Worked out from
 * your tags, your genre playlists' names and what Spotify says you're playing, in
 * core/recommend/gaps.mjs — fetched with the engine the first time this screen
 * opens, since it brings the genre vocabulary with it.
 *
 * Nothing moves. Creating makes a new private playlist holding a copy of the
 * tracks; a playlist being split is left exactly as it is.
 * ======================================================================== */
const GAPS = { status:'idle', err:null, gaps:null, splits:null, untagged:0, homeless:0, made:new Set(), for:null,
  sound:null, filed:new Set() };

/** Audio records, only if listening is on or was: proposals by sound need nothing else, and are skipped without. */
async function gapsRecords() {
  if (typeof engineAudio !== 'function') return null;
  try { return await engineAudio(); } catch { return null; }
}

/** Work the proposals out. Listening only reorders them, so failing to get it costs nothing. */
async function gapsCompute() {
  // R is rebuilt whenever the library, its tags or its genre playlists change,
  // so the reports object this was worked out against says whether it is stale.
  GAPS.status = 'working'; GAPS.err = null; GAPS.for = R;
  try {
    await engineLoad();
    let active = null;
    try { active = (await getListening())?.recentlyActive ?? null; } catch { active = null; }
    const common = { lib: LIB, targets: engineTargets(), tagsOf: id => TAGS?.[id]?.tags ?? [], isMirror: isMirrorPlaylist };
    const u = BetterfyGaps.uncoveredGenres({ ...common, active });
    const split = BetterfyGaps.splitCandidates(common);
    // By sound (WP-H2): suggestions to create, so shown whatever the gate says.
    const records = await gapsRecords();
    const sound = records && globalThis.BetterfyAudioGaps
      ? BetterfyAudioGaps.soundProposals({ ...common, records, active }) : null;
    // WP-C3: a suggested name for each "new genre?", from CLAP, when it has heard them.
    if (sound?.orphans?.length && typeof clapNameOrphans === 'function') await clapNameOrphans(sound.orphans, records);
    Object.assign(GAPS, { status:'ready', gaps:u.gaps, splits:split.splits, untagged:u.untagged, homeless:u.homeless,
      sound: sound && (sound.pick.length || sound.hybrids.length || sound.orphans.length) ? sound : null });
  } catch (e) {
    GAPS.status = 'error'; GAPS.err = e?.message ?? String(e);
  }
  store.touch('gaps');
}

/** Make a private playlist holding these tracks. Nothing else in the library changes. */
async function gapsCreate(name, ids) {
  const pl = await sp('/me/playlists', { method:'POST', body:JSON.stringify({ name, public:false }) });
  await addTracks(pl.id, ids);
  GAPS.made.add(name.toLowerCase());
  toast(`Created “${name}” with ${ids.length} tracks. It becomes a place to file into after your next sync.`);
  store.touch('gaps');
}

/** Add these tracks to a playlist they already sound like. Nothing is taken out of anywhere. */
async function gapsFile(playlistId, name, ids, key) {
  await addTracks(playlistId, ids);
  GAPS.filed.add(key);
  toast(`Added ${ids.length} track${ids.length === 1 ? '' : 's'} to “${name}”.`);
  store.touch('gaps');
}

