import { test } from 'node:test';
import assert from 'node:assert/strict';

import { topOf, sourceTops, agreement, levelOf, withAgreement, tagTopsOf, srcByIdOf, agreeLine,
         SOURCES, LEVELS } from '../core/intrinsic/agree.mjs';
import { fitCalibration, decide, calibrationReport, AGREE_GATE } from '../core/intrinsic/calibrate.mjs';
import { decideCard } from '../core/intrinsic/family.mjs';
import { placementAccuracy } from '../core/validate/loo.mjs';
import { fixture } from './fixtures/engine-library.mjs';

/* Deterministic pseudo-random, so the synthetic rows are the same every run. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9 >>> 0) / 2 ** 32);
}

test('a source with no positive score, or no spread, says nothing', () => {
  assert.equal(topOf([['a', 0], ['b', 0]]), null);
  assert.equal(topOf([['a', 0.3], ['b', 0.3]]), null);
  assert.deepEqual(topOf([['a', 0.1], ['b', 0.5], ['c', 0.3], ['d', 0.2]]), ['b', 'c', 'd']);
  assert.deepEqual(topOf(new Map([['a', 0.4]])), ['a']);
});

test('sources are read from the parts a placement carries', () => {
  const results = [
    { playlistId: 'a', parts: { graph: 0.6, era: 0.9, learned: 0.1, audio: 0.2 } },
    { playlistId: 'b', parts: { graph: 0.2, era: 0.9, learned: 0.9, audio: 0.8 } },
    { playlistId: 'c', parts: { graph: 0.0, era: 0.9, learned: 0.5, audio: 0.4 } },
  ];
  const s = sourceTops(results, { tags: [['c', 3], ['a', 1]] });
  assert.deepEqual(s.history, ['a', 'b', 'c']);
  assert.deepEqual(s.sound, ['b', 'c', 'a']);
  assert.deepEqual(s.tags, ['c', 'a']);
  assert.equal(s.similar, undefined, 'no bridge part, no similar source');
  // An unheard track in a space without a bridge: history only.
  assert.deepEqual(Object.keys(sourceTops([{ playlistId: 'a', parts: { graph: 0.3 } }, { playlistId: 'b', parts: { graph: 0.1 } }])), ['history']);
});

test('levels: two sources first and none against is agree; one is single; any against is split', () => {
  assert.deepEqual(SOURCES, ['sound', 'history', 'similar', 'tags']);
  assert.deepEqual(LEVELS, ['agree', 'single', 'split']);
  assert.equal(agreement('a', { sound: ['a', 'b'], history: ['a'], tags: ['b', 'a'] }).level, 'agree');
  assert.equal(agreement('a', { sound: ['a', 'b'], history: ['b', 'a'] }).level, 'single');
  const x = agreement('a', { sound: ['a'], history: ['a'], tags: ['b', 'c', 'd'] });
  assert.equal(x.level, 'split');
  assert.deepEqual(x.against, ['tags']);
  assert.equal(agreement('a', {}).level, 'split', 'nothing vouches for it');
  assert.equal(agreement(null, { sound: ['a'] }).level, 'split');
  assert.equal(levelOf([['a', 0.5], ['b', 0.1]], { sound: ['a'], tags: ['a'] }), 'agree');
});

test('withAgreement joins sources by id, adds tags, drops what the live card will not have', () => {
  const rows = [{ id: 't1', scores: [['a', 0.5], ['b', 0.2]], truth: ['a'] }];
  const src = srcByIdOf([{ id: 't1', src: { history: ['a'] } }], [{ id: 't1', src: { similar: ['a'] } }]);
  assert.deepEqual(src, { t1: { history: ['a'], similar: ['a'] } });
  assert.equal(withAgreement(rows, src)[0].agree, 'agree');
  assert.equal(withAgreement(rows, src, null, { drop: ['similar'] })[0].agree, 'single');
  assert.equal(withAgreement(rows, src, tagTopsOf([{ id: 't1', scores: [['c', 2], ['d', 1], ['e', 0.5], ['a', 0.1]] }]))[0].agree, 'split');
  assert.equal(rows[0].agree, undefined, 'rows are copied, never changed');
});

/**
 * Held-out rows where the combined margin is weak for everybody, but on the
 * cards where the sources agree the lead is nearly always right: the
 * situation package 4 exists for. `agreeRight` is how often an agreeing card
 * is right.
 */
function agreeRows(n, { agreeShare = 0.35, agreeRight = 0.98, seed = 3 } = {}) {
  const r = rng(seed), out = [];
  const P = ['a', 'b', 'c', 'd', 'e', 'f'];
  for (let i = 0; i < n; i++) {
    const lead = P[Math.floor(r() * P.length)];
    const second = P.filter(p => p !== lead)[Math.floor(r() * 5)];
    const scores = P.map(p => [p, 0.2 + r() * 0.02]);
    scores.find(x => x[0] === lead)[1] = 0.32 + r() * 0.02;
    scores.find(x => x[0] === second)[1] = 0.30 + r() * 0.02;
    scores.sort((x, y) => y[1] - x[1]);
    const agrees = r() < agreeShare;
    const right = agrees ? r() < agreeRight : r() < 0.5;
    const top = scores[0][0];
    out.push({ id: `t${i}`, scores, truth: [right ? top : scores[1][0]], agree: agrees ? 'agree' : 'split' });
  }
  return out;
}

test('a level that is right often enough earns its own confident; margin alone earns nothing', () => {
  const rows = agreeRows(800);
  const { byLevel, ...plain } = fitCalibration(rows);
  assert.equal(plain.tau, null, 'the margin alone never gets to 90% here');
  assert.ok(byLevel?.agree, 'the agreeing cards earn a threshold of their own');
  assert.equal(byLevel.split, undefined, 'split never gets one');
  const cal = fitCalibration(rows);
  const s = rows.find(x => x.agree === 'agree').scores;
  assert.equal(decide(s, cal).kind === 'confident', false, 'without the level, the old answer');
  const d = decide(s, cal, { agree: 'agree' });
  if (d.kind === 'confident') assert.equal(d.via, 'agree');
  assert.notEqual(decide(s, cal, { agree: 'split' }).via, 'agree');
});

test('the report checks agreement-earned Sure on held-out rows and keeps it only past the gate', () => {
  const good = calibrationReport(agreeRows(1200, { agreeRight: 0.99 }));
  assert.ok(good.agree, 'a report on rows with levels carries the agreement summary');
  assert.equal(good.agree.use, true, JSON.stringify(good.agree));
  assert.ok(good.agree.right >= AGREE_GATE.minPrecision);
  assert.ok(good.agree.share >= 0.25, `coverage ${good.agree.share}`);
  assert.ok(good.cal.byLevel?.agree, 'the calibration handed back can use it');
  assert.match(agreeLine(good), /^Sure when sources agree: \d+% of cards, right \d+% of \d+ held out\.$/);

  // Agreeing cards that are right only 85% of the time: the fit may find a
  // threshold, but the held-out check refuses it and the calibration is the
  // old one, byte for byte.
  const weak = agreeRows(1200, { agreeRight: 0.85 });
  const bad = calibrationReport(weak);
  assert.equal(bad.agree.use, false);
  assert.equal(bad.cal.byLevel, undefined);
  const stripped = calibrationReport(weak.map(({ agree, ...r }) => r));
  assert.deepEqual(bad.cal, stripped.cal);
  assert.deepEqual(bad.checked, stripped.checked);
  assert.match(agreeLine(bad), /^Sure when sources agree: not used yet \(.+\)\.$/);
});

test('rows without levels report exactly as before', () => {
  const rows = agreeRows(300).map(({ agree, ...r }) => r);
  const rep = calibrationReport(rows);
  assert.equal(rep.agree, undefined);
  assert.equal(rep.cal.byLevel, undefined);
});

test('the family card passes the level through', () => {
  const rows = agreeRows(1200, { agreeRight: 0.99 });
  const cal = calibrationReport(rows).cal;
  const s = rows.filter(x => x.agree === 'agree').map(x => x.scores)
    .find(sc => decide(sc, cal, { agree: 'agree' }).kind === 'confident');
  assert.ok(s, 'some agreeing card is confident');
  const fams = new Map(['a', 'b', 'c', 'd', 'e', 'f'].map(id => [id, id < 'd' ? 'x' : 'y']));
  assert.equal(decideCard(s, cal, null, fams, { agree: 'agree' }).kind, 'sure');
  assert.notEqual(decideCard(s, cal, null, fams).kind, 'sure');
});

test('the Score harness puts each row\'s own sources on it', () => {
  const acc = placementAccuracy(fixture(), { collect: true, sources: true });
  assert.equal(placementAccuracy(fixture(), { collect: true }).rows[0].src, undefined, 'off by default: rows as before');
  assert.ok(acc.rows.length > 0);
  for (const r of acc.rows) {
    assert.ok(r.src && typeof r.src === 'object');
    for (const k of Object.keys(r.src)) assert.ok(['history', 'similar', 'sound'].includes(k), k);
    assert.equal(r.src.sound, undefined, 'the headline engine has no sound in its parts');
  }
  assert.ok(acc.rows.some(r => r.src.history?.length), 'filing history speaks for some tracks');
});
