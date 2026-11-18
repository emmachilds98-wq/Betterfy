// Wikidata's query service rate-limits (429). Every request goes through one
// queue in web/app/engine.js: a 429 waits and retries, a stuck one rests.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../web/app/engine.js', import.meta.url), 'utf8');
const from = src.indexOf('async function corsJson('), to = src.indexOf('/* ---- the jobs behind the Engine screen');
const code = src.slice(from, to);

function sandbox(answers) {
  const calls = [];
  const ctx = vm.createContext({ URL, Number, Math, Date, Error, Promise, calls,
    setTimeout: fn => fn(),   // no real waiting in the test
    fetch: async url => { calls.push(url); const status = answers.shift() ?? 200;
      return { ok: status === 200, status, headers: { get: () => null }, json: async () => ({ ok: true }) }; } });
  vm.runInContext(code + '\nthis.corsJson = corsJson; this.WD = WD;', ctx);
  return ctx;
}
const Q = 'https://query.wikidata.org/sparql';

test('a 429 from Wikidata is retried, then answers', async () => {
  const c = sandbox([429, 429, 200]);
  assert.deepEqual(await c.corsJson(Q, {}), { ok: true });
  assert.equal(c.calls.length, 3);
});

test('a Wikidata that keeps refusing rests, and the next ask fails fast without fetching', async () => {
  const c = sandbox([429, 429, 429, 429]);
  await assert.rejects(c.corsJson(Q, {}), /answered 429/);
  assert.equal(c.calls.length, 4);
  await assert.rejects(c.corsJson(Q, {}), /busy; trying again in 10 min/);
  assert.equal(c.calls.length, 4, 'no request while resting');
});

test('requests to other hosts are not queued or retried', async () => {
  const c = sandbox([429]);
  await assert.rejects(c.corsJson('https://labs.api.listenbrainz.org/x', {}), /answered 429/);
  assert.equal(c.calls.length, 1);
});
