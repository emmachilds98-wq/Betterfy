// The library health report and the Tidy cleanup sprint (BUILD-6 F9).
//
// Pure: no DOM, no storage, no fetch. The health score itself is the one the
// Library rows already show (web/screens/lists.mjs playlistHealth); this module
// only builds its inputs from the reports every account has (R.misfiled,
// R.within, R.drift, the sound tier's rows), ranks the result, and keeps the
// sprint's own counts. Bundled into the page through web/screens/tidy.mjs.

export const HEALTH_VERSION = '1.0.0';
/** How many playlists the report lists. */
export const REPORT_N = 5;
/** At or above this a playlist reads "Healthy" (lists.mjs's word) and is left off the report. */
export const HEALTHY = 85;
/** Sessions of the sprint kept on this device. */
export const SPRINT_KEEP = 20;

/** What Tidy can act on per playlist: rows in Wrong place, By sound and Repeats. Map id -> counts. */
export function tidyCounts({ misfiled = [], soundRows = [], within = [] } = {}) {
  const out = new Map();
  const at = id => { let x = out.get(id); if (!x) out.set(id, x = { misfile: 0, sound: 0, dupes: 0 }); return x; };
  for (const m of misfiled ?? []) if (m?.currentPlaylistId) at(m.currentPlaylistId).misfile++;
  for (const r of soundRows ?? []) if (r?.from) at(r.from).sound++;
  for (const d of within ?? []) if (d?.playlistId) at(d.playlistId).dupes++;
  return out;
}

/** The Tidy section a playlist's report row opens: the first with rows for it, else null. */
export function sectionFor(t) {
  if (!t) return null;
  return t.misfile > 0 ? 'misfile' : t.sound > 0 ? 'sound' : t.dupes > 0 ? 'dupes' : null;
}

/**
 * Inputs for playlistHealth() for one playlist, from the reports. Misfiled rows
 * name their playlist as `currentPlaylistId` (web/app/reports.js); drift rows
 * as `playlistId`.
 */
export function healthInputs({ id, tracks = 0, list = [], misfiled = [], drift = [], splitIds, undecidedIds, twins } = {}, { repeatCount, staleDays } = {}) {
  return {
    tracks,
    misfiled: (misfiled ?? []).filter(m => m?.currentPlaylistId === id).length,
    drifting: (drift ?? []).some(d => d?.playlistId === id),
    split: !!splitIds?.has?.(id),
    undecided: !!undecidedIds?.has?.(id),
    twins: twins?.get?.(id) ?? [],
    repeats: typeof repeatCount === 'function' ? repeatCount(list) : 0,
    staleDays: typeof staleDays === 'function' ? staleDays(list) : null,
  };
}

/**
 * The worst `n` playlists by health, lowest score first. rows: [{ id, name,
 * tracks, health: { score, word, notes } | null, tidy?: counts }]. Rows with no
 * health (under eight tracks) and healthy ones are left off. Ties go to the
 * playlist with more Tidy can fix, then the bigger one, then by name, so the
 * order never depends on the input's.
 */
export function rankHealth(rows, { n = REPORT_N, below = HEALTHY } = {}) {
  const work = t => (t ? t.misfile + t.sound + t.dupes : 0);
  return (rows ?? []).filter(r => r?.health && Number.isFinite(r.health.score) && r.health.score < below)
    .sort((a, b) => a.health.score - b.health.score || work(b.tidy) - work(a.tidy)
      || (b.tracks ?? 0) - (a.tracks ?? 0) || String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id)))
    .slice(0, n)
    .map(r => ({ id: r.id, name: r.name, score: r.health.score, word: r.health.word,
      why: (r.health.notes ?? []).slice(0, 3), section: sectionFor(r.tidy), fixable: work(r.tidy) }));
}

/* ---------- the sprint's own counts ---------- */

/** A new sprint session. `now` is ms. */
export function sprintStart(now, { sec = null, pl = null } = {}) {
  return { start: now, last: now, sec, pl, moves: 0, keeps: 0, undos: 0, movesUndone: 0, stack: [] };
}

/** Record one decision (kind 'move' | 'keep') with whatever is needed to take it back. Returns the session. */
export function sprintDecide(s, kind, undo, now) {
  if (kind === 'move') s.moves++; else s.keeps++;
  s.stack.push({ kind, ...undo });
  s.last = now;
  return s;
}

/** Take the newest decision back; returns it (or null when there is none). */
export function sprintUndo(s, now) {
  const d = s.stack.pop();
  if (!d) return null;
  s.undos++;
  if (d.kind === 'move') s.movesUndone++;
  if (d.kind === 'move') s.moves--; else s.keeps--;
  s.last = now;
  return d;
}

/**
 * The numbers a session ends with. Decisions are the ones that stand (undone
 * ones subtracted). `perMin` runs from the first key to the last decision, so
 * a sprint left open does not drag it down. `kept` is the share of moves made
 * that were not taken back, the same reading as core/measure/history.mjs's
 * Tidy tier rate ("moves kept"), null without a move.
 */
export function sprintStats(s) {
  const decisions = s.moves + s.keeps;
  const ms = Math.max(0, s.last - s.start);
  const made = s.moves + s.movesUndone;
  return { decisions, moves: s.moves, made, keeps: s.keeps, undos: s.undos, ms,
    perMin: decisions && ms > 0 ? +(decisions / (ms / 60000)).toFixed(1) : null,
    kept: made ? s.moves / made : null };
}

/** Add a finished session's stats to the stored list (newest last, at most SPRINT_KEEP); sessions with no decision are dropped. */
export function sprintSave(list, stats, at) {
  const prev = Array.isArray(list) ? list.filter(x => x && Number.isFinite(x.decisions)) : [];
  if (!stats?.decisions && !stats?.undos) return prev.slice(-SPRINT_KEEP);
  return [...prev, { at, decisions: stats.decisions, moves: stats.moves, made: stats.made, keeps: stats.keeps, undos: stats.undos, ms: stats.ms,
    perMin: stats.perMin, kept: stats.kept }].slice(-SPRINT_KEEP);
}

/** Totals over stored sessions: decisions a minute over all of them, and the share of moves made that stood. */
export function sprintTotals(list) {
  let d = 0, ms = 0, moves = 0, made = 0, n = 0;
  for (const x of Array.isArray(list) ? list : []) {
    if (!x || !Number.isFinite(x.decisions)) continue;
    n++; d += x.decisions; ms += x.ms ?? 0; moves += x.moves ?? 0; made += x.made ?? x.moves ?? 0;
  }
  return { sessions: n, decisions: d, perMin: d && ms > 0 ? +(d / (ms / 60000)).toFixed(1) : null, kept: made ? moves / made : null };
}
