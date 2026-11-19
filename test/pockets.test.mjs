import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fitCalibration, decide, calibrationReport, pocketKeys, withPockets, sizeBand, pocketLabel, pocketsLine,
         POCKET_GATE } from '../core/intrinsic/calibrate.mjs';
import { decideCard, familyAccuracy } from '../core/intrinsic/family.mjs';

/* Build 8 I2: "Sure" earned in pockets, not by one global threshold. */

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9 >>> 0) / 2 ** 32);
}
const P = ['a', 'b', 'c', 'd', 'e', 'f'];
const FAM = new Map(P.map(id => [id, id < 'd' ? 'x' : 'y']));

/** Rows whose margins look the same everywhere; only the pocket knows how often the lead is right. */
function rows(n, { filedShare = 0.4, filedRight = 0.99, freshRight = 0.5, seed = 5 } = {}) {
  const r = rng(seed), out = [];
  for (let i = 0; i < n; i++) {
    const lead = P[Math.floor(r() * P.length)];
    const second = P.filter(p => p !== lead)[Math.floor(r() * 5)];
    const scores = P.map(p => [p, 0.2 + r() * 0.02]);
    scores.find(x => x[0] === lead)[1] = 0.32 + r() * 0.02;
    scores.find(x => x[0] === second)[1] = 0.30 + r() * 0.02;
    scores.sort((x, y) => y[1] - x[1]);
    const filed = r() < filedShare;
    const right = r() < (filed ? filedRight : freshRight);
    out.push({ id: `t${i}`, scores, truth: [right ? scores[0][0] : scores[1][0]], filed });
  }
  return out;
}
const pocketed = rs => {
  const filedById = new Map(rs.map(r => [r.id, r.filed]));
  return withPockets(rs, { fresh: id => !filedById.get(id), famOf: id => FAM.get(id), sizeOf: () => 40 });
};
const strip = rs => rs.map(({ pockets, ...r }) => r);

test('pocket keys name situation, family, size and agreement within a situation, most specific first', () => {
  assert.deepEqual(pocketKeys({ sit: 'fresh', fam: 'Drum & bass', size: 'small', agree: 'agree' }),
    ['agree:agree|sit:fresh', 'fam:Drum & bass', 'size:small', 'sit:fresh']);
  assert.deepEqual(pocketKeys({ sit: 'filed', agree: 'split' }), ['sit:filed']);
  assert.deepEqual(pocketKeys({}), []);
  assert.equal(sizeBand(10), 'small'); assert.equal(sizeBand(40), 'mid'); assert.equal(sizeBand(200), 'large');
});

test('withPockets reads the lead playlist and the track, never the answer; rows are copied', () => {
  const rs = [{ id: 't', scores: [['a', 0.5], ['d', 0.1]], truth: ['d'], agree: 'agree' }];
  const out = withPockets(rs, { fresh: () => true, famOf: id => FAM.get(id), sizeOf: id => (id === 'a' ? 12 : 99) });
  assert.deepEqual(out[0].pockets, ['agree:agree|sit:fresh', 'fam:x', 'size:small', 'sit:fresh']);
  assert.equal(rs[0].pockets, undefined);
});

test('a pocket earns its own threshold where the whole population does not', () => {
  const rs = pocketed(rows(900));
  const plain = fitCalibration(strip(rs));
  assert.equal(plain.tau, null, 'one global threshold earns nothing on the mixed population');
  const cal = fitCalibration(rs);
  assert.ok(cal.pockets?.['sit:filed'], JSON.stringify(cal.pockets));
  assert.equal(cal.pockets['sit:fresh'], undefined, 'the coin-flip pocket earns nothing');
  const s = rs.find(r => r.pockets.includes('sit:filed')).scores;
  assert.notEqual(decide(s, cal).kind, 'confident', 'without the pocket keys the card is not Sure');
  const d = decide(s, cal, { pockets: ['sit:filed'] });
  assert.equal(d.kind, 'confident');
  assert.equal(d.via, 'pocket');
});

test('the gate passes: held-out Sure at >= 95% on >= 25% of tracks, with and without numbers', () => {
  const rs = pocketed(rows(1200));
  const without = calibrationReport(strip(rs));
  const rep = calibrationReport(rs);
  assert.equal(rep.pockets.use, true, JSON.stringify(rep.pockets));
  assert.ok(rep.pockets.right >= POCKET_GATE.minPrecision, `precision ${rep.pockets.right}`);
  assert.ok(rep.pockets.share >= POCKET_GATE.coverage, `coverage ${rep.pockets.share}`);
  assert.ok(rep.pockets.keys.some(k => k.key === 'sit:filed' && k.n >= POCKET_GATE.minN));
  assert.ok(rep.cal.pockets, 'the calibration handed back can use it');
  assert.equal(without.checked.confidentN, 0, 'without pockets: nothing is Sure');
  assert.ok(rep.checked.confidentShare > (without.checked.confidentShare ?? 0));
  console.log(`# I2 fixture: Sure without pockets ${without.checked.confidentShare ?? 0} of tracks; with pockets `
    + `${rep.pockets.share} at ${rep.pockets.right} (n ${rep.pockets.n})`);
});

test('the gate fails both ways: too imprecise and too narrow, and the calibration is then the old one', () => {
  // Pocket right only 85%: no pocket is held out at 95%.
  const weak = pocketed(rows(1200, { filedRight: 0.85 }));
  const w = calibrationReport(weak);
  assert.equal(w.pockets.use, false);
  assert.equal(w.cal.pockets, undefined);
  assert.deepEqual(w.cal, calibrationReport(strip(weak)).cal, 'byte for byte the old calibration');
  assert.deepEqual(w.checked, calibrationReport(strip(weak)).checked);
  // Precise but only 10% of tracks: honest, yet under the 25% bar, so it stays off and says how close.
  const narrow = pocketed(rows(1500, { filedShare: 0.1 }));
  const nr = calibrationReport(narrow);
  assert.equal(nr.pockets.use, false);
  assert.match(nr.pockets.why, /of tracks, 25% needed/);
  assert.equal(nr.cal.pockets, undefined);
  assert.match(pocketsLine(nr), /^Sure earned: none yet \(.+\)\.( Closest: \d+% of tracks at \d+%\.)?$/);
});

test('a pocket with fewer than the minimum held-out tracks keeps "not earned"', () => {
  const tiny = pocketed(rows(60, { filedShare: 0.2 }));
  const cal = fitCalibration(tiny);
  assert.equal(cal.pockets?.['sit:filed'], undefined);
  assert.equal(calibrationReport(tiny).pockets.use, false);
});

test('rows without pockets report exactly as before', () => {
  const rep = calibrationReport(strip(pocketed(rows(300))));
  assert.equal(rep.pockets, undefined);
  assert.equal(rep.cal.pockets, undefined);
});

test('the report line names the pockets, the share and the precision', () => {
  const rep = calibrationReport(pocketed(rows(1200)));
  const line = pocketsLine(rep);
  assert.match(line, /^Sure earned: pockets filed artists.* — \d+% of tracks at \d+%\.$/);
  assert.equal(pocketsLine({}), '');
  assert.equal(pocketLabel('agree:agree|sit:fresh'), 'sources agree, never-filed artists');
  assert.equal(pocketLabel('fam:Drum & bass'), 'Drum & bass');
});

test('family cards: situation pockets carry to the family level, and Sure still only names playlists', () => {
  const fr = familyAccuracy(pocketed(rows(900)), FAM);
  assert.ok(fr.rows.every(r => !r.pockets || r.pockets.every(k => k.startsWith('sit:') || k.includes('|sit:'))));
  const cal = calibrationReport(pocketed(rows(1200))).cal;
  const s = rows(50)[0].scores;
  const dc = decideCard(s, cal, null, FAM, { pockets: ['sit:filed'] });
  assert.equal(dc.kind, 'sure');
  assert.ok(Array.isArray(dc.playlists), 'a card names playlists; it never files by itself');
});
