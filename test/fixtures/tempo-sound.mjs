// Synthetic sound with tempos for libraries that have none (E3, tempo range per
// playlist). Nothing here is real audio: every record is a fabricated
// embedding plus a fabricated tempo reading, so a measurement on it says what
// the idea can do when tempo is as informative as stated below, not what it
// does on any listener's library.
//
// The assumptions, fixed before measuring (not tuned to the result):
//  - Sound separates families well and playlists inside a family poorly
//    (embedding = family direction + 0.5 x playlist direction + noise), which
//    is where a second, independent signal has room to help.
//  - A playlist's tracks sit near its own tempo centre (sd 2.5 BPM); the
//    centres of a family's playlists are spread over +-15 BPM. A wide playlist
//    (every sixth) holds any tempo in a 60 BPM span, so it learns no range.
//  - 15% of readings come out an octave off (and say so: octaveAmbiguous),
//    20% have confidence below the 0.3 floor and are never used.
import { makeRecord, N_STYLES, EMB_DIM } from '../../core/audio/record.mjs';

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9 >>> 0) / 2 ** 32);
}
const gauss = r => { let a = 0; for (let i = 0; i < 6; i++) a += r(); return (a - 3) / 0.7071; };
const dirs = new Map();
function dir(key) {
  if (!dirs.has(key)) {
    const r = rng([...String(key)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 17));
    dirs.set(key, Float32Array.from({ length: EMB_DIM }, () => r() - 0.5));
  }
  return dirs.get(key);
}

/**
 * Records for the tracks of `lib`.
 * @param {object} lib      { playlists:[{id,tracks}], liked }
 * @param {(playlist, index)=>({fam:string, bpm:number, wide?:boolean})} home  a playlist's family and tempo centre
 * @param {(track)=>string|null} [homeOf]  playlist id a track belongs to (default: the first playlist holding it)
 */
export function soundWithTempo(lib, home, { seed = 3, homeOf = null } = {}) {
  const r = rng(seed);
  const byTrack = new Map();
  lib.playlists.forEach((p, i) => {
    const h = home(p, i);
    for (const t of p.tracks) if (!byTrack.has(t.id)) byTrack.set(t.id, { pl: p.id, ...h });
  });
  const byPl = new Map(lib.playlists.map((p, i) => [p.id, { pl: p.id, ...home(p, i) }]));
  const records = [];
  const seen = new Set();
  for (const t of [...lib.playlists.flatMap(p => p.tracks), ...(lib.liked ?? [])]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    const h = byTrack.get(t.id) ?? byPl.get(homeOf?.(t));
    if (!h) continue;
    const emb = new Float32Array(EMB_DIM);
    const fd = dir('f:' + h.fam), pd = dir('p:' + h.pl);
    for (let k = 0; k < EMB_DIM; k++) emb[k] = fd[k] + 0.5 * pd[k] + (r() - 0.5) * 1.5;
    const act = new Float32Array(N_STYLES).fill(0.01);
    act[(h.fam.length * 7) % N_STYLES] = 0.8;
    let bpm = h.wide ? h.bpm + (r() - 0.5) * 60 : h.bpm + gauss(r) * 2.5;
    const flip = r() < 0.15, conf = r() < 0.2 ? 0.1 + r() * 0.15 : 0.35 + r() * 0.6;
    const dsp = { bpm: +(flip ? (r() < 0.5 ? bpm / 2 : bpm * 2) : bpm).toFixed(1), bpmConf: +conf.toFixed(2) };
    if (flip) { dsp.octaveAmbiguous = true; dsp.bpmAlt = +bpm.toFixed(1); }
    records.push(makeRecord({ id: t.id, isrc: 'GBXXX0000001', activations: act, embeddings: emb, patches: 1,
      source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 165000]], seconds: 10 }, mel: '1.0.0', at: 1000, dsp }));
  }
  return records;
}

/** The shaped seeds (test/fixtures/shaped-library.mjs): five families, tempo zones per family. */
export function shapedHome(lib) {
  const ZONE = [128, 90, 120, 118, 140];          // club, rap, indie, pop-ish, older dance
  return (p, i) => {
    const fam = i % 5;
    const spreadR = rng(i * 7919 + 13);
    return { fam: 'f' + fam, bpm: ZONE[fam] + (spreadR() - 0.5) * 30, wide: i % 6 === 0 };
  };
}

/** A fabricated account's genre playlists (test/fixtures/accounts.mjs): a tempo per genre. */
export const GENRE_BPM = { 'drum and bass': 174, jungle: 165, house: 126, techno: 134, ambient: 80, 'hip hop': 92,
  'uk garage': 132, indie: 122, rock: 128, jazz: 108, classical: 84, pop: 116, folk: 100, metal: 150, reggae: 78, soul: 96 };
const FAM_OF = { 'drum and bass': 'dnb', jungle: 'dnb', house: 'club', techno: 'club', 'uk garage': 'club', ambient: 'calm',
  classical: 'calm', jazz: 'calm', 'hip hop': 'urban', soul: 'urban', reggae: 'urban', indie: 'band', rock: 'band',
  folk: 'band', pop: 'band', metal: 'band' };
export function accountHome() {
  return p => {
    const g = Object.keys(GENRE_BPM).find(k => p.name.toLowerCase().startsWith(k)) ?? 'pop';
    return { fam: FAM_OF[g], bpm: GENRE_BPM[g] };
  };
}
