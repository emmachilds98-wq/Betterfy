// @bundle engine BetterfyTune 200
// Engine › Tune: the Score run's constants, swept on the account's own held-out
// tracks (BUILD-6-PLAN §3.1–§3.3). Pure parameter sweep: counts and lookups on
// this account's library and heard tracks, no new learning, nothing shared and
// nothing that leaves the device. It never changes a shipped constant; it
// reports, per constant, the current value, the best value in a small grid and
// the measured delta, and it hands back overrides for ONLY the rows that clear
// §3.1's bar. The page stores those on this device ("reset to default" clears
// them). A tuned value therefore applies to the account whose folds it won on,
// and an account that clears no bar changes nothing.
//
// Three groups are swept here, each constant one at a time:
//   sound   SOUND_FIRST_WEIGHTS (audio / learned / graph / bpm)
//   ident   identify: SOURCES.library / .tags, SPECIFIC, MIN_GENRE
//   misfit  Tidy-by-sound MISFIT: k / curMax / likely / sure
// All need listening (heard tracks). The rest of §3.1 is read from History, not
// swept (`NOT_SWEPT`).
//
// "Held out": placement is the Score run's own k-fold; identify and misfit
// already leave the scored track out of its neighbours. Every bar must also
// hold on BOTH halves of the tracks (by fold hash), so a gain that only one
// half shows is treated as noise and kept out.
import { placementAccuracy, foldOf } from './loo.mjs';
import { SOUND_FIRST_WEIGHTS } from '../intrinsic/space.mjs';
import { audioIndex } from '../intrinsic/audio.mjs';
import { SOURCES, SPECIFIC, MIN_GENRE, identifyAccuracyFor } from '../audio/identify.mjs';
import { MISFIT, misfitAccuracy } from '../audio/misfit.mjs';
import { genreMembership } from '../audio/match.mjs';

export const TUNE_VERSION = '1.0.0';
/** Fewest scored tracks before a group is swept at all. */
export const TUNE_MIN = Object.freeze({ sound: 30, ident: 30, misfit: 30 });

/** §3.1 rows that are read from History rather than swept, and why. */
export const NOT_SWEPT = Object.freeze([
  'Tempo ranges: judged by hand against the genre list, and the ontology tests pin them',
  'Split constants: need accepted vs dismissed offers in History (10 or more)',
  'Batch "sure" threshold: needs 30 or more batch filings in History',
  'Queue weights: need the skip rate of top-20 vs the rest from History',
  'Discover blend: needs the keep rate from History',
]);

// Each param: its shipped value and a small grid that includes it.
const PARAMS = Object.freeze({
  sound: [
    { key: 'audio',   label: 'Filing by sound, weight of sound',   current: SOUND_FIRST_WEIGHTS.audio,   grid: [1.0, 1.5, 2.0] },
    { key: 'learned', label: 'Filing by sound, weight of learned', current: SOUND_FIRST_WEIGHTS.learned, grid: [1.5, 2.0, 3.0] },
    { key: 'graph',   label: 'Filing by sound, weight of artists', current: SOUND_FIRST_WEIGHTS.graph,   grid: [0.25, 0.5, 1.0] },
    { key: 'bpm',     label: 'Filing by sound, weight of tempo',   current: SOUND_FIRST_WEIGHTS.bpm,     grid: [0.2, 0.4, 0.8] },
  ],
  ident: [
    { key: 'library',  label: 'Naming genres, library vote',  current: SOURCES.library, grid: [1.0, 1.6, 2.2] },
    { key: 'tags',     label: 'Naming genres, tag vote',      current: SOURCES.tags,    grid: [0.25, 0.5, 1.0] },
    { key: 'specific', label: 'Naming genres, sub-genre bar', current: SPECIFIC,        grid: [0.4, 0.5, 0.6] },
    { key: 'minGenre', label: 'Naming genres, genre floor',   current: MIN_GENRE,       grid: [0.2, 0.25, 0.35] },
  ],
  misfit: [
    { key: 'k',      label: 'Tidy by sound, sound-alikes looked at', current: MISFIT.k,      grid: [8, 12, 16] },
    { key: 'curMax', label: 'Tidy by sound, home share at most',     current: MISFIT.curMax, grid: [0.1, 0.15, 0.2] },
    { key: 'likely', label: 'Tidy by sound, share to offer',         current: MISFIT.likely, grid: [0.4, 0.5, 0.6] },
    { key: 'sure',   label: 'Tidy by sound, share to call sure',     current: MISFIT.sure,   grid: [0.6, 0.7, 0.8] },
  ],
});
export const TUNE_GROUPS = Object.freeze(Object.keys(PARAMS));
const TITLES = { sound: 'Filing by sound', ident: 'Naming genres by sound', misfit: 'Tidy by sound' };

const half = id => foldOf(id, 2);
const top1Of = rows => (rows.length ? rows.filter(r => r.scores.length && r.truth.includes(r.scores[0][0])).length / rows.length : null);
const ge = (a, b, eps = 1e-9) => a != null && b != null && a >= b - eps;
const pts = d => `${d >= 0 ? '+' : '-'}${Math.abs(Math.round(d * 1000) / 10)} pts`;
const pc = x => (x == null ? 'n/a' : Math.round(x * 1000) / 10 + '%');

// ---- one measurement per group: the base once, then each alternative value ----

function soundMetric(lib, o, p) {
  const r = placementAccuracy(lib, { folds: o.folds, limit: o.limit, isMirror: o.isMirror, targets: o.targets,
                                     audio: o.audio, collect: true, genreGraph: true,
                                     soundWeights: { ...SOUND_FIRST_WEIGHTS, ...p } });
  const w = r.withAudio;
  if (!w) return null;
  const rows = w.rows ?? [];
  return { n: w.heard, top1: w.top1, nf: w.neverFiled?.scored ? w.neverFiled.top1 : null,
           halves: [0, 1].map(h => top1Of(rows.filter(x => half(x.id) === h))) };
}
function soundJudge(b, c) {
  const pass = c.top1 >= b.top1 + 0.01 - 1e-9 && (b.nf == null || ge(c.nf, b.nf))
    && c.halves.every((x, i) => ge(x, b.halves[i]));
  return { pass, score: c.top1 + (c.nf ?? 0) * 0.1 };
}
const soundSay = m => `top-1 ${pc(m.top1)}${m.nf != null ? `, never-filed ${pc(m.nf)}` : ''}`;
const soundDelta = (b, c) => `top-1 ${pts(c.top1 - b.top1)}${b.nf != null ? `, never-filed ${pts(c.nf - b.nf)}` : ''}`;

function identMetric(lib, o, p) {
  const run = only => identifyAccuracyFor(lib, o.audio, { targets: o.targets, isMirror: o.isMirror, limit: o.limit, only,
    weights: { ...SOURCES, library: p.library, tags: p.tags }, specific: p.specific, minGenre: p.minGenre });
  const all = run(null);
  if (!all) return null;
  return { n: all.scored, genre: all.genre, specific: all.specific,
           halves: [0, 1].map(h => { const x = run(id => half(id) === h); return x ? { genre: x.genre, specific: x.specific } : null; }) };
}
function identJudge(b, c) {
  const pass = c.genre >= b.genre + 0.02 - 1e-9 && ge(c.specific, b.specific)
    && c.halves.every((x, i) => x && b.halves[i] && ge(x.genre, b.halves[i].genre));
  return { pass, score: c.genre + c.specific * 0.5 };
}
const identSay = m => `genre ${pc(m.genre)}, sub-genre ${pc(m.specific)}`;
const identDelta = (b, c) => `genre ${pts(c.genre - b.genre)}, sub-genre ${pts(c.specific - b.specific)}`;

function misfitMetric(lib, o, p) {
  const index = audioIndex(o.audio?.records ?? o.audio);
  const membership = genreMembership(lib, { targets: o.targets, isMirror: o.isMirror });
  const opts = { ...MISFIT, ...p };
  const run = only => misfitAccuracy({ index, membership, opts, limit: o.limit, only });
  const all = run(null);
  if (!all) return null;
  const f = x => (x ? { caught: x.caught ?? 0, fa: x.sure.falseAlarm ?? 0 } : null);
  return { n: all.scored, ...f(all), halves: [0, 1].map(h => f(run(id => half(id) === h))) };
}
function misfitJudge(b, c) {
  const ok = (x, y) => x && y && x.fa <= 0.05 && ge(x.caught, y.caught - 0.05);
  const better = c.fa < b.fa - 0.005 || c.caught >= b.caught + 0.02;
  const pass = ok(c, b) && better && c.halves.every((x, i) => ok(x, b.halves[i]));
  return { pass, score: c.caught - 2 * c.fa };
}
const misfitSay = m => `caught ${pc(m.caught)}, sure false-alarm ${pc(m.fa)}`;
const misfitDelta = (b, c) => `caught ${pts(c.caught - b.caught)}, sure false-alarm ${pts(c.fa - b.fa)}`;

const GROUPS = {
  sound:  { metric: soundMetric,  judge: soundJudge,  say: soundSay,  delta: soundDelta },
  ident:  { metric: identMetric,  judge: identJudge,  say: identSay,  delta: identDelta },
  misfit: { metric: misfitMetric, judge: misfitJudge, say: misfitSay, delta: misfitDelta },
};
const defaults = g => Object.fromEntries(PARAMS[g].map(p => [p.key, p.current]));

/**
 * Sweep the named groups (all by default). `audio` is the heard records (or the
 * engine's `{ records }`); without enough of them a group reports "not enough
 * data yet" instead of a guess.
 *
 * @returns {{ rows: object[], skipped: {group:string,title:string,why:string}[], notSwept: string[], version: string }}
 *   rows: { group, title, key, label, current, best, pass, delta, grid:[{value,say}], base, n }
 */
export function tuneSweep(lib, { audio = null, targets = null, isMirror = null, limit = 300, folds = 5,
                                 groups = TUNE_GROUPS } = {}) {
  const o = { audio, targets, isMirror, limit, folds };
  const rows = [], skipped = [];
  const heard = audio ? audioIndex(audio?.records ?? audio).size : 0;
  for (const g of groups) {
    if (!PARAMS[g]) continue;
    const G = GROUPS[g], title = TITLES[g];
    if (!heard) { skipped.push({ group: g, title, why: 'needs listening on, with some tracks heard' }); continue; }
    let base = null;
    try { base = G.metric(lib, o, defaults(g)); } catch { base = null; }
    if (!base || !(base.n >= TUNE_MIN[g])) {
      skipped.push({ group: g, title, why: `not enough data yet (${base?.n ?? 0} of ${TUNE_MIN[g]})` });
      continue;
    }
    for (const p of PARAMS[g]) {
      const grid = [];
      for (const value of p.grid) {
        if (value === p.current) { grid.push({ value, m: base, j: { pass: false, score: G.judge(base, base).score } }); continue; }
        let m = null;
        try { m = G.metric(lib, o, { ...defaults(g), [p.key]: value }); } catch { m = null; }
        if (m) grid.push({ value, m, j: G.judge(base, m) });
      }
      // The best passing value, else the best-scoring one (shown, never applied).
      const pool = grid.filter(x => x.j.pass);
      const winner = (pool.length ? pool : grid).slice()
        .sort((a, b) => b.j.score - a.j.score || Math.abs(a.value - p.current) - Math.abs(b.value - p.current))[0];
      const moved = !!winner && winner.value !== p.current;
      rows.push({ group: g, title, key: p.key, label: p.label, current: p.current,
                  best: winner ? winner.value : p.current, pass: moved && winner.j.pass,
                  delta: moved ? G.delta(base, winner.m) : 'no change',
                  grid: grid.map(x => ({ value: x.value, say: G.say(x.m) })),
                  base: G.say(base), n: base.n });
    }
  }
  return { rows, skipped, notSwept: NOT_SWEPT.slice(), version: TUNE_VERSION };
}

/** Merge the results of several `tuneSweep` calls (one per group, from the worker). */
export function mergeTune(parts) {
  const ps = (parts ?? []).filter(Boolean);
  return { rows: ps.flatMap(x => x.rows ?? []), skipped: ps.flatMap(x => x.skipped ?? []),
           notSwept: NOT_SWEPT.slice(), version: TUNE_VERSION };
}

/** The overrides worth storing: only rows that cleared the bar, `{ sound: {audio: 2}, … }`. */
export function tuneOverrides(result) {
  const out = {};
  for (const r of result?.rows ?? []) if (r.pass) (out[r.group] ??= {})[r.key] = r.best;
  return out;
}

/** Stored overrides, kept only where they name a known constant with a value from its grid. */
export function cleanOverrides(o) {
  const out = {};
  for (const g of TUNE_GROUPS) for (const p of PARAMS[g]) {
    const v = o?.[g]?.[p.key];
    if (typeof v === 'number' && p.grid.includes(v) && v !== p.current) (out[g] ??= {})[p.key] = v;
  }
  return out;
}

// Overrides in the shape each consumer takes; null means "use the shipped value".
export const soundFirstFor = o => (o?.sound && Object.keys(o.sound).length ? { ...o.sound } : null);
export function identifyOptsFor(o) {
  const i = o?.ident;
  if (!i || !Object.keys(i).length) return null;
  return { weights: { ...SOURCES, ...(i.library != null ? { library: i.library } : {}), ...(i.tags != null ? { tags: i.tags } : {}) },
           specific: i.specific ?? SPECIFIC, minGenre: i.minGenre ?? MIN_GENRE };
}
export const misfitOptsFor = o => (o?.misfit && Object.keys(o.misfit).length ? { ...MISFIT, ...o.misfit } : null);

/** One line per constant, for the card. */
export function tuneLines(result) {
  const out = [];
  for (const r of result?.rows ?? []) {
    out.push(`${r.label}: now ${r.current}, best ${r.best}${r.best !== r.current ? ` (${r.delta})` : ''}, ${
      r.pass ? 'clears the bar' : r.best !== r.current ? 'below the bar, not used' : 'keep'}`);
  }
  for (const s of result?.skipped ?? []) out.push(`${s.title}: not swept, ${s.why}`);
  return out;
}

/** The copyable block for the "Score + Tune" paste. */
export function tuneBlock(result) {
  if (!result) return '';
  const lines = ['Betterfy tune sweep'];
  for (const g of TUNE_GROUPS) {
    const rs = (result.rows ?? []).filter(r => r.group === g);
    if (!rs.length) continue;
    lines.push('', `${TITLES[g]} (${rs[0].n} tracks; now: ${rs[0].base})`);
    for (const r of rs) {
      lines.push(`  ${r.key}: now ${r.current}, best ${r.best}, ${r.delta}${r.pass ? ' [clears the bar]' : ''}; `
        + `grid ${r.grid.map(x => `${x.value} = ${x.say}`).join(' | ')}`);
    }
  }
  for (const s of result.skipped ?? []) lines.push('', `${s.title}: not swept (${s.why})`);
  lines.push('', ...(result.notSwept ?? []).map(x => `Not swept: ${x}`));
  return lines.join('\n');
}
