/* ---------- Score + Tune, by itself (docs/NEXT-WORKPLAN.md package 1) ----------
 * core/review/autoscore.mjs decides whether a run is due; this runs it. A
 * minute after the app opens, then every five minutes while the tab is in
 * front, it asks autoScoreWhy() and, when a run is due, does what the owner's
 * "Score + Tune" button does: engineValidate() (which refits the weights, the
 * calibration and the blend, and decides every gate), then engineTune(), then
 * keeps only the tuned rows that cleared their bar on both halves of this
 * account's tracks (tuneApply). Nothing here writes to Spotify; it only decides
 * which parts of the engine File uses, exactly as a run by hand does.
 * Skipped with Data Saver on. Kept on this device in bf_autoscore. */
const AUTOSCORE_KEY = 'bf_autoscore';
const AUTOSCORE_RUN = { running: false, started: false, firstMs: 60e3, everyMs: 5 * 60e3 };

function autoScoreLast() {
  try { return JSON.parse(LS.getItem(AUTOSCORE_KEY) || 'null'); } catch { return null; }
}

/** Remember a run that just ended, automatic or by hand, so the timer counts from it. */
function autoScoreNote(why, ok = true) {
  const rec = { at: Date.now(), heard: typeof listenHeard === 'function' ? listenHeard() : 0, why, ok: !!ok };
  try { LS.setItem(AUTOSCORE_KEY, JSON.stringify(rec)); } catch { /* private mode: counts this session only */ }
  return rec;
}

/** Distinct tracks in genre playlists: what a Score run has to score. */
function autoScoreFiled() {
  if (!LIB?.playlists) return 0;
  const targets = new Set(engineTargets()), ids = new Set();
  for (const p of LIB.playlists) if (targets.has(p.id)) for (const t of p.tracks ?? []) if (t?.id) ids.add(t.id);
  return ids.size;
}

const autoScoreBusy = () => AUTOSCORE_RUN.running || !!ENG.valRunning || !!TUNE.running || ENG.status === 'working'
  || (typeof ANALYSE !== 'undefined' && !!ANALYSE.running);

/** Why a run is due now (or null), from what the page holds. */
function autoScoreDue(now = Date.now()) {
  if (typeof autoScoreWhy !== 'function') return null;
  return autoScoreWhy({ last: autoScoreLast(), now, heard: typeof listenHeard === 'function' ? listenHeard() : 0,
    filed: autoScoreFiled(), listening: LISTEN?.state ?? null, busy: autoScoreBusy() });
}

/** One check: run Score + Tune when one is due. Returns why it ran, or null. */
async function autoScoreTick() {
  if (typeof document !== 'undefined' && document.hidden) return null;
  if (navigator.connection?.saveData) return null;
  const why = autoScoreDue();
  if (!why) return null;
  AUTOSCORE_RUN.running = true; store.touch('eng');
  let ok = false;
  try {
    await engineLoad();
    // The learnt map first (remembered on this device), so the Engine screen shows the results, not "Learn my library".
    if (ENG.status !== 'ready') await engineAnalyse();
    await engineValidate();
    ok = !!ENG.val && !ENG.val.error;
    if (ok) {
      await engineTune();
      if (TUNE.res && !TUNE.err) await tuneApply();
    }
  } catch { ok = false; }
  finally {
    autoScoreNote(why, ok);
    AUTOSCORE_RUN.running = false; store.touch('eng');
  }
  return why;
}

/** Started once from boot, after the first paint. */
function autoScoreStart() {
  if (AUTOSCORE_RUN.started) return;
  AUTOSCORE_RUN.started = true;
  const first = Number.isFinite(globalThis.BF_AUTOSCORE_MS) ? globalThis.BF_AUTOSCORE_MS : AUTOSCORE_RUN.firstMs;
  const tick = () => fire(autoScoreTick());
  setTimeout(() => { tick(); setInterval(tick, AUTOSCORE_RUN.everyMs); }, first);
}

/** The Engine screen's line under the Score buttons. */
function autoScoreText() {
  if (typeof autoScoreLine !== 'function') return '';
  return autoScoreLine(autoScoreLast(), Date.now(), { filed: LIB ? autoScoreFiled() : null, running: AUTOSCORE_RUN.running });
}
