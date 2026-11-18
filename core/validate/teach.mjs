// @bundle engine BetterfyTeach 210
// Does the teach queue teach? A measurement (BUILD-6 SG's gate: "Score after
// 20 teach answers beats before").
//
// A library, its waiting (unfiled) tracks and an answer key for them. The
// listener is simulated: each question the teach queue asks is answered from the
// key, by filing the track where it really goes. The engine is then rebuilt from
// the library with those answers in it, exactly as the page rebuilds it after
// any filing, and scored again on the tracks still waiting.
//
//   Score  top-1 of the account-native engine (core/intrinsic/space.mjs) on the
//          waiting tracks nobody answered, the same tracks before and after.
//
// `strategy: 'queue'` asks about the first tracks in the File queue's own order
// (filequeue.mjs orderBacklog) instead, to compare choosing where to ask with
// just filing from the top.
//
// Two ways in:
//
//   simulateTeach  any library, waiting tracks and answer key. test/teach.test.mjs
//                  runs it on the synthetic accounts in test/fixtures/.
//   teachGate      this account's own filing: one fold of its filed tracks is
//                  hidden and treated as waiting, the playlists they came from
//                  are the key. The Score run calls it, and the File screen's
//                  teach card is shown only where it passes (per account, on
//                  this device; nothing is shared). Like every number here it
//                  is the account grading the engine with its own answers.
import { buildSpace, placements, learnRejected } from '../intrinsic/space.mjs';
import { scoresOf, decide, calibrationReport } from '../intrinsic/calibrate.mjs';
import { placementAccuracy, foldOf, truthOf, scoredTracks } from './loo.mjs';
import { libraryWithout } from './baseline.mjs';
import { BEAT_MARGIN } from './blend.mjs';
import { orderBacklog, DECISION_BAND } from '../review/filequeue.mjs';
import { teachQueue, TEACH } from '../review/teach.mjs';

export const TEACH_SIM_VERSION = '1.0.0';

const rowOf = t => ({ id: t.id, artists: (t.artists ?? []).filter(a => a?.id).map(a => ({ id: a.id, name: a.name })),
                      artist: (t.artists ?? []).map(a => a?.name).join(', '), added: t.added_at ?? '', skips: 0 });

/** The library with each [track, playlistId] answer filed. A copy; the input is untouched. */
export function withAnswers(lib, answers) {
  const add = new Map();
  for (const [t, pid] of answers) (add.get(pid) ?? add.set(pid, []).get(pid)).push(t);
  return { ...lib, playlists: (lib.playlists ?? []).map(p => add.has(p.id) ? { ...p, tracks: [...(p.tracks ?? []), ...add.get(p.id)] } : p) };
}

/** Top-1 of the engine (a built space) on `tracks`, against `truth` (id -> playlist ids). */
export function scoreOn(space, tracks, truth, { soundFirst = false } = {}) {
  let right = 0, n = 0;
  for (const t of tracks) {
    const want = truth.get(t.id);
    if (!want?.length) continue;
    n++;
    const top = placements(t, space, { limit: 1, soundFirst }).results?.[0];
    if (top && want.includes(top.playlistId)) right++;
  }
  return { n, right, top1: n ? +(right / n).toFixed(4) : null };
}

/** The engine's calibrated verdict for each waiting track, and its best
 *  guesses (the top three, the card's picks): id -> { decision, guesses }. */
export function decisionsFor(space, tracks, cal, { soundFirst = false } = {}) {
  const out = new Map();
  for (const t of tracks) {
    const results = placements(t, space, { limit: Infinity, soundFirst }).results ?? [];
    out.set(t.id, { decision: decide(scoresOf(results), cal),
                    margin: results.length >= 2 ? results[0].score - results[1].score : null,
                    guesses: results.slice(0, TEACH.guesses).map(r => ({ id: r.playlistId, name: r.name })) });
  }
  return out;
}

/**
 * Simulate `answers` answers, asked `batch` at a time with the engine rebuilt
 * between batches (each answer re-scores everything, plan §4.3).
 *
 * @param {object} lib       { playlists, liked }
 * @param {object} o
 * @param {object[]} o.waiting  the unfiled tracks, raw Spotify-shaped
 * @param {Map}    o.truth      track id -> [playlist ids it belongs in]
 * @param {'teach'|'queue'} [o.strategy]
 * @returns {{ strategy, asked, inList, before, after, gain }}
 */
export function simulateTeach(lib, { waiting, truth, answers = 20, batch = TEACH.batch, strategy = 'teach',
                                    folds = 5, targets = null, genreGraph = false, cal = null, calLimit = null,
                                    isMirror = null, audio = null, online = false, close = false } = {}) {
  // Both off by default: measured on the shaped seeds (docs/BUILD-7-PLAN.md E1),
  // neither opens the gate on more seeds, and close calls cost tracks.
  // `online` (E1): each answer's "not those" (the short list's picks above the
  // right one, or all of it when the right one was missing) is learnt at once
  // and replayed onto every rebuilt space, as the page learns from each tap.
  // `close`: the queue favours close calls (teach.mjs TEACH.closeBoost).
  // With `audio` (ENGINE-REVIEW layer 5) the engine is the one File places heard
  // tracks with: sound-first, and each answer joins its playlist's sound, so a
  // single answer counts for every track that sounds like it.
  const spaceOpts = { targets: targets ? new Set(targets) : null, genreGraph, isMirror, ...(audio ? { audio } : {}) };
  const sf = { soundFirst: !!audio };
  // "How sure may it be", fitted once on the library's own filing, as the Score run does.
  cal ??= calibrationReport(placementAccuracy(lib, { folds, collect: true, limit: calLimit, targets: spaceOpts.targets, genreGraph, isMirror }).rows).cal;
  const pending = (waiting ?? []).filter(t => truth.get(t.id)?.length);
  const asked = [];
  const first = buildSpace(lib, spaceOpts);
  let cur = lib, space = first, inList = 0;
  const noes = [];
  while (asked.length < answers) {
    const done = new Set(asked.map(([t]) => t.id));
    const left = pending.filter(t => !done.has(t.id));
    if (!left.length) break;
    const want = Math.min(batch, answers - asked.length);
    const dec = decisionsFor(space, left, cal, sf);
    const rows = left.map(rowOf);
    const byId = new Map(left.map(t => [t.id, t]));
    let picks;
    if (strategy === 'teach') {
      picks = teachQueue(rows, { decisionOf: r => dec.get(r.id).decision, guesses: r => dec.get(r.id).guesses,
                                 limit: want, marginOf: close ? r => dec.get(r.id).margin : null })
        .map(q => ({ t: byId.get(q.row.id), choices: q.choices.map(c => c.id) }));
    } else {
      // The File card shows its top three too: same tap, the queue's own order.
      picks = orderBacklog(rows, { bandOf: r => DECISION_BAND[dec.get(r.id).decision?.kind] ?? null }).slice(0, want)
        .map(r => ({ t: byId.get(r.id), choices: dec.get(r.id).guesses.map(g => g.id) }));
    }
    if (!picks.length) break;
    const round = [];
    for (const { t, choices } of picks) {
      const real = truth.get(t.id);
      // The tap: one of the short list when the right playlist is on it, else
      // "somewhere else" and the right one picked from the full list.
      const hit = choices.find(id => real.includes(id));
      if (hit) inList++;
      round.push([t, hit ?? real[0]]);
      if (online) for (const id of hit ? choices.slice(0, choices.indexOf(hit)) : choices) noes.push([t, id]);
    }
    asked.push(...round);
    cur = withAnswers(cur, round);
    space = buildSpace(cur, spaceOpts);
    for (const [t, id] of noes) learnRejected(space, t, id);
  }
  const done = new Set(asked.map(([t]) => t.id));
  const rest = pending.filter(t => !done.has(t.id));
  const before = scoreOn(first, rest, truth, sf), after = scoreOn(space, rest, truth, sf);
  return { version: TEACH_SIM_VERSION, strategy, asked: asked.length, inList, before, after, ...(audio ? { sound: true } : {}),
           answered: asked.map(([t, pid]) => [t.id, pid]),
           gain: before.top1 != null && after.top1 != null ? +(after.top1 - before.top1).toFixed(4) : null };
}

/** What the gate needs before it says anything: the answers asked, and
 *  enough hidden tracks left to score that one track is not the whole verdict. */
export const TEACH_GATE = { answers: 20, minScored: 30, waitingCap: 400, calLimit: 600, calFolds: 5, fold: 0, folds: 5,
  /** "Beats": at least a point of top-1 (the blend's own bar, validate/blend.mjs)
   *  and at least two more tracks right, so one lucky track is never a verdict. */
  margin: BEAT_MARGIN, minTracks: 2 };

/**
 * The per-account gate. One fold of this account's filed tracks is hidden (the
 * same deterministic fold assignment as the Score run) and becomes the queue;
 * where each really sat is the answer key. 20 answers are simulated from that
 * key through the teach queue, and the engine is scored on the hidden tracks
 * nobody was asked about, before and after.
 *
 * { pass, why, asked, scored, before, after, gain }. `pass` only when all 20
 * were asked, enough tracks were left to score, and more of them were placed
 * right after than before ("beats", not "ties"). Otherwise the teach card stays
 * hidden, and `why` says which.
 */
export function teachGate(lib, { targets = null, isMirror = null, genreGraph = false, audio = null, ...over } = {}) {
  const o = { ...TEACH_GATE, ...over };
  const allowed = targets ? new Set(targets) : null;
  const truthAll = truthOf(lib, { isMirror });
  const hidden = scoredTracks(lib, { isMirror, targets: allowed })
    .filter(t => foldOf(t.id, o.folds) === o.fold).slice(0, o.waitingCap);
  const truth = new Map();
  for (const t of hidden) {
    const want = [...(truthAll.get(t.id) ?? [])].filter(id => !allowed || allowed.has(id)).sort();
    if (want.length) truth.set(t.id, want);
  }
  const out = { version: TEACH_SIM_VERSION, pass: false, why: null, asked: 0, scored: 0,
                before: null, after: null, gain: null };
  if (truth.size < o.answers + o.minScored) return { ...out, why: `not enough filed tracks yet (${truth.size} of ${o.answers + o.minScored})` };
  const base = libraryWithout(lib, new Set(truth.keys()));
  const r = simulateTeach(base, { waiting: hidden, truth, answers: o.answers, targets, genreGraph, isMirror,
                                  folds: o.calFolds, calLimit: o.calLimit, audio,
                                  ...(o.online != null ? { online: o.online } : {}), ...(o.close != null ? { close: o.close } : {}) });
  Object.assign(out, { asked: r.asked, inList: r.inList, scored: r.before.n, before: r.before.top1, after: r.after.top1,
                       ...(r.sound ? { sound: true } : {}),
                       gain: r.gain, right: [r.before.right, r.after.right] });
  return teachVerdict(out, o);
}

/** The gate's verdict on a measured result: { ...result, pass, why }. */
export function teachVerdict(r, over = {}) {
  const o = { ...TEACH_GATE, ...over };
  const [was, now] = r?.right ?? [0, 0];
  const why = (r?.asked ?? 0) < o.answers ? `only ${r?.asked ?? 0} of ${o.answers} questions to ask`
    : (r?.scored ?? 0) < o.minScored ? `only ${r?.scored ?? 0} tracks left to score`
    : !((r.gain ?? 0) >= o.margin && now - was >= o.minTracks) ? 'the answers did not move the score enough'
    : null;
  return { ...r, pass: !why, why: why ?? 'beats' };
}
