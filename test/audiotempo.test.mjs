import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempo, tempoFromMel, TEMPO_VERSION, OCTAVE_AMBIGUOUS } from '../core/audio/dsp/tempo.mjs';
import { melFrames, SAMPLE_RATE as SR } from '../core/audio/mel.mjs';

// Synthetic drum tracks, deterministic (seeded PRNG), 16 kHz mono.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const put = (out, at, n, f) => { for (let i = 0; i < n && at + i < out.length; i++) if (at + i >= 0) out[at + i] += f(i, i / SR); };
const click = (o, at) => { const r = rng(1); put(o, at, 160, i => (r() * 2 - 1) * Math.exp(-i / 32)); };
const kick = (o, at, g = 1) => { let ph = 0; put(o, at, 3200, (i, t) => { ph += 2 * Math.PI * (50 + 100 * Math.exp(-t / 0.03)) / SR; return g * Math.sin(ph) * Math.exp(-t / 0.08); }); };
const hat = (o, at, g = 0.3) => { const r = rng(7); let prev = 0; put(o, at, 640, i => { const w = r() * 2 - 1, hp = w - prev; prev = w; return g * hp * Math.exp(-i / 128); }); };
const snare = (o, at, g = 0.6) => { const r = rng(9); put(o, at, 1920, (i, t) => g * ((r() * 2 - 1) * 0.7 + 0.3 * Math.sin(2 * Math.PI * 190 * t)) * Math.exp(-t / 0.04)); };
const noise = (o, g, seed = 3) => { const r = rng(seed); for (let i = 0; i < o.length; i++) o[i] += g * (r() * 2 - 1); return o; };

/** place(out, beat, at) is called per beat; at(t) maps beat time t to a sample index. */
function track(bpm, seconds, place, { jitter = 0, seed = 5 } = {}) {
  const out = new Float32Array(Math.round(seconds * SR)), r = rng(seed), P = 60 / bpm;
  for (let b = 0; 0.1 + b * P < seconds; b++)
    place(out, b, t => Math.round((0.1 + t * P + (jitter ? (r() * 2 - 1) * jitter : 0)) * SR));
  return out;
}
const clicks = bpm => track(bpm, 30, (o, b, at) => click(o, at(b)));
const kicks = bpm => track(bpm, 30, (o, b, at) => kick(o, at(b)));
const offHats = (bpm, opts) => track(bpm, 30, (o, b, at) => { kick(o, at(b)); hat(o, at(b + 0.5)); }, opts);

// The policy, exactly: right within ±1 BPM; or, when flagged octaveAmbiguous,
// the answer is the true tempo's ×2 or ×½ and the true tempo is among the
// alternates within ±1. Anything else (a 3:2 error, an unflagged octave
// error, a flagged miss without the truth listed) fails.
function right(r, truth) {
  if (r.bpm != null && Math.abs(r.bpm - truth) <= 1) return 'exact';
  if (!r.octaveAmbiguous || r.bpm == null) return false;
  const octave = [truth * 2, truth / 2].some(o => Math.abs(r.bpm - o) <= 2);
  return octave && r.alternates.some(a => Math.abs(a.bpm - truth) <= 1) ? 'octave-flagged' : false;
}
const policy = (r, truth) => assert.ok(right(r, truth), `truth ${truth}: ${JSON.stringify(r)}`);

test('result shape and version', () => {
  const r = tempo(kicks(120));
  assert.deepEqual(Object.keys(r).sort(), ['alternates', 'bpm', 'confidence', 'octaveAmbiguous', 'version']);
  assert.equal(r.version, TEMPO_VERSION);
  assert.ok(r.confidence >= 0 && r.confidence <= 1);
  for (const a of r.alternates) assert.ok(a.bpm >= 60 && a.bpm <= 200 && a.score > 0 && a.score <= 1, JSON.stringify(a));
});

// The common tempi come out exact and unflagged; 174 (and only near the top
// of the range) is allowed to be flagged, per the policy above.
for (const bpm of [70, 90, 120, 128, 140]) {
  test(`click track at ${bpm} BPM: exact within ±1, not flagged`, () => {
    const r = tempo(clicks(bpm));
    assert.ok(Math.abs(r.bpm - bpm) <= 1, JSON.stringify(r));
    assert.equal(r.octaveAmbiguous, false);
    assert.ok(r.confidence > 0.5, `confidence ${r.confidence}`);
  });
  test(`kick track at ${bpm} BPM: exact within ±1, not flagged`, () => {
    const r = tempo(kicks(bpm));
    assert.ok(Math.abs(r.bpm - bpm) <= 1, JSON.stringify(r));
    assert.equal(r.octaveAmbiguous, false);
  });
}

test('174 BPM clicks and kicks follow the policy, and 87 is listed', () => {
  for (const x of [clicks(174), kicks(174)]) {
    const r = tempo(x);
    policy(r, 174);
    assert.ok(r.alternates.some(a => Math.abs(a.bpm - 87) <= 1), JSON.stringify(r));
  }
});

test('kick with off-beat hats is the kick tempo, not 2/3 of it or the hat pulse', () => {
  for (const bpm of [120, 128, 140]) {
    const r = tempo(offHats(bpm));
    assert.ok(Math.abs(r.bpm - bpm) <= 1, `${bpm}: ${JSON.stringify(r)}`);
    assert.equal(r.octaveAmbiguous, false);
  }
});

test('swung hats (triplet feel) keep the beat', () => {
  for (const bpm of [96, 100, 110]) {
    const r = tempo(track(bpm, 30, (o, b, at) => { kick(o, at(b)); hat(o, at(b), 0.2); hat(o, at(b + 2 / 3)); }));
    assert.ok(Math.abs(r.bpm - bpm) <= 1, `${bpm}: ${JSON.stringify(r)}`);
  }
});

test('timing jitter (±12 ms) under a noise floor still lands within ±1 BPM', () => {
  for (const bpm of [125, 174]) {
    const r = tempo(noise(offHats(bpm, { jitter: 0.012 }), 0.05));
    assert.ok(Math.abs(r.bpm - bpm) <= 1, `${bpm}: ${JSON.stringify(r)}`);
  }
});

test('half-time patterns are reported as octave-ambiguous with both tempi listed', () => {
  // DnB-ish 174: kick on 1 and the "and" of 3, snare on 2 and 4, 8th hats.
  const dnb = tempo(track(174, 30, (o, b, at) => {
    if (b % 4 === 0) kick(o, at(b));
    if (b % 4 === 2) kick(o, at(b + 0.5));
    if (b % 2 === 1) snare(o, at(b));
    hat(o, at(b), 0.15); hat(o, at(b + 0.5), 0.15);
  }));
  // Hip-hop 85: kick and snare alternate, 8th hats.
  const hiphop = tempo(track(85, 30, (o, b, at) => {
    (b % 2 === 0 ? kick : snare)(o, at(b));
    hat(o, at(b), 0.15); hat(o, at(b + 0.5), 0.15);
  }));
  for (const [r, truth] of [[dnb, 174], [hiphop, 85]]) {
    policy(r, truth);
    assert.equal(r.octaveAmbiguous, true, JSON.stringify(r));
    const all = [r.bpm, ...r.alternates.map(a => a.bpm)];
    for (const t of [truth, truth === 174 ? 87 : 170]) assert.ok(all.some(b => Math.abs(b - t) <= 1), `${t} in ${all}`);
    const partner = r.alternates.find(a => Math.abs(a.bpm - r.bpm * 2) <= 2 || Math.abs(a.bpm - r.bpm / 2) <= 1);
    assert.ok(partner.score >= OCTAVE_AMBIGUOUS, JSON.stringify(r));
    assert.ok(r.confidence < 0.75, 'an ambiguous answer is not a confident one');
  }
});

test('sweep 60–200 BPM: every case passes the policy, octave errors are always flagged', () => {
  let exact = 0, flaggedOctave = 0, n = 0, worst = 0;
  for (let bpm = 60; bpm <= 200; bpm += 3.7) {
    for (const x of [kicks(bpm), offHats(bpm), noise(offHats(bpm, { jitter: 0.01, seed: Math.round(bpm * 10) }), 0.05)]) {
      const r = tempo(x), how = right(r, bpm);
      n++;
      assert.ok(how, `${bpm.toFixed(2)}: ${JSON.stringify(r)}`);
      if (how === 'exact') { exact++; worst = Math.max(worst, Math.abs(r.bpm - bpm)); } else flaggedOctave++;
    }
  }
  console.log(`  tempo sweep: ${n} tracks, ${exact} exact (worst error ${worst.toFixed(2)} BPM), ${flaggedOctave} flagged octave`);
  assert.ok(exact / n >= 0.95, `${exact}/${n} exact`);
});

test('silence: bpm null, confidence 0', () => {
  for (const x of [new Float32Array(30 * SR), new Float32Array(30 * SR).fill(1e-6)]) {
    assert.deepEqual(tempo(x), { bpm: null, confidence: 0, alternates: [], octaveAmbiguous: false, version: TEMPO_VERSION });
  }
});

test('white noise has no beat: bpm null, confidence 0', () => {
  const r = tempo(noise(new Float32Array(30 * SR), 0.3));
  assert.equal(r.bpm, null);
  assert.equal(r.confidence, 0);
});

test('too short to judge (under 4 s): no answer', () => {
  assert.equal(tempo(kicks(120).subarray(0, 3 * SR)).bpm, null);
  assert.ok(Math.abs(tempo(kicks(120).subarray(0, 10 * SR)).bpm - 120) <= 1, '10 s windows still work');
});

test('tempoFromMel on existing frames gives the same answer as tempo()', () => {
  const x = offHats(128);
  assert.deepEqual(tempoFromMel(melFrames(x)), tempo(x));
});

test('other sample rates are resampled', () => {
  const sr = 44100, bpm = 128, out = new Float32Array(30 * sr);
  for (let t = 0.1; t < 30; t += 60 / bpm) {
    const at = Math.round(t * sr);
    for (let i = 0; i < 0.2 * sr && at + i < out.length; i++) out[at + i] += Math.sin(2 * Math.PI * 60 * i / sr) * Math.exp(-i / (0.08 * sr));
  }
  assert.ok(Math.abs(tempo(out, { sampleRate: sr }).bpm - bpm) <= 1);
});

test('min/max bound the answer', () => {
  const r = tempo(clicks(174), { min: 70, max: 140 });
  assert.ok(Math.abs(r.bpm - 87) <= 1, JSON.stringify(r));
  for (const a of r.alternates) assert.ok(a.bpm >= 70 && a.bpm <= 140);
  assert.throws(() => tempo(clicks(120), { min: 150, max: 100 }), RangeError);
});

test('speed: 30 s of audio', () => {
  const x = offHats(128);
  tempo(x); // warm-up
  const t0 = performance.now(), runs = 5;
  for (let i = 0; i < runs; i++) tempo(x);
  const ms = (performance.now() - t0) / runs;
  const t1 = performance.now();
  const mel = melFrames(x);
  const melMs = performance.now() - t1;
  const t2 = performance.now();
  tempoFromMel(mel);
  console.log(`  tempo: ${ms.toFixed(1)} ms per 30 s (mel ${melMs.toFixed(1)} ms + tempo from mel ${(performance.now() - t2).toFixed(1)} ms)`);
  assert.ok(ms < 2000, `${ms} ms`);
});
