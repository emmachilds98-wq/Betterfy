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

// ---- record v2: optional second ears (WP-C1 MAEST, WP-C2 CLAP) ----
import { RECORD_VERSION, MIN_RECORD_VERSION, makeEar, withEar, earCurrent, EARS,
         MAEST_MODEL, MAEST_DIM, MAEST_N_STYLES, CLAP_MODEL, CLAP_DIM } from '../core/audio/record.mjs';

const maestOut = () => { const a = new Float32Array(MAEST_N_STYLES).fill(0.01); a[12] = 0.7; return { embedding: rnd(MAEST_DIM, 3), activations: a }; };

test('v2: a new record has null second ears, and a v1 record stays valid and current', () => {
  assert.equal(RECORD_VERSION, 2);
  assert.equal(MIN_RECORD_VERSION, 1);
  const r = makeRecord(analysis());
  assert.equal(r.v, 2);
  assert.equal(r.maest, null);
  assert.equal(r.clap, null);
  const { maest, clap, ...v1 } = { ...r, v: 1 };
  assert.ok(validRecord(v1), 'a v1 record reads back');
  assert.ok(isCurrent(v1, { mel: '1.0.0' }), 'nobody re-listens because of the bump');
  assert.ok(!isCurrent({ ...r, v: 0 }) && !validRecord({ ...r, v: 0 }));
  assert.ok(!isCurrent({ ...r, v: 3 }) && !validRecord({ ...r, v: 3 }), 'a record from a newer build is not trusted');
  assert.ok(isCurrent(makeMiss({ id: 'x', reason: MISS.NO_PREVIEW, at: 0 }), { now: 1 }));
});

test('v2: makeEar builds each ear with its own model id and dimension', () => {
  const m = makeEar('maest', maestOut());
  assert.equal(m.model, MAEST_MODEL);
  assert.equal(unpackEmbedding(m.emb).length, MAEST_DIM);
  assert.equal(m.styles.length, TOP_STYLES);
  assert.equal(m.styles[0][0], 12);
  const c = makeEar('clap', { embedding: rnd(CLAP_DIM, 5) });
  assert.equal(c.model, CLAP_MODEL);
  assert.equal(c.styles, undefined, 'CLAP keeps an embedding only');
  assert.throws(() => makeEar('maest', { embedding: rnd(CLAP_DIM) , activations: maestOut().activations }));
  assert.throws(() => makeEar('maest', { embedding: rnd(MAEST_DIM) }), 'MAEST needs its styles');
  assert.throws(() => makeEar('clap', { embedding: rnd(MAEST_DIM) }));
  assert.throws(() => makeEar('vggish', { embedding: [] }));
  assert.deepEqual(Object.keys(EARS).sort(), ['clap', 'maest']);
});

test('v2: withEar adds one ear without touching the base ear; earCurrent judges each ear alone', () => {
  const v1 = { ...makeRecord(analysis()), v: 1 };
  delete v1.maest; delete v1.clap;
  const r = withEar(v1, 'maest', makeEar('maest', maestOut()));
  assert.equal(r.v, RECORD_VERSION);
  for (const k of ['id', 'isrc', 'model', 'mel', 'at', 'styles', 'sections', 'emb']) assert.deepEqual(r[k], v1[k], k);
  assert.ok(validRecord(r));
  assert.ok(earCurrent(r, 'maest'));
  assert.ok(!earCurrent(r, 'clap'), 'a missing ear re-queues only that ear');
  assert.ok(isCurrent(r, { mel: '1.0.0' }), 'the base record stays current');
  const stale = { ...r, maest: { ...r.maest, model: 'discogs-maest-old' } };
  assert.ok(validRecord(stale), 'a stale second ear is still a valid base record');
  assert.ok(!earCurrent(stale, 'maest'));
  const both = withEar(r, 'clap', makeEar('clap', { embedding: rnd(CLAP_DIM, 9) }));
  assert.ok(earCurrent(both, 'clap') && earCurrent(both, 'maest'));
  assert.equal(withEar(both, 'clap', null).clap, null);
  assert.ok(!('maest' in v1), 'the input is not mutated');
  assert.throws(() => withEar(makeMiss({ id: 'x', reason: MISS.NO_PREVIEW }), 'maest', r.maest));
  assert.throws(() => withEar(r, 'maest', { model: MAEST_MODEL, emb: packEmbedding(rnd(10)) , styles: [[1, 0.5]] }));
});

test('v2: validRecord rejects a present-but-malformed second ear and accepts null or absent', () => {
  const r = withEar(makeRecord(analysis()), 'maest', makeEar('maest', maestOut()));
  const bad = [
    { ...r, maest: { ...r.maest, emb: packEmbedding(rnd(MAEST_DIM - 1)) } },
    { ...r, maest: { ...r.maest, emb: { s: NaN, q: r.maest.emb.q } } },
    { ...r, maest: { ...r.maest, styles: [[MAEST_N_STYLES, 0.5]] } },
    { ...r, maest: { ...r.maest, styles: [[1, 1.5]] } },
    { ...r, maest: { ...r.maest, styles: [] } },
    { ...r, maest: 'x' },
    { ...r, clap: { model: CLAP_MODEL, emb: packEmbedding(rnd(CLAP_DIM + 1)) } },
    { ...r, clap: { emb: packEmbedding(rnd(CLAP_DIM)) } },
    { ...r, clap: { model: CLAP_MODEL, emb: { s: 1, q: '!!' } } },
  ];
  for (const b of bad) { assert.equal(validRecord(b), false); assert.equal(earCurrent(b, 'maest') && earCurrent(b, 'clap'), false); }
  assert.ok(validRecord({ ...r, clap: null }));
  const { clap, ...noClap } = r;
  assert.ok(validRecord(noClap));
});
