// Family first, then sub-genre (core/intrinsic/family.mjs, ENGINE-REVIEW layer 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { playlistFamilies, conceptsIn, familyRow, familyAccuracy, familyInUse, fitFamilyCalibration,
         decideCard, FAMILY_GATE, FAMILY_CONFIDENT_GATE, familyGate } from '../core/intrinsic/family.mjs';
import { fitCalibration, calibrationReport } from '../core/intrinsic/calibrate.mjs';
import { familyLine } from '../web/screens/engine.mjs';

const NAMES = [['rol', 'Rollers'], ['jun', 'D&B Jungle Alarms'], ['ukg', 'UKG'], ['bas', 'Bassline'],
               ['tec', 'Techno'], ['dh', 'Dancehall Emma'], ['lnh', 'Late Night House Emma'], ['gym', 'Gym']];
const FAM = playlistFamilies(NAMES);

test('a playlist’s family is the genre its name names, at the level a person calls the genre', () => {
  assert.equal(FAM.get('rol'), 'drum-and-bass');
  assert.equal(FAM.get('jun'), 'drum-and-bass');
  assert.equal(FAM.get('ukg'), 'uk-garage');
  assert.equal(FAM.get('bas'), 'uk-garage');
  assert.equal(FAM.get('lnh'), 'house', 'a phrase inside a longer name is found');
  assert.equal(FAM.get('gym'), 'own:gym', 'no genre in the name: a family of its own');
  assert.equal(playlistFamilies([['x', 'House & Garage']]).get('x'), 'own:x', 'two families named: merged with neither');
  assert.deepEqual(conceptsIn(''), []);
});

test('familyRow sums each family’s playlists, highest first, and maps the truth', () => {
  const r = familyRow({ scores: [['rol', 2], ['jun', 1.9], ['tec', 1]], truth: ['jun'] }, FAM, 1);
  assert.equal(r.fams[0][0], 'drum-and-bass');
  assert.ok(Math.abs(r.fams.reduce((s, [, p]) => s + p, 0) - 1) < 1e-9);
  assert.deepEqual(r.truth, ['drum-and-bass']);
});

/** Rows where the family is easy and the sub-genre a coin flip, like the owner's confusions. */
function rows(n = 400) {
  const out = []; let s = 7;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const pairs = [['rol', 'jun'], ['ukg', 'bas']];
  for (let i = 0; i < n; i++) {
    const [a, b] = pairs[i % 2], truth = rnd() < 0.5 ? a : b, other = truth === a ? b : a;
    const swap = rnd() < 0.45;
    const lead = swap ? other : truth, second = swap ? truth : other;
    out.push({ id: `t${i}`, truth: [truth],
               scores: [[lead, 3 + rnd() * 0.2], [second, 2.9 + rnd() * 0.2], ['tec', 1 + rnd()], ['dh', 0.5]].sort((x, y) => y[1] - x[1]) });
  }
  return out;
}

test('familyAccuracy: family right far more often than the flat pick, and family "confident" is earned', () => {
  const acc = familyAccuracy(rows(), FAM, { report: calibrationReport });
  assert.ok(acc.family > 0.95, `family ${acc.family}`);
  assert.ok(acc.flat < 0.7, `flat ${acc.flat}`);
  assert.ok(acc.within > 0.4 && acc.within < 0.7);
  assert.equal(acc.families, new Set(FAM.values()).size);
  assert.ok(acc.sure.checked.confidentN > 0, 'family-level confident is checked on held-out rows');
  assert.ok(acc.sure.checked.confidentRight >= 0.9);
  assert.equal(familyInUse(acc), true);
  // Under the top-1 bar it still passes on its confident part (build 8 I1), and fails without it.
  assert.equal(familyInUse({ ...acc, family: FAMILY_GATE.minFamily - 0.01 }), acc.sure.checked.confidentRight >= 0.95
    && acc.sure.checked.confidentN >= 20 && acc.sure.checked.confidentShare >= 0.25);
  assert.equal(familyInUse({ ...acc, family: FAMILY_GATE.minFamily - 0.01, sure: null }), false);
  assert.equal(familyInUse(null), false);
  assert.equal(familyAccuracy([], FAM), null);
});

test('decideCard: the playlist when it is sure; else the family and the two inside it; else as before', () => {
  const rs = rows();
  const cal = fitCalibration(rs);
  assert.equal(cal.tau, null, 'the flat level never earns confident on coin flips');
  const famCal = fitFamilyCalibration(familyAccuracy(rs, FAM).rows);
  assert.ok(famCal.tau != null);
  const d = decideCard(rs[0].scores, cal, famCal, FAM);
  assert.equal(d.kind, 'family');
  assert.equal(d.family, FAM.get(rs[0].scores[0][0]));
  assert.equal(d.playlists.length, 2);
  assert.ok(d.playlists.every(id => FAM.get(id) === d.family));
  // Without a family calibration it is calibrate.mjs decide(), unchanged.
  assert.notEqual(decideCard(rs[0].scores, cal, null, FAM).kind, 'family');
  // A family of one playlist that is confident is the playlist itself: Sure.
  const solo = playlistFamilies([['tec', 'Techno'], ['dh', 'Dancehall']]);
  const sr = Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, truth: ['tec'], scores: [['tec', 5], ['dh', 0]] }));
  const sc = fitCalibration(sr);
  const out = decideCard([['tec', 5], ['dh', 0]], { ...sc, tau: null }, fitFamilyCalibration(familyAccuracy(sr, solo).rows), solo);
  assert.equal(out.kind, 'sure'); assert.deepEqual(out.playlists, ['tec']);
});

test('the Score line says what was measured and whether it is used', () => {
  const pc = x => (x == null ? '—' : `${Math.round(x * 100)}%`);
  const line = familyLine({ n: 600, family: 0.9, within: 0.7, flat: 0.64, families: 12,
                            sure: { confidentN: 120, confidentShare: 0.3, confidentRight: 0.93 }, use: true }, pc);
  assert.match(line, /Family first \(12 families\): family top-1 90%, right playlist inside the right family 70% \(flat top-1 64%, 600 tracks\); family confident on 30% of tracks, right 93% — used/);
  assert.match(familyLine({ n: 1, family: 0.5, within: 0.5, flat: 0.5, families: 3, sure: null, use: false }, pc), /none earned yet — not used/);
});

test('File shows a settled family as one line and its picks as equals', () => {
  const src = readFileSync(new URL('../web/screens/inbox.mjs', import.meta.url), 'utf8');
  assert.match(src, /for sure\. Which one\?/);
  assert.match(src, /' twoway'/);
});

test('I1: family first passes on its confident part when top-1 misses its bar', () => {
  const base = { n: 600, family: 0.74, within: 0.7, flat: 0.6, families: 12 };
  const sure = (n, right, share) => ({ checked: { confidentN: n, confidentRight: right, confidentShare: share } });
  // The owner's shape: top-1 74%, confident on 38% at 97%.
  assert.deepEqual(familyGate({ ...base, sure: sure(228, 0.97, 0.38) }), { use: true, by: 'confident', why: null });
  assert.equal(familyInUse({ ...base, sure: sure(228, 0.97, 0.38) }), true);
  // Top-1 bar alone, as before.
  assert.equal(familyGate({ ...base, family: 0.9, sure: null }).by, 'top1');
  // Each part of the confident bar can fail, and says which.
  assert.match(familyGate({ ...base, sure: sure(228, 0.93, 0.38) }).why, /right 93%, 95% needed/);
  assert.match(familyGate({ ...base, sure: sure(10, 0.99, 0.38) }).why, /only 10 confident family calls, 20 needed/);
  assert.match(familyGate({ ...base, sure: sure(100, 0.99, 0.2) }).why, /confident on 20% of tracks, 25% needed/);
  assert.match(familyGate({ ...base, sure: null }).why, /no confident family calls yet/);
  // The checked block itself (as engine.js keeps it) reads the same.
  assert.equal(familyGate({ ...base, sure: sure(228, 0.97, 0.38).checked }).use, true);
  assert.equal(familyGate({ ...base, families: 1, sure: sure(228, 0.97, 0.38) }).use, false);
  assert.equal(familyGate(null).use, false);
  assert.deepEqual({ ...FAMILY_CONFIDENT_GATE }, { minPrecision: 0.95, minN: 20, coverage: 0.25 });
});

test('I1: the Score line says which bar it cleared, or why not', () => {
  const pc = x => (x == null ? '—' : `${Math.round(x * 100)}%`);
  const f = { n: 600, family: 0.74, within: 0.7, flat: 0.6, families: 12,
              sure: { confidentN: 228, confidentShare: 0.38, confidentRight: 0.97 } };
  assert.match(familyLine({ ...f, use: true, by: 'confident' }, pc), /confident on 38% of tracks, right 97% — used where it is confident/);
  assert.match(familyLine({ ...f, use: false, why: 'confident family calls right 93%, 95% needed' }, pc), /not used \(confident family calls right 93%, 95% needed\)/);
});
