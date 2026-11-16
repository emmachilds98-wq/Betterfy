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
import { earCurrent, withEar } from '../../core/audio/record.mjs';
import { NEAR_DEFAULT } from '../../core/intrinsic/audio.mjs';

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

  /** The stored record with this run's MAEST answer on it; the run's own copy if
   *  the store can't say. Null if it was re-heard as another recording meanwhile. */
  async function latest(was, heard) {
    let now = null;
    try { now = await deps.store.get?.(was.id); } catch { now = null; }
    if (!now || now === was) return heard;
    if (now.miss || now.source?.deezerId !== was.source?.deezerId) return null;
    return withEar(now, 'maest', heard.maest);
  }

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
          // Put the ear on the record as it is now, not as it was when the run began:
          // a listening run may have added CLAP or DSP to it meanwhile (WP-C2).
          if (r.record) { const now = await latest(rec, r.record); r = now ? { record: now } : { skip: 'different-recording' }; }
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

/**
 * The ear the page should place with, from the stored Score verdict
 * (core/validate/gate.mjs earChoice) and the records it has. 'effnet' unless
 * that Score run chose a second ear, its gate passed, and records with a
 * current MAEST answer exist. So switching Deep listen on, or hearing tracks
 * with it, changes no suggestion by itself: only a Score run can.
 */
export function chosenEar(choice, records) {
  const ear = choice?.ear;
  if (ear !== 'maest' && ear !== 'both') return 'effnet';
  if (choice.gate?.pass !== true) return 'effnet';
  for (const r of records?.values?.() ?? records ?? []) if (earCurrent(r, 'maest')) return ear;
  return 'effnet';
}

/** Records the Score run should also score with the second ear: only when some have one. */
export function scoreArms(records) {
  let any = false;
  for (const r of records?.values?.() ?? records ?? []) {
    if (earCurrent(r, 'maest')) return ['maest', 'both', 'near'];
    any = true;
  }
  // 'near' (ENGINE-REVIEW layer 1): the first ear scored against each
  // playlist's nearest heard tracks too. gate.mjs nearChoice decides it.
  return any ? ['near'] : null;
}

/** The nearest-members setting the Score arm uses (core/intrinsic/audio.mjs NEAR_DEFAULT). */
export const NEAR_SETTING = NEAR_DEFAULT;

/**
 * May the File engine mix in each playlist's nearest tracks? Only when a Score
 * run chose it (`choice.near`), and only for the first ear, which is what the
 * arm measured.
 */
export function nearInUse(choice, ear = 'effnet') {
  return ear === 'effnet' && choice?.near === true;
}

/** The Score card's line for nearest tracks, or '' when the run had no such arm. */
export function nearScoreText(w) {
  return w?.nearChoice?.text ?? '';
}

/** The Score card's line for the second ear, or '' without arms. Counts and rates only. */
export function maestScoreText(w, pc = x => (x == null ? '—' : `${Math.round(x * 1000) / 10}%`)) {
  const m = w?.arms?.maest;
  if (!m) return '';
  const b = w.arms.both, c = w.choice ?? {};
  return `Second ear (MAEST): top-1 ${pc(m.top1)}, never-filed ${pc(m.neverFiled?.top1)}, ${m.heard} heard`
    + (b ? `; both ears: top-1 ${pc(b.top1)}, never-filed ${pc(b.neverFiled?.top1)}` : '')
    + `; first ear: top-1 ${pc(w.top1)}, never-filed ${pc(w.neverFiled?.top1)}. `
    + `Placing with: ${c.ear === 'maest' ? 'the second ear' : c.ear === 'both' ? 'both ears' : 'the first ear'} (${c.reason ?? '—'})`;
}
