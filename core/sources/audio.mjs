// Audio-model provider (WP-S1, docs/AUDIO-ANALYSIS-PLAN.md §4.1–4.4).
//
// Same split as discogs.mjs and lastfm.mjs: a defineProvider() declaration
// and pure mapping functions. There is no fetch here — the "response" is an
// AudioRecord (core/audio/record.mjs) that the listener's own browser already
// produced from a 30-second Deezer preview and stored. Raw scores are stored,
// not evidence, so a mapping-table or threshold change re-maps every track
// without re-running anything; AUDIO.version stamps which mapping produced a
// profile.
//
// What it says is about ONE RECORDING: entityType 'track', keyed by the
// Spotify track id. That is the whole value of the source and is never
// averaged up to the artist. Being track-level, it outranks artist clouds on
// specificity in weights.mjs with no special case anywhere.
//
// Labels go through the reviewed static tables only — STYLE_MAP via
// styleConcept() (audio-vocab.mjs) and MOOD_MAP via an injected moodHints()
// (core/audio/heads.mjs). Never through resolveConcept() at runtime, and an
// unmapped label is dropped, never emitted as `unknown`: the vocabulary is
// the same for every listener, so it must not reach anybody's
// unknown-concepts review queue (§4.2).
import { defineProvider } from './provider.mjs';
import { styleConcept, AUDIO_VOCAB_VERSION } from './audio-vocab.mjs';
import { evidence } from '../evidence/evidence.mjs';
import { relativeStrength } from '../evidence/normalise.mjs';
import { linkConfidence } from '../identity/track-identity.mjs';
import { MODEL, validRecord } from '../audio/record.mjs';

export const AUDIO = defineProvider({
  id: 'audio-effnet',
  version: '3.0.0',            // bump on any mapping-table or threshold change
  capabilities: ['genre', 'mood', 'voice', 'similarity'],
  entityTypes: ['track'],
  // A prior only; phase 0 measured the style labels at 29% top-1 on scene
  // genres. Replaced by the phase-2 benchmark.
  reliability: 0.6,
  // Trained on Discogs' editorial labels, so it shares Discogs' vocabulary
  // but not its evidence: it hears this recording, Discogs reads the
  // discography. Own group. The analysis plan calls the group `audio`; the
  // build plan (newer) names it `audio-model`, which is what is used. Merge
  // with 'discogs' if the benchmark shows correlated errors.
  independenceGroup: 'audio-model',
  optional: true,
  requires: 'nothing — runs in your browser on 30-second previews',
});

/** At most this many style records per track, like Discogs. */
export const MAX_STYLES = 10;
/**
 * A label must reach this sigmoid to count. A declared prior, swept in
 * phase 2 (§6); changing it bumps AUDIO.version.
 */
export const DEFAULT_THRESHOLD = 0.1;

const FIELD_OF_FACET = { mood: 'mood', context: 'context', era: 'era' };

/** The local stand-in when no moodHints() is injected: no mood evidence at all. */
const noMoods = () => [];

/**
 * Is this record one the provider may speak from? A miss, a malformed or
 * foreign-model record, or one whose ISRC no longer matches the track (a
 * Spotify relink) yields nothing. Identity was enforced when the record was
 * made (ISRC equal and duration within 3 s, §4.1); a record that failed it
 * was never stored, so there is no "lower confidence" path here.
 */
export function usableRecord(record, { isrc = null } = {}) {
  if (!record || record.miss) return false;
  if (record.model !== MODEL || !validRecord(record)) return false;
  if (isrc && record.isrc && record.isrc !== isrc) return false;
  return true;
}

/**
 * One stored AudioRecord -> evidence records. Pure.
 *
 * - styles: the record's top styles ([[classIndex, p], ...]) through
 *   styleConcept(). Below `threshold`, or with no concept, a label is
 *   dropped. A parent-fallback label carries its 0.5 reliability. At most
 *   `maxStyles`. Strength is relative to the strongest kept label, the same
 *   "shape of the answer" normaliseValues() uses for every provider.
 * - moods: `heads.moods` through the injected `moodHints(heads)` (MOOD_MAP);
 *   without one, none. Field by facet: mood / context / era.
 * - voice: `heads.voice` (p of voice) → one field-`voice` record, 'voice' or
 *   'instrumental', confidence |2p − 1|. Dropped when that is under
 *   `threshold`: a coin flip is not a claim.
 *
 * @param {object} record  an AudioRecord (record.mjs)
 * @param {object} [opts]
 * @param {string} [opts.entityId]   defaults to record.id (the Spotify track id)
 * @param {string|null} [opts.isrc]  the track's current ISRC, when known
 * @param {number} [opts.threshold]
 * @param {number} [opts.maxStyles]
 * @param {(heads: object) => {facet: string, concept: string, p: number, labels: string[]}[]} [opts.moodHints]
 * @param {number} [opts.retrievedAt]
 */
export function toEvidence(record, { entityId = null, isrc = null, threshold = DEFAULT_THRESHOLD,
                                     maxStyles = MAX_STYLES, moodHints = noMoods,
                                     retrievedAt = null } = {}) {
  if (!usableRecord(record, { isrc })) return [];
  const ctx = {
    source: AUDIO.id, entityType: 'track', entityId: entityId ?? record.id,
    identityConfidence: linkConfidence('isrc'),
    retrievedAt: retrievedAt ?? record.at ?? Date.now(),
  };
  const prov = { matchedBy: 'isrc', adapter: AUDIO.version, vocab: AUDIO_VOCAB_VERSION, model: record.model, isrc: record.isrc ?? null };
  const out = [];

  // Styles.
  const styles = [];
  for (const [i, p] of record.styles ?? []) {
    if (!(p >= threshold)) continue;
    const m = styleConcept(i);
    if (!m.concept) continue;                 // unmapped: dropped, never `unknown`
    styles.push({ ...m, p });
  }
  styles.sort((a, b) => b.p - a.p);
  const kept = styles.slice(0, Math.max(0, maxStyles));
  const maxP = kept.length ? kept[0].p : 0;
  for (const s of kept) {
    out.push(evidence({
      ...ctx, field: 'genre', rawValue: s.label, concept: s.concept, facet: 'genre',
      sourceConfidence: relativeStrength(s.p, maxP) * s.reliability,
      provenance: { ...prov, field: 'style', p: s.p, resolvedVia: s.via === 'parent' ? 'audio-vocab:parent' : 'audio-vocab' },
    }));
  }

  // Moods, through the reviewed MOOD_MAP only.
  const heads = record.heads ?? null;
  if (heads) {
    const moods = (moodHints(heads) ?? [])
      .filter(h => h && h.concept && FIELD_OF_FACET[h.facet] && h.p >= threshold);
    const maxM = Math.max(0, ...moods.map(h => h.p));
    for (const h of moods) {
      out.push(evidence({
        ...ctx, field: FIELD_OF_FACET[h.facet], rawValue: (h.labels ?? [h.concept]).join('+'),
        concept: h.concept, facet: h.facet,
        sourceConfidence: relativeStrength(h.p, maxM),
        provenance: { ...prov, field: 'moodtheme', p: h.p, labels: [...(h.labels ?? [])], resolvedVia: 'mood-map' },
      }));
    }

    // Voice / instrumental.
    const pv = Number(heads.voice);
    if (heads.voice != null && Number.isFinite(pv) && pv >= 0 && pv <= 1) {
      const decisive = Math.abs(2 * pv - 1);
      if (decisive >= threshold) {
        const v = pv >= 0.5 ? 'voice' : 'instrumental';
        out.push(evidence({
          ...ctx, field: 'voice', rawValue: v, concept: v, facet: 'voice',
          sourceConfidence: decisive,
          provenance: { ...prov, field: 'voice_instrumental', p: pv },
        }));
      }
    }
  }
  return out;
}

/**
 * Index stored records per track for the engine: Map(trackId -> evidence[]).
 * Accepts a Map or a plain object keyed by Spotify track id. Misses and
 * unusable records produce no entry.
 */
export function indexRecords(records, opts = {}) {
  const out = new Map();
  if (!records) return out;
  const entries = records instanceof Map ? records.entries() : Object.entries(records);
  for (const [id, rec] of entries) {
    const ev = toEvidence(rec, { ...opts, entityId: id });
    if (ev.length) out.set(id, ev);
  }
  return out;
}

/**
 * Do indexed audio records still describe this track? False only when both
 * sides carry an ISRC and they differ (the track was relinked since the
 * record was made); the record is then ignored rather than trusted.
 */
export function sameRecording(records, track) {
  const want = track?.isrc ?? null;
  if (!want) return true;
  return (records ?? []).every(r => !r?.provenance?.isrc || r.provenance.isrc === want);
}
