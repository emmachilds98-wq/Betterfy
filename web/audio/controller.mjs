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
import { runQueue } from '../../core/audio/worker.js';
import { MISS } from '../../core/audio/record.mjs';

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
 */
export function createAudioController(deps) {
  const st = { state: 'off', done: 0, total: 0, reason: null, failed: 0, missed: {}, heard: 0, last: null };
  let abort = null, ears = null, running = null;

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
        if (!tracks.length) { st.state = 'done'; return { done: 0, stopped: false }; }
        if (!ears) {
          st.reason = 'loading the listening model'; emit();
          try { ears = await deps.loadEar(); }
          catch (e) { ears = null; st.state = 'paused'; st.reason = `couldn’t load the model: ${e?.message ?? e}`; return { done: 0, stopped: true }; }
          st.reason = null; emit();
        }
        if (signal.aborted) { st.state = 'paused'; return { done: 0, stopped: true }; }
        const analyse = { lookup: deps.lookup, fetchPreview: deps.fetchPreview, decode: deps.decode, now: deps.now,
                          ear: ears.ear, heads: ears.heads, summariseHeads: ears.summariseHeads };
        const res = await runQueue(analyse, tracks, { signal, onResult: async (r, t) => {
          if (r.record) { await deps.store.put(r.record); st.heard++; }
          else if (r.miss) { await deps.store.put(r.miss); st.missed[r.miss.miss] = (st.missed[r.miss.miss] ?? 0) + 1; }
          else st.failed++;
          st.done++; st.last = t?.id ?? null;
          emit();
        } });
        st.state = res.stopped ? 'paused' : 'done';
        return res;
      } finally {
        running = null; abort = null;
        emit();
      }
    })();
    return running;
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
