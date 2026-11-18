// Per-stage timing of listening (SOUND-ENGINE-PLAN L1). Measurement only: it
// wraps the functions listening already calls, adds up how long each took, and
// never changes what is heard, stored or ranked. Nothing is sent anywhere; the
// page keeps the last few samples per device in localStorage (bf_listen_timing).
//
// Stages: lookup (Deezer, by ISRC), download (the preview windows), decode,
// model (the listening model, its heads, CLAP), dsp (tempo and key). A "track"
// sample is one track heard from scratch; a "topup" sample is one stored
// record given a missing field (tempo/key, CLAP, Beat This, key v4), which
// downloads the preview again.

export const STAGES = Object.freeze(['lookup', 'download', 'decode', 'model', 'dsp']);
/** Samples kept per kind: a rolling window, so the median follows the device's current state. */
export const TIMING_KEEP = 60;

const nowMs = () => (globalThis.performance?.now ? performance.now() : Date.now());

const validSample = s => s && typeof s === 'object' && STAGES.some(k => Number.isFinite(s[k]) && s[k] >= 0);

/**
 * @param {{ now?: () => number, seed?: { track?: object[], topup?: object[] } }} [o]
 */
export function createTimer({ now = nowMs, seed } = {}) {
  const keep = { track: [], topup: [] };
  for (const k of Object.keys(keep)) keep[k] = (Array.isArray(seed?.[k]) ? seed[k] : []).filter(validSample).slice(-TIMING_KEEP);
  let cur = {};
  /** Wrap an async (or sync) function so its time lands in `stage` of the sample being built. */
  const wrap = (stage, fn) => typeof fn !== 'function' ? fn : async (...a) => {
    const t0 = now();
    try { return await fn(...a); } finally { cur[stage] = (cur[stage] ?? 0) + Math.max(0, now() - t0); }
  };
  /** Close the sample being built as one `kind` ('track' or 'topup'); samples with no time are dropped. */
  const finish = kind => {
    const ms = {};
    let total = 0;
    for (const s of STAGES) if (cur[s] > 0) { ms[s] = Math.round(cur[s]); total += ms[s]; }
    cur = {};
    if (!total || !keep[kind]) return null;
    keep[kind].push(ms);
    if (keep[kind].length > TIMING_KEEP) keep[kind].shift();
    return ms;
  };
  const snapshot = () => ({ track: keep.track.map(x => ({ ...x })), topup: keep.topup.map(x => ({ ...x })) });
  return { wrap, finish, snapshot };
}

/**
 * `deps` (lookup, fetchPreview, decode, ear, heads, dsp, clap) with every
 * call timed into `timer`. Same shape, same results; the originals are untouched.
 */
export function timeDeps(deps, timer) {
  const out = { ...deps };
  if (deps.lookup) out.lookup = timer.wrap('lookup', deps.lookup);
  if (deps.fetchPreview) out.fetchPreview = timer.wrap('download', deps.fetchPreview);
  if (deps.decode) out.decode = timer.wrap('decode', deps.decode);
  if (deps.ear) out.ear = { ...deps.ear, run: timer.wrap('model', deps.ear.run) };
  if (deps.heads) out.heads = { ...deps.heads, run: timer.wrap('model', deps.heads.run) };
  if (deps.dsp) out.dsp = timer.wrap('dsp', deps.dsp);
  if (deps.clap) out.clap = { ...deps.clap, decode: timer.wrap('decode', deps.clap.decode), embed: timer.wrap('model', deps.clap.embed) };
  return out;
}

const median = xs => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Samples → what the page shows: the median per stage, the median total, and
 * how many a minute that is. `perMin` is 0 with no samples.
 * @returns {{ n: number, ms: Record<string, number>, total: number, perMin: number }}
 */
export function summariseTimings(samples) {
  const list = (samples ?? []).filter(validSample);
  const ms = {};
  for (const s of STAGES) ms[s] = Math.round(median(list.map(x => x[s] ?? 0)));
  const total = Math.round(median(list.map(x => STAGES.reduce((n, s) => n + (x[s] ?? 0), 0))));
  return { n: list.length, ms, total, perMin: total > 0 ? Math.round((60000 / total) * 10) / 10 : 0 };
}

const secs = ms => (ms / 1000).toFixed(1);

/** "about 2.1 s a track (29 a minute): 0.9 s waiting for Deezer, 0.8 s hearing"; '' with too few samples. */
export function timingLine(samples, { min = 3 } = {}) {
  const s = summariseTimings(samples);
  if (s.n < min || !s.total) return '';
  const wait = s.ms.lookup + s.ms.download, hear = s.ms.decode + s.ms.model + s.ms.dsp;
  const perMin = s.perMin >= 10 ? Math.round(s.perMin) : s.perMin;
  return `about ${secs(s.total)} s a track (${perMin} a minute): ${secs(wait)} s waiting for Deezer, ${secs(hear)} s hearing`;
}

/** The device, in a few plain words, so a phone run and a computer run can be compared. */
export function deviceClass(nav = {}) {
  const cores = Number.isFinite(nav.hardwareConcurrency) ? nav.hardwareConcurrency : null;
  const gb = Number.isFinite(nav.deviceMemory) ? nav.deviceMemory : null;
  const kind = nav.mobile === true ? 'phone or tablet' : 'computer';
  return [kind, cores ? `${cores} cores` : null, gb ? `${gb} GB memory` : null].filter(Boolean).join(', ');
}

/** Lines for the Score report: one per kind with samples, with the per-stage medians. */
export function timingReportLines(snapshot, device = '') {
  const lines = [];
  for (const [kind, label] of [['track', 'Listening speed'], ['topup', 'Top-up speed (per record)']]) {
    const s = summariseTimings(snapshot?.[kind]);
    if (!s.n) continue;
    const parts = STAGES.filter(k => s.ms[k] > 0).map(k => `${k} ${secs(s.ms[k])} s`).join(', ');
    lines.push(`${label}${device ? ` (${device})` : ''}: ${secs(s.total)} s each, ${s.perMin} a minute, over ${s.n}; ${parts}`);
  }
  return lines;
}
