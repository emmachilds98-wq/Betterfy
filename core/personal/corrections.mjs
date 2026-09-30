// The personal layer — §23, and §39's bottom row.
//
// The rule that shapes every line of this file: a correction never touches
// provider evidence. What Last.fm said stays exactly what Last.fm said, and
// what the listener said is stored beside it, so that:
//
//   - reclassifying the library after an ontology change cannot silently
//     discard a year of somebody's corrections, and
//   - a correction cannot silently corrupt the global model either. If you
//     file all your minimal techno under "Techno" because that is how your
//     brain works, that is true of your library and not of the world.
//
// Hence two answers, always available side by side: what the evidence says,
// and what you said. §23 calls them the global and personal classifications.
//
// The log is append-only. "I moved this to Deep House in March and back to
// Tech House in June" is a different fact from "this is Tech House", and the
// second is recoverable from the first while the reverse is not.

export const CORRECTIONS_VERSION = '3.0.0';

/**
 * What a listener can tell the engine.
 *
 *   accept / reject   a filing suggestion, per (track, playlist)
 *   skip              deferred, not judged — the weakest signal there is
 *   move              filed somewhere, having been somewhere else
 *   genre             "this track is X", the strongest statement available
 *   not-sure          from the review UI: recorded, because knowing a human
 *                     looked and could not tell is worth as much as an answer
 *   playlist-type     "this playlist is a mood bucket, whatever it is called"
 *   concept           "the tag X means Y" — grows the ontology from real use
 */
export const KINDS = ['accept', 'reject', 'skip', 'move', 'genre', 'not-sure', 'playlist-type', 'concept'];

/** @typedef {{kind: string, trackId?: string, playlistId?: string, fromPlaylistId?: string,
 *             value?: string, raw?: string, at: number, note?: string}} Correction */

/** Build one correction. Frozen, like evidence, and for the same reason. */
export function correction({ kind, trackId = null, playlistId = null, fromPlaylistId = null,
                             value = null, raw = null, at = Date.now(), note = null } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`unknown correction kind: ${kind}`);
  return Object.freeze({ kind, trackId, playlistId, fromPlaylistId, value, raw, at, note,
                         version: CORRECTIONS_VERSION });
}

/**
 * An append-only log of what the listener has told the engine, plus the
 * derived views the rest of the app actually reads.
 *
 * Derived views are rebuilt from the log rather than maintained alongside it,
 * so there is exactly one source of truth and no way for the two to disagree.
 */
export class CorrectionLog {
  constructor(entries = []) {
    this.entries = [...entries];
  }

  add(...corrections) {
    for (const c of corrections) if (c) this.entries.push(c);
    return this;
  }

  /** Every correction about one track, oldest first. */
  forTrack(trackId) { return this.entries.filter(c => c.trackId === trackId); }

  /**
   * The listener's own genre for a track, or null.
   *
   * The most recent explicit statement wins — a person who changes their mind
   * has changed their mind, and the earlier entry stays in the log.
   */
  genreOf(trackId) {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const c = this.entries[i];
      if (c.trackId === trackId && c.kind === 'genre') return c.value;
    }
    return null;
  }

  /** Playlists this track has been rejected for. Never expires: they meant it. */
  rejectedFor(trackId) {
    return [...new Set(this.entries
      .filter(c => c.trackId === trackId && c.kind === 'reject' && c.playlistId)
      .map(c => c.playlistId))];
  }

  /** How many times a track has been skipped, and when last. */
  skipsOf(trackId) {
    const skips = this.entries.filter(c => c.trackId === trackId && c.kind === 'skip');
    return { skips: skips.length, lastSkip: skips.length ? skips[skips.length - 1].at : null };
  }

  /** The listener's own type for a playlist, or null. */
  typeOf(playlistId) {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const c = this.entries[i];
      if (c.playlistId === playlistId && c.kind === 'playlist-type') return c.value;
    }
    return null;
  }

  /** Tracks a human looked at and could not classify. Not failures — data. */
  unsure() {
    return [...new Set(this.entries.filter(c => c.kind === 'not-sure' && c.trackId).map(c => c.trackId))];
  }

  /**
   * Raw strings the listener has mapped to a concept the ontology knows.
   *
   * This is §8's "candidate concepts for later review" closing the loop: the
   * review queue surfaces an unmapped tag, a person says what it means, and
   * the answer is available to the normaliser without an ontology release.
   * @returns {Map<string, string>} raw -> concept
   */
  conceptMap() {
    const m = new Map();
    for (const c of this.entries) if (c.kind === 'concept' && c.raw && c.value) m.set(c.raw.toLowerCase(), c.value);
    return m;
  }

  /**
   * How much a listener has corrected the engine about a given concept.
   *
   * Not used to change any classification — that would be the personal layer
   * leaking into the global model, which §23 forbids. It is a *report*: forty
   * corrections all moving tracks out of `tech-house` says the ontology, the
   * weights or the evidence is wrong about tech house, and that is worth a
   * human knowing.
   */
  disagreements() {
    const tally = new Map();
    for (const c of this.entries) {
      if (c.kind !== 'genre' || !c.value) continue;
      tally.set(c.value, (tally.get(c.value) ?? 0) + 1);
    }
    return [...tally].sort((a, b) => b[1] - a[1]).map(([concept, count]) => ({ concept, count }));
  }

  toJSON() { return { version: CORRECTIONS_VERSION, entries: this.entries }; }

  static fromJSON(json) {
    return new CorrectionLog((json?.entries ?? []).map(e => Object.freeze({ ...e })));
  }
}

/**
 * Import v1's feedback store without losing anything.
 *
 * v1 keeps `{ [trackId]: { skips, lastSkip, rejected: [playlistId] } }` and
 * that is real, hard-won signal — somebody sat and told the app "no, not
 * there" one track at a time. Discarding it because the new schema is nicer
 * would be the worst possible upgrade.
 *
 * Timestamps: v1 records only `lastSkip`, so repeated skips all land on it.
 * That is lossy and there is nothing to be done about it; the count survives,
 * which is what anything downstream actually reads.
 */
export function fromV1Feedback(fb, { now = Date.now() } = {}) {
  const log = new CorrectionLog();
  for (const [trackId, entry] of Object.entries(fb ?? {})) {
    const at = Date.parse(entry?.lastSkip ?? '') || now;
    for (const playlistId of entry?.rejected ?? [])
      log.add(correction({ kind: 'reject', trackId, playlistId, at, note: 'imported from v1 feedback' }));
    for (let i = 0; i < (entry?.skips ?? 0); i++)
      log.add(correction({ kind: 'skip', trackId, at, note: 'imported from v1 feedback' }));
  }
  return log;
}

/**
 * Merge two logs, for the cross-device sync v1 already does.
 *
 * Append-only makes this nearly trivial and, more importantly, safe: there is
 * no field to pick a winner for, so no device can lose what another recorded.
 * Entries are de-duplicated on their content so syncing twice is a no-op.
 */
export function mergeLogs(a, b) {
  const seen = new Set();
  const out = [];
  for (const c of [...(a?.entries ?? []), ...(b?.entries ?? [])]) {
    const k = JSON.stringify([c.kind, c.trackId, c.playlistId, c.fromPlaylistId, c.value, c.raw, c.at]);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  out.sort((x, y) => x.at - y.at);
  return new CorrectionLog(out);
}

/**
 * The profile as this listener sees it: the global answer, their own answer,
 * and which one applies.
 *
 * The global profile is returned untouched — not copied-and-edited, the same
 * object — because §39's whole point is that the derived layer below is
 * disposable and the layer above is not. A caller that wants the evidence's
 * opinion can always still get it.
 */
export function personalView(profile, log, { trackId = null } = {}) {
  const id = trackId ?? profile?.identity?.spotifyId ?? null;
  const own = id ? log?.genreOf?.(id) ?? null : null;
  return {
    global: profile?.genre ?? null,
    personal: own ? { primary: own, source: 'you' } : null,
    // What to actually file on. The listener wins when they have said
    // something: it is their library, and they are the only party here who
    // has heard the record.
    effective: own ?? profile?.genre?.primary ?? null,
    overridden: !!own && own !== profile?.genre?.primary,
    rejectedFor: id ? log?.rejectedFor?.(id) ?? [] : [],
    ...(id ? log?.skipsOf?.(id) ?? {} : {}),
  };
}
