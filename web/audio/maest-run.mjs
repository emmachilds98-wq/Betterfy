// The laptop "second ear" run (WP-C1): give heard tracks a MAEST answer.
//
// It never hears a new track by itself. It walks the records "Listen to my
// music" already stored, oldest first, and tops up those without a current
// `maest` field, MAEST_PER_RUN per start(). Each one is looked up and
// downloaded again (the preview URL is never kept, so there is nothing to
// reuse), decoded, and run through MAEST; core/audio/maest.mjs fillMaest()
// holds the rules. A track whose ISRC now finds another recording, or nothing,
// is left alone for the session.
//
// The page decides *whether* it may run (web/audio/deep-settings.mjs:
// switched on, Wi-Fi, deviceMemory >= 8 or the override). This only runs,
// stops cooperatively after the track in flight, and reports progress.
//
// Inference sits in its own Worker (docs/maest-worker.js) so the ~90 MB model
// can be dropped with `release()` when the run is done, without touching the
// first ear's worker.
import { fillMaest, needsMaest } from '../../core/audio/maest.mjs';

export const MAEST_PER_RUN = 50;

/**
 * Proxy MAEST to a Worker speaking { id, op, ... } → { id, ok, result|error }.
 * @param {{ postMessage: Function, addEventListener: Function, terminate?: Function }} worker
 * @param {{ modelUrl: string, ortBase?: string }} init
 */
export function createWorkerMaest(worker, init) {
  let seq = 0;
  const wait = new Map();
  worker.addEventListener('message', e => {
    const m = e.data || {};
    const w = wait.get(m.id);
    if (!w) return;
    wait.delete(m.id);
    m.ok ? w.ok(m.result) : w.bad(new Error(m.error || 'MAEST worker failed'));
  });
  worker.addEventListener('error', e => {
    const err = new Error(e?.message || 'MAEST worker crashed');
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
    run: async (data, patches) => { await ready; return call('maest', { data, patches }, [data.buffer]); },
    release: () => { try { worker.terminate?.(); } catch { /* already gone */ } },
  };
}

/**
 * @param {object} deps
 * @param {{ getAll(): Promise<Map>, put(rec): Promise<boolean> }} deps.store
 * @param {Function} deps.lookup         fetch.mjs lookup with jsonp bound
 * @param {Function} deps.fetchPreview   fetch.mjs fetchPreview with fetch bound
 * @param {Function} deps.decode         decode.mjs decodeTo16k
 * @param {() => Promise<{ run: Function, release?: Function }>} deps.loadMaest  loads the model, once per start
 * @param {(vm: object) => void} [deps.onChange]
 * @param {number} [deps.perRun]
 */
export function createMaestRunner(deps) {
  const perRun = deps.perRun ?? MAEST_PER_RUN;
  const st = { state: 'off', done: 0, total: 0, heard: 0, waiting: 0, failed: 0, reason: null };
  const skip = new Set();
  let abort = null, running = null;
  const vm = () => ({ ...st });
  const emit = () => { try { deps.onChange?.(vm()); } catch { /* a render bug must not stop the run */ } };

  /** How many stored records have, and still need, a second ear. */
  async function refresh() {
    const all = await deps.store.getAll();
    let heard = 0, waiting = 0;
    for (const r of all.values()) {
      if (r.miss) continue;
      if (needsMaest(r)) { if (!skip.has(r.id)) waiting++; } else heard++;
    }
    Object.assign(st, { heard, waiting });
    emit();
    return all;
  }

  async function start() {
    if (running) return running;
    abort = new AbortController();
    const signal = abort.signal;
    running = (async () => {
      let ear = null;
      try {
        const all = await refresh();
        const due = [...all.values()].filter(r => needsMaest(r) && !skip.has(r.id))
          .sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || (a.id < b.id ? -1 : 1)).slice(0, perRun);
        Object.assign(st, { state: 'running', done: 0, total: due.length, reason: null });
        emit();
        if (!due.length) { st.state = 'done'; return { done: 0, stopped: false }; }
        st.reason = 'loading the second ear'; emit();
        try { ear = await deps.loadMaest(); }
        catch (e) { st.state = 'paused'; st.reason = `couldn’t load the second ear: ${e?.message ?? e}`; return { done: 0, stopped: true }; }
        st.reason = null; emit();
        const fill = { lookup: deps.lookup, fetchPreview: deps.fetchPreview, decode: deps.decode, maest: ear };
        for (const rec of due) {
          if (signal.aborted) break;
          let r;
          try { r = await fillMaest(fill, rec); } catch (e) { r = { failed: { id: rec.id, stage: 'unknown', detail: String(e?.message ?? e) } }; }
          if (r.record) { await deps.store.put(r.record); st.heard++; st.waiting = Math.max(0, st.waiting - 1); }
          else if (r.skip) { skip.add(rec.id); st.waiting = Math.max(0, st.waiting - 1); }
          else st.failed++; // tried again on a later run
          st.done++;
          emit();
        }
        st.state = signal.aborted ? 'paused' : 'done';
        return { done: st.done, stopped: signal.aborted };
      } finally {
        try { await ear?.release?.(); } catch { /* nothing to free */ }
        running = null; abort = null;
        emit();
      }
    })();
    return running;
  }

  function stop(reason = 'stopped') {
    if (!abort) return Promise.resolve(null);
    st.reason = reason;
    abort.abort();
    emit();
    return running;
  }

  return { start, stop, refresh, vm, get running() { return !!running; } };
}

/** One line for the Deep listen block. */
export function maestStatusText(v) {
  if (!v) return '';
  const n = x => x.toLocaleString('en-GB');
  if (v.state === 'running') return v.reason ? `Second ear: ${v.reason}…` : `Second ear: listening… ${n(v.done)} of ${n(v.total)} this run.`;
  const tail = `${n(v.heard)} track${v.heard === 1 ? '' : 's'} heard by the second ear${v.waiting ? `, ${n(v.waiting)} still to go` : ''}.`;
  if (v.state === 'paused') return `Second ear stopped${v.reason && v.reason !== 'stopped' ? `: ${v.reason}` : ''}. ${tail}`;
  return tail;
}
