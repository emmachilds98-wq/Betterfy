import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join, normalize, dirname } from 'node:path';

// WP-B2's end-to-end smoke run, in real Chromium: three tracks go through the
// page's audio bundle exactly as the page wires it — Deezer lookup (faked:
// tests have no network), a Range download of a local preview fixture,
// decodeAudioData, the mel, the real Discogs-EffNet model and heads in the
// module Worker on onnxruntime-web (WASM, one thread), and into IndexedDB —
// then a fresh store reads the three records back through validRecord.
//
// Skips when Playwright or Chromium is missing (CI has neither). onnxruntime-web
// is served locally from BETTERFY_ORT_DIR (a node_modules/onnxruntime-web/dist)
// when it is set, else fetched from jsDelivr as the page does.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = join(ROOT, 'docs');
const PREVIEW = readFileSync(new URL('./fixtures/synth-stereo-44k.mp3', import.meta.url));
const ORT_DIR = process.env.BETTERFY_ORT_DIR || null;

let skip = false, chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { skip = 'Playwright not installed'; }
if (!skip && !existsSync(join(DOCS, 'audio.js'))) skip = 'docs/audio.js missing: run node build-web.mjs';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
                '.onnx': 'application/octet-stream', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg' };
const HARNESS = '<!doctype html><meta charset="utf-8"><title>audio smoke</title><body><script src="/audio.js"></script>';

function serve() {
  const srv = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/harness.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(HARNESS); }
    if (url.pathname === '/preview.mp3') {
      // The preview CDN answers Range with 206, as phase 0 measured.
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      if (!m) { res.writeHead(200, { 'content-type': 'audio/mpeg', 'access-control-allow-origin': '*' }); return res.end(PREVIEW); }
      const start = +m[1], end = Math.min(m[2] ? +m[2] : PREVIEW.length - 1, PREVIEW.length - 1);
      res.writeHead(206, { 'content-type': 'audio/mpeg', 'content-range': `bytes ${start}-${end}/${PREVIEW.length}` });
      return res.end(PREVIEW.subarray(start, end + 1));
    }
    let base = DOCS, path = url.pathname;
    if (path.startsWith('/ort/') && ORT_DIR) { base = ORT_DIR; path = path.slice(4); }
    const file = normalize(join(base, decodeURIComponent(path)));
    if (!file.startsWith(base) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise(ok => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

test('three tracks are heard end to end and stored, in Chromium', { skip, timeout: 240000 }, async t => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip(`Chromium would not launch: ${e.message.split('\n')[0]}`); return; }
  const srv = await serve();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${srv.address().port}/harness.html`);
    const out = await page.evaluate(async ({ ortBase }) => {
      const A = globalThis.BetterfyAudio;
      const at = f => new URL('/models/' + f, location.href).href;
      const store = A.openAudioStore();
      await store.clear();
      const worker = new Worker('/audio-worker.js', { type: 'module' });
      const w = A.createWorkerEar(worker, { modelUrl: at('discogs-effnet-bsdynamic-1.onnx'), ortBase: ortBase ?? undefined,
        headUrls: { mtg_jamendo_moodtheme: at('mtg_jamendo_moodtheme-discogs-effnet-1.onnx'),
                    voice_instrumental: at('voice_instrumental-discogs-effnet-1.onnx'),
                    danceability: at('danceability-discogs-effnet-1.onnx') } });
      // Deezer's JSONP, faked: the same answer shape track/isrc: gives.
      const jsonp = async url => {
        const isrc = decodeURIComponent(url).split('isrc:')[1];
        return { id: 1000 + +isrc.slice(-1), isrc, duration: 4, readable: true, preview: new URL('/preview.mp3?' + isrc, location.href).href };
      };
      let loadMs = 0;
      const ctrl = A.createAudioController({
        store,
        lookup: (isrc, o) => A.lookup(isrc, { jsonp, ...o }),
        fetchPreview: url => A.fetchPreview(url, { fetch: (u, i) => fetch(u, i) }),
        decode: buf => A.decodeTo16k(buf),
        loadEar: async () => { const t0 = performance.now(); const r = await w.ready; loadMs = performance.now() - t0;
          return { ear: w.ear, heads: r.heads.length ? w.heads : undefined, summariseHeads: A.summariseHeads, names: r.heads }; },
      });
      const tracks = [1, 2, 3].map(i => ({ id: 'trk' + i, isrc: 'GBTST000000' + i, durationMs: 4000 }));
      const t0 = performance.now();
      const res = await ctrl.start(tracks);
      const ms = performance.now() - t0 - loadMs;
      const all = await A.openAudioStore().getAll();
      const recs = [...all.values()];
      return { res, vm: ctrl.vm(), n: all.size, valid: recs.every(A.validRecord), misses: recs.filter(r => r.miss).length,
               heads: recs.map(r => r.heads && Object.keys(r.heads).sort()), styles: recs.map(r => r.styles.length),
               patches: recs.map(r => r.sections.length), source: recs[0]?.source, loadMs, perTrackMs: ms / 3,
               same: recs.length === 3 && recs.every(r => r.emb.q === recs[0].emb.q) };
    }, { ortBase: ORT_DIR ? '/ort/' : null });

    assert.deepEqual(errors, []);
    assert.deepEqual(out.res, { done: 3, stopped: false }, JSON.stringify(out.vm));
    assert.equal(out.n, 3, 'three records in IndexedDB');
    assert.equal(out.misses, 0);
    assert.equal(out.valid, true);
    assert.deepEqual(out.styles, [10, 10, 10]);
    assert.ok(out.patches.every(p => p >= 1), `patches ${out.patches}`);
    for (const h of out.heads) assert.deepEqual(h, ['danceable', 'moods', 'v', 'voice']);
    assert.equal(out.source.kind, 'deezer-isrc');
    assert.equal(out.same, true, 'the same audio gives the same embedding every time');
    t.diagnostic(`model load ${Math.round(out.loadMs)} ms, ${Math.round(out.perTrackMs)} ms per track (4 s fixture)`);
  } finally {
    await browser.close();
    srv.close();
  }
});
