// The review queue — §35.
//
// "This prevents the user being asked to manually inspect thousands of
// tracks." That is the entire justification, and it is also what makes the
// benchmark §26 asks for reachable: a queue that asks the right two hundred
// questions turns a real library into reviewed data, where asking about
// tracks in playlist order would just exhaust the person.
//
// §35's priority order, implemented as named reasons rather than one opaque
// score, so the UI can say *why* it is asking and a person can decide to work
// through one kind of question at a time.
import { uncertaintyOf, relevanceOf, playlistReach } from '../personal/relevance.mjs';
import { CONFIDENCE } from '../analysis/classify.mjs';

export const QUEUE_VERSION = '3.0.0';

/**
 * The reasons a track or playlist can be worth a person's attention, in
 * §35's order. Weight is what it contributes to that item's priority; they
 * add, because an item can be several of these at once and one that is all of
 * them should be at the very top.
 */
export const REASONS = {
  CONFLICTING_EVIDENCE: { weight: 1.00, why: 'independent sources disagree about what this is' },
  LOW_CONFIDENCE:       { weight: 0.80, why: 'not enough evidence to classify it' },
  HIGH_USE:             { weight: 0.70, why: 'you play this a lot' },
  MANY_PLAYLISTS:       { weight: 0.60, why: 'it is filed in several playlists, so a wrong answer spreads' },
  UNKNOWN_CONCEPT:      { weight: 0.55, why: 'it is tagged with something the ontology does not know' },
  SUSPICIOUS_PLAYLIST:  { weight: 0.50, why: 'this playlist overlaps another in a way worth checking' },
  LIKELY_MISFILE:       { weight: 0.45, why: 'it may be filed in the wrong place' },
  SINGLE_SOURCE:        { weight: 0.30, why: 'only one source has an opinion, and nothing corroborates it' },
  THIN_IDENTITY:        { weight: 0.25, why: 'we are not confident this evidence is even about this recording' },
};

/** Tracks a person could usefully be asked about, most useful first. */
export function trackQueue(profiles, lib, { weights = null, recentlyActive = null,
                                            log = null, limit = 200 } = {}) {
  const reach = playlistReach(lib);
  const answered = new Set(log?.entries?.filter(c => c.kind === 'genre' || c.kind === 'not-sure')
    .map(c => c.trackId) ?? []);

  const byId = new Map();
  for (const p of lib?.playlists ?? []) for (const t of p.tracks ?? []) if (t?.id && !byId.has(t.id)) byId.set(t.id, t);
  for (const t of lib?.liked ?? []) if (t?.id && !byId.has(t.id)) byId.set(t.id, t);

  const rows = [];
  for (const [id, { profile }] of profiles) {
    // Already answered. Asking again is how a review queue loses a person's
    // trust, and the answer is in the log either way.
    if (answered.has(id)) continue;
    const track = byId.get(id);
    if (!track) continue;

    const reasons = [];
    const conf = profile?.genre?.confidence;
    if (conf === CONFIDENCE.AMBIGUOUS) reasons.push('CONFLICTING_EVIDENCE');
    if (conf === CONFIDENCE.INSUFFICIENT_DATA) reasons.push('LOW_CONFIDENCE');
    // Ordering and the HIGH_USE *reason* use different signals on purpose.
    //
    // listeningWeights() blends real plays with a floor derived from how much
    // of an artist you have filed, which is a fair weak relevance signal and
    // fine for ordering. It is NOT "you play this a lot": in a library with
    // no listening history at all, the floor alone pushes every well-stocked
    // artist over any threshold, and the queue tells everybody they play
    // everything. `recentlyActive` is the short-term and recently-played
    // artists — actual plays, nothing else — which is what v1 already uses
    // where it says the same sentence.
    const played = relevanceOf(track, weights);
    if (recentlyActive?.has?.(track.artists?.[0]?.name)) reasons.push('HIGH_USE');
    if ((reach.get(id) ?? 0) >= 3) reasons.push('MANY_PLAYLISTS');
    if (profile?.unknown?.length) reasons.push('UNKNOWN_CONCEPT');
    // The genre answer's own backing, not "did any provider say anything".
    // Read from `coverage` this was dead code: Spotify supplies an era for
    // every dated track, so coverage was never 1 and the reason never fired.
    if ((profile?.confidence?.genreCoverage ?? 0) <= 1 && profile?.genre?.primary) reasons.push('SINGLE_SOURCE');
    // Strictly WORSE than the universal floor. A plain Spotify track with no
    // ISRC and no MusicBrainz match scores exactly the floor, and that is the
    // normal state of most of most libraries — flagging it would put the
    // whole library in the queue and say nothing.
    if ((profile?.confidence?.identity ?? 1) < BARE_IDENTITY) reasons.push('THIN_IDENTITY');
    if (!reasons.length) continue;

    // Scaled by how much the person actually cares about this record. A
    // perfectly ambiguous track nobody has ever played is a real question and
    // a bad one to lead with.
    const score = reasons.reduce((s, r) => s + REASONS[r].weight, 0)
      * (1 + Math.log1p(Math.max(0, played - 1)))
      * (profile?.genre?.primary ? 1 : 1.1);

    rows.push({
      kind: 'track', id,
      artist: track.artists?.[0]?.name ?? null,
      title: track.name ?? null,
      confidence: conf,
      suggested: profile?.genre?.primary ?? null,
      alternatives: profile?.genre?.alternatives ?? [],
      unknown: (profile?.unknown ?? []).map(u => u.raw),
      reasons: reasons.map(r => ({ code: r, why: REASONS[r].why })),
      explanation: profile?.explanation ?? [],
      score: +score.toFixed(4),
      question: questionKey(track, profile),
    });
  }
  return collapse(rows).slice(0, limit);
}

/** The identity confidence a track gets from its Spotify id alone. */
const BARE_IDENTITY = 0.3;

/**
 * What question a row is really asking.
 *
 * Eight tracks by one artist, with no track-level evidence between them, all
 * rest on the same tag cloud and produce the same answer at the same
 * confidence. They are not eight questions — they are one question with eight
 * tracks riding on it, and asking it eight times is exactly the "manually
 * inspect thousands of tracks" §35 exists to prevent.
 *
 * Keyed on the credited artists plus the answer and band, so a track the
 * engine reached a *different* conclusion about — because it has track-level
 * evidence the others lack — stays its own question.
 */
function questionKey(track, profile) {
  const artists = (track.artists ?? []).map(a => a?.id ?? a?.name).filter(Boolean).sort().join('+');
  return JSON.stringify([artists, profile?.genre?.primary ?? null, profile?.genre?.confidence ?? null,
                         (profile?.unknown ?? []).map(u => u.raw).sort()]);
}

/**
 * Collapse rows asking the same question into one, carrying the tracks it
 * covers. A question that decides eight tracks outranks one that decides a
 * single track — logarithmically, because the first few tracks are what make
 * a question worth asking and the rest are diminishing returns.
 */
function collapse(rows) {
  const byQuestion = new Map();
  for (const r of rows) {
    const cur = byQuestion.get(r.question);
    if (!cur) { byQuestion.set(r.question, { ...r, covers: [r], score: r.score }); continue; }
    cur.covers.push(r);
    cur.score = Math.max(cur.score, r.score);
  }
  return [...byQuestion.values()]
    .map(r => {
      const { question, covers, ...rest } = r;
      return {
        ...rest,
        tracks: covers.length,
        // Enough to show the person what they are deciding about, not the
        // whole list — a question covering 300 tracks should not ship 300
        // rows to a UI that will render four of them.
        examples: covers.slice(0, 5).map(c => ({ id: c.id, artist: c.artist, title: c.title })),
        trackIds: covers.map(c => c.id),
        score: +(r.score * (1 + Math.log1p(covers.length - 1))).toFixed(4),
      };
    })
    .sort((a, b) => b.score - a.score);
}

/** Playlists worth a look: suspicious relationships and weak identities. */
export function playlistQueue(classifications, relationships, { log = null, limit = 50 } = {}) {
  const answered = new Set(log?.entries?.filter(c => c.kind === 'playlist-type').map(c => c.playlistId) ?? []);
  const rows = new Map();
  const push = (id, name, reason, detail, weight) => {
    if (answered.has(id)) return;
    const cur = rows.get(id) ?? { kind: 'playlist', id, name, reasons: [], score: 0 };
    cur.reasons.push({ code: reason, why: REASONS[reason]?.why ?? detail, detail });
    cur.score += weight;
    rows.set(id, cur);
  };

  for (const c of classifications.values()) {
    if (c.confidence === CONFIDENCE.AMBIGUOUS)
      push(c.id, c.name, 'CONFLICTING_EVIDENCE',
        c.hybridOf ? `reads as both ${c.hybridOf.join(' and ')}` : 'no dimension leads clearly', 0.9);
    // What it is called and what is in it are different things. This is the
    // single most useful question the engine can ask about a playlist.
    const named = c.nameSaid.find(d => d.kind === 'genre')?.value;
    if (named && c.musicalIdentity.primary && named !== c.musicalIdentity.primary)
      push(c.id, c.name, 'SUSPICIOUS_PLAYLIST',
        `named "${named}" but its tracks are mostly ${c.musicalIdentity.primary}`, 0.85);
    if (c.musicalIdentity.shape === 'mixed' && c.isTarget)
      push(c.id, c.name, 'SUSPICIOUS_PLAYLIST',
        'it takes filing suggestions but is really two collections', 0.7);
  }

  for (const r of relationships ?? []) {
    if (r.kind === 'duplicate' || r.kind === 'near-duplicate')
      for (const side of [r.a, r.b])
        push(side.id, side.name, 'SUSPICIOUS_PLAYLIST', `${r.kind} of "${side === r.a ? r.b.name : r.a.name}"`, 0.8);
  }
  return [...rows.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Concepts the ontology has no answer for, ranked by how much of this
 * library is waiting on them.
 *
 * This is the queue entry that pays for itself most: one person answering
 * "schranz is a kind of hard techno" fixes every track carrying that tag, and
 * it is the mechanism §8 intends for growing the ontology from real libraries
 * rather than from guesswork.
 */
export function conceptQueue(profiles, { log = null, limit = 40 } = {}) {
  const known = log?.conceptMap?.() ?? new Map();
  const tally = new Map();
  for (const { profile } of profiles.values())
    for (const u of profile?.unknown ?? []) {
      if (known.has(u.raw)) continue;
      const cur = tally.get(u.raw) ?? { raw: u.raw, tracks: 0, sources: new Set() };
      cur.tracks++;
      for (const s of u.sources ?? []) cur.sources.add(s);
      tally.set(u.raw, cur);
    }
  return [...tally.values()]
    .map(u => ({ kind: 'concept', raw: u.raw, tracks: u.tracks, sources: [...u.sources],
                 why: `${u.tracks} track${u.tracks === 1 ? '' : 's'} are tagged "${u.raw}" and the ontology has no concept for it` }))
    .sort((a, b) => b.tracks - a.tracks)
    .slice(0, limit);
}

/** The whole queue, in the three sections a person would work through. */
export function reviewQueue(profiles, lib, { classifications = new Map(), relationships = [],
                                             weights = null, recentlyActive = null,
                                             log = null, limits = {} } = {}) {
  return {
    tracks: trackQueue(profiles, lib, { weights, recentlyActive, log, limit: limits.tracks ?? 200 }),
    playlists: playlistQueue(classifications, relationships, { log, limit: limits.playlists ?? 50 }),
    concepts: conceptQueue(profiles, { log, limit: limits.concepts ?? 40 }),
    version: QUEUE_VERSION,
  };
}
