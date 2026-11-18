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
  AUTOSCORE_RUN.running = true; AUTOSCORE_RUN.why = why; store.touch('eng');
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
  runHistorySeed();
  const first = Number.isFinite(globalThis.BF_AUTOSCORE_MS) ? globalThis.BF_AUTOSCORE_MS : AUTOSCORE_RUN.firstMs;
  const tick = () => fire(autoScoreTick());
  setTimeout(() => { tick(); setInterval(tick, AUTOSCORE_RUN.everyMs); }, first);
}

/** The Engine screen's line under the Score buttons. */
function autoScoreText() {
  if (typeof autoScoreLine !== 'function') return '';
  return autoScoreLine(autoScoreLast(), Date.now(), { filed: LIB ? autoScoreFiled() : null, running: AUTOSCORE_RUN.running });
}

/* ---------- every run, kept (docs/BUILD-7-PLAN.md M1) ----------
 * Each Score run's full report (the same text Copy results gives), and the end
 * of each listening run, first ear and second, kept on this device in
 * bf_run_history so the Engine screen can list them with a Copy each, long
 * after the tab that ran them is closed. Read-only for the runs themselves:
 * nothing here starts, stops or slows a run. */
const RUNHIST_KEY = 'bf_run_history';

function runHistoryList() {
  let raw = null;
  try { raw = LS.getItem(RUNHIST_KEY); } catch { raw = null; }
  return typeof runHistoryParse === 'function' ? runHistoryParse(raw) : [];
}

/** Once, at boot and before any run can overwrite what it reads: an empty list gets the rebuilt entry. */
function runHistorySeed() {
  try {
    if (typeof runHistoryParse !== 'function' || runHistoryParse(LS.getItem(RUNHIST_KEY)).length) return;
    const old = runHistoryRecovered();
    if (old.length) runHistoryWrite(old);
  } catch { /* nothing to rebuild */ }
}

function runHistoryWrite(list) {
  // A full localStorage drops the reports' text from the oldest runs first, then the oldest runs.
  for (let i = 0; i <= list.length; i++) {
    try { LS.setItem(RUNHIST_KEY, JSON.stringify(list)); return true; } catch { /* full: trim */ }
    const j = list.length - 1 - i;
    if (j < 1) break;
    list = list.map((r, k) => (k >= j ? { ...r, text: undefined } : r));
  }
  return false;
}

function runHistoryPut(run) {
  if (typeof runHistoryAdd !== 'function' || !run) return null;
  let raw = null;
  try { raw = LS.getItem(RUNHIST_KEY); } catch { raw = null; }
  const list = runHistoryAdd(raw ?? [], run);
  runHistoryWrite(list);
  store.touch('eng');
  return run;
}

/** The gates a Score run decided, as on/off, for the history's "switched on" lines. Unknown stays out. */
function scoreGates(v) {
  const b = x => (typeof x === 'boolean' ? x : undefined);
  const out = {
    audio: b(v?.mine?.withAudio?.gate?.pass),
    ear: v?.ear?.ear ? v.ear.ear !== 'effnet' : b(v?.earChoice?.gate?.pass),
    family: b(v?.family?.use ?? v?.family?.pass),
    mood: b(v?.mood?.pass ?? v?.mood?.gate?.pass),
    agree: b(v?.agree?.pass ?? v?.agree?.gate?.pass),
    pairs: b(v?.pairs?.pass ?? v?.pairs?.gate?.pass),
    near: b(v?.near?.pass ?? v?.near?.gate?.pass),
    teach: b(v?.teach?.pass),
    fill: b(v?.fill?.pass),
    weights: b(v?.weights?.plain?.use),
  };
  try { const g = SCREEN_MODS.engine?.bridgeVerdict?.(v); if (g) out.bridge = b(g.pass); } catch { /* left out */ }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

const SCORE_KEPT = new WeakMap();
/** Keep the Score run just shown on the Engine screen (and its Tune sweep, once that is in). */
async function scoreHistorySave(why) {
  const v = typeof ENG !== 'undefined' ? ENG.val : null;
  if (!v || v.error || !v.mine) return null;
  // When and why, per Score result (never written onto ENG.val itself): the Tune block rewrites the same entry.
  const k = SCORE_KEPT.get(v) ?? { at: Date.now(), why: why ?? 'manual' };
  SCORE_KEPT.set(v, k);
  let text = '';
  try {
    const log = await (typeof getLog === 'function' ? getLog({ all: true }).catch(() => null) : null);
    text = SCREEN_MODS.engine?.summary ? SCREEN_MODS.engine.summary(screenCtx('engine'), log) : '';
  } catch { text = ''; }
  const sure = ENG.calib?.base?.checked?.confidentShare;
  return runHistoryPut({ kind: 'score', at: k.at, build: BUILD, why: k.why,
    top1: v.mine.top1 ?? null, top3: v.mine.top3 ?? null, scored: v.mine.scored ?? null,
    sure: Number.isFinite(sure) ? sure : null, neverFiled: v.mine.neverFiled?.top1 ?? null,
    gates: scoreGates(v), tuned: !!(TUNE?.res && !TUNE.err), text });
}

/* Listening runs: the controller's view model goes running -> done/paused at
 * the end of a run; that edge is written down, once per run. */
const RUNHIST_WATCH = { listen: { running: false, since: null }, deep: { running: false, since: null } };
function runHistoryWatch(kind, vm) {
  const w = RUNHIST_WATCH[kind];
  if (!w || !vm) return;
  if (vm.state === 'running') { if (!w.running) { w.running = true; w.since = Date.now(); } return; }
  if (!w.running) return;
  w.running = false;
  try {
    const A = globalThis.BetterfyAudio;
    const extra = [];
    if (kind === 'listen' && AUDIO?.records) {
      const heard = [...AUDIO.records.values()].filter(r => !r.miss);
      const d = typeof deepSettings === 'function' ? deepSettings() : {};
      if (d.clap && A?.needsClap) extra.push(`Described by CLAP: ${heard.filter(r => !A.needsClap(r)).length} of ${heard.length} heard`);
      if (d.beats && A?.needsBeatsFlagged) {
        const flagged = heard.filter(r => r.dsp?.octaveAmbiguous === true);
        extra.push(`Unsure tempos re-checked by Beat This: ${flagged.filter(r => !A.needsBeatsFlagged(r)).length} of ${flagged.length}`);
      }
    }
    const run = listenRunEntry(kind, vm, { at: Date.now(), startedAt: w.since, build: BUILD, extra, missText: A?.MISS_TEXT });
    if (run) runHistoryPut(run);
  } catch { /* the run itself is untouched */ }
}

/* Runs from before this list existed: the full report was never saved, but the
 * device kept its headline and the verdicts it acted on. Shown once as one
 * "rebuilt" entry, so there is something to hand over. Never written back. */
function runHistoryRecovered() {
  const read = k => { try { return JSON.parse(LS.getItem(k) || 'null'); } catch { return null; } };
  const sc = read('bf_engscore'), au = read('bf_autoscore');
  if (!Number.isFinite(sc?.top1) && !Number.isFinite(au?.at)) return [];
  const pc = x => (x == null ? '—' : Math.round(x * 100) + '%');
  const fill = read('bf_fill'), teach = read('bf_teach'), weak = read('bf_weak');
  const E = SCREEN_MODS.engine ?? {};
  const plName = id => LIB?.playlists?.find(p => p.id === id)?.name ?? id;
  const at = Number.isFinite(au?.at) ? au.at : sc?.at ?? Date.now();
  const lines = [
    'Betterfy engine score, rebuilt from what this device kept (runs before run history existed only kept their headline)',
    au?.at ? `Last run: ${runWhen(au.at)}, ${au.why ?? 'by itself'}${au.ok === false ? ", didn't finish" : ''}; listening had heard ${Number(au.heard || 0)} tracks then` : null,
    Number.isFinite(sc?.top1) ? `This engine: top-1 ${pc(sc.top1)}, top-3 ${pc(sc.top3)} (${sc.scored ?? '?'} tracks)` : null,
    fill && E.fillLine ? E.fillLine(fill, pc) : null,
    teach && E.teachLine ? E.teachLine(teach, pc) : null,
    weak?.rows?.length ? `Weakest, as File places: ${weak.rows.map(r => `${plName(r.id)} ${pc(r.inTop3)} of ${r.n ?? '?'}${r.cause ? ` (${r.cause})` : ''}`).join('; ')}` : null,
  ];
  return [{ kind: 'score', at, build: '', why: au?.why ?? null, recovered: true,
            top1: sc?.top1 ?? null, top3: sc?.top3 ?? null, scored: sc?.scored ?? null,
            text: lines.filter(Boolean).join('\n') }];
}

/** The Engine screen's list: each run with the change from the one before it, in words. */
function runHistoryView() {
  const list = runHistoryList();
  return list.map((r, i) => {
    const prev = r.kind === 'score' ? list.slice(i + 1).find(x => x.kind === 'score') : null;
    return { ...r, when: runWhen(r.at), diff: prev && typeof scoreDiff === 'function' ? scoreDiff(prev, r) : [] };
  });
}
