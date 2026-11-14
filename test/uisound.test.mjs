import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as S from '../web/ui/sound.mjs';
import { FIXTURES as F, galleryHtml } from '../scripts/ui-shots/sound-gallery.mjs';

// UI-2 of docs/UI-BUILD-PLAN.md: the sound layer's renderers. The rule that
// matters most is the first one: with no audio data they draw nothing, so a
// listener who never turns listening on sees the page they had before.

const RENDERERS = ['soundChip', 'sectionStrip', 'evidenceBadges', 'bandChip',
                   'profileRow', 'listenPill', 'listenCard', 'missedList'];
const text = html => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

test('every renderer returns "" for null, undefined and empty input', () => {
  for (const n of RENDERERS)
    for (const v of [null, undefined, {}, [], '', 0, false, 'nonsense'])
      assert.equal(S[n](v), '', `${n}(${JSON.stringify(v)})`);
});

test('view models with only empty or unusable fields render nothing', () => {
  assert.equal(S.soundChip({ bpm: NaN, energy: undefined, moods: [], styles: [], voice: null, hybrid: false }), '');
  assert.equal(S.soundChip({ bpm: 0, key: '', camelot: '  ' }), '');
  assert.equal(S.sectionStrip({ sections: [] }), '');
  assert.equal(S.sectionStrip({ sections: [[], ['']] }), '');
  assert.equal(S.sectionStrip({ styles: [['house', .9]] }), '', 'styles alone are not sections');
  assert.equal(S.evidenceBadges({ tags: 0, history: -1, sound: NaN }), '');
  assert.equal(S.bandChip('MAYBE'), '');
  assert.equal(S.profileRow({ heard: 0, members: 30, bpm: [120, 130] }), '', 'nothing heard yet');
  assert.equal(S.listenPill({ state: 'off', done: 0, total: 100 }), '');
  assert.equal(S.listenPill({ state: 'exploded', done: 1, total: 2 }), '');
  assert.equal(S.listenCard({ state: 'exploded' }), '');
  assert.equal(S.missedList({ state: 'done', done: 5, total: 5, missed: { NO_PREVIEW: 0 } }), '');
  assert.equal(S.missedList({ state: 'done', done: 5, total: 5 }), '');
});

test('sound chip: tempo, key, energy meter, voice', () => {
  const html = S.soundChip(F.sound.full);
  assert.equal(text(html), '174 BPM·8A·energy ·vocal·dark, driving');
  assert.match(html, /aria-label="energy 4 of 5"/);
  assert.equal((html.match(/<i class="on">/g) || []).length, 4);
  assert.match(html, /title="A minor"/, 'the musical key name rides along on hover');
  assert.doesNotMatch(html, /snd-unsure/);
});

test('sound chip: octave-unsure tempo reads 87/174 and is marked unsure', () => {
  const html = S.soundChip(F.sound.octave);
  assert.match(text(html), /^87\/174 BPM/);
  assert.match(html, /class="snd-bpm snd-unsure" title="Half or double time/);
  assert.match(S.soundChip({ bpm: 174, bpmAlt: 87 }), />87\/174 </, 'lower first whichever way round');
  assert.match(S.soundChip({ bpm: 128, bpmAlt: 128 }), />128 </, 'equal alt is not unsure');
});

test('sound chip: a low-confidence tempo or key is dimmed, not hidden', () => {
  const html = S.soundChip(F.sound.unsure);
  assert.match(html, /snd-bpm snd-unsure/);
  assert.match(html, /snd-key snd-unsure" title="key is a rough guess"/);
  assert.match(text(html), /F# minor/, 'falls back to the key name with no Camelot');
});

test('sound chip: hybrid says so; energy clamps', () => {
  assert.match(text(S.soundChip(F.sound.hybrid)), /hybrid/);
  assert.match(S.soundChip({ energy: 3 }), /energy 5 of 5/);
  assert.match(S.soundChip({ energy: -1 }), /energy 0 of 5/);
});

test('section strip: one segment per section, coloured by its top style family', () => {
  const html = S.sectionStrip(F.sound.hybrid);
  assert.equal((html.match(/<i /g) || []).length, 5);
  assert.match(html, /snd-strip snd-strip-hybrid/);
  assert.match(html, /aria-label="Sections: uk garage → uk garage → dubstep → dubstep → uk garage \(hybrid\)"/);
  const colours = [...html.matchAll(/class="snd-m(\d)"/g)].map(m => +m[1]);
  assert.deepEqual(colours, [2, 2, 4, 4, 2], 'garage magenta, dubstep blue');
  const single = S.sectionStrip(F.sound.single);
  assert.match(single, /snd-none/, 'an unclear section stays in its place');
  assert.doesNotMatch(single, /hybrid/);
});

test('style colours are stable per label and follow families', () => {
  const m = S.soundStyleMark;
  assert.equal(m('drum and bass'), 4); assert.equal(m('jungle'), 4); assert.equal(m('dubstep'), 4);
  assert.equal(m('deep house'), 2); assert.equal(m('acid house'), 2); assert.equal(m('uk garage'), 2); assert.equal(m('electro pop'), 2);
  assert.equal(m('techno'), 3); assert.equal(m('ambient'), 3);
  assert.equal(m('hip hop'), 0); assert.equal(m('dancehall'), 0); assert.equal(m('soul'), 0);
  assert.equal(m('indie rock'), 1); assert.equal(m('folk'), 1);
  for (const l of ['zydeco', 'polka', '', 'Ωmega']) {
    const c = m(l);
    assert.ok(c >= 0 && c <= 4 && Number.isInteger(c), l);
    assert.equal(m(l), c, 'same label, same colour');
  }
  assert.equal(m('Drum And Bass'), 4, 'case does not matter');
});

test('evidence badges: fixed order, contributors only, strengths and a readable title', () => {
  const html = S.evidenceBadges({ learned: .05, sound: .3, tags: .4, history: .25 });
  assert.deepEqual([...html.matchAll(/class="ev ev-(\w+)"/g)].map(x => x[1]), ['tags', 'history', 'sound', 'learned']);
  assert.match(html, /^<span class="evs" title="tags 40% · history 25% · sound 30% · learned 5%"/);
  assert.match(html, /ev-sound" style="--w:0.30"/);
  const one = S.evidenceBadges(F.evidence.tagsOnly);
  assert.equal((one.match(/class="ev /g) || []).length, 1);
  assert.match(S.evidenceBadges({ sound: 4 }), /--w:1.00/, 'clamped');
});

test('band chip: the three band words, with the percentage small when given', () => {
  assert.equal(S.bandChip('HIGH'), '<span class="band band-sure">Sure</span>');
  assert.equal(S.bandChip('LIKELY', .684), '<span class="band band-likely">Likely <span class="pct">68%</span></span>');
  assert.equal(text(S.bandChip('AMBIGUOUS', .41)), 'Unsure 41%');
});

test('profile row: heard of members, BPM range, energy spread, top styles', () => {
  const html = S.profileRow(F.profile.full);
  assert.match(text(html), /^Heard 18 of 24168–176 BPMenergy drum and bassjungleliquid funk$/);
  assert.match(html, /aria-label="energy 55% to 92%"><i style="left:55%;width:37%"/);
  assert.match(html, /snd-style snd-m4" title="62%">drum and bass/);
  assert.match(text(S.profileRow(F.profile.narrow)), /124 BPM/, 'a single tempo is not a range');
  assert.equal(text(S.profileRow(F.profile.partial)), 'Heard 3 of 140house');
  assert.match(S.profileRow({ heard: 2, members: 1 }), />Heard 2</, 'inconsistent members are dropped, not shown');
});

test('listen pill: running counts, paused reason, done tallies, off is absent', () => {
  assert.equal(text(S.listenPill(F.listen.running)), 'Listening · 412 / 1,980');
  assert.match(S.listenPill(F.listen.running), /snd-bars snd-running/);
  assert.equal(text(S.listenPill(F.listen.paused)), 'Paused · on mobile data');
  assert.match(S.listenPill(F.listen.paused), /snd-bars snd-paused/);
  assert.equal(text(S.listenPill(F.listen.done)), 'Heard 1,772');
  assert.equal(text(S.listenPill(F.listen.allMiss)), 'Couldn’t hear any');
  assert.match(S.listenPill(F.listen.running), /role="status"/);
});

test('listen card: progress and honest counts, including when every track was missed', () => {
  const run = S.listenCard(F.listen.running);
  assert.match(run, /aria-valuemax="1980" aria-valuenow="412"/);
  assert.match(run, /width:21%/);
  assert.match(text(run), /412 of 1,980 tracks checked\s*heard 367 · couldn’t hear 45/);
  const all = text(S.listenCard(F.listen.allMiss));
  assert.match(all, /^Done/);
  assert.match(all, /40 of 40 tracks checked\s*heard none · couldn’t hear 40/);
  assert.match(text(S.listenCard(F.listen.paused)), /^Paused · on mobile data/);
  assert.equal(text(S.listenCard(F.listen.off)), 'OffNothing heard yet.');
  assert.doesNotMatch(S.listenCard(F.listen.off), /progressbar/);
});

test('missed list: biggest reason first, listener words, unknown reasons kept', () => {
  const html = S.missedList(F.listen.done);
  assert.match(text(html), /^Couldn’t hear 208 tracks/);
  const reasons = [...html.matchAll(/<li><span>([^<]+)<\/span><b>([\d,]+)<\/b>/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(reasons[0], ['No preview to listen to', '140']);
  assert.deepEqual(reasons.at(-1), ['Couldn’t load — will try again', '1']);
  assert.equal(reasons.length, 6);
  assert.match(text(S.missedList({ missed: { NO_ISRC: 1 } })), /Couldn’t hear 1 track(?!s)/);
  assert.match(S.missedList({ missed: { WEIRD: 2 } }), /<span>WEIRD<\/span>/);
});

test('every string from a view model is escaped', () => {
  const evil = '<img src=x onerror=alert(1)>"\'';
  const outs = [
    S.soundChip({ key: evil, moods: [evil] }),
    S.sectionStrip({ sections: [[evil]] }),
    S.profileRow({ heard: 1, members: 1, styles: [[evil, .5]] }),
    S.listenPill({ state: 'paused', done: 1, total: 2, reason: evil }),
    S.listenCard({ state: 'paused', done: 1, total: 2, reason: evil }),
    S.missedList({ missed: { [evil]: 1 } }),
  ];
  for (const o of outs) {
    assert.ok(o.length > 0);
    assert.doesNotMatch(o, /<img/);
    assert.doesNotMatch(o, /"'/);
  }
});

test('only the contract and one prefixed helper become page globals', () => {
  assert.deepEqual(Object.keys(S).sort(), [...RENDERERS, 'SOUND_UI_VERSION', 'soundStyleMark'].sort());
  const template = readFileSync(new URL('../docs/app.template.html', import.meta.url), 'utf8');
  assert.doesNotMatch(template, /\b(function|const|let|var)\s+soundStyleMark\b/);
});

test('the committed gallery fragment matches the renderers', () => {
  const committed = readFileSync(new URL('../scripts/ui-shots/gallery/sound.html', import.meta.url), 'utf8');
  assert.equal(committed, galleryHtml(), 'stale — run node scripts/ui-shots/sound-gallery.mjs');
});
