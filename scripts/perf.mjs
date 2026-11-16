// Performance on a 5k library (docs/BUILD-6-PLAN.md P1; budgets in BUILD-5-PLAN §7).
//
//   npm run build:web && npm run perf [-- --throttle=4 --liked=5000 --json]
//
// Builds a deterministic synthetic library (fake ids, real artist ids from
// docs/tags.json so scoring does real work), writes it straight into the page's
// IndexedDB cache, loads docs/ in Chromium offline and prints: first render,
// buildReports on the main thread, long tasks (>50 ms) while File sits open,
// and screen-change time. Exits 1 when a bar is missed.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.error('Playwright is not installed.'); process.exit(2); }
const arg = (n, d) => (process.argv.find(a => a.startsWith(`--${n}=`)) ?? '').split('=')[1] ?? d;
const THROTTLE = +arg('throttle', 4), N_LIKED = +arg('liked', 5000), N_PL = +arg('playlists', 60);
const JSON_OUT = process.argv.includes('--json');
const ROOT = arg('root', path.join(path.dirname(fileURLToPath(import.meta.url)), '../docs'));

/** The synthetic library: deterministic, no network, no real track ids. */
function syntheticLibrary(nLiked, nPl) {
  const tags = JSON.parse(readFileSync(path.join(ROOT, 'tags.json'), 'utf8'));
  const artistIds = Object.keys(tags).sort().slice(0, 1500);
  let seed = 12345; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // Skewed, as listening is: a few hundred artists carry most of a library.
  const pick = () => artistIds[Math.floor(rnd() * rnd() * artistIds.length)];
  const syl = ['ka', 'ro', 'mi', 'dex', 'vel', 'an', 'tor', 'lu', 'sen', 'ray', 'fo', 'zi'];
  const word = n => Array.from({ length: n }, () => syl[Math.floor(rnd() * syl.length)]).join('');
  let n = 0;
  const track = () => { n++; const a = pick();
    return { id: 't' + String(n).padStart(21, '0'), name: word(2) + ' ' + word(2), artists: [{ id: a, name: 'Artist ' + a.slice(0, 6) }],
      album: 'Album ' + (n % 900), albumType: 'album', released: String(2000 + (n % 25)), art: null,
      duration_ms: 180000 + (n * 7919) % 120000, isrc: 'XX' + String(n).padStart(10, '0'),
      added_at: new Date(Date.UTC(2015, 0, 1) + n * 3e6).toISOString() }; };
  const liked = Array.from({ length: nLiked }, track);
  const names = ['House', 'Techno', 'Rollers', 'Jungle', 'Ambient', 'Hip Hop', 'UKG', 'Indie'];
  const playlists = Array.from({ length: nPl }, (_, i) => {
    // Genre playlists are built around a few artists; ~40% of each is a liked song.
    const base = Array.from({ length: 6 }, pick);
    const tracks = Array.from({ length: 110 }, (_, j) => {
      if (j % 5 < 2) return liked[Math.floor(rnd() * liked.length)];
      const t = track(); t.artists = [{ id: base[j % 6], name: 'Artist ' + base[j % 6].slice(0, 6) }]; return t; });
    return { id: 'p' + String(i).padStart(21, '0'), name: names[i % 8] + ' ' + (1 + (i >> 3)), snapshot_id: 's1', tracks };
  });
  return { captured_at: new Date(0).toISOString(), user: { id: 'me', name: 'Perf' }, playlists, liked };
}

const lib = syntheticLibrary(N_LIKED, N_PL);
const mime = f => f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : f.endsWith('.json') ? 'application/json' : 'application/octet-stream';
const srv = createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html';
  try { const b = readFileSync(f); r.writeHead(200, { 'content-type': mime(f) }); r.end(b); }
  catch { r.writeHead(404); r.end(); } }).listen(0);
const base = `http://127.0.0.1:${srv.address().port}/`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await ctx.route(/^https:\/\//, r => r.fulfill({ status: 404, body: '' }));
await ctx.addInitScript(() => {
  localStorage.setItem('bf_tok', JSON.stringify({ access_token: 'x', refresh_token: 'y', expires_at: Date.now() + 3.6e6 }));
  window.__long = [];
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push({ at: Math.round(e.startTime), ms: Math.round(e.duration) }); })
    .observe({ type: 'longtask', buffered: true }); } catch { /* no longtask support */ }
  // Who held the thread: the scripts behind each slow frame (Chromium's long-animation-frame).
  window.__loaf = [];
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__loaf.push({ at: Math.round(e.startTime), ms: Math.round(e.duration),
    by: (e.scripts || []).map(x => `${x.invoker || x.sourceFunctionName || '?'}:${Math.round(x.duration)}`).slice(0, 4) }); })
    .observe({ type: 'long-animation-frame', buffered: true }); } catch { /* older Chromium */ }
  const watch = () => { const app = document.getElementById('app');
    if (!app) return requestAnimationFrame(watch);
    if (!app.hidden) { window.__firstRender = performance.now(); return; }
    new MutationObserver((_, o) => { if (!app.hidden) { window.__firstRender = performance.now(); o.disconnect(); } }).observe(app, { attributes: true }); };
  document.addEventListener('DOMContentLoaded', watch);
});
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
await page.goto(base + 'tags.json');
await page.evaluate(async lib => { await new Promise((ok, bad) => {
  const r = indexedDB.open('betterfy', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put(lib, 'library'); tx.oncomplete = ok; tx.onerror = bad; }; r.onerror = bad; }); }, lib);
const cdp = await ctx.newCDPSession(page);
if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
await page.goto(base + 'index.html');
await page.waitForFunction(() => window.__firstRender, null, { timeout: 180000 });
const firstRender = await page.evaluate(() => Math.round(window.__firstRender));
const marks = await page.evaluate(() => performance.getEntriesByType('mark').map(m => m.name + '@' + Math.round(m.startTime)));
const bootLong = await page.evaluate(() => window.__long.slice());
// Background work (listening resume, analysis, sync, tag fills) runs while File is open.
await page.waitForTimeout(8000);
const allLong = await page.evaluate(() => window.__long.slice());
const bgLong = allLong.slice(bootLong.length);

// The same rebuild a sync or a tag fill does, through the worker: what the page's thread pays for it.
const viaWorker = await page.evaluate(async () => { const n = window.__long.length; const t = performance.now();
  if (typeof refreshReports === 'function') await refreshReports(); const wallMs = Math.round(performance.now() - t); await new Promise(r => setTimeout(r, 400));
  return { wallMs, longTasks: window.__long.slice(n) }; });
const rebuild = await page.evaluate(() => { const t = performance.now(); const R2 = buildReports(LIB, CFG, TAGS);
  return { ms: Math.round(performance.now() - t), backlog: R2.backlog.length }; });
const screens = [];
for (const v of ['tidy', 'discover', 'lists', 'inbox'])
  screens.push({ v, ms: await page.evaluate(v => new Promise(ok => { const t = performance.now(); go(v);
    requestAnimationFrame(() => requestAnimationFrame(() => ok(Math.round(performance.now() - t)))); }), v) });
const out = { throttle: THROTTLE, liked: N_LIKED, playlists: N_PL, firstRenderMs: firstRender, marks, bootLongTasks: bootLong,
  backgroundLongTasks: bgLong, slowFrames: await page.evaluate(() => window.__loaf.filter(f => f.ms > 50)), buildReportsMainThreadMs: rebuild.ms, refreshViaWorker: viaWorker, backlog: rebuild.backlog,
  screenChangeMs: Object.fromEntries(screens.map(s => [s.v, s.ms])), pageErrors: errors };
console.log(JSON.stringify(out, null, JSON_OUT ? 0 : 1));
await browser.close(); srv.close();
const bad = [];
if (firstRender >= 1000) bad.push(`first render ${firstRender} ms >= 1000`);
if (bgLong.some(l => l.ms > 50)) bad.push('background long task > 50 ms');
if (Math.max(...screens.map(s => s.ms)) >= 100) bad.push('screen change >= 100 ms');
if (bad.length) { console.error('Budgets missed: ' + bad.join('; ')); process.exit(1); }
