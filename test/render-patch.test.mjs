// A5 wired into render() (docs/archive/BUILD-5-PLAN.md): a redraw of the screen already
// showing patches #main in place, so a focused input keeps focus and its value;
// the row lists that opt into FLIP carry data-key and data-flip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }

const PAGE = 'file://' + fileURLToPath(new URL('../docs/index.html', import.meta.url));

test('render() on the same screen keeps a focused input, its value and its caret', { skip: !chromium && 'playwright not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(PAGE);
    await page.waitForTimeout(500);
    const out = await page.evaluate(() => {
      // A stand-in screen: only #main and the patch path are under test.
      document.getElementById('app').hidden = false;
      R = { backlog: [], within: [], misfiled: [], clusters: [], across: [] }; LIB = { playlists: [], liked: [] };
      let n = 0;
      view = 'discover';
      VIEWS.discover = () => `<h1>t${n}</h1><input id="probe"><ul>${[0, 1].map(i => `<li data-key="k${i}">r${i}</li>`).join('')}</ul>`;
      paintedView = null; render(1);
      const first = document.getElementById('probe');
      first.focus(); first.value = 'hello'; first.setSelectionRange(2, 3);
      const li0 = document.querySelector('[data-key="k0"]');
      n = 1; render();
      const now = document.getElementById('probe');
      return { same: now === first, focus: document.activeElement === now, value: now.value,
               sel: [now.selectionStart, now.selectionEnd], title: document.querySelector('#main h1').textContent,
               row: document.querySelector('[data-key="k0"]') === li0 };
    });
    assert.deepEqual(errors, []);
    assert.equal(out.title, 't1', 'the redraw did land');
    assert.ok(out.same && out.focus, 'the input kept focus');
    assert.equal(out.value, 'hello');
    assert.deepEqual(out.sel, [2, 3]);
    assert.ok(out.row, 'a keyed row is the same node');
  } finally { await browser.close(); }
});

test('a screen change replaces #main whole', { skip: !chromium && 'playwright not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(PAGE);
    await page.waitForTimeout(500);
    const replaced = await page.evaluate(() => {
      document.getElementById('app').hidden = false;
      R = { backlog: [], within: [], misfiled: [], clusters: [], across: [] }; LIB = { playlists: [], liked: [] };
      view = 'discover'; VIEWS.discover = () => '<p id="keep">x</p>';
      paintedView = null; render(1);
      const p = document.getElementById('keep');
      render(1);
      return document.getElementById('keep') !== p;
    });
    assert.ok(replaced);
  } finally { await browser.close(); }
});

test('Tidy, History and DJ order rows carry data-key and data-flip', () => {
  const src = f => readFileSync(new URL('../web/screens/' + f, import.meta.url), 'utf8');
  for (const [f, min] of [['tidy.mjs', 4], ['history.mjs', 2], ['shuffle.mjs', 1]]) {
    const n = (src(f).match(/data-flip data-key=/g) ?? []).length;
    assert.ok(n >= min, `${f}: ${n} keyed row templates, wanted ${min}`);
  }
});
