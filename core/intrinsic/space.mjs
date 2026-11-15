// @bundle engine BetterfyIntrinsic 10
// The intrinsic space — where a track sits, and which of this account's
// buckets it sits nearest.
//
// This is the layer that answers the reframed question. It never asks what a
// record is; it asks which of the listener's own buckets it resembles, and it
// answers from the buckets' own members. The vocabulary problem disappears
// because no vocabulary is involved.
//
// Every number below is a declared prior, not a fitted value. There is no
// recommendation benchmark to fit against yet — but unlike the tag engine's
// thresholds, these have somewhere to go: leave-one-out placement accuracy over
// the account's own library is a real fitness surface with thousands of rows,
// and `core/validate/loo.mjs` computes it.
import { cooccurrence, trackVector, cosine, centroid, norm } from './cooccurrence.mjs';
import { registrantIndex, profileOf, shapeScores, registrantOf, registrantWeight,
         formatOf, eraOf } from './features.mjs';
import { mirrorPredicate } from '../playlists/mirror.mjs';
import { explain } from './explain.mjs';
import { bonusIndex, bonusProfileOf, bonusScores } from './bonus-rekordbox.mjs';
import { bridgeIndex, artistHomes, bridgeScores } from './bridge.mjs';
import { audioIndex, buildAudioProfiles, audioScores } from './audio.mjs';
import { trainLearner } from './audio-learn.mjs';
import { tempoOf, tempoRelation, MIX_MIN_CONF } from '../audio/match.mjs';

// 4.1.0: the audio layer (WP-E2 of docs/AUDIO-BUILD-PLAN.md). With no audio
// passed, every output except this string is byte-identical to 4.0.0
// (test/audioengine.test.mjs holds it to a hash of main's output).
export const SPACE_VERSION = '4.1.0';

/**
 * Relative weights. `graph` leads because the artist neighbourhood is the only
 * component that carries what the listener *means* rather than what the record
 * merely *is*: format and era describe an object, co-occurrence describes a
 * taxonomy.
 *
 * Components that cannot be judged for a given track are dropped and the rest
 * renormalised, so a missing ISRC costs nothing rather than scoring zero.
 */
export const WEIGHTS = {
  graph:       1.00,
  registrant:  0.50,
  minutes:     0.25,
  era:         0.30,
  albumType:   0.20,
  albumTracks: 0.15,
  popularity:  0.10,
  // Bonus layer (§4.7). Present only for a listener who has imported a
  // Rekordbox collection, and null for every track that import does not cover —
  // which `combine()` drops rather than scoring zero, so the weights below
  // cannot affect anybody who does not have the file.
  bpm:         0.40,
  key:         0.25,
  // Neighbour bridge (docs/SMARTER-GENRES-PLAN.md §4.1b): where this artist's
  // outside neighbours are filed. Only present when a bridge was gathered and
  // passed in, and null for a track none of whose artists it knows, so like
  // the bonus layer it costs nothing to anybody without one. A prior: phase 0
  // exists to measure whether it earns any weight at all.
  bridge:      0.50,
  // Sound (docs/AUDIO-BUILD-PLAN.md WP-E1/E2/L1). `audio` is how close the
  // track sounds to each playlist's analysed members (nearest centroid, which
  // phase 0 measured at 58% top-1 on its own); `learned` is the per-account
  // classifier trained on the same members. Both are priors, and both are
  // **gated**: `placements` only lets them into the score with `useAudio`,
  // which a caller sets only once `core/validate/gate.mjs` has passed on the
  // account's own library. Until then they are computed and shown on each row
  // (`heard`) and change no suggestion. Null for an unheard track, so like the
  // bonus layer they cost nothing to anybody without audio.
  audio:       0.50,
  learned:     0.50,
};

/**
 * Sound-first filing: the owner's call (2026-11-14) that what a track *sounds
 * like* should decide where it goes, with who-you-file-together only breaking
 * ties. Used for a track the app has heard; an unheard track is scored with
 * WEIGHTS exactly as before. The learner (trained on each genre playlist's own
 * tracks) leads, the nearest-sound centroid backs it up, and the artist graph,
 * built from genre playlists only so a mood or event playlist cannot vote,
 * stays in at a lower weight because an artist's other filing still says
 * something. Priors, measured by the Score run's sound variant
 * (placementAccuracy's `soundWeights`) on the account's own library.
 */
export const SOUND_FIRST_WEIGHTS = Object.freeze({
  learned:     2.00,
  audio:       1.50,
  graph:       0.50,
  bridge:      0.40,
  bpm:         0.40,
  registrant:  0.25,
  era:         0.15,
  minutes:     0.10,
  albumType:   0.10,
  key:         0.10,
  albumTracks: 0.05,
  popularity:  0.05,
});

/**
 * A bucket needs enough members to have a definition at all. Below this its
 * centroid is one or two records wearing a playlist's name, and treating that
 * as a learned meaning is how an engine acquires confident nonsense.
 *
 * Matches `MIN_PROFILED_TRACKS` in the playlist fingerprint deliberately: the
 * two answer the same question about the same libraries.
 */
export const MIN_DEFINITION_TRACKS = 5;

/** Bands, in the vocabulary the rest of the engine already uses. */
export const BANDS = { HIGH: 'HIGH', LIKELY: 'LIKELY', AMBIGUOUS: 'AMBIGUOUS', NONE: 'INSUFFICIENT_DATA' };

export const THRESHOLDS = {
  /** A top score below this is not a placement, it is a shrug. */
  MIN_SCORE: 0.10,
  /** How far clear of the runner-up the leader must be to read as HIGH. */
  HIGH_MARGIN: 0.08,
  /** And how strong in absolute terms. */
  HIGH_SCORE: 0.35,
  /** Below this margin two buckets are genuinely competing. */
  AMBIGUOUS_MARGIN: 0.02,
};

/**
 * Build everything the scorer needs, once.
 *
 * `skip` threads all the way down. Passing a track id here makes the entire
 * space — graph, registrant spans, bucket profiles and centroids — behave as
 * though that track had never been filed, which is what honest leave-one-out
 * requires and what `core/validate/loo.mjs` exercises.
 *
 * Destinations are chosen **structurally**: every non-mirror playlist with
 * enough members. Deliberately not `playlists.config.json`, whose `target`
 * flags are generated from one person's library — an account-native engine
 * cannot start by reading a file that assumes whose account it is.
 */
export function buildSpace(lib, { skip = null, isMirror = null, rekordbox = null, targets = null,
                                  bridge = null, audio = null, genreGraph = false } = {}) {
  // `targets`, when given, is the set of playlists the listener files into —
  // their genre playlists. Only those become destinations. Every playlist still
  // feeds the artist graph below: a "Sunday" playlist is not somewhere to file
  // a track, but it is still evidence of which artists belong together.
  const allowed = targets ? new Set(targets) : null;
  // Absent by default and absent for almost everybody. `bonusIndex(null)` is an
  // empty lookup, which makes every bonus score null, which makes the whole
  // layer free.
  const bonus = bonusIndex(rekordbox);
  // `genreGraph`: the artist graph learns only from the genre playlists
  // (`targets`), so mood and event playlists stop teaching genre. Off by
  // default, so every existing caller's space is unchanged.
  const graph = cooccurrence(lib, { skip, isMirror, only: genreGraph && allowed ? allowed : null });
  const registrants = registrantIndex(lib, { skip, isMirror });

  // A playlist holding essentially the whole library is a record rather than a
  // home. `cooccurrence` already drops it from the graph; it must also never be
  // offered as a destination, or it wins every comparison by the trivial merit
  // of containing everything — one of the four silent failures the mirror fix
  // was written for. Same structural predicate, so the two cannot disagree.
  const isStructuralMirror = mirrorPredicate(lib, { also: isMirror ?? undefined });

  const destinations = new Map();
  for (const p of lib?.playlists ?? []) {
    if (!p?.id || isStructuralMirror(p)) continue;
    if (allowed && !allowed.has(p.id)) continue;
    const tracks = (p.tracks ?? []).filter(t => t?.id && !skip?.has(t.id));
    if (tracks.length < MIN_DEFINITION_TRACKS) continue;
    // Counts rather than only membership, because an explanation has to be able
    // to say "who are in this playlist 12 times" — a set can say that an artist
    // is here, which is not the same claim and is far less convincing.
    const artistCounts = new Map();
    const registrantCounts = new Map();
    for (const t of tracks) {
      for (const a of t.artists ?? []) {
        if (!a?.id) continue;
        const row = artistCounts.get(a.id) ?? { name: a.name ?? null, n: 0 };
        row.n++;
        if (!row.name && a.name) row.name = a.name;
        artistCounts.set(a.id, row);
      }
      const r = registrantOf(t);
      if (r) registrantCounts.set(r, (registrantCounts.get(r) ?? 0) + 1);
    }

    const centroidVec = centroid(tracks.map(t => trackVector(t, graph)));
    destinations.set(p.id, {
      id: p.id,
      name: p.name ?? null,
      n: tracks.length,
      profile: profileOf(p, { skip }),
      centroid: centroidVec,
      centroidNorm: norm(centroidVec),
      artists: new Set(artistCounts.keys()),
      artistCounts,
      registrantCounts,
      // Membership by id, so overlap between two buckets can be measured
      // without walking either one again.
      trackIds: new Set(tracks.map(t => t.id)),
      bonusProfile: bonus.size ? bonusProfileOf(p, bonus, { skip }) : null,
    });
  }

  // Library-wide base rates, so an explanation can tell a distinguishing fact
  // from a universal one. "A single, and 100% of this bucket is too" is not a
  // reason to choose this bucket when 100% of every bucket is a single — it is
  // a horoscope. The same IDF instinct that stopped "electronic" dominating
  // every tag comparison, applied to explanations.
  const everyTrack = [];
  for (const d of destinations.values()) everyTrack.push(d);
  const baseline = { albumType: new Map(), era: new Map(), n: 0 };
  for (const d of everyTrack) {
    for (const [k, share] of d.profile.albumType) {
      baseline.albumType.set(k, (baseline.albumType.get(k) ?? 0) + share * d.n);
    }
    for (const [k, share] of d.profile.era) {
      baseline.era.set(k, (baseline.era.get(k) ?? 0) + share * d.n);
    }
    baseline.n += d.n;
  }
  if (baseline.n) {
    for (const m of [baseline.albumType, baseline.era]) {
      for (const [k, v] of m) m.set(k, v / baseline.n);
    }
  }

  // Only with a bridge does the space carry one, so a space built without it
  // is the same object, key for key, that it always was.
  const bridgeIdx = bridge ? bridgeIndex(bridge) : null;
  const withBridge = bridgeIdx?.size ? { bridge: bridgeIdx, artistHomes: artistHomes(destinations) } : {};

  // Same rule for sound: only with at least one usable record does the space
  // carry an audio layer, so `audio: null`, `[]` or a pile of misses leaves the
  // space exactly as it was. Profiles are built from `destinations`, which have
  // already dropped mirrors, non-targets and `skip`, so a held-out fold is never
  // part of the sound it is scored against, and a learner trained here never
  // saw it either.
  const withAudio = audioLayer(audio, destinations, skip);

  return { graph, registrants, destinations, baseline, bonus, version: SPACE_VERSION,
           targets: allowed ? [...allowed].sort() : null, ...withBridge, ...withAudio };
}

/**
 * `audio` may be the records themselves (array, Map, or id → record object,
 * anything `audioIndex` reads), or options:
 *
 *   { records, mel }   records, optionally dropping another mel front end's
 *   { index }          an `audioIndex` already built (reused across folds)
 *   { feedback }       WP-L2: the listener's verdicts (audio-feedback.mjs
 *                      reads a CorrectionLog or the page's feedback state),
 *                      handed to the trainer with `skip`, the fold whose
 *                      verdicts it must drop
 *   { learn }          a trainer, called once per space with
 *                      `{ index, profiles, minMembers }` (plus `skip` and
 *                      `feedback` when feedback is given): `profiles` is
 *                      destination id → analysed members (`.ids`), already
 *                      without `skip`. It returns the learner: an object with
 *                      `learnedScores(track)` (WP-L1's name) or a function of
 *                      the track, giving destination id → probability as a
 *                      Map, an object or [[id, p], …], or null when unheard.
 *
 *   { model }          'prototype' | 'logistic' | 'auto': which model the
 *                      trainer fits, handed to it as `{ model }` (its
 *                      LEARN_DEFAULTS override). The hosted page and its
 *                      worker always pass 'prototype' (BUILD-5-PLAN §2.3):
 *                      per-playlist averages of the account's own heard
 *                      tracks, no regression fitted. Unset, the trainer's
 *                      own default, exactly as before.
 *
 * `learn` defaults to WP-L1's `trainLearner` (core/intrinsic/audio-learn.mjs);
 * pass `learn: false` for the centroid alone.
 *
 * Returns the keys to spread into the space: `{}` when there is nothing to
 * hear, so the space is key for key what it was without audio.
 */
function audioLayer(audio, destinations, skip) {
  if (!audio) return {};
  const opts = typeof audio === 'object' && !(audio instanceof Map) && !Array.isArray(audio)
    && ('records' in audio || 'index' in audio || 'learn' in audio || 'feedback' in audio || 'model' in audio) ? audio : { records: audio };
  const index = opts.index instanceof Map ? opts.index : audioIndex(opts.records, { mel: opts.mel });
  if (!index.size) return {};
  const layer = buildAudioProfiles(destinations, index, { skip });
  const out = { audio: layer };
  const learn = opts.learn === undefined ? trainLearner : opts.learn;
  if (typeof learn === 'function' && layer.profiles.size) {
    // WP-L2: the listener's verdicts, and the fold they must not reach.
    const fb = opts.feedback ? { skip: skip ?? null, feedback: opts.feedback } : {};
    const args = { index, profiles: layer.profiles, minMembers: layer.minMembers, ...fb };
    const learner = opts.model ? learn(args, { model: opts.model }) : learn(args);
    const fn = typeof learner?.learnedScores === 'function' ? t => learner.learnedScores(t)
             : typeof learner === 'function' ? learner : null;
    if (fn) out.learned = fn;
  }
  return out;
}

/**
 * Put the audio layer back on a space that lost it, typically one revived from
 * `persist.mjs`, which stores the graph and profiles but not sound (records
 * live in their own store, and centroids are cheap to rebuild from them).
 * Takes `audio` exactly as `buildSpace` does. Returns a new space; with
 * nothing to hear, the space unchanged. Any existing layer is replaced.
 */
export function withAudioLayer(space, audio) {
  if (!space?.destinations) return space;
  const { audio: _a, learned: _l, ...rest } = space;
  const layer = audioLayer(audio, space.destinations, null);
  return Object.keys(layer).length ? { ...rest, ...layer } : (('audio' in space || 'learned' in space) ? rest : space);
}

/**
 * Let a space built earlier hear tracks heard since, without rebuilding it.
 *
 * Listening keeps going after the File screen's space is built, and the track
 * on screen is usually one of the unfiled ones it has just heard. Rebuilding
 * for each would cost the learner's training every time; this only makes the
 * new tracks *scorable*. Each playlist's sound and the learner are left exactly
 * as they were trained, which is right for an unfiled track: it is in no
 * playlist, so it was never part of either.
 *
 * Adds to the space's index in place, because the learner reads the same index
 * (audio-learn.mjs keeps the Map it was given). A track already in the index is
 * not replaced: its row may be a member the profiles were built from. Records
 * are checked as `audioIndex` checks them, so a miss or another model's record
 * adds nothing.
 *
 * @param {object} space  from `buildSpace` or `withAudioLayer`
 * @param {Iterable<object>|Map|null} records
 * @returns {number} how many tracks became scorable
 */
export function hearMore(space, records, { mel = undefined } = {}) {
  const index = space?.audio?.index;
  if (!(index instanceof Map) || !records) return 0;
  let n = 0;
  for (const [id, row] of audioIndex(records, { mel })) {
    if (index.has(id)) continue;
    index.set(id, row);
    n++;
  }
  return n;
}

/** Fewer heard members with a tempo than this, and a playlist's tempo says nothing. */
export const MIN_TEMPO_MEMBERS = 5;
const TEMPO_CACHE = new WeakMap();

/** A playlist's heard members' tempos (confident readings only), worked out once per profile. */
function memberTempos(profile, index) {
  if (!profile?.ids) return [];
  let list = TEMPO_CACHE.get(profile);
  if (!list) {
    list = [];
    for (const id of profile.ids) {
      const t = tempoOf(index?.get(id)?.rec);
      if (t && t.conf >= MIX_MIN_CONF) list.push(t);
    }
    TEMPO_CACHE.set(profile, list);
  }
  return list;
}

/**
 * Sound-path tempo: the share of a playlist's heard members this track could be
 * beatmatched with (straight within 6%, or half/double time at half credit).
 * A share, not a distance from the mean, so a playlist that is half 130 and
 * half 140 is a fair home for both. Null when the track's tempo is unsure or the
 * playlist has too few heard tempos; the Rekordbox file, when present, wins.
 */
function tempoShare(t, profile, index) {
  const members = memberTempos(profile, index);
  if (members.length < MIN_TEMPO_MEMBERS) return null;
  let s = 0;
  for (const m of members) {
    let best = 0;
    for (const a of [t.bpm, t.alt]) {
      for (const b of [m.bpm, m.alt]) {
        const r = a && b ? tempoRelation(a, b) : null;
        if (r) best = Math.max(best, r.rel === 'same' ? 1 : 0.5);
      }
    }
    s += best;
  }
  return +(s / members.length).toFixed(4);
}

/** Whatever a learner returned → Map of finite numbers, or null. */
function asScoreMap(x) {
  if (!x) return null;
  const entries = x instanceof Map ? [...x] : Array.isArray(x) ? x : Object.entries(x);
  const out = new Map();
  for (const [id, v] of entries) if (id != null && Number.isFinite(v)) out.set(id, v);
  return out.size ? out : null;
}

/**
 * One track's raw sound scores against every destination, rescaled into a
 * component `combine()` can mix: 0 for the destination it sounds least like,
 * 1 for the one it sounds most like, linearly between.
 *
 * Why relative rather than the raw cosine: embedding cosines bunch high (every
 * track sounds somewhat like every electronic playlist), so a raw value would
 * add a near-constant to every judged destination. That ranks nothing, and
 * where some destinations are judged and others aren't (too few analysed
 * members) it would quietly favour the judged ones. A destination that cannot
 * be judged gets the mean of the judged ones instead of null, for the same
 * reason: "can't tell" must neither help nor hurt it. Fewer than two judged
 * destinations, or no spread at all, is nothing to rank by: null.
 */
export function relativeSound(raw, destIds) {
  if (!raw) return null;
  const judged = [];
  for (const v of raw.values()) if (Number.isFinite(v)) judged.push(v);
  if (judged.length < 2) return null;
  const lo = Math.min(...judged), hi = Math.max(...judged);
  if (!(hi - lo > 1e-9)) return null;
  const scaled = new Map();
  let sum = 0;
  for (const [id, v] of raw) {
    if (!Number.isFinite(v)) continue;
    const s = (v - lo) / (hi - lo);
    scaled.set(id, s);
    sum += s;
  }
  const neutral = sum / scaled.size;
  const out = new Map();
  for (const id of destIds) out.set(id, scaled.get(id) ?? neutral);
  return out;
}

/**
 * Combine the present components into one score.
 *
 * Renormalising over what is present is the whole trick: it means "we could not
 * judge this" and "this scored badly" are different outcomes, which is the
 * distinction the tag engine could never make and the reason it always returned
 * its strongest guess.
 */
export function combine(parts, weights = WEIGHTS) {
  let num = 0, den = 0;
  const used = {};
  for (const [k, w] of Object.entries(weights)) {
    const v = parts[k];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    num += w * v;
    den += w;
    used[k] = +v.toFixed(4);
  }
  return { score: den > 0 ? num / den : 0, used, judged: Object.keys(used).length };
}

/**
 * Returns `{ declined }` rather than a weak list when there is nothing to go
 * on — the same refusal the v3 classifier makes, for the same reason: a ranking
 * is always *producible*, which is exactly why producing one is not evidence
 * that it means anything.
 */
/**
 * Rank this account's buckets for one track.
 *
 * `why` is off by default because the harness scores thousands of tracks and
 * none of them needs prose. A UI asks for it; a sweep does not.
 */
export function placements(track, space, { limit = 5, exclude = null, why = false,
                                           weights = WEIGHTS, useAudio = false, soundFirst = false } = {}) {
  if (!track?.id) return { declined: 'NO_TRACK', results: [] };
  if (!space?.destinations?.size) return { declined: 'NO_DESTINATIONS', results: [] };
  // Sound-first: a heard track is scored with sound let in and leading. An
  // unheard one (or a space with no audio layer) falls through untouched.
  if (soundFirst && space.audio && audioScores(track, space)) {
    useAudio = true;
    weights = SOUND_FIRST_WEIGHTS;
  }

  const vec = trackVector(track, space.graph);
  const vecNorm = norm(vec);
  // Worked out once per track rather than per destination: it is one vote
  // spread across all of them. Null — and then absent from every row — when the
  // space has no bridge or it knows none of this track's artists.
  const bridged = space.bridge ? bridgeScores(track, space) : null;
  // Sound, likewise once per track. Only a heard track in a space with an audio
  // layer gets any of this; for everyone else both are null, no row gains a
  // key, and the output is what it was before audio existed.
  //
  // The gate: without `useAudio` these are shown on each row (`heard`, the raw
  // cosine and probability) and never enter `parts`, so they change no score
  // and no ranking. `core/validate/gate.mjs` decides when a caller may pass it.
  const rawSound = space.audio ? audioScores(track, space) : null;
  const rawLearned = rawSound && space.learned ? asScoreMap(space.learned(track)) : null;
  const destIds = rawSound ? [...space.destinations.keys()] : null;
  const sound = useAudio ? relativeSound(rawSound, destIds) : null;
  const learned = useAudio ? relativeSound(rawLearned, destIds) : null;
  // Tempo measured from the preview, on the sound path only (so a placement
  // without sound is unchanged): only a confident reading counts.
  const heardTempo = useAudio && rawSound ? tempoOf(space.audio.index?.get(track.id)?.rec) : null;
  const tempo = heardTempo && heardTempo.conf >= MIX_MIN_CONF ? heardTempo : null;
  const rows = [];
  for (const d of space.destinations.values()) {
    if (exclude?.has(d.id)) continue;
    const shape = shapeScores(track, d.profile, { registrants: space.registrants });
    const graph = vec.size && d.centroid.size
      ? cosine(vec, d.centroid, vecNorm, d.centroidNorm) : null;
    const extra = space.bonus?.size ? bonusScores(track, d.bonusProfile, space.bonus)
                                    : { bpm: null, key: null };
    const parts = bridged ? { graph, ...shape, ...extra, bridge: bridged.get(d.id) ?? 0 }
                          : { graph, ...shape, ...extra };
    if (sound) parts.audio = sound.get(d.id);
    if (learned) parts.learned = learned.get(d.id);
    if (tempo && (parts.bpm === null || parts.bpm === undefined)) {
      const f = tempoShare(tempo, space.audio.profiles?.get(d.id), space.audio.index);
      if (f !== null) parts.bpm = f;
    }
    const { score, used, judged } = combine(parts, weights);
    if (!judged) continue;
    const shared = (track.artists ?? []).filter(a => a?.id && d.artists.has(a.id)).length;
    const row = { playlistId: d.id, name: d.name, score: +score.toFixed(4),
                  parts: used, judged, sharedArtists: shared, members: d.n };
    if (rawSound) {
      row.heard = { audio: rawSound.get(d.id) ?? null,
                    learned: rawLearned?.has(d.id) ? +rawLearned.get(d.id).toFixed(4) : null };
    }
    rows.push(row);
  }

  if (!rows.length) return { declined: 'NOTHING_JUDGEABLE', results: [] };
  rows.sort((a, b) => b.score - a.score || a.playlistId.localeCompare(b.playlistId));

  const top = rows[0], second = rows[1] ?? null;
  const margin = second ? top.score - second.score : top.score;

  let band = BANDS.LIKELY;
  if (top.score < THRESHOLDS.MIN_SCORE) band = BANDS.NONE;
  else if (margin < THRESHOLDS.AMBIGUOUS_MARGIN) band = BANDS.AMBIGUOUS;
  else if (top.score >= THRESHOLDS.HIGH_SCORE && margin >= THRESHOLDS.HIGH_MARGIN) band = BANDS.HIGH;

  const results = rows.slice(0, limit);
  if (why) {
    for (const r of results) {
      r.why = explain(track, space.destinations.get(r.playlistId), space);
    }
  }

  return {
    declined: band === BANDS.NONE ? 'WEAK_SIGNAL' : null,
    band,
    margin: +margin.toFixed(4),
    results,
    version: SPACE_VERSION,
  };
}
