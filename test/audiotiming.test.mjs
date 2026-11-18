import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTimer, timeDeps, summariseTimings, timingLine, deviceClass, timingReportLines, TIMING_KEEP } from '../core/audio/timing.mjs';
import { hearingFunnel, funnelText, funnelLines, funnelStages } from '../core/audio/funnel.mjs';
import { MISS } from '../core/audio/record.mjs';

/** A clock the fakes advance, so stage times are exact. */
const clock = () => { let t = 0; return { now: () => t, tick: ms => { t += ms; } }; };

test('timeDeps times each stage and leaves results and the original deps alone', async () => {
  const c = clock();
  const timer = createTimer({ now: c.now });
  const deps = {
    lookup: async () => { c.tick(300); return { previewUrl: 'u' }; },
    fetchPreview: async () => { c.tick(600); return { buffers: [1] }; },
    decode: async () => { c.tick(100); return 'pcm'; },
    ear: { run: async () => { c.tick(800); return 'out'; }, other: 5 },
    dsp: async () => { c.tick(40); return { bpm: 120 }; },
  };
  const orig = deps.lookup;
  const timed = timeDeps(deps, timer);
  assert.equal(deps.lookup, orig, 'originals untouched');
  assert.equal(timed.ear.other, 5, 'other members kept');
  assert.deepEqual(await timed.lookup(), { previewUrl: 'u' }, 'results unchanged');
  await timed.fetchPreview(); await timed.decode(); await timed.ear.run(); await timed.dsp();
  assert.deepEqual(timer.finish('track'), { lookup: 300, download: 600, decode: 100, model: 800, dsp: 40 });
  assert.equal(timer.snapshot().track.length, 1);
  assert.equal(timer.finish('track'), null, 'an empty sample is dropped');
});

test('a thrown stage still counts its time and still throws', async () => {
  const c = clock();
  const timer = createTimer({ now: c.now });
  const f = timer.wrap('download', async () => { c.tick(50); throw new Error('boom'); });
  await assert.rejects(f, /boom/);
  assert.equal(timer.finish('topup').download, 50);
});

test('summary: medians per stage, tracks a minute, rolling window, seed', async () => {
  const s = [{ lookup: 400, download: 600, model: 1000 }, { lookup: 500, download: 700, model: 1000 }, { lookup: 600, download: 800, model: 1400 }];
  const sum = summariseTimings(s);
  assert.deepEqual(sum.ms, { lookup: 500, download: 700, decode: 0, model: 1000, dsp: 0 });
  assert.equal(sum.total, 2200); assert.equal(sum.perMin, 27.3); assert.equal(sum.n, 3);
  assert.equal(summariseTimings([]).perMin, 0);
  assert.equal(timingLine(s.slice(0, 2)), '', 'too few samples: no line');
  assert.equal(timingLine(s), 'about 2.2 s a track (27 a minute): 1.2 s waiting for Deezer, 1.0 s hearing');
  const c = clock(), t = createTimer({ now: c.now, seed: { track: s } });
  assert.equal(t.snapshot().track.length, 3);
  const w = t.wrap('lookup', async () => c.tick(10));
  for (let i = 0; i < TIMING_KEEP + 5; i++) { await w(); t.finish('track'); }
  assert.equal(t.snapshot().track.length, TIMING_KEEP);
  assert.equal(createTimer({ seed: { track: [{ junk: 1 }, 'x', null] } }).snapshot().track.length, 0, 'bad seed ignored');
  assert.match(timingReportLines({ track: s }, 'computer, 8 cores')[0], /^Listening speed \(computer, 8 cores\): 2\.2 s each, 27\.3 a minute, over 3; lookup 0\.5 s/);
  assert.deepEqual(timingReportLines({}), []);
});

test('deviceClass', () => {
  assert.equal(deviceClass({ hardwareConcurrency: 8, deviceMemory: 16, mobile: false }), 'computer, 8 cores, 16 GB memory');
  assert.equal(deviceClass({ mobile: true }), 'phone or tablet');
});

test('funnel counts every stage and each miss reason', () => {
  const tracks = [
    ...['h1', 'h2', 'h3'].map(id => ({ id, isrc: 'I' + id })),
    { id: 'nd', isrc: 'I' }, { id: 'np', isrc: 'I' }, { id: 'np2', isrc: 'I' }, { id: 'idn', isrc: 'I' }, { id: 'ts', isrc: 'I' },
    { id: 'noisrc' }, { id: 'noisrc2', isrc: null },
    { id: 'new', isrc: 'I' }, { id: 'h1', isrc: 'Ih1' },
  ];
  const rec = new Map([
    ['h1', { id: 'h1' }], ['h2', { id: 'h2' }], ['h3', { id: 'h3' }],
    ['nd', { id: 'nd', miss: MISS.NOT_ON_DEEZER }], ['np', { id: 'np', miss: MISS.NO_PREVIEW }], ['np2', { id: 'np2', miss: MISS.NO_PREVIEW }],
    ['idn', { id: 'idn', miss: MISS.IDENTITY }], ['ts', { id: 'ts', miss: MISS.TOO_SHORT }],
    ['noisrc2', { id: 'noisrc2', miss: MISS.NO_ISRC }], ['elsewhere', { id: 'elsewhere' }],
  ]);
  const f = hearingFunnel(tracks, rec);
  assert.equal(f.total, 11, 'duplicates once, other records ignored');
  assert.equal(f.heard, 3);
  assert.equal(f.withIsrc, 9); assert.equal(f.waiting, 1);
  assert.equal(f.onDeezer, 7); assert.equal(f.hasPreview, 4); assert.equal(f.downloaded, 4);
  assert.deepEqual(f.misses, { [MISS.NO_ISRC]: 2, [MISS.NOT_ON_DEEZER]: 1, [MISS.NO_PREVIEW]: 2, [MISS.IDENTITY]: 1, [MISS.TOO_SHORT]: 1 });
  assert.equal(funnelText(f), 'Heard 3 of 11. Not on Deezer 1, no preview 2, a different version 1, too short 1, no ISRC 2, not tried yet 1.');
  assert.equal(funnelStages(f).length, 6);
  assert.match(funnelLines(f)[1], /biggest miss \(2\)/);
});

test('funnel with nothing heard or an empty library says so', () => {
  assert.equal(funnelText(hearingFunnel([], new Map())), 'Nothing heard yet.');
  assert.equal(funnelText(hearingFunnel([{ id: 'a', isrc: 'I' }], null)), 'Nothing heard yet. Not tried yet 1.');
  assert.equal(funnelText(hearingFunnel([{ id: 'a', isrc: 'I' }], new Map([['a', { id: 'a' }]]))), 'Heard 1 of 1.');
});
