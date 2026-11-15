// Typical tempo per genre: the ranges DJs and producers work in.
//
// Why a table: tempo is the one thing about a track that is both cheap to
// measure from a preview (core/audio/dsp/tempo.mjs: 86% within ±1 BPM at
// confidence ≥ 0.3 on the Beatport set) and strongly tied to genre. Drum & bass
// lives at 170-176, house at 120-128, UK garage at 130-138. So each can check
// the other:
//   - a "87 or 174?" reading is settled by which octave fits the genre it
//     sounds like (`resolveOctave`);
//   - a genre guess whose range excludes a confidently measured tempo is
//     marked down (`tempoFit`), which catches the audio model's most common
//     confusions inside electronic music (it hears "breakbeat" in both jungle
//     and UK breaks; 170 against 132 tells them apart).
//
// These are soft priors, never vetoes: a 160 BPM house edit exists. Ranges are
// the common working range, deliberately a little generous. `null` means tempo
// says nothing about the genre (rock, pop, ambient), and a genre with no row
// inherits its nearest ancestor's (see `tempoRangeOf`).
//
// Half-time genres (dubstep, trap, halftime DnB) are listed at the tempo a DJ
// would set, with `half: true`: a tempo tracker often reports half of it, and
// that is a match, not a miss.

import { GENRE_INDEX, ancestorsOf } from './index.mjs';

export const TEMPO_VERSION = '1.0.0';

/** slug → [low, high] BPM, or null for "tempo says nothing". */
export const TEMPO = Object.freeze({
  'electronic': null,
  'house': [115, 130], 'deep-house': [112, 126], 'tech-house': [120, 130], 'progressive-house': [118, 130],
  'acid-house': [116, 130], 'disco-house': [112, 128], 'electro-house': [124, 132], 'afro-house': [115, 126],
  'melodic-house': [112, 126], 'garage-house': [115, 128], 'minimal-house': [118, 128], 'bass-house': [122, 132],
  'hard-house': [138, 152], 'donk': [140, 160],
  'techno': [120, 150], 'minimal-techno': [118, 130], 'acid-techno': [128, 148], 'detroit-techno': [118, 135],
  'hard-techno': [138, 165], 'dub-techno': [112, 128],
  'trance': [125, 145], 'progressive-trance': [124, 136], 'psytrance': [136, 150], 'uplifting-trance': [134, 142],
  'hard-trance': [138, 155],
  'breakbeat': [120, 140], 'big-beat': [95, 135], 'uk-breaks': [126, 140], 'breakcore': [160, 260],
  'drum-and-bass': [160, 180], 'jungle': [155, 175], 'liquid-dnb': [168, 178], 'neurofunk': [168, 180],
  'jump-up': [168, 180], 'halftime': [160, 180],
  'uk-garage': [128, 140], 'bassline': [132, 144], 'future-garage': [125, 140], 'grime': [136, 144],
  'uk-funky': [126, 134],
  'dubstep': [136, 150], 'brostep': [138, 152], 'uk-bass': [126, 145],
  'hardcore': [160, 200], 'gabber': [160, 220], 'hardstyle': [145, 160], 'jumpstyle': [138, 152], 'makina': [160, 180],
  'jersey-club': [130, 145], 'footwork': [155, 165], 'gqom': [118, 130],
  'ambient': null, 'downtempo': [80, 112], 'idm': null, 'electro': [118, 135], 'synthwave': [80, 120],
  'synth-pop': [100, 132], 'eurodance': [128, 145],
  'hip-hop': [80, 105], 'uk-hip-hop': [80, 100], 'drill': [136, 148], 'trap': [130, 155], 'phonk': [120, 150],
  'boom-bap': [84, 98], 'conscious-hip-hop': [80, 100], 'g-funk': [86, 100], 'lo-fi-hip-hop': [65, 95],
  'rnb': [60, 110], 'neo-soul': [65, 100], 'soul': null, 'motown': null, 'funk': [90, 125], 'disco': [110, 132],
  'rock': null, 'pop': null, 'dance-pop': [110, 132], 'k-pop': null, 'hyperpop': null,
  'jazz': null, 'reggae': [60, 95], 'dub': [60, 90], 'dancehall': [88, 110], 'afrobeats': [95, 118],
  'latin': null, 'folk': null, 'country': null, 'blues': null, 'classical': null, 'soundtrack': null,
});

/** Played at this tempo but felt (and often tracked) at half of it. */
export const HALF_TIME = Object.freeze(new Set(['dubstep', 'brostep', 'halftime', 'trap', 'drill', 'phonk']));

/** How much a half- or double-time reading counts: real, but weaker than a straight one. */
export const OCTAVE_CREDIT = 0.6;
/** Outside the range, fit falls to zero over this many BPM. */
export const FALLOFF = 12;

/**
 * The working range for a genre: its own row, else its nearest ancestor's.
 * Null when tempo says nothing about it (or it isn't a known genre).
 */
export function tempoRangeOf(slug) {
  if (!slug) return null;
  if (Object.hasOwn(TEMPO, slug)) return TEMPO[slug];
  if (!GENRE_INDEX.has(slug)) return null;
  for (const a of ancestorsOf(slug)) if (Object.hasOwn(TEMPO, a)) return TEMPO[a];
  return null;
}

const straight = (bpm, [lo, hi]) =>
  bpm >= lo && bpm <= hi ? 1 : Math.max(0, 1 - (bpm < lo ? lo - bpm : bpm - hi) / FALLOFF);

/**
 * How well a tempo fits a genre, 0–1, or null when tempo says nothing about it.
 * Half or double the tempo counts at OCTAVE_CREDIT (full credit for half-time
 * genres read at half), so a tracker's octave slip never zeroes a right genre.
 * @returns {{ fit: number, bpm: number } | null}  `bpm`: the octave that fitted best
 */
export function tempoFit(bpm, slug) {
  const range = tempoRangeOf(slug);
  if (!range || !Number.isFinite(bpm) || bpm <= 0) return null;
  const half = HALF_TIME.has(slug) || ancestorsOf(slug).some(a => HALF_TIME.has(a));
  let best = { fit: straight(bpm, range), bpm };
  for (const [k, credit] of [[2, half ? 1 : OCTAVE_CREDIT], [0.5, OCTAVE_CREDIT]]) {
    const f = straight(bpm * k, range) * credit;
    if (f > best.fit) best = { fit: f, bpm: bpm * k };
  }
  return { fit: +best.fit.toFixed(4), bpm: +best.bpm.toFixed(1) };
}

/**
 * Settle a "87 or 174?" reading with what the track sounds like.
 * `candidates` are [slug, weight] pairs (any order); the reading whose straight
 * fit, weighted by them, is higher wins. Ties and no information keep the
 * tracker's own first reading.
 * @returns {{ bpm: number, from: 'tracker'|'genre' }}
 */
export function resolveOctave(bpm, alt, candidates = []) {
  if (!Number.isFinite(alt) || alt <= 0 || !Number.isFinite(bpm)) return { bpm, from: 'tracker' };
  let a = 0, b = 0;
  for (const [slug, w] of candidates) {
    const range = tempoRangeOf(slug);
    if (!range || !(w > 0)) continue;
    a += w * straight(bpm, range);
    b += w * straight(alt, range);
  }
  return b > a + 1e-9 ? { bpm: alt, from: 'genre' } : { bpm, from: 'tracker' };
}

/** Every slug in the table is a real genre (checked by the test). */
export const tempoSlugs = () => Object.keys(TEMPO);
