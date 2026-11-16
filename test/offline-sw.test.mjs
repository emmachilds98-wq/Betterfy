// F6 (docs/BUILD-6-PLAN.md): what the service worker answers, and what it must
// leave to the browser. Run against the built docs/sw.js in a bare sandbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SW = readFileSync(new URL('../docs/sw.js', import.meta.url), 'utf8');
const PAGE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const BUILD = PAGE.match(/name="bf-build"\s+content="([^"]*)"/)?.[1];
const SCOPE = 'https://example.github.io/Betterfy/';

function sandbox() {
  const listeners = {};
  const self = { location: { href: SCOPE + 'sw.js' }, registration: { scope: SCOPE },
                 addEventListener: (t, f) => { listeners[t] = f; } };
  const box = { self, URL, caches: {}, fetch: () => { throw new Error('no network in this test'); } };
  vm.createContext(box);
  vm.runInContext(SW, box);
  const answers = (url, o = {}) => {
    let took = false;
    listeners.fetch({ request: { url, method: o.method ?? 'GET', mode: o.mode ?? 'cors', cache: o.cache ?? 'default' },
                      respondWith: p => { took = true; p?.catch?.(() => {}); } });
    return took;
  };
  return { answers };
}

test('docs/sw.js carries the same build stamp as the page', () => {
  assert.ok(BUILD, 'rebuild with npm run build:web');
  assert.equal(SW.match(/const BUILD = '([^']+)'/)?.[1], BUILD);
  assert.ok(!SW.includes('__BUILD__'));
});

test('the worker never answers for another origin', () => {
  const { answers } = sandbox();
  for (const u of ['https://api.spotify.com/v1/me', 'https://accounts.spotify.com/api/token',
    'https://ws.audioscrobbler.com/2.0/?method=artist.getTopTags', 'https://api.deezer.com/track/isrc:X',
    'https://firestore.googleapis.com/v1/projects/x/databases/(default)/documents/a',
    'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort.wasm.bundle.min.mjs',
    'https://www.wikidata.org/w/api.php', 'https://api.listenbrainz.org/1/x'])
    assert.equal(answers(u), false, u);
});

test('the update check and "Update now" go past it; the shell and stamped bundles do not', () => {
  const { answers } = sandbox();
  assert.equal(answers(SCOPE + '?_=123', { cache: 'no-store' }), false, 'version.js publishedBuild');
  assert.equal(answers(SCOPE, { cache: 'reload' }), false, 'installUpdate pulls a fresh copy');
  assert.equal(answers(SCOPE + '?_=123'), false, 'a cache-busted address, whatever its cache mode');
  assert.equal(answers(SCOPE, { mode: 'navigate' }), true, 'the page');
  assert.equal(answers(SCOPE + 'index.html?v=9', { mode: 'navigate' }), true);
  for (const f of ['engine.js', 'audio.js', 'engine-worker.js', 'reports-worker.js', 'audio-worker.js', 'maest-worker.js', 'tags.json'])
    assert.equal(answers(`${SCOPE}${f}?v=${BUILD}`), true, f);
  assert.equal(answers(`${SCOPE}engine.js?v=1999-01-01-0000`), false, 'another build\'s bundle is not this cache\'s');
  assert.equal(answers(SCOPE + 'models/effnet.onnx'), false, 'the models are never kept');
  assert.equal(answers(SCOPE + 'icon-192.png'), true);
  assert.equal(answers(SCOPE + 'tags.json?v=' + BUILD, { method: 'POST' }), false);
  assert.equal(answers('https://example.github.io/Other/index.html', { mode: 'navigate' }), false, 'outside its scope');
});
