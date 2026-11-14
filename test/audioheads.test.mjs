import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEADS, MOOD_LABELS, MOOD_MAP, TOP_MOODS, MAX_BATCH, createHeads, summariseHeads, moodHints } from '../core/audio/heads.mjs';
import { EMB_DIM } from '../core/audio/record.mjs';
import { MOODS, CONTEXTS, ERAS } from '../core/ontology/facets.mjs';

// A fake onnxruntime: each head's session returns a fixed row per patch,
// optionally beside a decoy output of another width, and records its calls.
function fakeOrt(rowsByFile, { decoy = false } = {}) {
  const calls = [];
  class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } }
  const InferenceSession = {
    async create(url) {
      const file = String(url).split('/').pop();
      const row = rowsByFile[file];
      if (!row) throw new Error(`no fake for ${file}`);
      return {
        inputNames: ['model/Placeholder'],
        async run(feeds) {
          const [name] = Object.keys(feeds);
          const x = feeds[name];
          calls.push({ file, input: name, dims: x.dims });
          const n = x.dims[0];
          const width = row.width ?? row.length;
          const data = new Float32Array(n * width);
          for (let p = 0; p < n; p++) data.set(row.fn ? row.fn(p) : row, p * width);
          const out = { activations: { data } };
          if (decoy) out.embeddings = { data: new Float32Array(n * 1280) };
          return out;
        },
        async release() { calls.push({ file, released: true }); },
      };
    },
  };
  return { ort: { Tensor, InferenceSession }, calls };
}

const moodRow = () => { const r = new Float32Array(56).fill(0.01); r[MOOD_LABELS.indexOf('dark')] = 0.9; r[MOOD_LABELS.indexOf('holiday')] = 0.7; r[MOOD_LABELS.indexOf('sad')] = 0.6; return r; };
const urls = Object.fromEntries(Object.entries(HEADS).map(([n, h]) => [n, `/models/${h.file}`]));
const rows = {
  [HEADS.mtg_jamendo_moodtheme.file]: moodRow(),
  [HEADS.voice_instrumental.file]: Float32Array.from([0.2, 0.8]),
  [HEADS.danceability.file]: Float32Array.from([0.3, 0.7]),
  [HEADS.approachability.file]: Float32Array.from([0.5]),
  [HEADS.engagement.file]: Float32Array.from([0.25]),
};

test('HEADS contract: files, class counts, out keys', () => {
  assert.equal(HEADS.mtg_jamendo_moodtheme.classes.length, 56);
  assert.deepEqual([...HEADS.voice_instrumental.classes], ['instrumental', 'voice']);
  assert.deepEqual([...HEADS.danceability.classes], ['danceable', 'not_danceable']);
  assert.equal(HEADS.approachability.classes.length, 1);
  assert.equal(HEADS.engagement.classes.length, 1);
  for (const [name, h] of Object.entries(HEADS)) {
    assert.equal(h.file, `${name}-discogs-effnet-1.onnx`);
    assert.ok(h.outKey);
  }
  assert.deepEqual([...MOOD_LABELS], [...MOOD_LABELS].sort(), 'labels are alphabetical');
  assert.equal(new Set(MOOD_LABELS).size, 56);
});

test('run() feeds [n×1280] under the session\'s own input name and returns [patches×classes] per head', async () => {
  const { ort, calls } = fakeOrt(rows, { decoy: true });
  const heads = await createHeads({ ort, urls });
  const patches = 3;
  const out = await heads.run(new Float32Array(patches * EMB_DIM), patches);
  for (const [name, h] of Object.entries(HEADS)) {
    assert.ok(out[name] instanceof Float32Array, name);
    assert.equal(out[name].length, patches * h.classes.length, name);
  }
  assert.ok(calls.every(c => c.released || (c.input === 'model/Placeholder' && c.dims[1] === EMB_DIM && c.dims[0] === patches)));
  await heads.release();
  assert.equal(calls.filter(c => c.released).length, 5);
});

test('run() batches long inputs and keeps patch order', async () => {
  const width = 2;
  const { ort, calls } = fakeOrt({ [HEADS.voice_instrumental.file]: { width, fn: p => Float32Array.from([p, -p]) } });
  const heads = await createHeads({ ort, urls: { voice_instrumental: urls.voice_instrumental } });
  const patches = MAX_BATCH + 5;
  const out = await heads.run(new Float32Array(patches * EMB_DIM), patches);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(c => c.dims[0]), [MAX_BATCH, 5]);
  assert.equal(out.voice_instrumental[2 * (MAX_BATCH + 1)], 1, 'second batch restarts its own patch count at 0, placed after the first');
});

test('heads without a URL are skipped; unknown heads and bad shapes are refused', async () => {
  const { ort } = fakeOrt(rows);
  const heads = await createHeads({ ort, urls: { danceability: urls.danceability, engagement: null } });
  assert.deepEqual(heads.names, ['danceability']);
  await assert.rejects(createHeads({ ort, urls: { nope: 'x.onnx' } }), /unknown head/);
  await assert.rejects(heads.run(new Float32Array(10), 1), /expected 1×1280/);
  await assert.rejects(heads.run(new Float32Array(0), 0), /no patches/);
});

test('summariseHeads averages over patches into the compact record shape', async () => {
  const { ort } = fakeOrt({ ...rows, [HEADS.voice_instrumental.file]: { width: 2, fn: p => Float32Array.from(p === 0 ? [1, 0] : [0, 1]) } });
  const heads = await createHeads({ ort, urls });
  const out = await heads.run(new Float32Array(2 * EMB_DIM), 2);
  const s = summariseHeads(out, 2);
  assert.equal(s.moods.length, TOP_MOODS);
  assert.deepEqual(s.moods.slice(0, 3), [['dark', 0.9], ['holiday', 0.7], ['sad', 0.6]]);
  assert.equal(s.voice, 0.5, 'voice p averaged over the two patches');
  assert.equal(s.danceable, 0.3, 'p of the danceable class, not its complement');
  assert.equal(s.approachability, 0.5);
  assert.equal(s.engagement, 0.25);
  assert.ok(JSON.stringify(s).length < 400, 'stays small');
  assert.equal(summariseHeads({}, 2), null);
  assert.throws(() => summariseHeads({ danceability: new Float32Array(3) }, 2), /expected 2×2/);
});

test('every one of the 56 mood labels has an explicit MOOD_MAP entry, and every concept exists', () => {
  assert.equal(MOOD_LABELS.length, 56);
  assert.deepEqual(Object.keys(MOOD_MAP).sort(), [...MOOD_LABELS]);
  const tables = { mood: MOODS, context: CONTEXTS, era: ERAS };
  for (const label of MOOD_LABELS) {
    const hit = MOOD_MAP[label];
    assert.ok(hit === null || typeof hit === 'object', `${label} is explicit`);
    if (hit) assert.ok(tables[hit.facet]?.[hit.concept], `${label} → ${hit.facet}:${hit.concept} exists`);
  }
});

test('holiday and christmas are not mis-mapped; film-library themes map to null', () => {
  assert.notEqual(MOOD_MAP.holiday?.concept, 'summer');
  assert.notEqual(MOOD_MAP.christmas?.concept, 'winter');
  assert.equal(MOOD_MAP.holiday, null);
  assert.equal(MOOD_MAP.christmas, null);
  for (const l of ['trailer', 'corporate', 'documentary', 'advertising', 'commercial', 'film', 'movie'])
    assert.equal(MOOD_MAP[l], null, l);
});

test('moodHints maps, drops nulls, merges duplicates and honours a threshold', () => {
  const heads = { moods: [['dark', 0.9], ['holiday', 0.7], ['sad', 0.6], ['emotional', 0.4], ['party', 0.3], ['trailer', 0.2]] };
  const h = moodHints(heads);
  assert.deepEqual(h.map(x => `${x.facet}:${x.concept}`), ['mood:dark', 'mood:melancholic', 'context:party']);
  assert.deepEqual(h[1].labels, ['sad', 'emotional']);
  assert.equal(h[1].p, 0.6);
  assert.deepEqual(moodHints(heads, { min: 0.5 }).map(x => x.concept), ['dark', 'melancholic']);
  assert.deepEqual(moodHints(null), []);
  assert.deepEqual(moodHints({}), []);
});
