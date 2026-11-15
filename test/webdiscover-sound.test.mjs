import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GOLDEN, DISCOVER, renderDiscover } from './ui4-cards.mjs';
import { assertSameHTML } from './golden.mjs';

// UI-4: the Discover card's sound slots, same rule as the File card.

const stubs = { soundChip: () => '', sectionStrip: () => '', bandChip: () => '', evidenceBadges: () => '' };
const fake = {
  soundChip: vm => `<span class="SC">${vm.bpm}</span>`,
  sectionStrip: vm => `<span class="SS">${vm.sections.length}</span>`,
  bandChip: b => `<span class="BC">${b}</span>`,
  evidenceBadges: e => `<span class="EB">${Object.keys(e).join('+')}</span>`,
};
const golden = n => readFileSync(new URL(`discover-${n}.html`, GOLDEN), 'utf8');

for (const [name, t] of Object.entries(DISCOVER)) {
  test(`Discover card "${name}" with no sound data matches the pre-slot golden`, () => {
    assertSameHTML(renderDiscover(t, { renderers: stubs }), golden(name));
    assertSameHTML(renderDiscover(t, { renderers: fake }), golden(name));
  });
}

test('the fit call and the other picks carry band and evidence', () => {
  const t = { ...DISCOVER.three, sound: { bpm: 172, sections: [['jungle']] },
    suggest: DISCOVER.three.suggest.map(sg => ({ ...sg, band: 'AMBIGUOUS', evidence: { tags: 0.3, sound: 0.2 } })) };
  const html = renderDiscover(t, { renderers: fake });
  assert.match(html, /<div class="sndchip"><span class="SC">172<\/span><\/div>/);
  assert.match(html, /<div class="sndstrip"><span class="SS">1<\/span><\/div>/);
  assert.match(html, /ranked by the same model the file queue uses<\/span><span class="EB">tags\+sound<\/span><\/span>\s*<span class="BC">AMBIGUOUS<\/span><span class="sc">Likely/);
  assert.equal((html.match(/class="BC"/g) ?? []).length, 3);
});
