import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRecord, makeMiss, isCurrent, validRecord, packEmbedding, unpackEmbedding,
         MISS, MODEL, N_STYLES, EMB_DIM, TOP_STYLES, MISS_TTL_MS } from '../core/audio/record.mjs';

const rnd = (n, seed = 1) => { let s = seed; return Float32Array.from({ length: n }, () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5); };
const cos = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] ** 2; y += b[i] ** 2; } return d / Math.sqrt(x * y); };

function analysis(patches = 3) {
  const activations = new Float32Array(patches * N_STYLES).fill(0.01);
  // Patch 0 and 1 say style 7; patch 2 says style 42 — a track that changes.
  activations[7] = 0.9; activations[N_STYLES + 7] = 0.8; activations[2 * N_STYLES + 42] = 0.95;
  return { id: 'trk1', isrc: 'GBXXX0000001', activations, embeddings: rnd(patches * EMB_DIM), patches,
           source: { kind: 'deezer-isrc', deezerId: 1, windows: [[0, 165000]], seconds: 10 }, mel: '1.0.0', at: 1000 };
}

test('a record keeps top styles, a per-section timeline, and a compact embedding', () => {
  const r = makeRecord(analysis());
  assert.equal(r.model, MODEL);
  assert.equal(r.styles.length, TOP_STYLES);
  assert.equal(r.styles[0][0], 7, 'the style most sections agree on leads');
  assert.deepEqual(r.sections.map(s => s[0][0]), [7, 7, 42], 'the change inside the clip is visible');
  assert.ok(JSON.stringify(r).length < 2600, `record is small: ${JSON.stringify(r).length} bytes`);
  assert.ok(validRecord(r));
});

test('int8 embedding packing preserves direction (cosine > 0.999)', () => {
  const e = rnd(EMB_DIM, 7);
  assert.ok(cos(e, unpackEmbedding(packEmbedding(e))) > 0.999);
  const zero = unpackEmbedding(packEmbedding(new Float32Array(EMB_DIM)));
  assert.ok(zero.every(v => v === 0), 'silence packs without NaN');
});

test('shape mismatches are refused rather than stored', () => {
  assert.throws(() => makeRecord({ ...analysis(), patches: 2 }));
  assert.throws(() => makeRecord({ ...analysis(), patches: 0 }));
});

test('misses: catalogue facts are cacheable, a failed request never is', () => {
  const m = makeMiss({ id: 'x', reason: MISS.NO_PREVIEW, at: 0 });
  assert.ok(validRecord(m));
  assert.throws(() => makeMiss({ id: 'x', reason: MISS.FAILED }));
  assert.ok(isCurrent(m, { now: MISS_TTL_MS - 1 }));
  assert.ok(!isCurrent(m, { now: MISS_TTL_MS + 1 }), 'an old miss is re-asked');
});

test('a record from another model or mel version is not current', () => {
  const r = makeRecord(analysis());
  assert.ok(isCurrent(r, { mel: '1.0.0' }));
  assert.ok(!isCurrent(r, { mel: '1.1.0' }));
  assert.ok(!isCurrent({ ...r, model: 'something-else' }));
});

test('validRecord never throws on junk read back from storage', () => {
  for (const junk of [null, 1, 'x', {}, { v: 1, id: 'a', styles: [[999, 0.5]] }, { v: 1, id: 'a', styles: [[1, 0.5]], emb: { s: 1, q: '!!' } }])
    assert.equal(validRecord(junk), false);
});
