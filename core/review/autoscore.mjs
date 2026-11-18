// Score + Tune, run by itself (docs/NEXT-WORKPLAN.md package 1).
//
// Every gate that switches a part of the engine on (sound in the blend, the
// deep ear, nearest members, family first, mood chips, fitted weights, teach,
// Fill this playlist) is decided by this account's own Score run. Until now
// that needed someone to find Library ▸ Engine and press a button, so an
// account that never did kept every gate shut, and a gate decided on 200 heard
// tracks never heard about the next 2,000.
//
// This file decides only *whether a run is due*; web/app/autoscore.js runs it.
// Pure, no storage, no clock of its own, so every branch is a unit test.
//
// `last` is the record the page keeps in localStorage `bf_autoscore`:
//   { at, heard, why, ok }   when the last run (automatic or by hand) ended,
//                            how many tracks listening had heard then, why it
//                            ran, and whether it finished.
// Bundled into the page and exposed as globals, like filequeue.mjs.

export const AUTOSCORE = Object.freeze({
  /** A first run needs this many tracks filed in genre playlists to score anything worth keeping. */
  minFiled: 60,
  /** Listening finished and heard at least this many more since the last run. */
  listenedMore: 50,
  /** Listening still going, but heard this many more ... */
  heardMore: 200,
  /** ... and this much more, as a share of what it had heard last time. */
  heardGrowth: 0.25,
  /** The weekly check. Also the longest a running listen can hold a run back. */
  weekMs: 7 * 24 * 3600e3,
  /** A run that failed is not tried again for this long. */
  retryMs: 6 * 3600e3,
});

const HOUR = 3600e3, DAY = 24 * HOUR;

/**
 * Why a Score + Tune run is due now, or null when it is not.
 *
 * @param {object} o
 * @param {{at:number, heard?:number, why?:string, ok?:boolean}|null} o.last
 * @param {number} o.now
 * @param {number} [o.heard]      tracks listening has heard so far
 * @param {number} [o.filed]      distinct tracks in genre (target) playlists
 * @param {string|null} [o.listening]  listening state: 'running' | 'done' | 'paused' | null
 * @param {boolean} [o.busy]      a Score or Tune run (or the first analysis) already going
 * @returns {'first'|'listened'|'heard'|'weekly'|null}
 */
export function autoScoreWhy({ last = null, now, heard = 0, filed = 0, listening = null, busy = false } = {}) {
  if (busy || !Number.isFinite(now)) return null;
  if (filed < AUTOSCORE.minFiled) return null;
  const at = Number.isFinite(last?.at) ? last.at : null;
  if (at == null) return 'first';
  const age = now - at;
  // A run that did not finish: leave it for a while, then try again for the reason it first ran.
  if (last.ok === false) {
    if (age < AUTOSCORE.retryMs) return null;
    return ['first', 'listened', 'heard', 'weekly'].includes(last.why) ? last.why : 'weekly';
  }
  const was = Number(last.heard) || 0, more = heard - was;
  const grew = more >= AUTOSCORE.heardMore && heard >= was * (1 + AUTOSCORE.heardGrowth);
  // Listening and a Score run both want the computer: let listening finish, unless that is
  // taking all week. A long listen still earns a run on the way once it has heard a lot more.
  if (listening === 'running' && age < AUTOSCORE.weekMs) return grew ? 'heard' : null;
  if (listening === 'done' && more >= AUTOSCORE.listenedMore) return 'listened';
  if (grew) return 'heard';
  if (age >= AUTOSCORE.weekMs) return 'weekly';
  return null;
}

/** "2 h ago", "3 days ago", "just now". */
export function agoWords(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  if (ms < 90e3) return 'just now';
  if (ms < HOUR) return `${Math.round(ms / 60e3)} min ago`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} h ago`;
  const d = Math.round(ms / DAY);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

const WHY_WORDS = {
  first: 'on its first check',
  listened: 'after listening finished',
  heard: 'after listening heard more of your library',
  weekly: 'on its weekly check',
  manual: 'when you ran it',
};

/**
 * The line under the Score buttons on the Engine screen.
 * @param {object|null} last  the `bf_autoscore` record
 * @param {number} now
 * @param {{filed?: number, running?: boolean}} [o]
 */
export function autoScoreLine(last, now, { filed = null, running = false } = {}) {
  if (running) return 'Scoring and tuning by itself now. It runs in the background; the app stays usable.';
  const next = 'Runs again by itself when listening finishes or has heard 200+ more tracks, or in ';
  if (!Number.isFinite(last?.at)) {
    if (filed != null && filed < AUTOSCORE.minFiled)
      return `Runs by itself once ${AUTOSCORE.minFiled} tracks are filed in your genre playlists (${filed} so far), then weekly.`;
    return 'Runs by itself a minute after the app opens, then again after listening and weekly. No need to press anything.';
  }
  const age = now - last.at;
  if (last.ok === false) {
    const wait = Math.max(0, AUTOSCORE.retryMs - age);
    return `The last run ${agoWords(age)} didn't finish. It tries again by itself ${wait > 0 ? `in about ${Math.max(1, Math.round(wait / HOUR))} h` : 'soon'}.`;
  }
  const left = Math.max(0, AUTOSCORE.weekMs - age);
  const days = Math.max(1, Math.ceil(left / DAY));
  return `Last scored ${agoWords(age)}, ${WHY_WORDS[last.why] ?? 'by itself'}. ${next}${days === 1 ? 'a day' : `${days} days`}.`;
}

/** The Settings row's short status: "scored 2 h ago" / "waiting". */
export function autoScoreStatus(last, now) {
  if (!Number.isFinite(last?.at)) return 'On · first run soon';
  if (last.ok === false) return 'On · retrying';
  return `On · scored ${agoWords(now - last.at)}`;
}

/* ---------- every run, kept (docs/BUILD-7-PLAN.md M1) ----------
 * A Score run's report, and the end of each listening run (first ear, second
 * ear), used to live only in the page's memory: close the tab without pressing
 * Copy results and it was gone. The page now keeps them in localStorage
 * `bf_run_history`, newest first, and the Engine screen lists them, each with
 * its own Copy. These are the pure parts. */

export const RUN_KEEP = Object.freeze({ score: 12, listen: 12, deep: 8 });
const RUN_KINDS = Object.keys(RUN_KEEP);

/** A stored entry, or null for anything that is not one (a corrupt row is dropped, not fatal). */
function cleanRun(r) {
  if (!r || typeof r !== 'object' || !RUN_KINDS.includes(r.kind) || !Number.isFinite(r.at)) return null;
  return r;
}

/** Read the stored list: newest first, corrupt rows dropped. Never throws. */
export function runHistoryParse(raw) {
  let list = raw;
  if (typeof raw === 'string') { try { list = JSON.parse(raw); } catch { list = null; } }
  if (!Array.isArray(list)) return [];
  return list.map(cleanRun).filter(Boolean).sort((a, b) => b.at - a.at);
}

/**
 * Add one run, newest first, keeping at most `keep[kind]` of each kind.
 * An entry with the same kind and `at` replaces the old one (a Score run
 * whose Tune sweep finished afterwards is written twice).
 * @param {object[]} prev
 * @param {object} run  { kind: 'score'|'listen'|'deep', at, ... }
 */
export function runHistoryAdd(prev, run, { keep = RUN_KEEP } = {}) {
  const list = runHistoryParse(prev);
  if (!cleanRun(run)) return list;
  const out = [run, ...list.filter(r => !(r.kind === run.kind && r.at === run.at))].sort((a, b) => b.at - a.at);
  const seen = {};
  return out.filter(r => (seen[r.kind] = (seen[r.kind] ?? 0) + 1) <= (keep[r.kind] ?? 12));
}

/** Kept for the plan's name: the Score runs only, newest first. */
export function scoreHistory(prev, run, o) {
  return runHistoryAdd(prev, { kind: 'score', ...run }, o).filter(r => r.kind === 'score');
}

const GATE_WORDS = {
  audio: 'Sound in the blend', ear: 'Second ear', near: 'Nearest members', family: 'Family first',
  agree: 'Agreement check', pairs: 'Pair check', bridge: 'Similar artists', mood: 'Mood chips',
  teach: 'Teach questions', fill: 'Fill this playlist', weights: 'Fitted weights',
};
const pct = x => `${Math.round(x * 100)}%`;

/**
 * What changed between two Score runs, in words, `b` the newer:
 * "Top-1 61% → 66% (+5)", "Family first: switched on". Empty when nothing did.
 */
export function scoreDiff(a, b) {
  if (!a || !b) return [];
  const out = [];
  const num = (label, x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const d = Math.round(y * 100) - Math.round(x * 100);
    if (Math.abs(d) >= 1) out.push(`${label} ${pct(x)} → ${pct(y)} (${d > 0 ? '+' : '−'}${Math.abs(d)})`);
  };
  num('Top-1', a.top1, b.top1);
  num('Top-3', a.top3, b.top3);
  num('Sure', a.sure, b.sure);
  num('Never-filed artists top-1', a.neverFiled, b.neverFiled);
  const ga = a.gates ?? {}, gb = b.gates ?? {};
  for (const k of Object.keys(GATE_WORDS)) {
    const x = ga[k], y = gb[k];
    if (typeof x !== 'boolean' || typeof y !== 'boolean' || x === y) continue;
    out.push(`${GATE_WORDS[k]}: switched ${y ? 'on' : 'off'}`);
  }
  return out;
}

/** "18 Nov, 01:40" in the listener's own time. */
export function runWhen(at) {
  try {
    return new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return new Date(at).toISOString().slice(0, 16).replace('T', ' '); }
}

const LISTEN_MISS = { noIsrc: 'no ISRC', noPreview: 'no preview', fetch: 'download failed', decode: "couldn't decode" };

/**
 * A listening run that just ended, as a history entry with its own text.
 * `vm` is the controller's view model ({ done, total, heard, missed, reason, state }).
 * Null when it heard nothing (a run that only checked there was nothing to do).
 * @param {'listen'|'deep'} kind
 */
export function listenRunEntry(kind, vm, { at, startedAt = null, build = '', extra = [], missText = LISTEN_MISS } = {}) {
  if (!vm || !Number.isFinite(at)) return null;
  const done = Number(vm.done) || 0;
  if (done <= 0) return null;
  const n = x => Number(x || 0).toLocaleString('en-GB');
  const missed = Object.entries(vm.missed ?? {}).filter(([, v]) => v > 0);
  const label = kind === 'deep' ? 'Deep listen (second ear)' : 'Listening (first ear)';
  const how = vm.state === 'done' ? 'finished' : `stopped${vm.reason && vm.reason !== 'stopped' ? `: ${vm.reason}` : ''}`;
  const mins = Number.isFinite(startedAt) && at > startedAt ? Math.round((at - startedAt) / 60e3) : null;
  const lines = [
    `Betterfy ${label} — build ${build}`,
    `Ended ${runWhen(at)}, ${how}${mins != null ? `, after ${mins} min` : ''}`,
    `This run: ${n(done)} of ${n(vm.total ?? done)} tracks`,
    Number.isFinite(vm.heard) ? `Heard in all: ${n(vm.heard)} tracks` : null,
    missed.length ? `Couldn't hear: ${missed.map(([k, v]) => `${n(v)} ${missText[k] ?? k}`).join(', ')}` : null,
    ...extra.filter(Boolean),
  ].filter(Boolean);
  return { kind, at, build, done, total: Number(vm.total) || done, heard: Number(vm.heard) || null,
           state: vm.state ?? null, text: lines.join('\n') };
}
