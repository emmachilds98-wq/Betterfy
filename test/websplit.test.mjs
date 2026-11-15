import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { APP_FILES, appSource } from '../web/manifest.mjs';

// A1 of docs/BUILD-5-PLAN.md: the page's script lives in web/app/ and
// web/screens/, joined in APP_FILES order where the template says __APP__.

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('every script file is listed once, and every listed file exists', () => {
  const onDisk = ['app', 'screens'].flatMap(d =>
    readdirSync(new URL(`../web/${d}/`, import.meta.url)).filter(f => f.endsWith('.js')).map(f => `${d}/${f}`));
  assert.equal(new Set(APP_FILES).size, APP_FILES.length, 'a file is listed twice');
  assert.deepEqual([...onDisk].sort(), [...APP_FILES].sort(),
    'web/app or web/screens has a file web/manifest.mjs does not list (or the other way round)');
});

test('the template keeps no script of its own in the app <script>', () => {
  const tpl = read('docs/app.template.html');
  const i = tpl.lastIndexOf('<script>\n'), j = tpl.indexOf('</script>\n</body>', i);
  assert.ok(i > 0 && j > i, 'the app <script> is not at the end of the body');
  assert.equal(tpl.slice(i + 9, j).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim(), '__CORE__ __APP__');
});

test('the built page carries the script, in order', () => {
  const page = read('docs/index.html');
  let at = 0;
  for (const f of APP_FILES) {
    // A distinctive line from each file, found after the previous file's.
    const line = read(`web/${f}`).split('\n').find(l => l.trim().length > 30 && !/__[A-Z_]+__/.test(l));
    const i = page.indexOf(line, at);
    assert.ok(i >= at, `${f} is missing from docs/index.html, or out of order — rebuild with node build-web.mjs`);
    at = i;
  }
  assert.ok(appSource().endsWith('\n'));
});
