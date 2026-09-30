// Tempo and key, if you happen to have them.
//
// `rekordbox.mjs` already imports a Rekordbox collection into `rekordbox.json`
// as `{ [spotifyTrackId]: { bpm, key, camelot } }`, and until now nothing read
// it back. It is the listener's own factual data rather than a third party's
// opinion, which is what makes it fair game — but `CLAUDE.md` is explicit that
// external enrichment must be "silently absent and zero-cost for anyone who
// doesn't have it, never something the core filing model leans on", and most
// people will never export a Rekordbox library.
//
// So the contract here is stronger than "optional". For any track not in the
// file, the engine's output must be **identical** — same ranking, same scores,
// same confidence band — whether or not the file is loaded at all. That is not
// a claim to be trusted; `test/intrinsic.test.mjs` asserts it directly, and
// without that test this module would be exactly the dependency the rule
// forbids.
//
// The mechanism that makes it true is the one already in `combine()`: a
// component that cannot be judged is dropped and the remaining weights are
// renormalised, so a missing bpm costs nothing rather than scoring zero. These
// features return null far more often than they return a number, and that is
// the normal case rather than a degraded one.
export const BONUS_VERSION = '4.0.0';

/** Tempo is only worth comparing within a tolerance that means something to a
 *  DJ. Half and double time are deliberately *not* treated as matches: a 140
 *  bpm record does not belong in a 70 bpm bucket just because the arithmetic
 *  works. */
export const BPM_TOLERANCE = 6;

/** Harmonic mixing: the Camelot wheel. Same key mixes, its relative
 *  major/minor mixes, and one step around the wheel mixes. Everything else is
 *  a clash, which is a real distinction rather than a smooth falloff. */
export const KEY_MATCH = { same: 1, relative: 0.8, adjacent: 0.7, clash: 0 };

const CAMELOT = /^(\d{1,2})([AB])$/;

/** `{ trackId: {bpm, key, camelot} }`, or an empty lookup. Never throws: an
 *  absent or malformed file is the ordinary case, not an error. */
export function bonusIndex(raw) {
  if (!raw || typeof raw !== 'object') return { byTrack: new Map(), size: 0, version: BONUS_VERSION };
  const byTrack = new Map();
  for (const [id, row] of Object.entries(raw)) {
    if (!id || !row || typeof row !== 'object') continue;
    const raw_bpm = Number(row.bpm);
    // Usable, not merely finite. A bpm of 0 or -1 is finite and means nothing,
    // and the first version of this guard let such a row through carrying
    // neither a tempo nor a key — an entry that exists and says nothing, which
    // is worse than no entry, because `bonusProfileOf` would count it.
    const bpm = Number.isFinite(raw_bpm) && raw_bpm > 0 ? raw_bpm : null;
    const camelot = typeof row.camelot === 'string' && CAMELOT.test(row.camelot.toUpperCase())
      ? row.camelot.toUpperCase() : null;
    if (bpm === null && camelot === null) continue;
    byTrack.set(id, { bpm, camelot });
  }
  return { byTrack, size: byTrack.size, version: BONUS_VERSION };
}

/** How well two Camelot keys mix, or null when either is unreadable. */
export function keyCompatibility(a, b) {
  const ma = CAMELOT.exec(String(a ?? '').toUpperCase());
  const mb = CAMELOT.exec(String(b ?? '').toUpperCase());
  if (!ma || !mb) return null;
  const [, na, la] = ma, [, nb, lb] = mb;
  const x = Number(na), y = Number(nb);
  if (x === y && la === lb) return KEY_MATCH.same;
  if (x === y) return KEY_MATCH.relative;           // relative major/minor
  // The wheel wraps: 12 and 1 are adjacent.
  const step = Math.min(Math.abs(x - y), 12 - Math.abs(x - y));
  if (step === 1 && la === lb) return KEY_MATCH.adjacent;
  return KEY_MATCH.clash;
}

/** A bucket's tempo and key shape, over whichever of its tracks the file knows.
 *  `n` is reported so a caller can tell "this bucket has no tempo data" from
 *  "this bucket's tempo is all over the place". */
export function bonusProfileOf(playlist, bonus, { skip = null } = {}) {
  const bpms = [], keys = new Map();
  let n = 0;
  for (const t of playlist?.tracks ?? []) {
    if (!t?.id || skip?.has(t.id)) continue;
    const row = bonus?.byTrack?.get(t.id);
    if (!row) continue;
    n++;
    if (row.bpm !== null) bpms.push(row.bpm);
    if (row.camelot) keys.set(row.camelot, (keys.get(row.camelot) ?? 0) + 1);
  }
  const mean = bpms.length ? bpms.reduce((a, b) => a + b, 0) / bpms.length : null;
  return { n, bpmCount: bpms.length, bpm: { mean }, keys, keyCount: [...keys.values()].reduce((a, b) => a + b, 0) };
}

/** At least this many of a bucket's tracks must be known before its tempo or
 *  key shape is worth comparing against. Three records is a coincidence. */
export const MIN_KNOWN = 4;

/**
 * Tempo and key scores for one track against one bucket, both nullable.
 *
 * Returns `{ bpm: null, key: null }` for any track the file does not know,
 * which is what makes the absence of the whole file free: `combine()` drops
 * null components and renormalises, so the arithmetic is byte-identical to a
 * run where this module was never called.
 */
export function bonusScores(track, bonusProfile, bonus) {
  const row = bonus?.byTrack?.get(track?.id);
  if (!row || !bonusProfile || bonusProfile.n < MIN_KNOWN) return { bpm: null, key: null };

  let bpm = null;
  if (row.bpm !== null && bonusProfile.bpmCount >= MIN_KNOWN && bonusProfile.bpm.mean !== null) {
    const off = Math.abs(row.bpm - bonusProfile.bpm.mean);
    bpm = off <= BPM_TOLERANCE ? 1 - (off / BPM_TOLERANCE) * 0.5 : Math.max(0, 0.5 - (off - BPM_TOLERANCE) / 30);
  }

  let key = null;
  if (row.camelot && bonusProfile.keyCount >= MIN_KNOWN) {
    let best = 0, judged = false;
    for (const [k, count] of bonusProfile.keys) {
      const c = keyCompatibility(row.camelot, k);
      if (c === null) continue;
      judged = true;
      best = Math.max(best, c * (count / bonusProfile.keyCount) + c * 0.5);
    }
    key = judged ? Math.min(1, best) : null;
  }

  return { bpm, key };
}
