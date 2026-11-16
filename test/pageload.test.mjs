// The built page must load without a top-level error. Unit tests slice the
// source, so a load-order mistake between web/app files (a `const` used above
// where it is declared) passes them all and still blanks the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }

// Locally a missing Playwright skips; in CI it is installed on purpose, so its
// absence is a broken pipeline, not a pass (BUILD-6 D3).
const skip = !chromium && !process.env.CI && 'playwright not installed';

/** Load a page and collect its uncaught errors. */
async function pageErrors(url) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url);
    await page.waitForTimeout(1000);
    return errors;
  } finally { await browser.close(); }
}

test('the page-load check catches a load-order crash (canary)', { skip }, async () => {
  assert.ok(chromium, 'playwright must be installed in CI');
  const html = '<!doctype html><script>useIt(); const useIt = () => 1;</script>';
  const errors = await pageErrors('data:text/html,' + encodeURIComponent(html));
  assert.equal(errors.length, 1, 'a const used before its declaration must surface as a page error');
});

test('docs/index.html loads with no page errors', { skip }, async () => {
  assert.ok(chromium, 'playwright must be installed in CI');
  const errors = await pageErrors('file://' + fileURLToPath(new URL('../docs/index.html', import.meta.url)));
  assert.deepEqual(errors, []);
});
