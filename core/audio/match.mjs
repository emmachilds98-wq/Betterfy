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

export const MATCH_VERSION = '1.0.0';

/** Beatmatching range: within 6% a DJ can pitch one onto the other. */
export const MIX_TOLERANCE = 0.06;
/** A tempo reading below this confidence is not used for mixing. */
export const MIX_MIN_CONF = 0.3;

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
  for (const n of nearest(row.emb, index, { k: pool, exclude: new Set([trackId]) })) {
    const t = tempoOf(index.get(n.id)?.rec);
    if (!t || t.conf < MIX_MIN_CONF) continue;
    const r = tempoRelation(own, t.bpm, tolerance) ?? (t.alt ? tempoRelation(own, t.alt, tolerance) : null);
    if (!r) continue;
    out.push({ id: n.id, sim: n.sim, bpm: +t.bpm.toFixed(1), rel: r.rel, diff: r.diff });
    if (out.length >= k) break;
  }
  return out;
}
