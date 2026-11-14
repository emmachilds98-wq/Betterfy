// A tiny CLAP text table and CLAP audio embeddings, for WP-C3's naming and
// search tests (core/audio/clap-search.mjs). The shapes are WP-C2's:
// a table of { text, kind, concept?, emb } prompts and a record field
// `clap: { model, emb }`, both packed with record.mjs's packEmbedding.
//
// Sound is a few fixed random directions in a 32-d space: each prompt is one
// direction, and a track "sounds like" a prompt by leaning toward it. A broad
// prompt ("electronic") is the mean of every direction, so it sits close to
// everything, which is what naming has to see past.
import { packEmbedding } from '../../core/audio/record.mjs';

export const DIM = 32;

function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 32 - 0.5; };
}
const unit = v => { const n = Math.hypot(...v); return Float32Array.from(v, x => x / n); };
const direction = seed => { const r = rng(seed); return unit(Array.from({ length: DIM }, () => r())); };

export const DIRS = {
  phonk: direction(1), jersey: direction(2), dnb: direction(3), bass: direction(4), rolling: direction(5), euphoric: direction(6),
};

export function table({ template = '{name} music' } = {}) {
  const all = Object.values(DIRS);
  const broad = unit(Array.from({ length: DIM }, (_, i) => all.reduce((s, d) => s + d[i], 0)));
  const p = (text, kind, emb, concept) => ({ text, kind, ...(concept ? { concept } : {}), emb: packEmbedding(emb) });
  return {
    v: 1, model: 'laion/larger_clap_music', revision: 'test', dim: DIM, template,
    prompts: [
      p('phonk music', 'genre', DIRS.phonk, 'phonk'),
      p('jersey club music', 'genre', DIRS.jersey, 'jersey-club'),
      p('drum and bass music', 'genre', DIRS.dnb, 'drum-and-bass'),
      p('bassline music', 'genre', DIRS.bass, 'bassline'),
      p('electronic music', 'genre', broad, 'electronic'),
      p('dark rolling bassline', 'description', unit(DIRS.rolling.map((x, i) => x + 0.6 * DIRS.dnb[i]))),
      p('euphoric hands-up vocal', 'description', DIRS.euphoric),
    ],
  };
}

let SEED = 100;
/** A CLAP field leaning toward these directions, plus noise. */
export function clapField(mix, noise = 0.35) {
  const r = rng(SEED++);
  const v = Array.from({ length: DIM }, (_, i) => noise * r() + Object.entries(mix).reduce((s, [k, w]) => s + w * DIRS[k][i], 0));
  return { model: 'larger_clap_music-audio-q8-1', emb: packEmbedding(unit(v)) };
}
export const resetSeed = () => { SEED = 100; };
