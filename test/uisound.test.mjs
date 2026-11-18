// UI-2: the sound layer's renderers (web/ui/sound.mjs), on fixtures.
// soundChip is WP-D4's and is tested in its own file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as S from '../web/ui/sound.mjs';
import { SOUND, EVIDENCE, PROFILE, LISTEN, galleryHTML } from './fixtures/uisound.mjs';
import { profileVM, listenVM, MISS_TEXT } from '../web/audio/controller.mjs';

const MINE = ['sectionStrip', 'evidenceBadges', 'bandChip', 'profileRow', 'listenTidyText', 'listenPill', 'listenCard', 'missedList'];

test('no data, no markup: every renderer returns "" for null, undefined and empty input', () => {
  const empties = [null, undefined, {}, [], '', 0, false];
  for (const n of MINE) for (const e of empties) assert.equal(S[n](e), '', `${n}(${JSON.stringify(e)})`);
  assert.equal(S.sectionStrip({ sections: [] }), '');
  assert.equal(S.sectionStrip({ sections: [[], ['']] }), '');
  assert.equal(S.sectionStrip({ styles: [['House', 1]] }), '', 'styles without sections draw no strip');
  assert.equal(S.evidenceBadges({ tags: 0, sound: 0 }), '');
  assert.equal(S.evidenceBadges({ tags: NaN, sound: -1 }), '');
  assert.equal(S.bandChip('NOPE'), '');
  assert.equal(S.profileRow({ heard: 0, members: 40 }), '', 'nothing heard yet: nothing drawn');
  assert.equal(S.listenPill(LISTEN.off), '');
  assert.equal(S.listenCard(LISTEN.off), '');
  assert.equal(S.missedList({ missed: { NOT_ON_DEEZER: 0 } }), '');
});

test('B2 output with nothing heard renders nothing on the Playlists row', () => {
  const vm = profileVM({ tracks: [{ id: 'a' }, { id: 'b' }] }, new Map(), null);
  assert.equal(S.profileRow(vm), '');
  assert.equal(S.listenPill(listenVM(null, { on: false })), '');
});

test('soundMark: stable per label, by family, parent prefix ignored', () => {
  assert.equal(S.soundMark('Bassline'), S.soundMark('Electronic---Bassline'));
  assert.equal(S.soundMark('Deep House'), 0);
  assert.equal(S.soundMark('UK Garage'), 0);
  assert.equal(S.soundMark('Drum n Bass'), 1);
  assert.equal(S.soundMark('Jungle'), 1);
  assert.equal(S.soundMark('Techno'), 2);
  assert.equal(S.soundMark('Hip Hop'), 3);
  assert.equal(S.soundMark('Indie Rock'), 4);
  const odd = 'Zeuhl';
  const m = S.soundMark(odd);
  assert.ok([0, 1, 2, 3, 4].includes(m));
  for (let i = 0; i < 5; i++) assert.equal(S.soundMark(odd), m, 'same label, same colour');
  assert.equal(S.soundMark(''), null);
  assert.equal(S.soundMark(null), null);
});

test('sectionStrip: one cell per section, hybrid looks hybrid', () => {
  const one = S.sectionStrip(SOUND.oneStyle);
  assert.equal((one.match(/<i /g) ?? []).length, 3);
  assert.doesNotMatch(one, /sstrip-hybrid/);
  assert.match(one, /aria-label="3 sections, Deep House"/);

  const h = S.sectionStrip(SOUND.hybrid);
  assert.match(h, /class="sstrip sstrip-hybrid"/);
  assert.match(h, /aria-label="Hybrid: 4 sections, Bassline then Donk"/);
  assert.equal((h.match(/<i /g) ?? []).length, 4);
  assert.match(h, new RegExp(`class="m${S.soundMark('Bassline')}" title="Section 1: Bassline, Speed Garage"`));

  const o = S.sectionStrip(SOUND.octaveUnsure);
  assert.match(o, /^<div class="sstrip"/, 'one top style throughout: not hybrid');
});

test('sectionStrip escapes labels', () => {
  const x = S.sectionStrip({ sections: [['<b>"x"</b>']] });
  assert.doesNotMatch(x, /<b>/);
  assert.match(x, /&lt;b&gt;&quot;x&quot;/);
});

test('evidenceBadges: fixed order, zero left out, --w is each share', () => {
  const m = S.evidenceBadges(EVIDENCE.mixed);
  assert.deepEqual([...m.matchAll(/class="ev ev-(\w+)"/g)].map(x => x[1]), ['tags', 'history', 'sound']);
  assert.match(m, /ev-tags" style="--w:0.5"/);
  assert.match(m, /aria-label="Based on tags 50%, history 30%, sound 20%"/);
  assert.match(m, /title="sound: 20% of this suggestion/);
  const all = S.evidenceBadges(EVIDENCE.all);
  assert.deepEqual([...all.matchAll(/class="ev ev-(\w+)"/g)].map(x => x[1]), ['tags', 'history', 'sound', 'learned']);
  assert.match(S.evidenceBadges(EVIDENCE.tagsOnly), /^<span class="evs"[^>]*><span class="ev ev-tags" style="--w:1"/);
  // contributions that don't sum to 1 are shown as shares
  assert.match(S.evidenceBadges({ tags: 2, sound: 2 }), /ev-sound" style="--w:0.5"/);
});

test('bandChip: three states, UI-1 classes, optional smaller percentage', () => {
  assert.equal(S.bandChip('HIGH'), '<span class="band band-sure">Sure</span>');
  assert.equal(S.bandChip('LIKELY'), '<span class="band band-likely">Likely</span>');
  assert.equal(S.bandChip('AMBIGUOUS'), '<span class="band band-unsure">Unsure</span>');
  assert.equal(S.bandChip('medium'), S.bandChip('LIKELY'), "Tidy's medium is Likely");
  assert.equal(S.bandChip('low'), S.bandChip('AMBIGUOUS'));
  assert.equal(S.bandChip('HIGH', 0.914), '<span class="band band-sure" title="Sure, 91%">Sure<span class="pct">91%</span></span>');
});

test('profileRow: B2 shape (heard, members, styles) and the full shape', () => {
  const b2 = S.profileRow(PROFILE.b2);
  assert.match(b2, /14 of 40 tracks heard/);
  assert.match(b2, /Bassline <span class="sprof-p">57%<\/span>/);
  assert.doesNotMatch(b2, /BPM|energy/, 'no range given, none drawn');
  const full = S.profileRow(PROFILE.full);
  assert.match(full, /132–140 <span class="sprof-unit">BPM/);
  assert.match(full, /energy from 3 to 4 of 5/);
  assert.match(S.profileRow(PROFILE.one), /1 of 1 track heard/);
  assert.match(S.profileRow({ heard: 3, members: 3, bpm: [128, 128] }), />128 <span class="sprof-unit">/);
});

test('profileRow straight from B2 profileVM', () => {
  const recs = new Map([['a', { styles: [[1, .9]] }], ['b', { styles: [[1, .8]] }], ['c', { miss: 'NO_PREVIEW' }]]);
  const vm = profileVM({ tracks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }, recs, ['Electronic---House', 'Electronic---Bassline']);
  const html = S.profileRow(vm);
  assert.match(html, /2 of 3 tracks heard/);
  assert.match(html, new RegExp(`<i class="m${S.soundMark('Bassline')}" aria-hidden="true"></i>Bassline`));
});

test('listenPill: running counts, paused gives the reason, done', () => {
  assert.match(S.listenPill(LISTEN.running), /class="lpill lpill-running" role="status"/);
  assert.match(S.listenPill(LISTEN.running), /Listening · 412 \/ 1,980/);
  assert.equal((S.listenPill(LISTEN.running).match(/<i><\/i>/g) ?? []).length, 5, 'the mark’s five bars');
  assert.match(S.listenPill(LISTEN.starting), /Listening…/);
  assert.match(S.listenPill(LISTEN.paused), /lpill-paused.*Paused · no Wi-Fi/);
  assert.match(S.listenPill(LISTEN.stopped), />Paused<\/span>/, '"stopped" is not a reason worth showing');
  assert.match(S.listenPill({ state: 'paused', done: 0, total: 9, reason: 'ask' }), />Paused · Wi-Fi\?</);
  const err = S.listenPill({ state: 'paused', done: 0, total: 9,
    reason: 'couldn’t load the model: Failed to fetch dynamically imported module: https://cdn.jsdelivr.net/npm/x.mjs' });
  assert.match(err, />Paused · tap for details</, 'an error is a few words, not the message');
  assert.doesNotMatch(err, /jsdelivr|Failed/);
  assert.match(S.listenPill({ state: 'paused', reason: 'hearing Discover picks' }), />Paused</);
  for (const r of ['ask', 'waiting for Wi-Fi', 'offline', 'couldn’t load the model: boom', 'a new run', 'stopped']) {
    const words = S.listenPill({ state: 'paused', reason: r }).replace(/<[^>]+>/g, '').replace(/·/g, ' ').trim().split(/\s+/);
    assert.ok(words.length <= 4, `${r}: ${words.join(' ')}`);
  }
  assert.match(S.listenPill(LISTEN.done), /Listened · 1,802 tracks heard/);
  assert.match(S.listenPill({ state: 'running', done: 12, total: 10 }), /10 \/ 10/, 'never more done than total');
});

test('listenCard: status, meter while running, all-miss explained', () => {
  const r = S.listenCard(LISTEN.running);
  assert.match(r, /Listening to 412 of 1,980 this run/);
  assert.match(r, /role="progressbar" aria-valuemin="0" aria-valuemax="1980" aria-valuenow="412"/);
  assert.match(r, /<b>380<\/b> heard/);
  assert.match(r, /<b>32<\/b> couldn’t be heard/);
  assert.match(r, /class="smiss"/);
  const d = S.listenCard(LISTEN.done);
  assert.match(d, /Up to date for this scope/);
  assert.doesNotMatch(d, /progressbar/);
  const a = S.listenCard(LISTEN.allMiss);
  assert.match(a, /None of these could be heard yet/);
  assert.doesNotMatch(a, /<b>0<\/b> heard/);
  assert.match(S.listenCard(LISTEN.paused), /Paused: waiting for Wi-Fi/);
  assert.match(S.listenCard(LISTEN.stopped), /Paused\. It carries on where it left off\./);
  const off = S.listenCard(LISTEN.offWithHistory);
  assert.match(off, /lcard-off/);
  assert.match(off, /<b>220<\/b> heard/);
  assert.doesNotMatch(off, /lpill/, 'no pill while off');
  assert.doesNotMatch(r, /lp-txt/, 'the card’s bars carry no second copy of the count');
});

test('missedList: most common first, B2 wording, unknown codes shown as is', () => {
  const m = S.missedList(LISTEN.allMiss);
  assert.match(m, /<summary>40 tracks couldn’t be heard<\/summary>/);
  const order = [...m.matchAll(/<li><b>(\d+)<\/b>/g)].map(x => +x[1]);
  assert.deepEqual(order, [25, 12, 3]);
  for (const k of Object.keys(LISTEN.allMiss.missed)) assert.ok(m.includes(MISS_TEXT[k].replace(/’/g, '’')), k);
  assert.match(S.missedList({ missed: { WEIRD: 1 } }), /1 track couldn’t be heard[\s\S]*<b>1<\/b> WEIRD/);
});

test('the renderers carry the same miss wording as B2', async () => {
  // The renderer keeps its own copy so it works without the audio bundle;
  // this keeps the two from drifting apart.
  const src = readFileSync(new URL('../web/ui/sound.mjs', import.meta.url), 'utf8');
  for (const [k, v] of Object.entries(MISS_TEXT)) assert.ok(src.includes(`${k}: '${v}'`), k);
});

test('the shots gallery is up to date with the renderers', () => {
  const file = readFileSync(new URL('../scripts/ui-shots/gallery/sound.html', import.meta.url), 'utf8');
  assert.equal(file, galleryHTML(), 'run: node test/fixtures/uisound.mjs --write');
});

test('only renderers and soundMark become page globals', () => {
  const ok = new Set(['SOUND_UI_VERSION', 'soundMark', 'soundChip', ...MINE, 'SURE_CONF']);
  for (const k of Object.keys(S)) assert.ok(ok.has(k), `unexpected export ${k}`);
});
