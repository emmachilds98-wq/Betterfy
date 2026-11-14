import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { indexCaches, buildRegistry, buildEvidence, profileLibrary, analysePlaylists,
         recommend } from '../core/engine.mjs';
import { buildFixtureLibrary, NOW } from '../core/benchmark/playlists.mjs';
import { AUDIO, toEvidence, indexRecords, usableRecord, sameRecording,
         MAX_STYLES, DEFAULT_THRESHOLD } from '../core/sources/audio.mjs';
import { STYLE_LABELS, FALLBACK_RELIABILITY, styleConcept } from '../core/sources/audio-vocab.mjs';
import { makeRecord, makeMiss, MISS, N_STYLES, EMB_DIM } from '../core/audio/record.mjs';
import { unknownConcepts } from '../core/evidence/normalise.mjs';
import { ProviderRegistry } from '../core/sources/provider.mjs';

/* ---------- byte-identical without audio (written first, plan §0 rule 3) ---------- */

/*
 * With no audio records, every engine output must be exactly what it was
 * before the audio provider existed. The pinned hash below was computed on
 * claude/audio-v1 (c7accea), BEFORE core/engine.mjs learned about audio, from
 * the same two fixtures run through the same calls. If this hash moves, an
 * engine output moved for a listener who has never analysed a track.
 */

const T0 = Date.UTC(2026, 0, 1);
const ENGINE_LIB = {
  playlists: [
    { id: 'p1', name: 'Tech House', tracks: [
      { id: 't1', name: 'Pressure', artists: [{ id: 'a1', name: 'Producer One' }], released: '2021-06-01', isrc: 'GBAAA2100001' },
      { id: 't2', name: 'Pressure', artists: [{ id: 'a1', name: 'Producer One' }], released: '2021-06-01' },
    ] },
    { id: 'p2', name: 'Jungle', tracks: [
      { id: 't3', name: 'Rollers', artists: [{ id: 'a2', name: 'Jungle Artist' }], released: '1996-01-01' },
    ] },
  ],
  liked: [{ id: 't4', name: 'Untitled', artists: [{ id: 'a3', name: 'Nobody Has Tagged This' }] }],
};
const ENGINE_CACHES = {
  lastfm: {
    a1: { tags: [['tech house', 100], ['house', 60]], checkedAt: T0 },
    a2: { tags: [['jungle', 100], ['drum and bass', 80]], checkedAt: T0 },
    a3: { tags: [], checkedAt: T0 },
  },
  discogs: { a1: { tags: [['tech house', 9], ['minimal house', 2]], checkedAt: T0 } },
};

// Built once: buildFixtureLibrary() numbers its tracks from a module-level
// counter, so a second call in the same process gets different ids.
const FIXTURE = buildFixtureLibrary();

/** Maps and Sets serialised as entries, so a JSON comparison sees everything. */
const replacer = (_k, v) => v instanceof Map ? { $map: [...v] } : v instanceof Set ? { $set: [...v] } : v;

/** Every engine output on the existing fixtures, as one JSON string. */
function engineOutputs(extra = {}) {
  const out = {};
  // The engine test fixture, every provider cache present.
  {
    const idx = indexCaches({ ...ENGINE_CACHES, now: T0, ...extra });
    const registry = buildRegistry(idx.present);
    const profiles = profileLibrary(ENGINE_LIB, idx, { registry, now: T0 });
    const analysis = analysePlaylists(ENGINE_LIB, profiles, { now: T0 });
    out.engine = { registry: { ids: registry.ids, versions: registry.versions() }, profiles, analysis,
                   evidence: buildEvidence(ENGINE_LIB.playlists[0].tracks[0], idx, { now: T0 }) };
  }
  // The playlist benchmark's fixture library, through recommendations.
  {
    const { lib, tags } = structuredClone(FIXTURE);
    const idx = indexCaches({ lastfm: tags, now: NOW, ...extra });
    const registry = buildRegistry(idx.present);
    const profiles = profileLibrary(lib, idx, { registry, now: NOW });
    const analysis = analysePlaylists(lib, profiles, { now: NOW });
    const rec = recommend(lib, profiles, analysis);
    const seed = lib.playlists[0].tracks[0].id;
    out.fixture = { registry: { ids: registry.ids, versions: registry.versions() }, profiles, analysis,
                    moreLikeThis: rec.moreLikeThis(seed), unfiled: rec.unfiled(),
                    missing: rec.missingFromPlaylist(lib.playlists[0].id),
                    underserved: rec.underservedGenres() };
  }
  return JSON.stringify(out, replacer);
}

const sha = s => createHash('sha256').update(s).digest('hex');
const PINNED = '358c68c16ffc545290d37505e3d24e360d4089e127a59df30f0e4a19bf42f955';

test('BYTE-IDENTICAL: with no audio, engine outputs on the existing fixtures are unchanged', () => {
  const json = engineOutputs();
  assert.equal(json, engineOutputs(), 'the harness itself is deterministic');
  assert.equal(sha(json), PINNED);
});

test('BYTE-IDENTICAL: audio passed as null is the same as audio absent', () => {
  assert.equal(engineOutputs({ audio: null }), engineOutputs());
});

/* ---------- the provider ---------- */

const ix = label => { const i = STYLE_LABELS.indexOf(label); assert.ok(i >= 0, label); return i; };

/**
 * A real makeRecord() output whose mean activations put `styles` on top.
 * One patch, so the mean is exactly what is written here.
 */
function heard(id, styles, { heads = null, isrc = 'GBAAA2100001' } = {}) {
  const act = new Float32Array(N_STYLES).fill(0.001);
  for (const [label, p] of Object.entries(styles)) act[ix(label)] = p;
  let s = 7;
  const emb = Float32Array.from({ length: EMB_DIM }, () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5);
  return makeRecord({ id, isrc, activations: act, embeddings: emb, patches: 1,
                      source: { kind: 'deezer-isrc', deezerId: 1, windows: [], seconds: 30 },
                      mel: 'test', heads, at: T0 });
}

/** A minimal MOOD_MAP stand-in, in heads.mjs's moodHints() shape. */
const MOODS = { dark: { facet: 'mood', concept: 'dark' }, party: { facet: 'context', concept: 'party' },
                retro: { facet: 'era', concept: 'retro' }, trailer: null };
const moodHints = h => (h?.moods ?? []).filter(([l]) => MOODS[l])
  .map(([l, p]) => ({ ...MOODS[l], p, labels: [l] })).sort((a, b) => b.p - a.p);

test('the declaration: track-level, optional, its own independence group', () => {
  assert.equal(AUDIO.id, 'audio-effnet');
  assert.deepEqual(AUDIO.entityTypes, ['track']);
  assert.equal(AUDIO.independenceGroup, 'audio-model');
  assert.notEqual(AUDIO.independenceGroup, 'discogs', 'hears the recording; Discogs reads the discography');
  assert.equal(AUDIO.optional, true);
  assert.equal(MAX_STYLES, 10);
  assert.ok(DEFAULT_THRESHOLD > 0 && DEFAULT_THRESHOLD < 1);
  const reg = new ProviderRegistry([AUDIO]);
  assert.equal(reg.independenceOf('audio-effnet'), 'audio-model');
});

test('styles become track-level genre evidence through the static table', () => {
  const ev = toEvidence(heard('t1', { 'Electronic---Jungle': 0.6, 'Electronic---Techno': 0.3 }));
  assert.equal(ev.length, 2);
  const [j, t] = ev;
  assert.equal(j.source, 'audio-effnet');
  assert.equal(j.entityType, 'track');
  assert.equal(j.entityId, 't1');
  assert.equal(j.field, 'genre');
  assert.equal(j.concept, 'jungle');
  assert.equal(j.rawValue, 'Electronic---Jungle');
  assert.equal(j.sourceConfidence, 1, 'the strongest label is the headline');
  assert.equal(t.concept, 'techno');
  assert.equal(t.sourceConfidence, 0.5, 'relative to the strongest, like every provider');
  assert.equal(j.identityConfidence, 0.98, 'ISRC-matched, or no record at all');
  assert.equal(j.provenance.matchedBy, 'isrc');
  assert.equal(j.retrievedAt, T0);
});

test('a parent-fallback label is discounted to 0.5', () => {
  // Electronic---Abstract has no concept of its own; it falls back to electronic.
  const ev = toEvidence(heard('t1', { 'Electronic---Abstract': 0.5 }));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].concept, 'electronic');
  assert.equal(ev[0].sourceConfidence, FALLBACK_RELIABILITY);
  assert.equal(ev[0].sourceConfidence, 0.5);
  assert.equal(ev[0].provenance.resolvedVia, 'audio-vocab:parent');
});

test('unmapped labels are never emitted, and never reach the unknown-concepts queue', () => {
  const ev = toEvidence(heard('t1', { 'Brass & Military---Brass Band': 0.9, "Children's---Story": 0.8,
                                      'Electronic---Jungle': 0.4 }));
  assert.deepEqual(ev.map(r => r.concept), ['jungle']);
  assert.ok(ev.every(r => r.field !== 'unknown' && r.concept));
  assert.deepEqual(unknownConcepts(ev), []);
  // The unmapped labels do not set the scale either: jungle is the headline.
  assert.equal(ev[0].sourceConfidence, 1);
});

test('labels under the threshold are dropped; the threshold is a parameter', () => {
  const rec = heard('t1', { 'Electronic---Jungle': 0.6, 'Electronic---Techno': 0.05 });
  assert.deepEqual(toEvidence(rec).map(r => r.concept), ['jungle']);
  assert.deepEqual(toEvidence(rec, { threshold: 0.01 }).map(r => r.concept), ['jungle', 'techno']);
  assert.deepEqual(toEvidence(rec, { threshold: 0.9 }), []);
});

test('at most MAX_STYLES style records, strongest first', () => {
  const mapped = STYLE_LABELS.filter(l => l.startsWith('Electronic---') && styleConcept(l).via === 'style').slice(0, 14);
  const rec = heard('t1', Object.fromEntries(mapped.map((l, i) => [l, 0.9 - i * 0.02])));
  assert.ok(toEvidence(rec).length <= MAX_STYLES);
  // makeRecord keeps only the top 10, so build the wider case by hand as well.
  const wide = { ...rec, styles: mapped.map((l, i) => [ix(l), +(0.9 - i * 0.02).toFixed(4)]) };
  const ev = toEvidence(wide, { threshold: 0 });
  assert.equal(ev.length, MAX_STYLES, '14 mapped labels above threshold, 10 kept');
  assert.ok(ev.every((r, i, a) => i === 0 || a[i - 1].provenance.p >= r.provenance.p));
  assert.equal(toEvidence(wide, { threshold: 0, maxStyles: 3 }).length, 3);
});

test('a miss, a foreign model, a malformed record or a relinked ISRC give no evidence', () => {
  assert.deepEqual(toEvidence(makeMiss({ id: 't1', reason: MISS.NO_PREVIEW })), []);
  assert.deepEqual(toEvidence(null), []);
  assert.deepEqual(toEvidence({}), []);
  const rec = heard('t1', { 'Electronic---Jungle': 0.6 });
  assert.deepEqual(toEvidence({ ...rec, model: 'some-other-model' }), []);
  assert.deepEqual(toEvidence({ ...rec, styles: [] }), []);
  assert.deepEqual(toEvidence({ ...rec, emb: { s: 1, q: 'AAAA' } }), []);
  assert.equal(usableRecord(rec, { isrc: 'GBAAA2100001' }), true);
  assert.deepEqual(toEvidence(rec, { isrc: 'USZZZ9900001' }), [], 'relinked: another recording');
});

test('voice_instrumental becomes field `voice`', () => {
  const v = toEvidence(heard('t1', { 'Electronic---Jungle': 0.6 }, { heads: { voice: 0.9 } }))
    .filter(r => r.field === 'voice');
  assert.equal(v.length, 1);
  assert.equal(v[0].rawValue, 'voice');
  assert.equal(v[0].entityType, 'track');
  assert.ok(Math.abs(v[0].sourceConfidence - 0.8) < 1e-9);
  const i = toEvidence(heard('t1', {}, { heads: { voice: 0.1 } })).filter(r => r.field === 'voice');
  assert.equal(i[0].rawValue, 'instrumental');
  assert.deepEqual(toEvidence(heard('t1', {}, { heads: { voice: 0.52 } })).filter(r => r.field === 'voice'), [],
    'a coin flip is not a claim');
});

test('moods map only through an injected moodHints(); without one, none', () => {
  const heads = { moods: [['dark', 0.5], ['trailer', 0.9], ['party', 0.25], ['retro', 0.2], ['epic', 0.4]] };
  const rec = heard('t1', { 'Electronic---Jungle': 0.6 }, { heads });
  assert.deepEqual(toEvidence(rec).filter(r => r.field !== 'genre'), [], 'local fallback says nothing');
  const ev = toEvidence(rec, { moodHints });
  const by = f => ev.filter(r => r.field === f).map(r => r.concept);
  assert.deepEqual(by('mood'), ['dark']);
  assert.deepEqual(by('context'), ['party']);
  assert.deepEqual(by('era'), ['retro']);
  assert.ok(!ev.some(r => /trailer|epic/.test(r.rawValue)), 'null-mapped and unmapped labels never emitted');
  assert.deepEqual(unknownConcepts(ev), []);
  assert.equal(ev.find(r => r.concept === 'dark').sourceConfidence, 1);
});

test('indexRecords keys by track id and skips misses', () => {
  const recs = { t1: heard('t1', { 'Electronic---Jungle': 0.6 }),
                 t2: makeMiss({ id: 't2', reason: MISS.NOT_ON_DEEZER }) };
  const idx = indexRecords(recs);
  assert.deepEqual([...idx.keys()], ['t1']);
  assert.deepEqual([...indexRecords(new Map(Object.entries(recs))).keys()], ['t1']);
  assert.equal(sameRecording(idx.get('t1'), { isrc: 'GBAAA2100001' }), true);
  assert.equal(sameRecording(idx.get('t1'), { isrc: 'XX' }), false);
  assert.equal(sameRecording(idx.get('t1'), {}), true);
});

/* ---------- the engine, with audio ---------- */

test('the engine adds audio as track-level evidence, only for heard tracks', () => {
  const audio = { t3: heard('t3', { 'Electronic---Jungle': 0.7 }, { isrc: null }),
                  t4: heard('t4', { 'Electronic---Jungle': 0.7 }, { isrc: null }),
                  t2: makeMiss({ id: 't2', reason: MISS.NO_ISRC }) };
  const idx = indexCaches({ ...ENGINE_CACHES, now: T0, audio });
  assert.equal(idx.present.audio, true);
  const registry = buildRegistry(idx.present);
  assert.ok(registry.has('audio-effnet'));
  const profiles = profileLibrary(ENGINE_LIB, idx, { registry, now: T0 });

  const base = indexCaches({ ...ENGINE_CACHES, now: T0 });
  const before = profileLibrary(ENGINE_LIB, base, { registry: buildRegistry(base.present), now: T0 });

  // t4's artist is untagged everywhere: the recording alone now speaks.
  const t4 = profiles.get('t4');
  assert.equal(before.get('t4').profile.genre.primary, null);
  assert.equal(t4.profile.genre.primary, 'jungle');
  assert.ok(t4.profile.genre.entities.includes('track'));
  assert.ok(t4.profile.confidence.sources.includes('audio-effnet'));
  // A miss changes nothing about t2's evidence.
  assert.deepEqual(profiles.get('t2').set.records, before.get('t2').set.records);
  // An independent group agreeing raises t3's score.
  assert.ok(profiles.get('t3').profile.genre.score > before.get('t3').profile.genre.score);
  assert.deepEqual(unknownConcepts(profiles.get('t3').set.records), []);
});

test('records that yield nothing leave the registry untouched; audio defaults to off', () => {
  const idx = indexCaches({ ...ENGINE_CACHES, now: T0,
                            audio: { t1: makeMiss({ id: 't1', reason: MISS.NO_PREVIEW }) } });
  assert.equal(idx.present.audio, false);
  assert.ok(!buildRegistry(idx.present).has('audio-effnet'));
  assert.deepEqual(buildRegistry({}).ids, ['spotify']);
  assert.equal('audio' in indexCaches({}), false, 'no audio given: the index keeps its old shape');
});

test('a relinked track ignores the stale record in the engine', () => {
  const t1 = ENGINE_LIB.playlists[0].tracks[0];   // isrc GBAAA2100001
  const stale = indexCaches({ now: T0, audio: { t1: heard('t1', { 'Electronic---Jungle': 0.7 }, { isrc: 'USZZZ9900001' }) } });
  assert.equal(stale.audio.size, 1);
  assert.ok(!buildEvidence(t1, stale, { now: T0 }).records.some(r => r.source === 'audio-effnet'));
  const ok = indexCaches({ now: T0, audio: { t1: heard('t1', { 'Electronic---Jungle': 0.7 }) } });
  assert.ok(buildEvidence(t1, ok, { now: T0 }).records.some(r => r.source === 'audio-effnet'));
});
