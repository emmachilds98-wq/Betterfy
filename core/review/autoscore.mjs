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
