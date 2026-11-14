import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GOLDEN, INBOX, renderInbox } from './ui4-cards.mjs';

// UI-4: the File card's sound slots draw nothing without sound data, so the
// card is byte for byte what it was before the slots existed.

const stubs = { soundChip: () => '', sectionStrip: () => '', bandChip: () => '', evidenceBadges: () => '' };
const fake = {
  soundChip: vm => `<span class="SC">${vm.bpm}</span>`,
  sectionStrip: vm => `<span class="SS">${vm.sections.length}</span>`,
  bandChip: b => `<span class="BC">${b}</span>`,
  evidenceBadges: e => `<span class="EB">${Object.keys(e).join('+')}</span>`,
};
const golden = n => readFileSync(new URL(`inbox-${n}.html`, GOLDEN), 'utf8');

for (const [name, t] of Object.entries(INBOX)) {
  test(`File card "${name}" with no sound data matches the pre-slot golden`, () => {
    assert.equal(renderInbox(t, { renderers: stubs }), golden(name));
    // Real renderers are never even asked when nothing carries sound.
    assert.equal(renderInbox(t, { renderers: fake }), golden(name));
  });
  test(`File card "${name}" with the pick selected matches its golden`, () => {
    const S = { fileSel: new Set(['p2']), fileSelFor: t.id };
    assert.equal(renderInbox(t, { S, renderers: fake }), golden(`${name}-sel`));
  });
}

test('empty renderers leave no wrapper even when the track has sound', () => {
  const t = { ...INBOX.tags, sound: { bpm: 174, sections: [['jungle']] } };
  const html = renderInbox(t, { renderers: stubs });
  assert.ok(!html.includes('sndchip') && !html.includes('sndstrip'));
  assert.equal(html, golden('tags'));
});

test('sound chip sits after the meta line, the strip under the artwork row', () => {
  const t = { ...INBOX.tags, sound: { bpm: 174, sections: [['jungle'], ['drum and bass']] } };
  const html = renderInbox(t, { renderers: fake });
  assert.match(html, /<span>4:14<\/span><\/div><div class="sndchip"><span class="SC">174<\/span><\/div>/);
  assert.match(html, /<\/div><div class="sndstrip"><span class="SS">2<\/span><\/div>\s*<div class="picks">/);
});

test('picks lead with the band chip and carry evidence; history picks keep their wording', () => {
  const t = { ...INBOX.history, suggest: INBOX.history.suggest.map((sg, i) =>
    ({ ...sg, band: i ? 'LIKELY' : 'HIGH', evidence: i ? { tags: 0.4 } : { history: 0.8 } })) };
  const html = renderInbox(t, { renderers: fake });
  assert.match(html, /4 of 5 other tracks by this artist are already here<\/span><span class="EB">history<\/span>/);
  assert.match(html, /<span class="rt"><span class="BC">HIGH<\/span><span class="sc">no tags yet<\/span>/);
  assert.match(html, /<span class="rt"><span class="BC">LIKELY<\/span><span class="sc">40%<\/span>/);
});
