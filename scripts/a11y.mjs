// axe-core over every screen of the built app (the same offline states as `npm run shots`).
//   npm run build:web && npm run a11y [-- --json]
// Needs axe-core (npm i --no-save axe-core) and Playwright with Chromium (global is fine:
// NODE_PATH=$(npm root -g)). Exit 1 when any critical/serious violation is found;
// minor/moderate ones are printed.
import { createRequire } from 'node:module';
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch {
  try { ({ chromium } = createRequire(path.join(process.env.NODE_PATH?.split(':')[0] || '/', 'x.js'))('playwright')); }
  catch { console.error('Playwright missing: npm i -g playwright && npx playwright install chromium'); process.exit(2); }
}
let axeSrc;
try { axeSrc = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); }
catch { console.error('axe-core missing: npm i --no-save axe-core'); process.exit(2); }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../docs');
const tags = JSON.parse(fs.readFileSync(path.join(ROOT, 'tags.json'), 'utf8'));
const top = id => tags[id]?.[0]?.[0];
const want = { 'drum and bass': 'Rollers', 'house': 'House', 'techno': 'Techno', 'ambient': 'Ambient', 'hip hop': 'Hip Hop', 'indie': 'Indie' };
const byG = {}; for (const id of Object.keys(tags)) { const g = top(id); if (want[g]) (byG[g] ??= []).push(id); }
let tn = 0;
const mk = aid => { tn++; return { id: 'tr' + String(tn).padStart(20, '0'), name: 'Track ' + tn, popularity: 40, duration_ms: 200000, explicit: false, external_ids: { isrc: 'GB' + tn }, track_number: 1,
  album: { id: 'al' + tn, name: 'Album ' + tn, release_date: String(2005 + tn % 18), album_type: 'album', images: [] }, artists: [{ id: aid, name: 'Artist ' + aid.slice(0, 4) }] }; };
const playlists = Object.entries(want).map(([g, name], i) => ({ id: 'pl' + i, name, owner: { id: 'me' }, snapshot_id: 's1', tracks: (byG[g] || []).slice(0, 14).flatMap(id => [mk(id), mk(id)]) }));
playlists.push({ id: 'plx', name: 'Late Night', owner: { id: 'me' }, snapshot_id: 's1', tracks: (byG.ambient || []).slice(14, 20).map(mk) });
const liked = []; for (const g of Object.keys(want)) for (const id of (byG[g] || []).slice(20, 26)) liked.push(mk(id));
for (const p of playlists) liked.push(...p.tracks.slice(0, 3));
const page = items => ({ items, next: null, total: items.length });
const json = process.argv.includes('--json');
const results = [];

async function run(b, FORM, THEME) {
  const srv = http.createServer((q, r) => {
    let f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html';
    fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); return; }
      r.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : f.endsWith('.json') ? 'application/json' : 'application/octet-stream' }); r.end(d); });
  }).listen(0);
  const PORT = srv.address().port;
  const vp = FORM === 'phone' ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } };
  const ctx = await b.newContext({ ...vp, colorScheme: THEME });
  await ctx.addInitScript(t => {
    localStorage.setItem('bf_tok', JSON.stringify({ access_token: 'x', refresh_token: 'y', expires_at: Date.now() + 3.6e6 }));
    localStorage.setItem('betterfy-theme', JSON.stringify({ mode: t }));
  }, THEME);
  await ctx.route(/^https:\/\/(?!127)/, route => {
    const u = new URL(route.request().url());
    if (u.host !== 'api.spotify.com') return route.fulfill({ status: 404, body: '' });
    const p = u.pathname.replace('/v1', ''); let body = page([]);
    if (p === '/me') body = { id: 'me', display_name: 'Demo' };
    else if (p === '/me/playlists') body = page(playlists.map(({ tracks, ...x }) => x));
    else if (/^\/playlists\/[^/]+\/(items|tracks)$/.test(p)) { const pl = playlists.find(x => x.id === p.split('/')[2]); body = page((pl?.tracks || []).map(t => ({ added_at: '2024-03-01T00:00:00Z', item: t }))); }
    else if (p === '/me/tracks') body = page(liked.map(t => ({ added_at: '2024-05-01T00:00:00Z', track: t })));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const pg = await ctx.newPage();
  await pg.goto(`http://127.0.0.1:${PORT}/index.html`);
  await pg.waitForSelector('#app:not([hidden])', { timeout: 30000 }); await pg.waitForTimeout(800);
  await pg.evaluate(axeSrc);
  const collect = (r, name) => { for (const v of r.violations) results.push({ state: `${FORM}-${THEME}-${name}`, id: v.id, impact: v.impact, n: v.nodes.length, sample: v.nodes.slice(0, 3).map(n => n.target.join(' ') + (v.id === 'color-contrast' ? ' (' + (n.any[0]?.data ? `${n.any[0].data.fgColor} on ${n.any[0].data.bgColor} = ${n.any[0].data.contrastRatio}` : '') + ')' : '')) }); };
  const scan = async name => collect(await pg.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } })), name);
  for (const v of ['inbox', 'tidy', 'discover', 'lists', 'new', 'shuffle']) {
    await pg.evaluate(v => go(v), v); await pg.waitForTimeout(700); await scan(v);
  }
  await pg.evaluate(() => { go('lists'); openPlSheet(Object.keys(CFG)[0]); }); await pg.waitForTimeout(900); await scan('lists-sheet');
  await pg.evaluate(() => closePlSheet()); await pg.waitForTimeout(400);
  await pg.evaluate(() => go('inbox'));
  for (const sec of [null, 'sources', 'engine', 'history']) {
    await pg.evaluate(s => { S.uhOpen = s; openUnderHood(s); }, sec); await pg.waitForTimeout(sec === 'engine' ? 2500 : 900);
    await scan('settings' + (sec ? '-' + sec : ''));
    await pg.evaluate(() => openSettings(false)); await pg.waitForTimeout(400);
  }
  await ctx.close();
  const c2 = await b.newContext({ ...vp, colorScheme: THEME });
  await c2.addInitScript(t => localStorage.setItem('betterfy-theme', JSON.stringify({ mode: t })), THEME);
  await c2.route(/^https:\/\//, r => r.fulfill({ status: 404, body: '' }));
  const lp = await c2.newPage(); await lp.goto(`http://127.0.0.1:${PORT}/index.html`);
  await lp.waitForSelector('#land:not([hidden])'); await lp.waitForTimeout(400);
  await lp.evaluate(axeSrc);
  collect(await lp.evaluate(() => axe.run(document)), 'landing');
  await c2.close(); srv.close();
}

const b = await chromium.launch();
for (const F of ['desk', 'phone']) for (const T of ['dark', 'light']) await run(b, F, T);
await b.close();
const bad = results.filter(r => r.impact === 'critical' || r.impact === 'serious');
if (json) console.log(JSON.stringify(results, null, 1));
else for (const r of results) console.log(`${r.impact.padEnd(9)} ${r.id.padEnd(26)} x${r.n}  ${r.state}  ${r.sample.join(' | ')}`);
console.log(`axe: ${bad.length} critical/serious, ${results.length - bad.length} minor/moderate (state x rule)`);
process.exit(bad.length ? 1 : 0);
