import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { normHTML, assertSameHTML } from './golden.mjs';

// A8: what the golden compare ignores, and what it still catches.

test('an empty slot on its own line no longer breaks a golden', () => {
  const slot = '';
  assertSameHTML(`<div class="meta"><span>4:14</span></div>\n    ${slot}\n<div class="row">`, '<div class="meta"><span>4:14</span></div><div class="row">');
});

test('re-indenting a template is formatting', () => {
  assertSameHTML('<ul>\n  <li>\n    one\n  </li>\n</ul>\n', '<ul><li>one</li></ul>');
});

test('gaps between attributes are formatting', () => {
  assert.equal(normHTML('<a  href="/x"\n   class="b" >t</a>'), '<a href="/x" class="b">t</a>');
});

test('runs of space in text collapse to one', () => {
  assert.equal(normHTML('<p>two   words\n  here</p>'), '<p>two words here</p>');
});

test('a real space between inline tags still counts', () => {
  assert.notEqual(normHTML('<b>a</b> <i>b</i>'), normHTML('<b>a</b><i>b</i>'));
});

test('changed text, tags, attributes and order are caught', () => {
  const base = '<div class="a"><span>x</span><em>y</em></div>';
  for (const other of ['<div class="b"><span>x</span><em>y</em></div>',
                       '<div class="a"><span>z</span><em>y</em></div>',
                       '<div class="a"><b>x</b><em>y</em></div>',
                       '<div class="a"><em>y</em><span>x</span></div>',
                       '<div class="a" hidden><span>x</span><em>y</em></div>']) {
    assert.throws(() => assertSameHTML(other, base));
  }
});

test('a real golden, re-indented and with an empty line added, still matches', () => {
  const g = readFileSync(new URL('./fixtures/ui4/inbox-tags.html', import.meta.url), 'utf8');
  const moved = g.replace(/\n/g, '\n    ').replace('</div>\n', '</div>\n\n');
  assert.notEqual(moved, g);
  assertSameHTML(moved, g);
});

test('every golden file is unchanged by normalising itself twice', () => {
  const dir = new URL('./fixtures/ui4/', import.meta.url);
  const files = [...readdirSync(dir).map(f => new URL(f, dir)), new URL('./fixtures/vnew-no-audio.html', import.meta.url)];
  for (const f of files) {
    const once = normHTML(readFileSync(f, 'utf8'));
    assert.equal(normHTML(once), once, String(f));
    assert.ok(once.length > 0);
  }
});
