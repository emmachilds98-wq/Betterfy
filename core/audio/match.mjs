// @bundle engine BetterfyMatch 130
// Matching by sound: tracks that sound alike, tracks that mix together, and
// which of your genre playlists the sound-alikes sit in.
//
// Everything here is a nearest-neighbour lookup or a count over the account's
// own heard tracks (SMARTER-GENRES-PLAN.md §3, R3): nothing is trained,
// nothing leaves the device, nothing is pooled across accounts. The vectors
// are the audio model's embeddings of Deezer previews (audio.mjs `audioIndex`
// rows: unit-normalised, so a dot product is the cosine).

import { resolveConcept } from '../ontology/index.mjs';
import { mirrorPredicate } from '../playlists/mirror.mjs';
import { tempoRangeOf } from '../ontology/tempo.mjs';

export const MATCH_VERSION = '1.0.0';

/** Beatmatching range: within 6% a DJ can pitch one onto the other. */
export const MIX_TOLERANCE = 0.06;
/** A tempo reading below this confidence is not used for mixing. */
export const MIX_MIN_CONF = 0.3;
/**
 * A key reading is used (shown, or counted for mixing) only at or above this
 * confidence. Measured on the Beatport EDM Key Dataset, held-out half: 62.4%
 * exact / 72.0% MIREX on the 53% of tracks at or above it, against 55.3% / 64.6%
 * on all of them (BUILD-5-PROGRESS.md). Key v4 readings (keynet.mjs, `keyNetV`)
 * map their own sure bar onto this number: 62.5% / 71.3% on 85% of tracks.
 * web/audio/dsp-view.mjs has the same
 * number for the chip; test/keygate.test.mjs keeps the two equal.
 */
export const KEY_MIN_CONF = 0.65;
/** How much a harmonic fit moves a "mixes with" ranking, in cosine-similarity units. */
export const KEY_RANK_BONUS = 0.03;

const CAMELOT_RE = /^(1[0-2]|[1-9])([AB])$/;
/** A record's Camelot key when it is sure enough to mix on, else null. */
export function keyOfRecord(record) {
  const d = record && !record.miss ? record.dsp : null;
  if (!d || typeof d.camelot !== 'string' || !(d.keyConf >= KEY_MIN_CONF)) return null;
  const c = d.camelot.toUpperCase();
  return CAMELOT_RE.test(c) ? c : null;
}
/**
 * Do two Camelot keys mix? 'same', 'adjacent' (a step round the wheel, same
 * letter) or 'relative' (same number, other letter) are harmonic; 'clash' is
 * not; null when either key is unknown (then nothing is claimed either way).
 */
export function keyFit(a, b) {
  const ma = CAMELOT_RE.exec(a ?? ''), mb = CAMELOT_RE.exec(b ?? '');
  if (!ma || !mb) return null;
  const x = Number(ma[1]), y = Number(mb[1]);
  if (x === y) return ma[2] === mb[2] ? 'same' : 'relative';
  const step = Math.min(Math.abs(x - y), 12 - Math.abs(x - y));
  return step === 1 && ma[2] === mb[2] ? 'adjacent' : 'clash';
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * The k heard tracks that sound most like `emb`, highest cosine first.
 * @param {Float32Array} emb  unit-normalised
 * @param {Map<string, {emb: Float32Array}>} index  from `audioIndex`
 * @param {{ k?: number, exclude?: Set<string>|null, filter?: (id: string) => boolean }} [o]
 * @returns {Array<{ id: string, sim: number }>}
 */
export function nearest(emb, index, { k = 12, exclude = null, filter = null } = {}) {
  if (!emb || !index?.size) return [];
  const top = [];
  for (const [id, row] of index) {
    if (exclude?.has(id) || (filter && !filter(id)) || !row?.emb || row.emb.length !== emb.length) continue;
    const sim = dot(emb, row.emb);
    if (top.length < k) { top.push({ id, sim }); top.sort((a, b) => b.sim - a.sim); }
    else if (sim > top[k - 1].sim) { top[k - 1] = { id, sim }; top.sort((a, b) => b.sim - a.sim); }
  }
  return top.map(r => ({ id: r.id, sim: +r.sim.toFixed(4) }));
}

/**
 * The genres a playlist's name says it is, as ontology slugs.
 * "Drum & Bass" is one genre; "Jungle & Breaks" is two; "Sunday" is none.
 * A name is read whole first, so an alias with "&" in it is not split.
 */
export function playlistConcepts(name) {
  const whole = resolveConcept(String(name ?? ''));
  if (whole.facet === 'genre' && whole.concept && whole.via === 'alias') return [whole.concept];
  const parts = String(name ?? '').split(/\s*(?:&|\+|\/|,|\||\band\b|\bx\b)\s*/i).map(s => s.trim()).filter(Boolean);
  const out = [];
  if (parts.length > 1) {
    for (const p of parts) {
      const r = resolveConcept(p);
      if (r.facet === 'genre' && r.concept && !out.includes(r.concept)) out.push(r.concept);
    }
  }
  if (!out.length && whole.facet === 'genre' && whole.concept) out.push(whole.concept);
  return out;
}

/**
 * Which genre playlists each track is in, and what each playlist's name says.
 * Only `targets` (the genre playlists) count; mirrors are left out.
 * @returns {{ playlists: Map<string, {name: string, concepts: string[]}>, of: Map<string, string[]> }}
 */
export function genreMembership(lib, { targets = null, isMirror = null } = {}) {
  const mirror = mirrorPredicate(lib, { also: isMirror ?? undefined });
  const allowed = targets ? new Set(targets) : null;
  const playlists = new Map(), of = new Map();
  for (const p of lib?.playlists ?? []) {
    if (!p?.id || mirror(p) || (allowed && !allowed.has(p.id))) continue;
    playlists.set(p.id, { name: p.name ?? p.id, concepts: playlistConcepts(p.name) });
    for (const t of p.tracks ?? []) {
      if (!t?.id) continue;
      const list = of.get(t.id) ?? [];
      if (!list.includes(p.id)) list.push(p.id);
      of.set(t.id, list);
    }
  }
  return { playlists, of };
}

/**
 * The sound-alikes of one track that are filed in a genre playlist, each with
 * the playlists it is in and what their names say. What `identify` reads as
 * "your library's view", and what the File card lists.
 */
export function filedNeighbours(trackId, index, membership, { k = 12, exclude = null } = {}) {
  const row = index?.get(trackId);
  if (!row || !membership?.of) return [];
  const skip = new Set(exclude ?? []);
  skip.add(trackId);
  return nearest(row.emb, index, { k, exclude: skip, filter: id => membership.of.has(id) }).map(n => {
    const pids = membership.of.get(n.id) ?? [];
    const concepts = [...new Set(pids.flatMap(pid => membership.playlists.get(pid)?.concepts ?? []))];
    return { ...n, playlists: pids, concepts };
  });
}

/** A record's usable tempo: { bpm, alt, conf } or null. */
export function tempoOf(record) {
  const d = record && !record.miss ? record.dsp : null;
  if (!d || !Number.isFinite(d.bpm) || d.bpm <= 0) return null;
  return { bpm: d.bpm, alt: d.octaveAmbiguous && Number.isFinite(d.bpmAlt) && d.bpmAlt > 0 ? d.bpmAlt : null,
           conf: Number.isFinite(d.bpmConf) ? d.bpmConf : 0 };
}

/**
 * How two tempos line up for a mix: 'same' within MIX_TOLERANCE, 'double' or
 * 'half' when one is twice the other within it, else null. `diff` is the
 * pitch change needed, as a fraction.
 */
export function tempoRelation(a, b, tolerance = MIX_TOLERANCE) {
  if (!(a > 0) || !(b > 0)) return null;
  let best = null;
  for (const [rel, k] of [['same', 1], ['double', 2], ['half', 0.5]]) {
    const diff = Math.abs(b * k - a) / a;
    if (diff <= tolerance && (!best || diff < best.diff)) best = { rel, diff: +diff.toFixed(4) };
  }
  return best;
}

/**
 * Heard tracks that mix with this one: a tempo you can beatmatch (straight,
 * or half/double time), ranked by how alike they sound, then by how little
 * pitching they need. A track's own tempo can be passed in (`bpm`) when it
 * has been settled elsewhere (identify's octave check); otherwise its record's.
 * @returns {Array<{ id: string, sim: number, bpm: number, rel: string, diff: number }>}
 */
export function mixesWith(trackId, index, { k = 8, bpm = null, tolerance = MIX_TOLERANCE, pool = 200 } = {}) {
  const row = index?.get(trackId);
  const own = bpm ?? tempoOf(row?.rec)?.bpm ?? null;
  if (!row || !(own > 0)) return [];
  const out = [];
  const ownKey = keyOfRecord(row.rec);
  for (const n of nearest(row.emb, index, { k: pool, exclude: new Set([trackId]) })) {
    const t = tempoOf(index.get(n.id)?.rec);
    if (!t || t.conf < MIX_MIN_CONF) continue;
    const r = tempoRelation(own, t.bpm, tolerance) ?? (t.alt ? tempoRelation(own, t.alt, tolerance) : null);
    if (!r) continue;
    const hit = { id: n.id, sim: n.sim, bpm: +t.bpm.toFixed(1), rel: r.rel, diff: r.diff };
    // Key only when both keys are sure; otherwise the entry is exactly what it always was.
    const theirs = keyOfRecord(index.get(n.id)?.rec), fit = keyFit(ownKey, theirs);
    if (fit) { hit.key = theirs; hit.keyFit = fit; }
    out.push(hit);
    if (!ownKey && out.length >= k) break;
  }
  if (ownKey) {
    // A harmonic fit lifts a mix a little, a clash lowers it; ties keep the similarity order.
    const rank = h => h.sim + (h.keyFit ? (h.keyFit === 'clash' ? -KEY_RANK_BONUS : KEY_RANK_BONUS) : 0);
    out.sort((a, b) => rank(b) - rank(a));
  }
  return out.slice(0, k);
}

/** Shown only at or above this confidence (86% within +-1 BPM there); equal to MIX_MIN_CONF and dsp-view's BPM_MIN_CONF. */
export const BPM_MIN_CONF = MIX_MIN_CONF;
/** Below this the preview had no steady pulse to speak of. */
export const BPM_NO_BEAT_CONF = 0.15;

const within = (b, [lo, hi]) => b >= lo && b <= hi;

/**
 * One BPM everywhere (SOUND-ENGINE-PLAN T2): settle a reading into a range by
 * x2 or x1/2 only. Returns the reading itself when it is already in range, the
 * fold that lands in it, or null when neither does (nothing is forced).
 * @param {number} bpm
 * @param {[number, number]} range
 * @returns {number|null}
 */
export function foldIntoRange(bpm, range) {
  if (!(bpm > 0) || !range) return null;
  if (within(bpm, range)) return bpm;
  for (const k of [2, 0.5]) if (within(bpm * k, range)) return bpm * k;
  return null;
}

/**
 * The BPM a listener sees for a track, in the convention they play it in.
 * Order: the range of a playlist the track is in or suggested for (padded by
 * the mixing tolerance), then the working range of the genre it sounds like;
 * at each, the reading as measured (or its flagged alternative) if it sits in
 * range, else x2 or x1/2 if that lands in it; else the reading as measured.
 * `settled` is false only for a reading flagged "87 or 174" that nothing settled.
 * @param {object} record  a stored AudioRecord
 * @param {{ playlistRange?: {lo: number, hi: number}|[number, number]|null, genres?: Array<string|[string, number]> }} [ctx]
 *        genres: ontology slugs, most specific first
 * @returns {{ bpm: number, from: 'measured'|'playlist'|'genre', conf: number, settled: boolean, alt: number|null } | null}
 */
export function displayTempo(record, { playlistRange = null, genres = [] } = {}) {
  const t = tempoOf(record);
  if (!t) return null;
  const cands = t.alt ? [t.bpm, t.alt] : [t.bpm];
  const stages = [];
  const pr = Array.isArray(playlistRange) ? playlistRange : playlistRange ? [playlistRange.lo, playlistRange.hi] : null;
  if (pr && pr[0] > 0 && pr[1] >= pr[0]) stages.push(['playlist', [[pr[0] * (1 - MIX_TOLERANCE), pr[1] * (1 + MIX_TOLERANCE)]]]);
  const gr = [];
  for (const g of genres ?? []) { const r = tempoRangeOf(Array.isArray(g) ? g[0] : g); if (r) gr.push(r); }
  if (gr.length) stages.push(['genre', gr]);
  const out = (bpm, from, settled) => ({ bpm: +bpm.toFixed(1), from, conf: t.conf, settled, alt: settled ? null : t.alt });
  for (const [from, ranges] of stages) {
    for (const c of cands) if (ranges.some(r => within(c, r))) return out(c, c === t.bpm ? 'measured' : from, true);
    for (const c of cands) for (const r of ranges) { const f = foldIntoRange(c, r); if (f) return out(f, from, true); }
  }
  return out(t.bpm, 'measured', !t.alt);
}

/**
 * SOUND-ENGINE-PLAN T3: one sure BPM, or "BPM unknown" with the reason.
 * Sure means confidence at or above BPM_MIN_CONF and the octave settled.
 * `why`: 'no-audio' (never heard), 'no-beat' (no steady pulse in the preview),
 * 'octave' (87 or 174, nothing settled it), 'unsure' (a pulse, not reliable).
 * @returns {{ state: 'sure', bpm: number, from: string, conf: number } | { state: 'unknown', why: string }}
 */
export function tempoShown(record, ctx = {}) {
  if (!record || record.miss) return { state: 'unknown', why: 'no-audio' };
  const t = tempoOf(record);
  if (!t || t.conf < BPM_NO_BEAT_CONF) return { state: 'unknown', why: 'no-beat' };
  if (t.conf < BPM_MIN_CONF) return { state: 'unknown', why: 'unsure' };
  const d = displayTempo(record, ctx);
  if (!d.settled) return { state: 'unknown', why: 'octave' };
  return { state: 'sure', bpm: d.bpm, from: d.from, conf: d.conf };
}

/** The words behind each "BPM unknown" (shown on tap or hover). */
export const TEMPO_UNKNOWN_TEXT = Object.freeze({
  'no-audio': 'Not heard yet: no preview on Deezer',
  'no-beat': 'The beat wasn\u2019t clear in the 30 s preview',
  'octave': 'Could be half or double: file it to a playlist and it will settle',
  'unsure': 'A pulse, but the reading isn\u2019t reliable enough to show',
});
