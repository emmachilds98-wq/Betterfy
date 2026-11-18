// Time limits for the listening runs (docs/DESIGN-PLAN.md L0).
//
// One preview download, decode or model call that never settles must not
// leave a run "listening" for ever. Each per-track step and each model load
// is raced against a timer; when the timer wins, the step counts as failed
// (tried again on a later run) and the run carries on. The step itself can't
// be cancelled, so its late answer, if it ever comes, is simply ignored.

/** Per track: lookup, download, decode and the model call together. */
export const TRACK_TIMEOUT_MS = 60_000;
/** Per model load (the largest, CLAP, is about 77 MB, on Wi-Fi only). */
export const MODEL_TIMEOUT_MS = 5 * 60_000;

export class TimeoutError extends Error {
  constructor(what, ms) {
    super(`${what} took longer than ${ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`}`);
    this.name = 'TimeoutError';
    this.timeout = true;
  }
}

/**
 * `p` (a promise, or a function returning one), or a TimeoutError after `ms`.
 * A missing, zero or non-finite `ms` means no limit.
 * @template T
 * @param {Promise<T> | (() => Promise<T>)} p
 * @param {number} ms
 * @param {string} [what]
 * @returns {Promise<T>}
 */
export function withTimeout(p, ms, what = 'this step') {
  const work = typeof p === 'function' ? Promise.resolve().then(p) : Promise.resolve(p);
  if (!(ms > 0) || !Number.isFinite(ms)) return work;
  let timer;
  const limit = new Promise((_, bad) => { timer = setTimeout(() => bad(new TimeoutError(what, ms)), ms); });
  work.catch(() => {}); // a late failure after the timer won is nobody's business
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}
