import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as sound from '../web/ui/sound.mjs';

// UI-0 of docs/UI-BUILD-PLAN.md: the stylesheet lives in web/styles/ partials so
// packages restyling different screens own different files, and the sound
// layer's renderers exist under fixed names before anything calls them.

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const TEMPLATE = read('docs/app.template.html');
const BUNDLE = read('docs/index.html');
const PARTIALS = readdirSync(new URL('../web/styles/', import.meta.url))
  .filter(f => f.endsWith('.css')).sort();

test('the template carries no CSS of its own, only the marker the build fills', () => {
  const styles = TEMPLATE.match(/<style>[\s\S]*?<\/style>/g);
  assert.equal(styles.length, 1, 'one <style> element');
  assert.equal(styles[0], '<style>\n__STYLES__</style>');
});

test('the built page inlines every partial, in file-name order', () => {
  const css = PARTIALS.map(f => read(`web/styles/${f}`)).join('');
  assert.ok(BUNDLE.includes(`<style>\n${css}</style>`),
    'docs/index.html is stale or out of order — run node build-web.mjs');
});

test('partials are numbered, so the cascade order is visible in the file list', () => {
  for (const f of PARTIALS) assert.match(f, /^\d{2}-[a-z0-9-]+\.css$/, f);
  assert.equal(new Set(PARTIALS.map(f => f.slice(0, 2))).size, PARTIALS.length, 'no two share a prefix');
});

test('the wordmark is not split by a flex gap', () => {
  // "Better" is a text node and "fy" a <span>; a gap on the flex row put a
  // space inside the word on every screen.
  const css = PARTIALS.map(f => read(`web/styles/${f}`)).join('');
  for (const sel of ['.logo', '.brand']) {
    for (const m of css.matchAll(new RegExp(`(?:^|[\\s}])${sel.replace('.', '\\.')}\\{([^}]*)\\}`, 'g')))
      assert.doesNotMatch(m[1], /\bgap:/, `${sel} must not set a gap`);
  }
});

test('every sound renderer exists, is bundled as a global, and renders nothing without data', () => {
  const names = ['soundChip', 'sectionStrip', 'evidenceBadges', 'bandChip',
                 'profileRow', 'listenPill', 'listenCard', 'missedList'];
  for (const n of names) {
    assert.equal(typeof sound[n], 'function', n);
    for (const empty of [null, undefined]) assert.equal(sound[n](empty), '', `${n}(${empty})`);
    assert.match(BUNDLE, new RegExp(`function ${n}\\(`), `${n} bundled`);
  }
  assert.match(BUNDLE, /Object\.assign\(globalThis, __mod\["web\/ui\/sound\.mjs"\]\)/);
  assert.equal(sound.SOUND_UI_VERSION, 1);
});
