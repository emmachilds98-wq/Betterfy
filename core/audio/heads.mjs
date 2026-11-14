// Extra heads on the effnet embedding: mood/theme, voice, danceability (WP-F1).
//
// These are small ONNX classifiers that read the 1280-d embedding the ear
// (WP-A3, core/audio/infer.mjs) already produced, so mood and voice cost a
// few hundred KB of model and no second pass over the audio. `ort` is
// injected exactly as in infer.mjs — onnxruntime-web in the page,
// onnxruntime-node in scripts, a fake session in tests — so this file has no
// runtime of its own and CI never needs a model.
//
// What comes out is two things, kept apart on purpose:
//   - summariseHeads(): the raw, compact numbers that go into
//     AudioRecord.heads (core/audio/record.mjs). Raw scores are stored, not
//     concepts, so a MOOD_MAP change re-maps every track without re-running
//     anything (AUDIO-ANALYSIS-PLAN §4.3).
//   - moodHints(): those numbers read through MOOD_MAP into ontology
//     concepts. A reviewed static table, never resolveConcept() at runtime:
//     the vocabulary is fixed and the same for every listener, and runtime
//     resolution mis-maps it (holiday→summer, christmas→winter; §2).
import { EMB_DIM } from './record.mjs';

export const HEADS_VERSION = '1.0.0';
/** Embedding rows sent to a head per session.run(). Heads are tiny; this only bounds memory. */
export const MAX_BATCH = 64;
/** Mood/theme labels kept per track in the record. */
export const TOP_MOODS = 8;

/**
 * The 56 MTG-Jamendo mood/theme labels, in the model's output order
 * (alphabetical, as published).
 */
export const MOOD_LABELS = Object.freeze([
  'action', 'adventure', 'advertising', 'background', 'ballad', 'calm', 'children', 'christmas',
  'commercial', 'cool', 'corporate', 'dark', 'deep', 'documentary', 'drama', 'dramatic',
  'dream', 'emotional', 'energetic', 'epic', 'fast', 'film', 'fun', 'funny',
  'game', 'groovy', 'happy', 'heavy', 'holiday', 'hopeful', 'inspiring', 'love',
  'meditative', 'melancholic', 'melodic', 'motivational', 'movie', 'nature', 'party', 'positive',
  'powerful', 'relaxing', 'retro', 'romantic', 'sad', 'sexy', 'slow', 'soft',
  'soundscape', 'space', 'sport', 'summer', 'trailer', 'travel', 'upbeat', 'uplifting',
]);

/**
 * The head contract: name → { file, classes, outKey }. `classes` is the
 * output order; a regression head has one unnamed output (classes.length 1).
 * `outKey` is the field the head's summary occupies in AudioRecord.heads.
 *
 * CLASS ORDER IS UNVERIFIED. Each Essentia model ships a JSON metadata file
 * (`<name>-discogs-effnet-1.json`, "classes") that states its output order;
 * it was unreachable from the environment this was written in. When the
 * models are first hosted under docs/models/, check every `classes` array
 * here against that JSON before anything reads these outputs — a swapped
 * binary head silently inverts voice/instrumental.
 */
export const HEADS = Object.freeze({
  mtg_jamendo_moodtheme: { file: 'mtg_jamendo_moodtheme-discogs-effnet-1.onnx', classes: MOOD_LABELS, outKey: 'moods' },
  voice_instrumental:    { file: 'voice_instrumental-discogs-effnet-1.onnx', classes: Object.freeze(['instrumental', 'voice']), outKey: 'voice' },
  danceability:          { file: 'danceability-discogs-effnet-1.onnx', classes: Object.freeze(['danceable', 'not_danceable']), outKey: 'danceable' },
  // Optional regression heads: one value per patch, not a probability.
  approachability:       { file: 'approachability-discogs-effnet-1.onnx', classes: Object.freeze(['approachability']), outKey: 'approachability' },
  engagement:            { file: 'engagement-discogs-effnet-1.onnx', classes: Object.freeze(['engagement']), outKey: 'engagement' },
});

/** How each head is summarised: the top-k list, one named class's p, or the regression mean. */
const SUMMARY = {
  mtg_jamendo_moodtheme: { kind: 'topk', k: TOP_MOODS },
  voice_instrumental:    { kind: 'class', cls: 'voice' },
  danceability:          { kind: 'class', cls: 'danceable' },
  approachability:       { kind: 'value' },
  engagement:            { kind: 'value' },
};

/**
 * MOOD_MAP: every one of the 56 labels → { facet, concept } in
 * MOODS / CONTEXTS / ERAS (core/ontology/facets.mjs), or an explicit null.
 * Reviewed by hand. A null is a decision, not a gap: these labels are the
 * same for every listener, so an unmapped one must never reach anybody's
 * unknown-concepts review queue (AUDIO-ANALYSIS-PLAN §4.2).
 *
 * Rules applied:
 *  - Film/production-library themes (what the track was licensed FOR, not
 *    how it feels) → null: action, adventure, advertising, commercial,
 *    corporate, documentary, drama, film, movie, trailer, children, game,
 *    nature, travel.
 *  - Seasonal themes → null. holiday is "holiday season / festive" in
 *    Jamendo, not a beach; christmas is a theme, not weather. Mapping them to
 *    summer/winter (what resolveConcept() does via aliases) would file
 *    carols under winter and festive jingles under summer.
 *  - Tempo words (fast, slow) → null: tempo is measured by DSP (WP-D1), not
 *    guessed from a mood head.
 *  - Words too vague to be one mood (cool, deep, melodic, ballad, funny,
 *    soundscape) → null.
 *  - Otherwise the ontology's own alias decides, so the two vocabularies
 *    agree (emotional→melancholic, heavy→aggressive, groovy→hypnotic, …).
 *    Two departures: epic→dramatic (Jamendo's epic is orchestral/cinematic,
 *    not the anthemic-dance sense the euphoric alias means), and
 *    travel→null (the driving context aliases it, but Jamendo's travel is
 *    travelogue/documentary music, not road-trip listening).
 */
const m = concept => Object.freeze({ facet: 'mood', concept });
const c = concept => Object.freeze({ facet: 'context', concept });
const e = concept => Object.freeze({ facet: 'era', concept });
export const MOOD_MAP = Object.freeze({
  action: null,              // film-library theme
  adventure: null,           // film-library theme
  advertising: null,         // film-library theme
  background: c('background'),
  ballad: null,              // a song form; could be romantic or sad
  calm: m('relaxed'),
  children: null,            // audience, not mood
  christmas: null,           // seasonal theme; NOT winter
  commercial: null,          // film-library theme
  cool: null,                // too vague
  corporate: null,           // film-library theme
  dark: m('dark'),
  deep: null,                // too vague (deep house? deep feeling?)
  documentary: null,         // film-library theme
  drama: null,               // film genre; 'dramatic' carries the feeling
  dramatic: m('dramatic'),
  dream: m('dreamy'),
  emotional: m('melancholic'), // the ontology's own alias
  energetic: m('energetic'),
  epic: m('dramatic'),       // cinematic sense, see header
  fast: null,                // tempo: DSP's job
  film: null,                // film-library theme
  fun: m('uplifting'),
  funny: null,               // comedic/novelty, not a listening mood
  game: null,                // music for games, not music to game to
  groovy: m('hypnotic'),     // the ontology's own alias
  happy: m('uplifting'),
  heavy: m('aggressive'),
  holiday: null,             // festive season; NOT summer
  hopeful: m('uplifting'),
  inspiring: m('uplifting'),
  love: m('romantic'),
  meditative: m('dreamy'),
  melancholic: m('melancholic'),
  melodic: null,             // a property of nearly everything
  motivational: m('energetic'),
  movie: null,               // film-library theme
  nature: null,              // documentary/library theme
  party: c('party'),
  positive: m('uplifting'),
  powerful: m('energetic'),
  relaxing: m('relaxed'),
  retro: e('retro'),
  romantic: m('romantic'),
  sad: m('melancholic'),
  sexy: m('romantic'),
  slow: null,                // tempo: DSP's job
  soft: m('relaxed'),
  soundscape: null,          // a texture/format, not a mood
  space: m('dreamy'),        // 'spacey' is a dreamy alias
  sport: c('workout'),
  summer: c('summer'),
  trailer: null,             // film-library theme
  travel: null,              // travelogue music, not road-trip; see header
  upbeat: m('energetic'),
  uplifting: m('uplifting'),
});

/**
 * Load the heads whose URLs are given. Heads without a URL are skipped
 * silently: every head is optional, and a page that only hosts the mood head
 * still works.
 *
 * @param {{ ort: { InferenceSession: { create(url: string|Uint8Array, opts?: object): Promise<any> }, Tensor: any },
 *           urls: { [name: string]: string|Uint8Array }, sessionOptions?: object }} deps
 * @returns {Promise<{ names: string[], run(embeddings: Float32Array, patches: number): Promise<{ [name: string]: Float32Array }>, release(): Promise<void> }>}
 */
export async function createHeads({ ort, urls = {}, sessionOptions }) {
  const sessions = {};
  for (const [name, url] of Object.entries(urls)) {
    if (!HEADS[name]) throw new Error(`unknown head: ${name}`);
    if (!url) continue;
    sessions[name] = await ort.InferenceSession.create(url, sessionOptions ?? { executionProviders: ['wasm'] });
  }

  /** Per head, a Float32Array [patches × classes.length], row-major. */
  async function run(embeddings, patches) {
    if (!(patches > 0)) throw new Error('no patches to run');
    if (embeddings.length !== patches * EMB_DIM) throw new Error(`expected ${patches}×${EMB_DIM} floats, got ${embeddings.length}`);
    const out = {};
    for (const [name, session] of Object.entries(sessions)) {
      const width = HEADS[name].classes.length;
      const input = session.inputNames?.[0] ?? 'embeddings';
      const res = new Float32Array(patches * width);
      for (let p0 = 0; p0 < patches; p0 += MAX_BATCH) {
        const n = Math.min(MAX_BATCH, patches - p0);
        const x = new ort.Tensor('float32', embeddings.subarray(p0 * EMB_DIM, (p0 + n) * EMB_DIM), [n, EMB_DIM]);
        res.set(pickOutput(await session.run({ [input]: x }), n, width, name), p0 * width);
      }
      out[name] = res;
    }
    return out;
  }
  return {
    names: Object.keys(sessions),
    run,
    release: async () => { for (const s of Object.values(sessions)) await s.release?.(); },
  };
}

/** The output tensor that is [n × width]. Heads may also return their own embedding; told apart by width. */
function pickOutput(out, n, width, name) {
  for (const t of Object.values(out)) {
    const data = t?.data ?? t;
    if (data?.length === n * width) return data;
  }
  throw new Error(`${name}: no [${n}×${width}] output`);
}

/**
 * The compact object stored in AudioRecord.heads, averaged over patches:
 *   { v, moods: [[label, p], ...top 8], voice: p, danceable: p, approachability: x, engagement: x }
 * Only heads that ran appear. Returns null when none did.
 *
 * @param {{ [name: string]: Float32Array }} outputs  from run()
 * @param {number} patches
 */
export function summariseHeads(outputs, patches) {
  if (!outputs || !(patches > 0)) return null;
  const summary = { v: HEADS_VERSION };
  let any = false;
  for (const [name, data] of Object.entries(outputs)) {
    const head = HEADS[name];
    if (!head || !data) continue;
    const width = head.classes.length;
    if (data.length !== patches * width) throw new Error(`${name}: expected ${patches}×${width} values, got ${data.length}`);
    const mean = new Float64Array(width);
    for (let p = 0; p < patches; p++) for (let k = 0; k < width; k++) mean[k] += data[p * width + k] / patches;
    const how = SUMMARY[name];
    if (how.kind === 'topk') {
      summary[head.outKey] = Array.from(mean.keys())
        .sort((a, b) => mean[b] - mean[a] || a - b)
        .slice(0, how.k)
        .map(i => [head.classes[i], round(mean[i])]);
    } else if (how.kind === 'class') {
      summary[head.outKey] = round(mean[head.classes.indexOf(how.cls)]);
    } else {
      summary[head.outKey] = round(mean[0]);
    }
    any = true;
  }
  return any ? summary : null;
}

/**
 * Mood/context/era concepts the stored mood list points at, through MOOD_MAP.
 * Null-mapped labels are dropped; several labels landing on one concept keep
 * the highest p. Sorted by p, highest first.
 *
 * @param {{ moods?: [string, number][] } | null} heads  AudioRecord.heads
 * @param {{ min?: number }} [opts]  drop labels below this p
 * @returns {{ facet: string, concept: string, p: number, labels: string[] }[]}
 */
export function moodHints(heads, { min = 0 } = {}) {
  const byKey = new Map();
  for (const [label, p] of heads?.moods ?? []) {
    const hit = MOOD_MAP[label];
    if (!hit || !(p >= min)) continue;
    const key = `${hit.facet}:${hit.concept}`;
    const cur = byKey.get(key);
    if (!cur) byKey.set(key, { facet: hit.facet, concept: hit.concept, p, labels: [label] });
    else { cur.labels.push(label); if (p > cur.p) cur.p = p; }
  }
  return [...byKey.values()].sort((a, b) => b.p - a.p);
}

const round = x => +x.toFixed(4);
