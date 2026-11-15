import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as sound from '../web/ui/sound.mjs';
import { assembledTemplate } from '../web/manifest.mjs';

// UI-0 of docs/UI-BUILD-PLAN.md: the stylesheet lives in web/styles/ partials so
// packages restyling different screens own different files, and the sound
// layer's renderers exist under fixed names before anything calls them.

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
// The template with its script put back (web/manifest.mjs): the page's script
// lives in web/app/ and web/screens/ since A1.
// The page's markup and its script, plus the screen modules the manifest does not list.
const TEMPLATE = assembledTemplate() + readdirSync(new URL('../web/screens/', import.meta.url)).filter(f => f.endsWith('.mjs')).map(f => read('web/screens/' + f)).join('\n');
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

test('the motion tokens are defined once, with the values BUILD-5-PLAN §4.2 gives', () => {
  const tokens = read('web/styles/00-tokens.css');
  const want = {
    '--dur-1': '120ms', '--dur-2': '200ms', '--dur-3': '300ms', '--dur-4': '450ms',
    '--ease-out': 'cubic-bezier(.2,.7,.3,1)', '--ease-in': 'cubic-bezier(.4,0,1,1)', '--ease-std': 'cubic-bezier(.3,0,.2,1)',
    '--ease-spring': 'linear(0,.106,.325,.556,.748,.886,.972,1.018,1.036,1.038,1.031,1.022,1.014,1.007,1.003,1)',
    '--ease-bounce': 'linear(0,.166,.493,.802,1.011,1.109,1.124,1.095,1.053,1.016,.994,.985,.985,.989,.995,.999,1)',
    '--slide': '24px',
  };
  for (const [name, value] of Object.entries(want)) {
    const defs = [...tokens.matchAll(new RegExp(`${name}:([^;]+);`, 'g'))].map(m => m[1].trim());
    assert.deepEqual(defs, [value], `${name} defined once as ${value}`);
  }
});

test('transitions and animations use the motion tokens where the value is the same', () => {
  // The named curve and the four durations are written once, in 00-tokens.css;
  // a partial that types them out again has drifted from the system.
  for (const f of PARTIALS.filter(f => f !== '00-tokens.css')) {
    const css = read(`web/styles/${f}`);
    assert.doesNotMatch(css, /cubic-bezier\(\.2,\s*\.7,\s*\.3,\s*1\)/, `${f}: use var(--ease-out)`);
    for (const m of css.matchAll(/(?:transition|animation)(?:-duration)?:([^;}]*)/g))
      assert.doesNotMatch(m[1], /(?:^|[\s,])(?:0?\.12s|0?\.2s|0?\.3s|0?\.45s|120ms|200ms|300ms|450ms)\b/,
        `${f}: "${m[0].trim()}" has a duration that is a --dur-* token`);
  }
});

test('the template has one empty-state style: only the File screen\'s "done" box is not .empty-state', () => {
  assert.deepEqual(TEMPLATE.match(/class="empty[ "][^"]*"?/g), ['class="empty done"']);
});
