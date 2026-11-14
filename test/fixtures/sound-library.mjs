// A synthetic library with synthetic sound, for WP-H2's proposals by sound
// (core/recommend/audio-gaps.mjs). Records go through the frozen makeRecord
// contract, so they are exactly what the page would hold.
//
// Sound is a few fixed random directions in embedding space plus per-track
// noise: three genre playlists (X drum & bass, Y bass, Z dubstep), and unfiled
// tracks that are each one of the cases the proposals are for.
import { makeRecord, N_STYLES, EMB_DIM } from '../../core/audio/record.mjs';

export const STYLE = { dnb: 57, bassline: 36, dubstep: 60, breakbeat: 41, ukg: 135 };

function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 32 - 0.5; };
}
const direction = seed => { const r = rng(seed); return Float32Array.from({ length: EMB_DIM }, () => r()); };
export const DIR = { x: direction(11), y: direction(12), z: direction(13), n: direction(14) };

let SEED = 1;
/** One record: `mix` weights the directions, `noise` scales a fresh random one. */
export function soundRecord(id, { mix = {}, noise = 1, styles = [[STYLE.dnb, 0.6]], sections = null, random = false } = {}) {
  const r = rng(1000 + SEED++);
  const base = random ? direction(50000 + SEED++) : null;
  const v = new Float32Array(EMB_DIM);
  for (let i = 0; i < EMB_DIM; i++) {
    let x = noise * r();
    for (const [k, w] of Object.entries(mix)) x += w * DIR[k][i];
    if (base) x += base[i];
    v[i] = x;
  }
  // Two patches: by default both lead with the same styles; `sections` gives
  // each patch its own leading style (a hybrid by sections).
  const per = sections ?? [styles[0][0], styles[0][0]];
  const act = new Float32Array(per.length * N_STYLES).fill(0.005);
  per.forEach((lead, p) => {
    for (const [s, q] of styles) act[p * N_STYLES + s] = q;
    act[p * N_STYLES + lead] = Math.max(0.7, act[p * N_STYLES + lead]);
  });
  const emb = new Float32Array(per.length * EMB_DIM);
  for (let p = 0; p < per.length; p++) emb.set(v, p * EMB_DIM);
  return makeRecord({ id, isrc: `ISRC${id}`, activations: act, embeddings: emb, patches: per.length,
                      source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 1]], seconds: 20 }, mel: '1.0.0', at: 1 });
}

/**
 * The library and its records. `kinds` picks which unfiled cases to include:
 * inside (sounds like X), pick (between X and Y, too few to be a group),
 * hybrid (a tight group between Y and Z), orphan (a tight group near nothing),
 * noise (random sounds).
 */
export function soundLibrary({ kinds = ['inside', 'pick', 'hybrid', 'orphan', 'noise'], extra = [] } = {}) {
  SEED = 1;
  const records = [];
  let n = 0;
  const make = (prefix, k, artist, rec) => Array.from({ length: k }, () => {
    const id = `${prefix}${n++}`;
    records.push(soundRecord(id, rec));
    return { id, name: `${prefix} track ${n}`, artists: [{ id: `${artist}-${n % 3}`, name: `${artist} ${n % 3}` }] };
  });
  const playlists = [
    { id: 'p-x', name: 'Drum & Bass', tracks: make('x', 20, 'dnb', { mix: { x: 1 }, styles: [[STYLE.dnb, 0.6]] }) },
    { id: 'p-y', name: 'Bass', tracks: make('y', 20, 'bl', { mix: { y: 1 }, styles: [[STYLE.bassline, 0.6]] }) },
    { id: 'p-z', name: 'Dubstep', tracks: make('z', 20, 'dub', { mix: { z: 1 }, styles: [[STYLE.dubstep, 0.6]] }) },
  ];
  const liked = [];
  const has = k => kinds.includes(k);
  if (has('inside')) liked.push(...make('in', 6, 'dnb', { mix: { x: 1 }, styles: [[STYLE.dnb, 0.6]] }));
  if (has('pick')) liked.push(...make('pk', 4, 'pk', { mix: { x: 0.75, y: 0.75 }, noise: 1.2, styles: [[STYLE.dnb, 0.4], [STYLE.bassline, 0.35]] }));
  if (has('hybrid')) liked.push(...make('hy', 10, 'hy', { mix: { y: 0.75, z: 0.75 }, noise: 0.8,
    styles: [[STYLE.bassline, 0.5], [STYLE.dubstep, 0.45]], sections: [STYLE.bassline, STYLE.dubstep] }));
  if (has('orphan')) liked.push(...make('or', 10, 'or', { mix: { n: 1 }, noise: 0.8, styles: [[STYLE.breakbeat, 0.5]] }));
  if (has('noise')) liked.push(...make('nz', 15, 'nz', { random: true, styles: [[STYLE.ukg, 0.3]] }));
  for (const e of extra) liked.push(...make(e.prefix, e.k, e.artist ?? e.prefix, e.rec));
  return { lib: { liked, playlists }, records, targets: ['p-x', 'p-y', 'p-z'] };
}
