// What the listener said about a filing, as examples for the sound learner.
//
// WP-L2 of docs/AUDIO-BUILD-PLAN.md. The learner (audio-learn.mjs) trains on
// each playlist's analysed members. This turns the listener's verdicts into
// two more kinds of example, per (track, playlist):
//
//   positive  "yes, this belongs there": an accepted suggestion, or the
//             destination of a move. Counted as a member of that playlist
//             even before the next sync shows it in the playlist.
//   negative  "no, not there": a rejected suggestion, or the playlist a track
//             was moved out of. Taken out of that playlist's members if it was
//             one (a correction beats membership: the listener has heard the
//             track, the snapshot is only where it happened to be) and used
//             as evidence against that playlist's sound.
//
// The latest statement about a pair wins, so "rejected in March, accepted in
// June" is a positive. A skip is not a verdict and teaches nothing here.
//
// Two places hold verdicts, and both are read:
//   - core/personal/corrections.mjs: a CorrectionLog, its JSON, or its entries
//     (accept / reject / move, oldest first by `at`)
//   - the page's synced feedback state (docs/app.template.html `FB`, the same
//     object `syncGroups/{id}/state/feedback` carries):
//       { [trackId]: { skips, lastSkip, rejected: [playlistId], accepted?: [playlistId] } }
//     It has no times, so within it a pair that is both accepted and rejected
//     counts as rejected (the page only keeps a reject the listener meant).
//
// Nothing leaves the account: these are this listener's own verdicts on their
// own playlists, used only to train their own learner
// (docs/SMARTER-GENRES-PLAN.md §3).

export const AUDIO_FEEDBACK_VERSION = '1.0.0';

const isFeedback = x => x && x.pos instanceof Map && x.neg instanceof Map;

/** Deterministic map of track id → sorted playlist ids, sorted by track id. */
function sortedPairs(m) {
  return new Map([...m].filter(([, s]) => s.size).sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([id, s]) => [id, [...s].sort()]));
}

/**
 * Every verdict in `sources`, folded into { pos, neg }: track id → playlist
 * ids, each pair in at most one of the two. Later sources win over earlier
 * ones for the same pair.
 *
 * @param {...*} sources  CorrectionLog | { entries } | Correction[] | page FB object | an earlier result | null
 * @returns {{ pos: Map<string, string[]>, neg: Map<string, string[]>, n: number, version: string }}
 */
export function feedbackExamples(...sources) {
  const state = new Map(); // `${track}\u0000${playlist}` → 'pos' | 'neg'
  const set = (t, p, v) => { if (t && p) state.set(`${t}\u0000${p}`, v); };

  for (const src of sources) {
    if (!src) continue;
    if (isFeedback(src)) {
      for (const [t, ps] of src.pos) for (const p of ps) set(t, p, 'pos');
      for (const [t, ps] of src.neg) for (const p of ps) set(t, p, 'neg');
      continue;
    }
    const entries = Array.isArray(src) ? src : Array.isArray(src.entries) ? src.entries : null;
    if (entries) {
      // Stable by time: equal times keep log order, which is append order.
      const ordered = entries.map((c, i) => [c, i]).sort((a, b) => ((a[0]?.at ?? 0) - (b[0]?.at ?? 0)) || a[1] - b[1]);
      for (const [c] of ordered) {
        if (!c?.trackId) continue;
        if (c.kind === 'accept') set(c.trackId, c.playlistId, 'pos');
        else if (c.kind === 'reject') set(c.trackId, c.playlistId, 'neg');
        else if (c.kind === 'move') {
          if (c.fromPlaylistId && c.fromPlaylistId !== c.playlistId) set(c.trackId, c.fromPlaylistId, 'neg');
          set(c.trackId, c.playlistId, 'pos');
        }
      }
      continue;
    }
    if (typeof src === 'object') {
      for (const id of Object.keys(src).sort()) {
        const f = src[id];
        for (const p of Array.isArray(f?.accepted) ? f.accepted : []) set(id, p, 'pos');
        for (const p of Array.isArray(f?.rejected) ? f.rejected : []) set(id, p, 'neg');
      }
    }
  }

  const pos = new Map(), neg = new Map();
  for (const [k, v] of state) {
    const [t, p] = k.split('\u0000');
    const m = v === 'pos' ? pos : neg;
    (m.get(t) ?? m.set(t, new Set()).get(t)).add(p);
  }
  const out = { pos: sortedPairs(pos), neg: sortedPairs(neg), version: AUDIO_FEEDBACK_VERSION };
  out.n = [...out.pos.values(), ...out.neg.values()].reduce((s, ps) => s + ps.length, 0);
  return out;
}

/**
 * The same verdicts with every pair about a track in `skip` removed. This is
 * the honesty rule: a track being scored (a held-out fold) must not have the
 * listener's verdict on it handed to the learner that scores it, any more
 * than its playlist membership is.
 */
export function withoutTracks(fb, skip) {
  if (!fb || !skip?.size) return fb;
  const drop = m => new Map([...m].filter(([t]) => !skip.has(t)));
  const out = { pos: drop(fb.pos), neg: drop(fb.neg), version: fb.version };
  out.n = [...out.pos.values(), ...out.neg.values()].reduce((s, ps) => s + ps.length, 0);
  return out;
}
