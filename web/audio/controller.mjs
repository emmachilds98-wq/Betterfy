// Runs "Listen to my music" in the page (WP-B2): queue → analyseOne → store.
//
// The page owns three things core/audio leaves to it: storage (store.mjs),
// when to run (settings.mjs), and where inference runs. Inference goes to a
// Worker (docs/audio-worker.js) so a model run never holds the main thread;
// lookup (Deezer JSONP needs the page's frame), download, decode
// (OfflineAudioContext does not exist in a Worker) and the mel (~40 ms) stay
// here. analyseOne() from core/audio/worker.js is used unchanged, with its ear
// and heads proxied to the Worker by createWorkerEar().
//
// Stop is cooperative: the track in flight finishes and is stored, no new one
// starts. Resume is simply start() again with a fresh queue, because the
// queue skips every id whose stored answer isCurrent().
//
// DSP (WP-D4): every new record gets tempo, key and loudness measured per
// preview window (core/audio/dsp/combine.mjs). Records heard before that, or
// under an older DSP version, are topped up lazily after the queue: the
// preview is fetched again and only the DSP runs, so the embedding stays and
// nothing is invalidated. None of it is shown unless web/audio/dsp-view.mjs's
// flag is on.
//
// CLAP (WP-C2), only with deps.loadClap AND deps.clapOn() saying yes (the
// "Deep listen" switch, on by default, Wi-Fi only): its encoder is loaded on
// the first such run, new records get their `clap` field in the same pass,
// and records heard before are topped up after DSP, the same lazy way.
// Without loadClap, or with clapOn() false, nothing here differs from before.
//
// Tidy-up (DESIGN-PLAN L0): the four top-ups after the queue (DSP, CLAP, Beat
// This, key v4) used to run with no progress of their own, so a finished
// queue read "listening 1/1" for minutes. Each now sets `tidy` on the vm,
// { step, done, total }, which the pill and status lines show instead. Every
// per-track step and every model load has a time limit (core/audio/timeout.mjs):
// a step that never settles counts as failed, is tried again on a later run,
// and the run carries on to `done`.
import { withTimeout, TRACK_TIMEOUT_MS, MODEL_TIMEOUT_MS } from '../../core/audio/timeout.mjs';
import { runQueue, fillDsp } from '../../core/audio/worker.js';
import { createTimer, timeDeps } from '../../core/audio/timing.mjs';
import { createPreviewCache } from '../../core/audio/fetch.mjs';
import { MISS } from '../../core/audio/record.mjs';
import { measureWindows, needsDsp } from '../../core/audio/dsp/combine.mjs';
import { fillClap, needsClap, CLAP_FILL_PER_RUN } from '../../core/audio/clap.mjs';
import { withBeats, needsBeatsFlagged, BEATS_FILL_PER_RUN } from '../../core/audio/dsp/beats.mjs';
import { withKeyNet, keyNetFields, keepKeyNet, needsKeyNet, KEYNET_FILL_PER_RUN } from '../../core/audio/dsp/keynet.mjs';

/** Records topped up with dsp per start(), after the queue. */
export const DSP_FILL_PER_RUN = 25;

/**
 * Proxy the ear and heads to a Worker speaking { id, op, ... } → { id, ok, result|error }.
 * Buffers are transferred, not copied, and so are unusable here afterwards.
 *
 * @param {{ postMessage: Function, addEventListener: Function }} worker
 * @param {{ modelUrl: string, headUrls?: object, ortBase?: string }} init
 */
export function createWorkerEar(worker, init) {
  let seq = 0;
  const wait = new Map();
  worker.addEventListener('message', e => {
    const m = e.data || {};
    const w = wait.get(m.id);
    if (!w) return;
    wait.delete(m.id);
    m.ok ? w.ok(m.result) : w.bad(new Error(m.error || 'audio worker failed'));
  });
  worker.addEventListener('error', e => {
    const err = new Error(e?.message || 'audio worker crashed');
    for (const w of wait.values()) w.bad(err);
    wait.clear();
  });
  const call = (op, body = {}, transfer = []) => new Promise((ok, bad) => {
    const id = ++seq;
    wait.set(id, { ok, bad });
    worker.postMessage({ id, op, ...body }, transfer);
  });
  const ready = call('init', init);
  return {
    ready,
    ear: { run: async (data, patches) => { await ready; return call('ear', { data, patches }, [data.buffer]); } },
    heads: { run: async (emb, patches) => { const r = await ready; if (!r?.heads?.length) throw new Error('no heads loaded');
      return call('heads', { emb: emb.slice(), patches }); } },
    /** CLAP (WP-C2): load its encoder in the same Worker, once; then `embed`
     *  takes 48 kHz windows (transferred) and returns the record's clap field. */
    /** Beat This (tempo): load its tracker in the same Worker, once. `measure` takes the
     *  decoded 16 kHz windows (copied, since the DSP still reads them) and returns the beat tempo. */
    loadBeats: async modelUrl => {
      await ready;
      await call('beatsInit', { modelUrl });
      return { measure: windows => call('beats', { windows: windows.map(w => w.slice()) }) };
    },
    /** Key v4 (keynet.mjs): load the key model in the same Worker, once. `logp` takes the
     *  decoded 16 kHz windows (copied) and returns the model's 24 log-probabilities. */
    loadKeyNet: async modelUrl => {
      await ready;
      await call('keynetInit', { modelUrl });
      return { logp: windows => call('keynet', { windows: windows.map(w => w.slice()) }) };
    },
    loadClap: async modelUrl => {
      await ready;
      await call('clapInit', { modelUrl });
      return { embed: windows => call('clap', { windows }, windows.map(w => w.buffer)) };
    },
  };
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./store.mjs').openAudioStore>} deps.store
 * @param {Function} deps.lookup          fetch.mjs lookup with jsonp bound
 * @param {Function} deps.fetchPreview    fetch.mjs fetchPreview with fetch bound
 * @param {Function} deps.decode          decode.mjs decodeTo16k
 * @param {() => Promise<{ ear: object, heads?: object, summariseHeads?: Function }>} deps.loadEar
 *        called on the first start(): loads the models, once
 * @param {(vm: object) => void} [deps.onChange]
 * @param {() => number} [deps.now]
 * @param {((windows: Float32Array[]) => object|null) | null} [deps.dsp]
 *        per-window DSP; default measureWindows, null switches DSP off
 * @param {number} [deps.dspFillPerRun]  records topped up with dsp per start (default DSP_FILL_PER_RUN)
 * @param {() => Promise<{ decode: Function, embed: Function }>} [deps.loadClap]
 *        CLAP (WP-C2): loads its encoder, once; { decode: 48 kHz decode, embed: windows → clap field }
 * @param {() => boolean} [deps.clapOn]  asked at each start(): may CLAP download and run now?
 * @param {number} [deps.clapFillPerRun] records given CLAP per start (default CLAP_FILL_PER_RUN)
 * @param {() => Promise<{ measure: Function }>} [deps.loadBeats]
 *        Beat This (tempo): loads its tracker, once; measure(windows) → beat tempo
 * @param {() => boolean} [deps.beatsOn]  asked at each start(): may Beat This download and run now?
 * @param {number} [deps.beatsFillPerRun] flagged records given Beat This per start (default BEATS_FILL_PER_RUN)
 * @param {() => Promise<{ logp: Function }>} [deps.loadKeyNet]
 *        key v4: loads the key model, once; logp(windows) → 24 log-probabilities
 * @param {() => boolean} [deps.keyNetOn]  asked at each start(); on unless it says false (owner rule: on by default)
 * @param {number} [deps.keyNetFillPerRun] heard records given key v4 per start (default KEYNET_FILL_PER_RUN)
 * @param {number} [deps.trackTimeoutMs] per-track limit, queue and top-ups (default TRACK_TIMEOUT_MS; 0 = none)
 * @param {object} [deps.timingSeed] earlier timing samples ({ track, topup }), kept per device by the page (L1)
 * @param {(snapshot: object) => void} [deps.onTiming] called with the rolling timing samples at the end of each run
 * @param {number} [deps.modelTimeoutMs] per-model-load limit (default MODEL_TIMEOUT_MS; 0 = none)
 */
export function createAudioController(deps) {
  const st = { state: 'off', done: 0, total: 0, reason: null, failed: 0, missed: {}, heard: 0, last: null };
  let abort = null, ears = null, running = null, clapEar = null;
  const dsp = deps.dsp === undefined ? measureWindows : deps.dsp;
  const fillBudget = deps.dspFillPerRun ?? DSP_FILL_PER_RUN;
  const noFill = new Set(); // ids whose dsp can't be filled this session (different recording now, nothing measured)
  const clapBudget = deps.clapFillPerRun ?? CLAP_FILL_PER_RUN;
  const noClap = new Set();  // the same, for CLAP
  const beatsBudget = deps.beatsFillPerRun ?? BEATS_FILL_PER_RUN;
  const noBeats = new Set(); // the same, for Beat This
  let beatsTracker = null;
  const keyNetBudget = deps.keyNetFillPerRun ?? KEYNET_FILL_PER_RUN;
  const noKeyNet = new Set(); // the same, for key v4
  let keyNet = null, keyNetFailed = false;
  // L1: per-stage timing, measurement only. Every call listening makes is wrapped; nothing it returns changes.
  const timer = createTimer({ now: deps.timerNow, seed: deps.timingSeed });
  const timed = d => timeDeps(d, timer);
  // L3: the top-ups after a run share one download per record (a short-lived cache of the raw windows, made per run).
  let pc = null, toppedIds = new Set(), downloaded = 0;
  const topDeps = d => ({ ...d, lookup: pc.lookup, fetchPreview: pc.fetchPreview });
  const trackMs = deps.trackTimeoutMs ?? TRACK_TIMEOUT_MS;
  const modelMs = deps.modelTimeoutMs ?? MODEL_TIMEOUT_MS;
  /** A model load, bounded. */
  const load = (fn, what) => withTimeout(fn, modelMs, `loading the ${what}`);
  /** One top-up step on one record, bounded: a timeout is a failure, tried again on a later run. */
  const step = fn => withTimeout(fn, trackMs, 'one track').catch(e => (e?.timeout ? { failed: { stage: 'timeout', detail: e.message } } : { skip: 'error' }));
  /** Start a tidy-up step: the pill and status show it instead of the finished queue's "1/1". */
  const tidyStart = (name, total) => { st.tidy = { step: name, done: 0, total }; emit(); };
  const tidyTick = () => { timer.finish('topup'); if (st.tidy) { st.tidy.done++; emit(); } };
  const tidyEnd = () => { if (st.tidy) { st.tidy = null; emit(); } };

  /** The key v4 model when it is on and loads; null otherwise (never fails a run, not retried this session). */
  async function keyNetNow() {
    if (!deps.loadKeyNet || deps.keyNetOn?.() === false || keyNetFailed) return null;
    if (keyNet) return keyNet;
    st.reason = 'loading the key model'; emit();
    try { keyNet = await load(deps.loadKeyNet, 'key model'); } catch (e) { keyNet = null; keyNetFailed = true; st.keyNetError = String(e?.message ?? e); }
    st.reason = null; emit();
    return keyNet;
  }
  /** The dsp to measure with: v4's key on top when its model is loaded. */
  const keyed = (d, net) => (d && net ? withKeyNet(d, net) : d);

  /** The Beat This tracker when it is switched on and loads; null otherwise (never fails a run). */
  async function beatsNow() {
    if (!deps.loadBeats || !deps.beatsOn?.()) return null;
    if (beatsTracker) return beatsTracker;
    st.reason = 'loading the tempo model'; emit();
    try { beatsTracker = await load(deps.loadBeats, 'tempo model'); } catch (e) { beatsTracker = null; st.beatsError = String(e?.message ?? e); }
    st.reason = null; emit();
    return beatsTracker;
  }

  /** The CLAP ear when it is switched on and loads; null otherwise (never fails a run). */
  async function clapNow() {
    if (!deps.loadClap || !deps.clapOn?.()) return null;
    if (clapEar) return clapEar;
    st.reason = 'loading the describe-in-words model'; emit();
    try { clapEar = await load(deps.loadClap, 'describe-in-words model'); } catch (e) { clapEar = null; st.clapError = String(e?.message ?? e); }
    st.reason = null; emit();
    return clapEar;
  }

  const emit = () => { try { deps.onChange?.(vm()); } catch { /* a render bug must not stop the queue */ } };
  const vm = () => ({ state: st.state, done: st.done, total: st.total, reason: st.reason ?? undefined,
                      missed: { ...st.missed, ...(st.failed ? { [MISS.FAILED]: st.failed } : {}) },
                      heard: st.heard, last: st.last, ...(st.tidy ? { tidy: { ...st.tidy } } : {}) });

  /** Re-count heard tracks and cacheable misses from what the store holds. */
  async function refresh() {
    const all = await deps.store.getAll();
    const missed = {};
    let heard = 0;
    for (const r of all.values()) r.miss ? (missed[r.miss] = (missed[r.miss] ?? 0) + 1) : heard++;
    st.missed = missed; st.heard = heard;
    emit();
    return all;
  }

  /**
   * Analyse `tracks` in order ({ id, isrc, durationMs }), storing each answer as it lands.
   * @returns {Promise<{ done: number, stopped: boolean }>}
   */
  async function start(tracks) {
    if (running) return running;
    abort = new AbortController();
    const signal = abort.signal;
    Object.assign(st, { state: 'running', done: 0, total: tracks.length, reason: null, last: null, tidy: null });
    emit();
    running = (async () => {
      try {
        pc = createPreviewCache({ lookup: timer.wrap('lookup', deps.lookup), fetchPreview: timer.wrap('download', deps.fetchPreview), max: deps.previewCacheMax ?? 64 });
        toppedIds = new Set(); downloaded = 0;
        if (!tracks.length) {
          // Nothing new to hear: still top up dsp (it needs no model), and CLAP when it is on.
          const net = await keyNetNow();
          if (dsp && fillBudget > 0) await topUpDsp(topDeps(timed({ decode: deps.decode, dsp: keyed(dsp, net) })), signal);
          const clap = signal.aborted ? null : await clapNow();
          if (clap && clapBudget > 0) await topUpClap(topDeps(timed({ clap })), signal);
          await topUpBeats(topDeps(timed({ decode: deps.decode })), signal);
          await topUpKeyNet(topDeps(timed({ decode: deps.decode })), signal);
          st.state = signal.aborted ? 'paused' : 'done'; return { done: 0, stopped: signal.aborted };
        }
        if (!ears) {
          st.reason = 'loading the listening model'; emit();
          try { ears = await load(deps.loadEar, 'listening model'); }
          catch (e) { ears = null; st.state = 'paused'; st.reason = `couldn’t load the model: ${e?.message ?? e}`; return { done: 0, stopped: true }; }
          st.reason = null; emit();
        }
        if (signal.aborted) { st.state = 'paused'; return { done: 0, stopped: true }; }
        const clap = await clapNow();
        const net = await keyNetNow();
        const analyse = timed({ lookup: deps.lookup, fetchPreview: deps.fetchPreview, decode: deps.decode, now: deps.now,
                          ear: ears.ear, heads: ears.heads, summariseHeads: ears.summariseHeads, ...(dsp ? { dsp: keyed(dsp, net) } : {}),
                          ...(clap ? { clap } : {}) });
        const res = await runQueue(analyse, tracks, { signal, timeoutMs: trackMs, onResult: async (r, t) => {
          if (r.record) { await deps.store.put(r.record); st.heard++; }
          else if (r.miss) { await deps.store.put(r.miss); st.missed[r.miss.miss] = (st.missed[r.miss.miss] ?? 0) + 1; }
          else st.failed++;
          timer.finish('track');
          st.done++; st.last = t?.id ?? null;
          emit();
        } });
        const top = topDeps(analyse);
        if (!res.stopped && dsp && fillBudget > 0) await topUpDsp(top, signal);
        if (!res.stopped && clap && clapBudget > 0) await topUpClap(top, signal);
        if (!res.stopped) await topUpBeats(top, signal);
        if (!res.stopped) await topUpKeyNet(top, signal);
        st.state = res.stopped || signal.aborted ? 'paused' : 'done';
        return res;
      } finally {
        running = null; abort = null; st.tidy = null;
        if (pc) { downloaded = pc.stats.downloads; pc.clear(); }
        try { deps.onTiming?.(timer.snapshot()); } catch { /* a storage bug must not stop listening */ }
        emit();
      }
    })();
    return running;
  }

  /** Measure dsp for stored records that lack it, a few per run, stoppable like the queue. */
  async function topUpDsp(analyse, signal) {
    const all = await deps.store.getAll();
    const due = [...all.values()].filter(r => needsDsp(r) && !noFill.has(r.id)).slice(0, fillBudget);
    if (!due.length) return;
    tidyStart('dsp', due.length);
    try {
      for (const rec of due) {
        if (signal.aborted) return;
        const r = await step(() => (toppedIds.add(rec.id), fillDsp(analyse, rec)));
        if (r.record) r.record = { ...r.record, dsp: keepKeyNet(rec.dsp, r.record.dsp) };
        if (r.record) { await deps.store.put(r.record); st.dspFilled = (st.dspFilled ?? 0) + 1; }
        else if (r.skip) noFill.add(rec.id);
        // a failed download, or one that timed out, is tried again on a later run
        tidyTick();
      }
    } finally { tidyEnd(); }
  }

  /** Give stored records their CLAP embedding, a few per run, stoppable like the queue. */
  async function topUpClap(analyse, signal) {
    const all = await deps.store.getAll();
    const due = [...all.values()].filter(r => needsClap(r) && !noClap.has(r.id)).slice(0, clapBudget);
    if (!due.length) return;
    tidyStart('clap', due.length);
    try {
      for (const rec of due) {
        if (signal.aborted) return;
        const r = await step(() => (toppedIds.add(rec.id), fillClap(analyse, rec)));
        if (r.record) { await deps.store.put(r.record); st.clapFilled = (st.clapFilled ?? 0) + 1; }
        else if (r.skip) noClap.add(rec.id);
        // a failed download, or one that timed out, is tried again on a later run
        tidyTick();
      }
    } finally { tidyEnd(); }
  }

  /** Beat This (opt-in): re-listen to records whose half/double time the DSP flagged, a few per run. */
  async function topUpBeats(analyse, signal) {
    if (signal.aborted || beatsBudget <= 0 || !dsp) return;
    const all = await deps.store.getAll();
    const due = [...all.values()].filter(r => needsBeatsFlagged(r) && !noBeats.has(r.id)).slice(0, beatsBudget);
    if (!due.length) return;
    if (!deps.loadBeats || !deps.beatsOn?.()) return;
    tidyStart('beats', due.length);
    try {
      const tracker = await beatsNow();
      if (!tracker) return;
      const withTempo = { lookup: analyse.lookup, fetchPreview: analyse.fetchPreview, decode: analyse.decode,
                          dsp: timer.wrap('dsp', keyed(withBeats(dsp, tracker, { onlyAmbiguous: true }), keyNet)) };
      for (const rec of due) {
        if (signal.aborted) return;
        const r = await step(() => (toppedIds.add(rec.id), fillDsp(withTempo, rec)));
        if (r.record) {
          r.record = { ...r.record, dsp: keepKeyNet(rec.dsp, r.record.dsp) };
          await deps.store.put(r.record);
          if (r.record.dsp?.beatsV) st.beatsFilled = (st.beatsFilled ?? 0) + 1;
          else noBeats.add(rec.id);   // the tracker failed on it: not again this session
        } else if (r.skip) noBeats.add(rec.id);
        tidyTick();
      }
    } finally { tidyEnd(); }
  }

  /**
   * Key v4: give heard records the learned key, a few per run. Only the key
   * fields change (tempo, Beat This and loudness are kept as they are).
   */
  async function topUpKeyNet(analyse, signal) {
    if (signal.aborted || keyNetBudget <= 0 || !dsp) return;
    const all = await deps.store.getAll();
    const due = [...all.values()].filter(r => needsKeyNet(r) && !noKeyNet.has(r.id)).slice(0, keyNetBudget);
    if (!due.length) return;
    if (!deps.loadKeyNet || deps.keyNetOn?.() === false || keyNetFailed) return;
    tidyStart('keys', due.length);
    try {
      const net = await keyNetNow();
      if (!net) return;
      for (const rec of due) {
        if (signal.aborted) return;
        const onlyKey = { lookup: analyse.lookup, fetchPreview: analyse.fetchPreview, decode: analyse.decode,
                          dsp: timer.wrap('dsp', async windows => { const f = await keyNetFields(net, windows, rec.dsp); return f ? { ...rec.dsp, ...f } : null; }) };
        const r = await step(() => (toppedIds.add(rec.id), fillDsp(onlyKey, rec)));
        if (r.record) { await deps.store.put(r.record); st.keyNetFilled = (st.keyNetFilled ?? 0) + 1; }
        else if (r.skip) noKeyNet.add(rec.id);
        tidyTick();
      }
    } finally { tidyEnd(); }
  }

  /** Finish the track in flight, start no more. */
  function stop(reason = 'stopped') {
    if (!abort) return Promise.resolve(null);
    st.reason = reason;
    abort.abort();
    emit();
    return running;
  }

  /** Resolves when no run is going (at once if none is). The second ear waits on this. */
  const whenIdle = () => (running ? running.then(() => undefined, () => undefined) : Promise.resolve());

  return { start, stop, refresh, vm, whenIdle, timing: () => timer.snapshot(),
    /** L3: preview downloads and distinct records topped up in the last run (bar: downloads <= 1.1 x records). */
    topupDownloads: () => ({ downloads: pc ? pc.stats.downloads : downloaded, records: toppedIds.size }), get running() { return !!running; } };
}

/** ListenVM for web/ui/sound.mjs, from the controller's state and the settings. */
export function listenVM(ctrl, settings) {
  const v = ctrl ? ctrl.vm() : { state: 'off', done: 0, total: 0, missed: {} };
  if (!settings?.on && v.state !== 'running') return { ...v, state: 'off' };
  return v;
}

/**
 * ProfileVM for one playlist: how many of its members have been heard, and
 * its most common top styles. `labels` is the model's 400 class names.
 */
export function profileVM(playlist, records, labels = null) {
  const ids = [...new Set((playlist?.tracks ?? []).map(t => t?.id).filter(Boolean))];
  const counts = new Map();
  let heard = 0;
  for (const id of ids) {
    const r = records?.get?.(id);
    if (!r || r.miss) continue;
    heard++;
    const top = r.styles?.[0]?.[0];
    if (top != null) counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  const styles = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([i, n]) => [styleName(labels?.[i]) ?? `style ${i}`, +(n / Math.max(1, heard)).toFixed(2)]);
  return { heard, members: ids.length, ...(styles.length ? { styles } : {}) };
}

/** "Electronic---Bassline" → "Bassline". */
export function styleName(label) {
  if (typeof label !== 'string') return null;
  const i = label.indexOf('---');
  return i >= 0 ? label.slice(i + 3) : label;
}

/** Plain-English reasons for the "couldn't be heard" list. */
export const MISS_TEXT = Object.freeze({
  NO_ISRC: 'Spotify gave no recording code (ISRC), so there is nothing safe to look up',
  NOT_ON_DEEZER: 'not on Deezer',
  NO_PREVIEW: 'on Deezer, but with no preview to listen to',
  IDENTITY: 'Deezer’s version is a different length, so probably a different recording',
  TOO_SHORT: 'the preview was too short to hear',
  FAILED: 'a download or decode failed this session (it will be tried again)',
});
