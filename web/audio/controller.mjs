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
// "Deep listen" switch, off by default, Wi-Fi only): its encoder is loaded on
// the first such run, new records get their `clap` field in the same pass,
// and records heard before are topped up after DSP, the same lazy way.
// Without loadClap, or with clapOn() false, nothing here differs from before.
import { runQueue, fillDsp } from '../../core/audio/worker.js';
import { MISS } from '../../core/audio/record.mjs';
import { measureWindows, needsDsp } from '../../core/audio/dsp/combine.mjs';
import { fillClap, needsClap, CLAP_FILL_PER_RUN } from '../../core/audio/clap.mjs';

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
 */
export function createAudioController(deps) {
  const st = { state: 'off', done: 0, total: 0, reason: null, failed: 0, missed: {}, heard: 0, last: null };
  let abort = null, ears = null, running = null, clapEar = null;
  const dsp = deps.dsp === undefined ? measureWindows : deps.dsp;
  const fillBudget = deps.dspFillPerRun ?? DSP_FILL_PER_RUN;
  const noFill = new Set(); // ids whose dsp can't be filled this session (different recording now, nothing measured)
  const clapBudget = deps.clapFillPerRun ?? CLAP_FILL_PER_RUN;
  const noClap = new Set();  // the same, for CLAP

  /** The CLAP ear when it is switched on and loads; null otherwise (never fails a run). */
  async function clapNow() {
    if (!deps.loadClap || !deps.clapOn?.()) return null;
    if (clapEar) return clapEar;
    st.reason = 'loading the describe-in-words model'; emit();
    try { clapEar = await deps.loadClap(); } catch (e) { clapEar = null; st.clapError = String(e?.message ?? e); }
    st.reason = null; emit();
    return clapEar;
  }

  const emit = () => { try { deps.onChange?.(vm()); } catch { /* a render bug must not stop the queue */ } };
  const vm = () => ({ state: st.state, done: st.done, total: st.total, reason: st.reason ?? undefined,
                      missed: { ...st.missed, ...(st.failed ? { [MISS.FAILED]: st.failed } : {}) },
                      heard: st.heard, last: st.last });

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
    Object.assign(st, { state: 'running', done: 0, total: tracks.length, reason: null, last: null });
    emit();
    running = (async () => {
      try {
        if (!tracks.length) {
          // Nothing new to hear: still top up dsp (it needs no model), and CLAP when it is on.
          if (dsp && fillBudget > 0) await topUpDsp({ lookup: deps.lookup, fetchPreview: deps.fetchPreview, decode: deps.decode, dsp }, signal);
          const clap = signal.aborted ? null : await clapNow();
          if (clap && clapBudget > 0) await topUpClap({ lookup: deps.lookup, fetchPreview: deps.fetchPreview, clap }, signal);
          st.state = signal.aborted ? 'paused' : 'done'; return { done: 0, stopped: signal.aborted };
        }
        if (!ears) {
          st.reason = 'loading the listening model'; emit();
          try { ears = await deps.loadEar(); }
          catch (e) { ears = null; st.state = 'paused'; st.reason = `couldn’t load the model: ${e?.message ?? e}`; return { done: 0, stopped: true }; }
          st.reason = null; emit();
        }
        if (signal.aborted) { st.state = 'paused'; return { done: 0, stopped: true }; }
        const clap = await clapNow();
        const analyse = { lookup: deps.lookup, fetchPreview: deps.fetchPreview, decode: deps.decode, now: deps.now,
                          ear: ears.ear, heads: ears.heads, summariseHeads: ears.summariseHeads, ...(dsp ? { dsp } : {}),
                          ...(clap ? { clap } : {}) };
        const res = await runQueue(analyse, tracks, { signal, onResult: async (r, t) => {
          if (r.record) { await deps.store.put(r.record); st.heard++; }
          else if (r.miss) { await deps.store.put(r.miss); st.missed[r.miss.miss] = (st.missed[r.miss.miss] ?? 0) + 1; }
          else st.failed++;
          st.done++; st.last = t?.id ?? null;
          emit();
        } });
        if (!res.stopped && dsp && fillBudget > 0) await topUpDsp(analyse, signal);
        if (!res.stopped && clap && clapBudget > 0) await topUpClap(analyse, signal);
        st.state = res.stopped || signal.aborted ? 'paused' : 'done';
        return res;
      } finally {
        running = null; abort = null;
        emit();
      }
    })();
    return running;
  }

  /** Measure dsp for stored records that lack it, a few per run, stoppable like the queue. */
  async function topUpDsp(analyse, signal) {
    const all = await deps.store.getAll();
    const due = [...all.values()].filter(r => needsDsp(r) && !noFill.has(r.id)).slice(0, fillBudget);
    for (const rec of due) {
      if (signal.aborted) return;
      let r;
      try { r = await fillDsp(analyse, rec); } catch { r = { skip: 'error' }; }
      if (r.record) { await deps.store.put(r.record); st.dspFilled = (st.dspFilled ?? 0) + 1; emit(); }
      else if (r.skip) noFill.add(rec.id);
      // a failed download is tried again on a later run
    }
  }

  /** Give stored records their CLAP embedding, a few per run, stoppable like the queue. */
  async function topUpClap(analyse, signal) {
    const all = await deps.store.getAll();
    const due = [...all.values()].filter(r => needsClap(r) && !noClap.has(r.id)).slice(0, clapBudget);
    for (const rec of due) {
      if (signal.aborted) return;
      let r;
      try { r = await fillClap(analyse, rec); } catch { r = { skip: 'error' }; }
      if (r.record) { await deps.store.put(r.record); st.clapFilled = (st.clapFilled ?? 0) + 1; emit(); }
      else if (r.skip) noClap.add(rec.id);
      // a failed download is tried again on a later run
    }
  }

  /** Finish the track in flight, start no more. */
  function stop(reason = 'stopped') {
    if (!abort) return Promise.resolve(null);
    st.reason = reason;
    abort.abort();
    emit();
    return running;
  }

  return { start, stop, refresh, vm, get running() { return !!running; } };
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
