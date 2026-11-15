// Held-out placement accuracy — the account grades the engine.
//
// This is the reason the intrinsic approach is worth building. Every other
// accuracy number in this project needed somebody to sit down and review
// tracks: §26 asks for ~500 reviewed rows before a weight can be trusted, and
// producing them is the work that has blocked tuning for the whole project.
//
// Placement needs none of that, because **the answer key is already in the
// library.** The listener filed these tracks. Hide one, ask where it goes,
// compare. Thousands of graded rows, per account, in seconds, with no reviewing
// and no opinion from anybody.
//
// ---------------------------------------------------------------------------
// Why folds rather than true leave-one-out
//
// True leave-one-out would rebuild the space once per track: with a few
// thousand filed tracks that is a few thousand graph builds, which is not a
// harness anybody runs. The obvious shortcut — build the space once and subtract
// the held-out track at scoring time — is how leakage gets in, because a track
// contributes to its artists' co-occurrence counts everywhere, not only to the
// centroid it is scored against.
//
// So: k folds. Every track in a fold is removed from the space *before* it is
// built, then every member of that fold is scored against a space that has
// never seen any of them. Exact rather than approximate, and k builds rather
// than one per track.
//
// The cost is a known, one-directional bias: each fold trains on (k-1)/k of the
// library, so the reported number is slightly *pessimistic* about a full-library
// engine. Pessimism is the safe direction for a number used to decide whether
// to take over somebody's filing.
// ---------------------------------------------------------------------------
import { buildSpace, placements, withAudioLayer, BANDS, WEIGHTS } from '../intrinsic/space.mjs';
import { mirrorPredicate } from '../playlists/mirror.mjs';
import { scoresOf } from '../intrinsic/calibrate.mjs';
import { audioIndex } from '../intrinsic/audio.mjs';
import { audioGate, earChoice } from './gate.mjs';

// 4.1.0: `audio` (WP-E2). Without it the result is key for key what 4.0.0 gave.
// `audio.arms` (WP-C1) adds `withAudio.arms` and nothing else, so the version
// is left alone: without arms every result is key for key what it was.
export const VALIDATE_VERSION = '4.1.0';

export const DEFAULT_FOLDS = 5;

/**
 * Deterministic fold assignment from the track id.
 *
 * Deliberately not random: two runs over the same library must produce the same
 * number, or every comparison between engines and every weight sweep is reading
 * fold noise. FNV-1a, because it needs to be stable and cheap, not
 * cryptographic.
 */
export function foldOf(trackId, folds = DEFAULT_FOLDS) {
  let h = 0x811c9dc5;
  const s = String(trackId);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % folds;
}

/**
 * Where each track actually lives: track id -> Set of playlist ids.
 *
 * Mirrors excluded, because "it is in the record-of-everything playlist" is not
 * a filing decision and crediting the engine for finding it there would make
 * the whole metric meaningless.
 *
 * A track legitimately belongs to several buckets at once — the README's own
 * example is a metal track that sits in both "Metal" and a mood playlist, where
 * neither placement is wrong. So truth is a **set**, and the engine is right if
 * its top answer is any member of it. Scoring against a single "correct"
 * playlist would punish the engine for being right about the other one.
 */
export function truthOf(lib, { isMirror = null } = {}) {
  const mirror = mirrorPredicate(lib, { also: isMirror ?? undefined });
  const truth = new Map();
  for (const p of lib?.playlists ?? []) {
    if (!p?.id || mirror(p)) continue;
    for (const t of p.tracks ?? []) {
      if (!t?.id) continue;
      if (!truth.has(t.id)) truth.set(t.id, new Set());
      truth.get(t.id).add(p.id);
    }
  }
  return truth;
}

const rate = (n, d) => (d > 0 ? +(n / d).toFixed(4) : null);

/**
 * The filed tracks the harness scores, in the order it scores them.
 *
 * Exported so a caller can fetch something about exactly these tracks first —
 * the page gathers the neighbour bridge for their artists before scoring —
 * without re-deriving the selection and quietly drifting from it.
 */
export function scoredTracks(lib, { limit = null, isMirror = null, targets = null } = {}) {
  const mirror = mirrorPredicate(lib, { also: isMirror ?? undefined });
  const allowed = targets ? new Set(targets) : null;
  const byId = new Map();
  for (const p of lib?.playlists ?? []) {
    if (!p?.id || mirror(p)) continue;
    if (allowed && !allowed.has(p.id)) continue;
    for (const t of p.tracks ?? []) if (t?.id && !byId.has(t.id)) byId.set(t.id, t);
  }
  let ids = [...byId.keys()].sort();      // sorted so `limit` is reproducible
  if (limit && ids.length > limit) ids = ids.slice(0, limit);
  return ids.map(id => byId.get(id));
}

/** Every artist filed in any of the space's destinations. */
const filedArtists = space => {
  const out = new Set();
  for (const d of space.destinations.values()) for (const a of d.artists) out.add(a);
  return out;
};

/** A small tally, for the subsets reported beside the headline numbers. */
const tally = () => ({ scored: 0, top1: 0, top3: 0 });
const tallyOut = t => ({ scored: t.scored, top1: rate(t.top1, t.scored), top3: rate(t.top3, t.scored) });

/**
 * Score the engine against the account's own filing.
 *
 * @param {object} lib
 * @param {object} [opts]
 * @param {number}  [opts.folds]   how many folds (ignored when leaky)
 * @param {boolean} [opts.leaky]   build the space WITH the held-out tracks in
 *                                 it. This is the canary, not a mode anybody
 *                                 should report: it measures how well the
 *                                 engine recognises tracks it has already been
 *                                 shown, which is always excellent and always
 *                                 meaningless. `test/intrinsic.test.mjs` asserts
 *                                 that it scores clearly better than the honest
 *                                 path — if it ever stops doing so, the fold
 *                                 machinery has broken and the honest number is
 *                                 quietly leaking.
 * @param {number}  [opts.limit]   cap tracks scored, for a quick pass
 * @param {Function} [opts.isMirror]
 * @param {*}       [opts.audio]   AudioRecords, or `{ records | index, mel, learn, feedback }`
 *                                 as `buildSpace` takes them. Every track is then
 *                                 also scored with sound let in (`withAudio`),
 *                                 against the same fold's space: the sound
 *                                 profiles and any learner are built without the
 *                                 fold, so a track never hears itself. The
 *                                 headline numbers are unchanged by it.
 *                                 `audio.arms` (WP-C1, with `records`): more
 *                                 ears to score the same way, e.g.
 *                                 ['maest', 'both']. Each is one more ranking
 *                                 per track against the same fold's space with
 *                                 only the sound layer rebuilt for that ear,
 *                                 reported in `withAudio.arms[ear]` with its
 *                                 own gate verdict. gate.mjs `earChoice` reads
 *                                 them against the first ear.
 */
export function placementAccuracy(lib, { folds = DEFAULT_FOLDS, leaky = false,
                                         limit = null, isMirror = null,
                                         weights = null, targets = null, bridge = null,
                                         audio = null, collect = false,
                                         genreGraph = false, soundWeights = null } = {}) {
  const truth = truthOf(lib, { isMirror });
  // With `targets`, the question is "which of my genre playlists", so only
  // tracks filed in one are scored and only those playlists count as right.
  const allowed = targets ? new Set(targets) : null;

  // One row per distinct filed track, with the track object to score.
  const byId = new Map();
  for (const t of scoredTracks(lib, { limit, isMirror, targets: allowed })) byId.set(t.id, t);
  const ids = [...byId.keys()];

  // With a bridge, every track is scored twice against the same space: once as
  // the engine stands (the headline numbers, unchanged in meaning) and once with
  // the bridge's vote added (`withBridge`). Same folds, same tracks, one build
  // per fold — so the difference between the two is the bridge and nothing else.
  const base = { ...(weights ?? WEIGHTS) };
  const bridgeWeight = base.bridge ?? WEIGHTS.bridge;
  delete base.bridge;
  const plus = bridge ? { ...base, bridge: bridgeWeight } : null;
  const neverFiled = tally(), neverFiledPlus = tally(), withPlus = tally();
  let bridgeJudged = 0;
  // `collect`: keep each held-out track's ranking as a distribution, for
  // core/intrinsic/calibrate.mjs to fit "how sure may it be" against. Every
  // destination has to be ranked for that, not just the top three.
  const rows = collect ? [] : null, rowsPlus = collect && bridge ? [] : null;

  // With audio, the same again for sound: one more ranking per track against
  // the same space, with `useAudio` letting the sound components in. The
  // weights are the headline's (no bridge), so the difference between the two
  // is sound and nothing else. The index is built once, not once per fold:
  // which tracks have been heard does not depend on the fold, only which of
  // them define a playlist's sound does, and buildSpace handles that.
  const audioOpts = audioOptions(audio);
  const sound = audioOpts ? { all: tally(), neverFiled: tally(), heard: 0, heardNeverFiled: 0,
                              judged: 0, changed: 0, rows: collect ? [] : null } : null;
  const limit3 = collect ? Infinity : 3;
  // WP-C1: the other ears, each tallied exactly like `sound`.
  const arms = sound ? armsOf(audio, audioOpts, collect) : [];

  const stats = {
    scored: 0, top1: 0, top3: 0, declined: 0, declinedWouldHaveBeenRight: 0,
    byBand: new Map(), byPlaylist: new Map(),
  };

  // Group by fold so each space is built once and used for every member.
  const groups = new Map();
  for (const id of ids) {
    const f = leaky ? 'all' : foldOf(id, folds);
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(id);
  }

  for (const [, members] of groups) {
    const skip = leaky ? null : new Set(members);
    const space = buildSpace(lib, { skip, isMirror, targets: allowed, bridge, audio: audioOpts, genreGraph });
    const filed = filedArtists(space);
    // Same graph, only the sound layer swapped for each other ear.
    const armSpaces = arms.map(a => withAudioLayer(space, a.opts, { skip }));

    for (const id of members) {
      const track = byId.get(id);
      const all = truth.get(id);
      const want = allowed && all ? new Set([...all].filter(pid => allowed.has(pid))) : all;
      if (!want?.size) continue;

      const out = placements(track, space, { limit: limit3, weights: base });
      stats.scored++;
      // "Never filed": none of the track's artists is in any destination of a
      // space that has not seen this track. The engine's weakest case, and the
      // one the bridge exists for.
      const fresh = !(track.artists ?? []).some(a => a?.id && filed.has(a.id));

      const band = out.band ?? BANDS.NONE;
      if (!stats.byBand.has(band)) stats.byBand.set(band, { n: 0, right: 0 });
      const bucket = stats.byBand.get(band);
      bucket.n++;

      const ranked = out.results ?? [];
      if (rows) rows.push({ id, scores: scoresOf(ranked), truth: [...want].sort() });
      const hit1 = ranked[0] && want.has(ranked[0].playlistId);
      const hit3 = ranked.slice(0, 3).some(r => want.has(r.playlistId));

      if (out.declined) {
        stats.declined++;
        // Abstention quality: when it refused, would it have been right anyway?
        // A refusal that would have been correct is a cost, not a virtue.
        if (hit1) stats.declinedWouldHaveBeenRight++;
      }

      if (hit1) { stats.top1++; bucket.right++; }
      if (hit3) stats.top3++;
      if (fresh) { neverFiled.scored++; if (hit1) neverFiled.top1++; if (hit3) neverFiled.top3++; }

      if (plus) {
        const more = placements(track, space, { limit: limit3, weights: plus });
        const r = more.results ?? [];
        if (rowsPlus) rowsPlus.push({ id, scores: scoresOf(r), truth: [...want].sort() });
        const p1 = r[0] && want.has(r[0].playlistId);
        const p3 = r.slice(0, 3).some(x => want.has(x.playlistId));
        if (r[0]?.parts && 'bridge' in r[0].parts) bridgeJudged++;
        withPlus.scored++; if (p1) withPlus.top1++; if (p3) withPlus.top3++;
        if (fresh) { neverFiledPlus.scored++; if (p1) neverFiledPlus.top1++; if (p3) neverFiledPlus.top3++; }
      }

      if (sound) {
        const more = space.audio
          ? placements(track, space, { limit: limit3, weights: soundWeights ?? base, useAudio: true }) : out;
        const r = more.results ?? [];
        if (sound.rows) sound.rows.push({ id, scores: scoresOf(r), truth: [...want].sort() });
        const s1 = r[0] && want.has(r[0].playlistId);
        const s3 = r.slice(0, 3).some(x => want.has(x.playlistId));
        if (space.audio?.index.has(id)) { sound.heard++; if (fresh) sound.heardNeverFiled++; }
        if (r[0]?.parts && ('audio' in r[0].parts || 'learned' in r[0].parts)) sound.judged++;
        if (r[0]?.playlistId !== ranked[0]?.playlistId) sound.changed++;
        sound.all.scored++; if (s1) sound.all.top1++; if (s3) sound.all.top3++;
        if (fresh) { sound.neverFiled.scored++; if (s1) sound.neverFiled.top1++; if (s3) sound.neverFiled.top3++; }

        arms.forEach((a, i) => {
          const sp = armSpaces[i];
          const res = sp.audio ? placements(track, sp, { limit: limit3, weights: soundWeights ?? base, useAudio: true }) : out;
          const ra = res.results ?? [];
          if (a.t.rows) a.t.rows.push({ id, scores: scoresOf(ra), truth: [...want].sort() });
          const a1 = ra[0] && want.has(ra[0].playlistId);
          const a3 = ra.slice(0, 3).some(x => want.has(x.playlistId));
          if (sp.audio?.index.has(id)) { a.t.heard++; if (fresh) a.t.heardNeverFiled++; }
          if (ra[0]?.parts && ('audio' in ra[0].parts || 'learned' in ra[0].parts)) a.t.judged++;
          if (ra[0]?.playlistId !== ranked[0]?.playlistId) a.t.changed++;
          a.t.all.scored++; if (a1) a.t.all.top1++; if (a3) a.t.all.top3++;
          if (fresh) { a.t.neverFiled.scored++; if (a1) a.t.neverFiled.top1++; if (a3) a.t.neverFiled.top3++; }
        });
      }

      // Per-bucket, credited to every bucket the track really is in. This is
      // what finds the buckets the engine does not understand, which a single
      // library-wide average hides completely.
      //
      // Three numbers rather than one, because the obvious single number is
      // unwinnable for a whole class of playlist and said so loudly the first
      // time this ran: every crossover bucket scored exactly 0. A track in both
      // "Tech House" and "Favourites" gets the tighter bucket ranked first —
      // correctly, and the library-wide top-1 counts it right, since truth is a
      // set — so a "view" can never be rank 1 and `rank1` alone reads as total
      // failure where there is none.
      //
      //   rank1     — this bucket came first. Meaningful for a bucket that is
      //               somebody's only home for its tracks; misleading for views.
      //   inTop3    — this bucket was offered at all. The honest measure of
      //               whether the engine has any idea what this bucket is.
      //   exclusive — rank 1 restricted to tracks whose *only* home is here,
      //               which removes the competition and is comparable across
      //               buckets of both kinds.
      const exclusive = want.size === 1;
      for (const pid of want) {
        if (!stats.byPlaylist.has(pid)) {
          stats.byPlaylist.set(pid, { n: 0, rank1: 0, inTop3: 0, exclusiveN: 0, exclusiveRight: 0 });
        }
        const row = stats.byPlaylist.get(pid);
        row.n++;
        const first = ranked[0]?.playlistId === pid;
        if (first) row.rank1++;
        if (ranked.slice(0, 3).some(r => r.playlistId === pid)) row.inTop3++;
        if (exclusive) { row.exclusiveN++; if (first) row.exclusiveRight++; }
      }
    }
  }

  const bands = {};
  for (const [b, v] of stats.byBand) bands[b] = { n: v.n, accuracy: rate(v.right, v.n) };

  const playlists = [...stats.byPlaylist.entries()]
    .map(([id, v]) => ({
      id, n: v.n,
      rank1: rate(v.rank1, v.n),
      inTop3: rate(v.inTop3, v.n),
      exclusive: rate(v.exclusiveRight, v.exclusiveN),
      exclusiveN: v.exclusiveN,
    }))
    // Ranked by `inTop3`, the one of the three that is fair to both a bucket
    // that is somebody's only home and a bucket that is a view of others.
    .sort((a, b) => (a.inTop3 ?? 0) - (b.inTop3 ?? 0) || b.n - a.n);

  const withAudio = sound ? {
    ...tallyOut(sound.all),
    neverFiled: tallyOut(sound.neverFiled),
    // Of the scored tracks: how many had a record, how many of those were by
    // never-filed artists, how many top answers sound had a say in, and how
    // many top answers it moved.
    heard: sound.heard, heardNeverFiled: sound.heardNeverFiled,
    judged: sound.judged, changed: sound.changed,
    analysed: audioOpts.index.size,
    // The weights the sound variant actually ran with: soundWeights when given
    // (sound-first), else the headline's.
    weights: { audio: (soundWeights ?? base).audio ?? WEIGHTS.audio,
               learned: (soundWeights ?? base).learned ?? WEIGHTS.learned },
    ...(soundWeights ? { soundFirst: true } : {}),
    learner: audioOpts.learn !== false && audioOpts.learn !== null,
    ...(sound.rows ? { rows: sound.rows } : {}),
  } : null;

  const result = {
    mode: leaky ? 'leaky' : `${folds}-fold`,
    scored: stats.scored,
    top1: rate(stats.top1, stats.scored),
    top3: rate(stats.top3, stats.scored),
    declined: stats.declined,
    declinedWouldHaveBeenRight: stats.declinedWouldHaveBeenRight,
    bands,
    playlists,
    worstPlaylists: playlists.slice(0, 10),
    neverFiled: tallyOut(neverFiled),
    ...(rows ? { rows } : {}),
    ...(plus ? { withBridge: { ...tallyOut(withPlus), neverFiled: tallyOut(neverFiledPlus),
                               judged: bridgeJudged, weight: bridgeWeight,
                               coverage: bridge.coverage ?? null,
                               ...(rowsPlus ? { rows: rowsPlus } : {}) } } : {}),
    ...(withAudio ? { withAudio } : {}),
    version: VALIDATE_VERSION,
  };
  // The verdict travels with the numbers it was read from, so no caller can
  // show one run's numbers beside another run's verdict.
  if (withAudio) withAudio.gate = audioGate(result);
  if (withAudio && arms.length) {
    withAudio.arms = {};
    for (const a of arms) {
      const arm = { ...tallyOut(a.t.all), neverFiled: tallyOut(a.t.neverFiled),
                    heard: a.t.heard, heardNeverFiled: a.t.heardNeverFiled, judged: a.t.judged, changed: a.t.changed,
                    analysed: a.opts.index.size, ...(a.t.rows ? { rows: a.t.rows } : {}) };
      // Each arm's own verdict against no sound at all, on the same run.
      arm.gate = audioGate({ ...result, withAudio: arm });
      withAudio.arms[a.ear] = arm;
    }
    // Which ear may place tracks, read from this same run (gate.mjs).
    withAudio.choice = earChoice(result);
  }
  return result;
}

/** `audio.arms` → [{ ear, opts, t }] with an index per ear, built once like the first ear's. */
function armsOf(audio, base, collect) {
  const list = audio && typeof audio === 'object' && Array.isArray(audio.arms) ? audio.arms : [];
  if (!list.length || !audio.records) return [];
  return [...new Set(list)].filter(ear => ear !== 'effnet').map(ear => ({
    ear,
    opts: { ...base, index: audioIndex(audio.records, { mel: audio.mel, ear }) },
    t: { all: tally(), neverFiled: tally(), heard: 0, heardNeverFiled: 0, judged: 0, changed: 0, rows: collect ? [] : null },
  }));
}

/** `audio` as placementAccuracy was given it → buildSpace options with a prebuilt index, or null. */
function audioOptions(audio) {
  if (!audio) return null;
  const opts = typeof audio === 'object' && !(audio instanceof Map) && !Array.isArray(audio)
    && ('records' in audio || 'index' in audio || 'learn' in audio || 'feedback' in audio) ? audio : { records: audio };
  const index = opts.index instanceof Map ? opts.index : audioIndex(opts.records, { mel: opts.mel });
  // Passed through as given: undefined lets buildSpace use its default learner.
  // `feedback` (WP-L2) too: buildSpace hands it to the learner with each fold's
  // skip, so a verdict on a held-out track never trains the learner scoring it.
  return { index, ...('learn' in opts ? { learn: opts.learn } : {}),
           ...(opts.feedback ? { feedback: opts.feedback } : {}) };
}
