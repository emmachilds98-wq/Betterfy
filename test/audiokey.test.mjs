import { test } from 'node:test';
import assert from 'node:assert/strict';
import { key, chromagram, toCamelot, toOpenKey, relation, scoreKeys, CAMELOT, KEY_VERSION } from '../core/audio/dsp/key.mjs';
import { SAMPLE_RATE } from '../core/audio/mel.mjs';
import { compare, summarise, wilson, twoWindows, analyseTrack } from '../scripts/audio-dsp/key-vs-rekordbox.mjs';

// WP-D2. These are SYNTHETIC checks: harmonic tones (8 partials at 1/h) in
// known keys. They prove the maths, the Camelot bookkeeping and the failure
// modes. They do not prove accuracy on real records; that number comes from
// scripts/audio-dsp/key-vs-rekordbox.mjs on the owner's library, and key()
// doesn't feed records or the UI (WP-D4) until it exists.
//
// Policy, asserted below: on every synthetic case the answer must be the
// exact key, not merely its relative. The relative major/minor or a fifth
// neighbour is expected as the top ALTERNATE (minor material shares its pitch
// classes with the relative major, so that is the honest runner-up), and the
// alternate must be flagged with its Camelot relation.

const SR = SAMPLE_RATE;
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

/** Harmonic tones: each note has partials 1..8 at amplitude 1/h, a short attack and a decay. */
function render(events, seconds, { cents = 0, sampleRate = SR } = {}) {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (const { notes, t0, dur, amp = 0.15 } of events) {
    const s0 = Math.round(t0 * sampleRate), n = Math.round(dur * sampleRate);
    for (const m of notes) {
      const f0 = 440 * 2 ** ((m - 69 + cents / 100) / 12);
      for (let h = 1; h <= 8 && f0 * h < sampleRate * 0.45; h++) {
        const a = amp / h, w = 2 * Math.PI * f0 * h / sampleRate;
        for (let i = 0; i < n && s0 + i < out.length; i++) out[s0 + i] += a * Math.min(1, i / 400) * Math.exp(-1.5 * i / n) * Math.sin(w * i);
      }
    }
  }
  return out;
}

const SCALE = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
// I–IV–V–I–vi–IV–V–I and i–iv–V–i–VI–iv–V–i (harmonic minor's major V), each
// chord over its root an octave down, with a scale run on top.
const CHORDS = {
  major: [[0, 4, 7], [5, 9, 12], [7, 11, 14], [0, 4, 7], [9, 12, 16], [5, 9, 12], [7, 11, 14], [0, 4, 7]],
  minor: [[0, 3, 7], [5, 8, 12], [7, 11, 14], [0, 3, 7], [8, 12, 15], [5, 8, 12], [7, 11, 14], [0, 3, 7]],
};

/** A chord progression in the key whose tonic is MIDI note `t`. */
function progression(t, mode, { seconds = 10, cents = 0, sampleRate } = {}) {
  const ev = [], d = seconds / CHORDS[mode].length, sc = SCALE[mode];
  CHORDS[mode].forEach((c, i) => {
    ev.push({ notes: c.map(x => t + x), t0: i * d, dur: d });
    ev.push({ notes: [t + c[0] - 12], t0: i * d, dur: d, amp: 0.25 });
    for (let j = 0; j < 4; j++) ev.push({ notes: [t + 12 + sc[(i * 2 + j) % 7]], t0: i * d + j * d / 4, dur: d / 4, amp: 0.1 });
  });
  return render(ev, seconds, { cents, sampleRate });
}

/** A scale up and down over a tonic drone: no chords at all. */
function scale(t, mode, { seconds = 8 } = {}) {
  const steps = [...SCALE[mode], 12, ...[...SCALE[mode]].reverse()], d = seconds / steps.length;
  const ev = [{ notes: [t - 12], t0: 0, dur: seconds, amp: 0.12 }];
  steps.forEach((s, i) => ev.push({ notes: [t + s], t0: i * d, dur: d * 1.5 }));
  return render(ev, seconds);
}

function noise(n, amp, seed = 1) {
  const x = new Float32Array(n); let s = seed;
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; x[i] = (s / 2 ** 32 - 0.5) * amp; }
  return x;
}

/** Four-on-the-floor kick plus off-beat noise hats: broadband, untuned. */
function drums(n, bpm = 128) {
  const x = new Float32Array(n), p = Math.round(SR * 60 / bpm); let s = 7;
  for (let b = 0; b < n; b += p) {
    for (let j = 0; j < 3000 && b + j < n; j++) x[b + j] += 0.8 * Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-j / 300)) * j / SR) * Math.exp(-j / 1500);
    for (let j = 0, h = b + (p >> 1); j < 1500 && h + j < n; j++) { s = (s * 1664525 + 1013904223) >>> 0; x[h + j] += 0.4 * (s / 2 ** 32 - 0.5) * Math.exp(-j / 300); }
  }
  return x;
}

const mix = (...xs) => xs[0].map((v, i) => xs.reduce((a, x) => a + x[i], 0));

// The tonic of each named key as a MIDI note in the octave from C3.
const NAMED = [['C', 'major', 48], ['A', 'minor', 57], ['F#', 'major', 54], ['Eb', 'minor', 51], ['G', 'major', 55], ['D', 'minor', 50]];

// ---------- Camelot bookkeeping ----------

// Written out by hand (and the same mapping as rekordbox.mjs's table), not
// derived from the formula under test.
const WHEEL = {
  'A minor': '8A', 'E minor': '9A', 'B minor': '10A', 'F# minor': '11A', 'C# minor': '12A', 'G# minor': '1A',
  'Eb minor': '2A', 'Bb minor': '3A', 'F minor': '4A', 'C minor': '5A', 'G minor': '6A', 'D minor': '7A',
  'C major': '8B', 'G major': '9B', 'D major': '10B', 'A major': '11B', 'E major': '12B', 'B major': '1B',
  'F# major': '2B', 'Db major': '3B', 'Ab major': '4B', 'Eb major': '5B', 'Bb major': '6B', 'F major': '7B',
};
const ENHARMONIC = { 'F#': 'Gb', 'C#': 'Db', 'G#': 'Ab', Eb: 'D#', Bb: 'A#', Db: 'C#', Ab: 'G#' };

test('Camelot: all 24 keys map to the wheel, in sharps and flats alike', () => {
  for (const [name, code] of Object.entries(WHEEL)) {
    const [tonic, mode] = name.split(' ');
    assert.equal(toCamelot(tonic, mode), code, name);
    if (ENHARMONIC[tonic]) assert.equal(toCamelot(ENHARMONIC[tonic], mode), code, `${ENHARMONIC[tonic]} ${mode}`);
    assert.equal(CAMELOT[code].key, name, `CAMELOT[${code}]`);
    assert.equal(CAMELOT[code].camelot, code);
  }
  assert.equal(Object.keys(CAMELOT).length, 24);
  assert.equal(new Set(Object.values(CAMELOT).map(k => `${k.pc}${k.mode}`)).size, 24, 'no two codes share a key');
  assert.equal(toCamelot('E♭', 'min'), '2A', 'unicode accidentals and short modes');
  assert.equal(toCamelot('bb', 'Minor'), '3A', 'case-insensitive');
  assert.equal(toCamelot('H', 'major'), null, 'unreadable tonic is null, not a guess');
  assert.equal(toCamelot('C', 'dorian'), null, 'unknown mode is null');
  assert.ok(Object.isFrozen(CAMELOT) && Object.isFrozen(CAMELOT['8A']));
});

test('Open Key: 1m is A minor, 1d is C major, and it walks the same wheel', () => {
  assert.equal(toOpenKey('A', 'minor'), '1m');
  assert.equal(toOpenKey('C', 'major'), '1d');
  assert.equal(toOpenKey('E', 'minor'), '2m');
  assert.equal(toOpenKey('F', 'major'), '12d');
  assert.equal(toOpenKey('D', 'minor'), '12m');
  for (const [code, k] of Object.entries(CAMELOT)) {
    const n = parseInt(code, 10);
    assert.equal(k.openKey, `${(n + 4) % 12 + 1}${code.endsWith('A') ? 'm' : 'd'}`, code);
  }
});

test('Camelot relations: relative, both fifths, parallel, and the 12→1 wrap', () => {
  assert.equal(relation('8A', '8B'), 'relative');
  assert.equal(relation('8A', '9A'), 'fifth-up');
  assert.equal(relation('8A', '7A'), 'fifth-down');
  assert.equal(relation('12B', '1B'), 'fifth-up', 'wraps');
  assert.equal(relation('1B', '12B'), 'fifth-down', 'wraps');
  assert.equal(relation('8A', '11B'), 'parallel', 'A minor / A major');
  assert.equal(relation('8A', '8A'), 'same');
  assert.equal(relation('8A', '3B'), null);
  assert.equal(relation('8A', '13Z'), null);
});

// ---------- named keys ----------

for (const [tonic, mode, midi] of NAMED) {
  test(`${tonic} ${mode}: a chord progression is read as exactly that key`, () => {
    const r = key(progression(midi, mode));
    assert.equal(r.camelot, toCamelot(tonic, mode), `got ${r.key}`);
    assert.equal(r.tonic, CAMELOT[r.camelot].tonic);
    assert.equal(r.mode, mode);
    assert.ok(r.confidence >= 0.6, `confidence ${r.confidence}`);
    assert.ok(r.alternates[0].compatible, `top alternate ${r.alternates[0].key} is a Camelot neighbour`);
    if (mode === 'minor') assert.equal(r.alternates[0].relation, 'relative', 'the relative major is the minor key\'s runner-up');
  });

  test(`${tonic} ${mode}: a bare scale over a tonic drone is read as that key`, () => {
    const r = key(scale(midi, mode));
    assert.equal(r.camelot, toCamelot(tonic, mode), `got ${r.key}, alternates ${r.alternates.map(a => a.key)}`);
    const rel = r.alternates.find(a => a.relation === 'relative');
    if (rel) assert.equal(rel.camelot, `${parseInt(r.camelot, 10)}${mode === 'minor' ? 'B' : 'A'}`);
  });
}

test('all 24 keys: progressions in every key come out exactly right', () => {
  let right = 0;
  const wrong = [];
  for (const mode of ['major', 'minor']) {
    for (let pc = 0; pc < 12; pc++) {
      const r = key(progression(48 + pc, mode, { seconds: 8 }));
      if (r.camelot === toCamelot(pc, mode)) right++;
      else wrong.push(`${NAMES[pc]} ${mode} -> ${r.key}`);
    }
  }
  console.log(`# synthetic accuracy: ${right}/24 progressions exact`);
  assert.equal(right, 24, wrong.join('; '));
});

// ---------- transposition ----------

test('transposition invariance: a semitone up moves the answer one semitone up', () => {
  for (const [tonic, mode, midi] of NAMED) {
    const base = key(progression(midi, mode));
    const up = key(progression(midi, mode, { cents: 100 }));      // every frequency × 2^(1/12)
    const pcUp = (CAMELOT[base.camelot].pc + 1) % 12;
    assert.equal(up.camelot, toCamelot(pcUp, mode), `${tonic} ${mode} + 1 semitone -> ${up.key}`);
    assert.equal(up.mode, base.mode);
  }
  // And the chroma itself rotates by one bin.
  const a = chromagram(progression(48, 'major')).chroma, b = chromagram(progression(49, 'major')).chroma;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < 12; i++) { dot += a[i] * b[(i + 1) % 12]; na += a[i] ** 2; nb += b[i] ** 2; }
  assert.ok(dot / Math.sqrt(na * nb) > 0.98, `rotated chroma cosine ${dot / Math.sqrt(na * nb)}`);
});

test('tuning tolerance: records tuned ±30 cents off A440 still read right, and the offset is reported', () => {
  for (const cents of [30, -30]) {
    const r = key(progression(57, 'minor', { cents }));
    assert.equal(r.camelot, '8A', `${cents} cents -> ${r.key}`);
    // Overtones 5 and 7 sit flat of equal temperament, which pulls the estimate a few cents low.
    assert.ok(Math.abs(r.tuningCents - cents) < 10, `estimated ${r.tuningCents} for ${cents}`);
  }
});

// ---------- robustness and failure modes ----------

test('with a four-on-the-floor kit and noise over the top, the key holds', () => {
  for (const [tonic, mode, midi] of [['C', 'major', 48], ['A', 'minor', 57], ['Eb', 'minor', 51]]) {
    const x = progression(midi, mode);
    const r = key(mix(x, drums(x.length), noise(x.length, 0.5, 3)));
    assert.equal(r.camelot, toCamelot(tonic, mode), `${tonic} ${mode} -> ${r.key}`);
  }
});

test('silence: no key, zero confidence, no throw', () => {
  for (const x of [new Float32Array(SR * 5), new Float32Array(0), new Float32Array(100), [], null, undefined]) {
    const r = key(x);
    assert.equal(r.key, null);
    assert.equal(r.camelot, null);
    assert.equal(r.confidence, 0);
    assert.deepEqual(r.alternates, []);
    assert.equal(r.version, KEY_VERSION);
  }
});

test('noise and drums alone: low confidence, no throw', () => {
  const cases = { white: noise(SR * 30, 0.5), quiet: noise(SR * 10, 0.001, 9), drums: drums(SR * 10),
                  'drums+noise': mix(drums(SR * 10), noise(SR * 10, 0.3, 5)) };
  for (const [name, x] of Object.entries(cases)) {
    const r = key(x);
    assert.ok(r.confidence < 0.2, `${name}: confidence ${r.confidence} for ${r.key}`);
  }
});

test('shape: every field present, confidence in 0..1, three flagged alternates', () => {
  const r = key(progression(54, 'major'));
  assert.deepEqual(Object.keys(r).sort(), ['alternates', 'camelot', 'confidence', 'key', 'mode', 'openKey', 'tonic', 'tuningCents', 'version']);
  assert.equal(r.key, 'F# major');
  assert.equal(r.openKey, '7d');
  assert.equal(r.version, KEY_VERSION);
  assert.ok(r.confidence >= 0 && r.confidence <= 1);
  assert.equal(r.alternates.length, 3);
  for (const a of r.alternates) {
    assert.equal(CAMELOT[a.camelot].key, a.key);
    assert.ok(a.score < 1 && a.score > -1);
    assert.equal(a.relation, relation(r.camelot, a.camelot));
    assert.equal(a.compatible, ['relative', 'fifth-up', 'fifth-down'].includes(a.relation));
  }
  assert.ok(r.alternates.every((a, i) => i === 0 || a.score <= r.alternates[i - 1].score), 'best first');
});

test('scoreKeys ranks all 24 keys, and a plain array input works', () => {
  const ranked = scoreKeys([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]);      // a C major triad
  assert.equal(ranked.length, 24);
  assert.equal(ranked[0].camelot, '8B');
  assert.equal(key(Array.from(progression(57, 'minor', { seconds: 6 }))).camelot, '8A');
});

test('other sample rates: 44.1 kHz input reads the same key', () => {
  const r = key(progression(50, 'minor', { seconds: 6, sampleRate: 44100 }), { sampleRate: 44100 });
  assert.equal(r.key, 'D minor');
});

test('speed: 30 s of 16 kHz audio', () => {
  const x = mix(progression(55, 'major', { seconds: 30 }), drums(SR * 30));
  key(x);                                     // warm the FFT tables
  const t = performance.now();
  const r = key(x);
  const ms = performance.now() - t;
  console.log(`# key() on 30 s at 16 kHz: ${ms.toFixed(0)} ms (${r.key}, confidence ${r.confidence})`);
  assert.equal(r.key, 'G major');
  assert.ok(ms < 5000, `${ms} ms`);
});

// ---------- the Rekordbox comparison script, offline ----------
// The real run needs the owner's files and Deezer; these check its bookkeeping
// with a fake fetch and a fake decoder, so a wrong number can't come from it.

test('comparison script: relations, MIREX weights, confidence bands and the Wilson interval', () => {
  assert.equal(compare('8A', '8A'), 'same');
  assert.equal(compare('8B', '8A'), 'relative');
  assert.equal(compare('9A', '8A'), 'fifth-up');
  assert.equal(compare('3B', '8A'), 'other');
  assert.equal(compare(null, '8A'), 'none');
  const s = summarise([
    { rekordbox: '8A', ours: '8A', confidence: 0.9 },
    { rekordbox: '8A', ours: '8B', confidence: 0.5 },
    { rekordbox: '5B', ours: '6B', confidence: 0.2 },
    { rekordbox: '5B', ours: null, confidence: 0 },
  ]);
  assert.equal(s.n, 4);
  assert.equal(s.exact, 0.25);
  assert.equal(s.compatible, 0.75);
  assert.equal(s.mirex, (1 + 0.3 + 0.5 + 0) / 4);
  assert.deepEqual(s.bands.map(b => [b.n, b.exact]), [[1, 1], [1, 0], [2, 0]]);
  assert.deepEqual(s.byMode.map(m => [m.mode, m.n]), [['minor', 2], ['major', 2]]);
  const [lo, hi] = wilson(80, 100);
  assert.ok(Math.abs(lo - 0.711) < 0.002 && Math.abs(hi - 0.867) < 0.002, `${lo} ${hi}`);
  assert.deepEqual(wilson(0, 0), [0, 0]);
});

test('comparison script: two windows are the first and middle 10 s', () => {
  const x = Float32Array.from({ length: 30 * SR }, (_, i) => i);
  const w = twoWindows(x);
  assert.equal(w.length, 20 * SR);
  assert.equal(w[0], 0);
  assert.equal(w[10 * SR], 10 * SR);            // the middle window of 30 s starts at 10 s
  assert.equal(twoWindows(new Float32Array(5)).length, 5, 'short clips are used whole');
});

test('comparison script: ISRC lookup, identity check and misses, with no network', async () => {
  const samples = progression(57, 'minor', { seconds: 12 });
  const fake = dz => async url => String(url).includes('/track/isrc:')
    ? { ok: true, json: async () => dz } : { ok: true, status: 206, arrayBuffer: async () => new ArrayBuffer(8) };
  const decode = async () => samples;
  const track = { id: 'sp1', isrc: 'GBXXX0000001', duration_ms: 200000 };
  const good = { readable: true, duration: 201, preview: 'https://cdn.example/p.mp3' };

  const r = await analyseTrack(track, { camelot: '8A' }, { fetch: fake(good), decode });
  assert.equal(r.full.camelot, '8A');
  assert.equal(r.full.relation, 'same');
  assert.equal(r.windows.camelot, '8A');
  assert.ok(!JSON.stringify(r).includes('cdn.example'), 'the preview URL is never kept');

  const miss = async (t, dz, opts = {}) => (await analyseTrack(t, { camelot: '8A' }, { fetch: fake(dz), decode, ...opts })).miss;
  assert.equal(await miss({ id: 'x' }, good), 'no-isrc');
  assert.equal(await miss(track, { error: { code: 800 } }), 'not-on-deezer');
  assert.equal(await miss(track, { ...good, readable: false }), 'not-readable');
  assert.equal(await miss(track, { ...good, preview: '' }), 'no-preview');
  assert.equal(await miss(track, { ...good, duration: 190 }), 'duration-mismatch');
  assert.equal(await miss(track, good, { decode: async () => { throw new Error('bad mp3'); } }), 'decode-failed');
  assert.equal(await miss(track, good, { fetch: async () => { throw new Error('offline'); } }), 'lookup-failed');
});
