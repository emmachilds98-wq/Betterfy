/* ===========================================================================
 * "Analyse my library" — one tap (docs/archive/BUILD-5-PLAN.md, owner's ask).
 *
 * One button runs the two things that make File's suggestions good, in the
 * background and under one status line: the tag gaps are filled (enrichMissing
 * already goes in listening order) and listening to the liked songs is started
 * (audioStart, on by default). When the tags are in, it opens File, where the
 * playlist and genre/mood/BPM suggestions already live. Nothing here writes to
 * Spotify, and nothing is asked of anyone without a key or without data: with
 * no Last.fm key it only listens, and with nothing to do it only routes.
 *
 * analyseRun() takes its collaborators as `d` so it can be tested with stubs;
 * analyseGo()/analyseAuto() wire the real ones.
 *
 * A new account never has to press it (2026-11-17, owner's ask): boot.js asks
 * analyseFirst() before the first paint, so File opens on the progress strip
 * rather than the button, then runs analyseAuto() in the background: genres
 * from Wikidata, listening, Last.fm tags, and last the Engine's map of the
 * playlists (engineAutoLearn, in the engine worker). File stays usable the
 * whole time. Every later load learns that map again quietly (from the cache,
 * usually), so the Engine screen never waits on "Learn my library" either.
 * ======================================================================== */
const ANALYSE = { running: false, pending: false, stage: null, tags: [0, 0], listen: null, timer: null };

/** Artists whose tags are thin — the same gap enrichMissing() fills. */
function analyseGapCount() {
  if (typeof LIB === 'undefined' || !LIB) return 0;
  const ids = new Set();
  const gap = id => (TAGS[id]?.tags?.length ?? 0) < REASK_TAG_FLOOR || TAGS[id]?.source === 'wikidata';
  for (const p of LIB.playlists) for (const t of p.tracks) for (const a of t.artists ?? []) if (a.id && gap(a.id)) ids.add(a.id);
  for (const t of LIB.liked) for (const a of t.artists ?? []) if (a.id && gap(a.id)) ids.add(a.id);
  return ids.size;
}

/** "Reading tags 120/400 · listening 37/412", from whatever has started. */
function analyseStatus(st) {
  const parts = [];
  const [td, tt] = st.tags ?? [0, 0];
  if (st.stage === 'genres') parts.push('Looking up genres');
  if (tt) parts.push(`Reading tags ${td.toLocaleString()}/${tt.toLocaleString()}`);
  if (st.stage === 'learn') parts.push('learning your playlists');
  const l = st.listen;
  if (l && l.total) parts.push(`listening ${Math.min(l.done ?? 0, l.total).toLocaleString()}/${l.total.toLocaleString()}`);
  else if (l?.state === 'paused') parts.push('listening waits for Wi-Fi');
  if (!parts.length) return 'Starting…';
  const line = parts.join(' · ');
  return line[0].toUpperCase() + line.slice(1);
}

/** Is there something worth offering? Gaps to fill, or listening that has not run. */
function analyseWanted(d = {}) {
  // Nothing in the library: nothing to read, nothing to listen to (File says what to do instead).
  if (typeof LIB !== 'undefined' && LIB && !d.gaps && !LIB.liked.length && !LIB.playlists.some(p => p.tracks?.length)) return { gaps: 0, listen: false, any: false };
  const gaps = (d.gaps ?? analyseGapCount)();
  const ran = (d.listenRan ?? (() => typeof listenEverRan === 'function' && listenEverRan()))();
  const canListen = (d.canListen ?? (() => audioSettings().on))();
  return { gaps, listen: canListen && !ran, any: (!!(d.key ?? lfmKey)() && gaps > 0) || (canListen && !ran) };
}

/**
 * Run it. Resolves with what was done; never throws (a failed half just stops).
 * `d`: key(), gaps(), enrich({quiet,onProgress}), listen(), listenVM(), status(st), go(view),
 * and optionally genres() (keyless genres, before the tags) and learn() (the Engine's map, last).
 */
async function analyseRun(d, { route = true } = {}) {
  if (ANALYSE.running) return { skipped: true };
  ANALYSE.running = true; ANALYSE.pending = false; ANALYSE.stage = null; ANALYSE.tags = [0, 0]; ANALYSE.listen = null;
  const now = () => ({ tags: ANALYSE.tags, listen: ANALYSE.listen, stage: ANALYSE.stage });
  const push = () => d.status?.({ ...now(), running: true });
  const out = { tags: false, listen: false };
  try {
    // Listening first: it runs by itself while the tags are read.
    try { await d.listen(); out.listen = true; } catch { /* its own error shows on Sources */ }
    const poll = () => { ANALYSE.listen = d.listenVM?.() ?? null; push(); };
    ANALYSE.timer = setInterval(poll, 600); poll();
    if (d.genres) {
      ANALYSE.stage = 'genres'; push();
      try { await d.genres(); out.genres = true; } catch { /* Last.fm still fills what it can */ }
      ANALYSE.stage = null;
    }
    if (d.key() && d.gaps() > 0) {
      await d.enrich({ quiet: true, onProgress: (n, t) => { ANALYSE.tags = [n, t]; push(); } });
      out.tags = true;
    }
    // Last, so the map is learned with the tags just read.
    if (d.learn) {
      ANALYSE.stage = 'learn'; push();
      try { out.learn = !!(await d.learn()); } catch { out.learn = false; }
      ANALYSE.stage = null;
    }
    poll();
  } catch { /* leave whatever finished */ }
  finally {
    clearInterval(ANALYSE.timer); ANALYSE.timer = null; ANALYSE.running = false; ANALYSE.stage = null;
    d.status?.({ ...now(), running: false });
  }
  if (route) d.go('inbox');
  return out;
}

function analyseDeps() {
  return {
    key: lfmKey, gaps: analyseGapCount,
    enrich: o => enrichMissing(o),
    genres: () => (untaggedArtists().size ? fillFromWikidata({ quiet: true }) : 0),
    learn: () => engineAutoLearn(),
    listen: () => audioStart({ quiet: true }),
    listenVM: () => AUDIO.vm,
    status: st => {
      // The home header's part ticks in place; it appears and goes with a redraw.
      const el = document.getElementById('analyseStrip');
      if (el) el.querySelector('.txt').textContent = analyseStatus(st);
      if (!el !== !st.running && typeof store !== 'undefined') store.touch('ui.inbox');
    },
    go: v => { if (view === 'inbox') go(v); },
  };
}

/** The button. */
function analyseGo() { LS.setItem('bf_analysed', '1'); return analyseRun(analyseDeps()); }

/** Is this the first load that has something to analyse? Asked by boot before the
 *  first paint, so File opens on the progress strip instead of the button. */
function analyseFirst() {
  if (LS.getItem('bf_analysed') || ANALYSE.running) return false;
  try { ANALYSE.pending = !!analyseWanted().any; } catch { ANALYSE.pending = false; }
  return ANALYSE.pending;
}

/** Once, on an account's first load: the same run as the button, in the background,
 *  never taking the screen away. Resolves when it is done (or at once, with nothing to do). */
function analyseAuto() {
  if (LS.getItem('bf_analysed') || ANALYSE.running) { ANALYSE.pending = false; return Promise.resolve(null); }
  if (!analyseWanted().any) { ANALYSE.pending = false; return Promise.resolve(null); }
  LS.setItem('bf_analysed', '1');
  return analyseRun(analyseDeps(), { route: false });
}

/**
 * The Engine's map of the playlists (what "Learn my library" makes), in the
 * background. Built in the engine worker and kept on this device, so after the
 * first time it is read back from the cache. Only when nothing has asked for it
 * yet (idle), there are genre playlists to learn, a worker to build it in, and no
 * Data Saver. Resolves true when the map is ready.
 */
async function engineAutoLearn() {
  if (typeof ENG === 'undefined' || ENG.status !== 'idle' || !LIB) return ENG?.status === 'ready';
  if (typeof navigator !== 'undefined' && navigator.connection?.saveData) return false;
  if (!engineInBackground() || !engineTargets().length) return false;
  await engineAnalyse();
  return ENG.status === 'ready';
}

/** The home header's analysis part while the first analysis runs ("Reading tags 120/400 · listening 37/412"),
 *  '' otherwise. The "Analyse my library" button is gone (DESIGN-PLAN C1): boot runs the first analysis by
 *  itself (analyseAuto), and analyseGo stays as the code path behind it. */
function analyseLine() {
  if (!ANALYSE.running && !ANALYSE.pending) return '';
  return analyseStatus({ tags: ANALYSE.tags, listen: ANALYSE.listen, stage: ANALYSE.stage });
}

/* ---------- First run (docs/archive/BUILD-6-PLAN.md O1) ----------
 * A count in the home header for a new account: the first five filed. It counts the
 * filings from the History log (so it needs nothing stored but "done") and disappears for good once
 * five have gone in, or at once for anyone who has already filed that many. */
const ONB = { n: null, busy: false };
const ONB_GOAL = 5;

function onbCount() {
  if (ONB.busy || LS.getItem('bf_onb_done')) return;
  ONB.busy = true;
  Promise.resolve(getLog()).then(log => {
    // Filed songs, not writes: a liked song filed where it already was writes nothing but still counts.
    const ids = new Set(log.filter(e => e.op === 'add' && e.reason === 'filed from inbox' && !e.undone).flatMap(e => e.trackIds ?? []));
    for (const id in FB) if (FB[id]?.accepted?.length) ids.add(id);
    const n = ids.size;
    const changed = n !== ONB.n; ONB.n = n;
    if (n >= ONB_GOAL) LS.setItem('bf_onb_done', '1');
    if (changed && view === 'inbox') render();
  }).catch(() => {}).finally(() => { ONB.busy = false; });
}

/** The home header's getting-started part: { n, goal } until five are filed, then null for good.
 *  "Connected" and "Analyse" were steps of the old strip; both happen by themselves now. */
function onbState() {
  if (typeof LIB === 'undefined' || !LIB || LS.getItem('bf_onb_done')) return null;
  if (!LIB.liked.length && !LIB.playlists.some(p => p.tracks?.length)) return null;
  onbCount();
  const n = ONB.n; if (n == null || n >= ONB_GOAL) return null;
  return { n, goal: ONB_GOAL };
}

/** Cold start on File: no genre playlist at all, so offer the groups Library offers. [] otherwise. */
function onbColdOffers() {
  if (typeof CFG === 'undefined' || !LIB) return [];
  const rows = Object.values(CFG);
  const noGenre = rows.length > 0 && !rows.some(p => p.axis === 'genre');
  if (!noGenre) return [];
  coldKick(true);
  return COLD.status === 'ready' ? BetterfyScreens.lists.coldStartOffers(COLD.found, 3) : [];
}
