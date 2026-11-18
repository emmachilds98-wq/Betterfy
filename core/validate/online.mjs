// @bundle engine BetterfyOnline 215
// Does learning from every tap help the next card? (docs/BUILD-7-PLAN.md E1)
//
// The Score run's held-out folds, replayed in the order the listener added the
// tracks. For each fold the space is built without it (as placementAccuracy
// does), then every held-out track is placed twice:
//
//   static  against the fold's space as built: what File showed before E1,
//           where only a rebuild learns.
//   online  against the same space after the taps on the tracks before it in
//           the replay: each was filed where it really sits (learnFiled), and
//           when the top pick was wrong, that pick got a "not there"
//           (learnRejected), as a pick of another playlist does on the page.
//
// Same tracks, same space, so the difference is the online learning and
// nothing else. A track never learns from itself: its own tap comes after it
// is scored. Nothing leaves the account; the result is a few counts.
import { buildSpace, placements, learnFiled, learnRejected } from '../intrinsic/space.mjs';
import { truthOf, scoredTracks, foldOf, DEFAULT_FOLDS } from './loo.mjs';

export const ONLINE_SCORE_VERSION = '1.0.0';

/**
 * @returns {{ version, scored, static: { top1, top3 }, online: { top1, top3 },
 *             repeat: { scored, static, online } }}
 *   `repeat`: the tracks whose artist was tapped earlier in the same fold, where
 *   online learning can act at all.
 */
export function onlineAccuracy(lib, { folds = DEFAULT_FOLDS, isMirror = null, targets = null, limit = null,
                                      genreGraph = false, audio = null, soundFirst = false, reject = true } = {}) {
  const truth = truthOf(lib, { isMirror });
  const allowed = targets ? new Set(targets) : null;
  const tracks = scoredTracks(lib, { limit, isMirror, targets: allowed });
  const addedAt = new Map();
  for (const p of lib.playlists ?? []) for (const t of p.tracks ?? []) {
    const at = t.added_at ?? '';
    if (!addedAt.has(t.id) || at < addedAt.get(t.id)) addedAt.set(t.id, at);
  }
  const groups = new Map();
  for (const t of tracks) {
    const f = foldOf(t.id, folds);
    (groups.get(f) ?? groups.set(f, []).get(f)).push(t);
  }
  const tally = () => ({ n: 0, top1: 0, top3: 0 });
  const st = tally(), on = tally(), rs = tally(), ro = tally();
  for (const [, members] of groups) {
    members.sort((a, b) => (addedAt.get(a.id) ?? '').localeCompare(addedAt.get(b.id) ?? '') || (a.id < b.id ? -1 : 1));
    const skip = new Set(members.map(t => t.id));
    const opts = { skip, isMirror, targets: allowed, genreGraph, ...(audio ? { audio } : {}) };
    const fixed = buildSpace(lib, opts), live = buildSpace(lib, opts);
    const tapped = new Set();
    for (const t of members) {
      const all = truth.get(t.id);
      const want = allowed && all ? [...all].filter(id => allowed.has(id)) : [...(all ?? [])];
      if (!want.length) continue;
      const rank = space => (placements(t, space, { limit: 3, soundFirst }).results ?? []).map(r => r.playlistId);
      const a = rank(fixed), b = rank(live);
      const repeat = (t.artists ?? []).some(x => x?.id && tapped.has(x.id));
      for (const [ids, c, r] of [[a, st, rs], [b, on, ro]]) {
        const h1 = want.includes(ids[0]), h3 = ids.some(id => want.includes(id));
        c.n++; c.top1 += h1; c.top3 += h3;
        if (repeat) { r.n++; r.top1 += h1; r.top3 += h3; }
      }
      // The tap: filed where it sits; a wrong first pick is a "not there".
      for (const id of want) learnFiled(live, t, id);
      if (reject && b[0] && !want.includes(b[0])) learnRejected(live, t, b[0]);
      for (const x of t.artists ?? []) if (x?.id) tapped.add(x.id);
    }
  }
  const pc = (c, k) => (c.n ? +(c[k] / c.n).toFixed(4) : null);
  const out = c => ({ top1: pc(c, 'top1'), top3: pc(c, 'top3'), right: c.top1 });
  return { version: ONLINE_SCORE_VERSION, scored: st.n, static: out(st), online: out(on),
           repeat: { scored: rs.n, static: out(rs), online: out(ro) } };
}
