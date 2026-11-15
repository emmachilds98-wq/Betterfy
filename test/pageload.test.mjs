// The built page must load without a top-level error. Unit tests slice the
// source, so a load-order mistake between web/app files (a `const` used above
// where it is declared) passes them all and still blanks the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }

test('docs/index.html loads with no page errors', { skip: !chromium && 'playwright not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('file://' + fileURLToPath(new URL('../docs/index.html', import.meta.url)));
    await page.waitForTimeout(1000);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
