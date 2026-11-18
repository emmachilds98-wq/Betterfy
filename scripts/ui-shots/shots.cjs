// Screenshots every screen of the built app against a synthetic library.
//
//   npm run shots                      desktop + phone, dark + light
//   node scripts/ui-shots/shots.cjs --only=desk-dark
//
// No network and no Spotify account: the app is served from docs/ on a local
// port, sign-in is a fake token in localStorage, and every call to
// api.spotify.com is answered from a library generated here out of real artist
// ids in docs/tags.json (so suggestions, tags and axes behave as they would),
// with invented names. Everything else off-host gets a 404, which is also what
// keeps Google Fonts out: the shots use the fallback faces, so compare them with
// each other rather than with the live site.
//
// Needs Playwright with Chromium. It is not a dependency of this repo; any
// global install works (NODE_PATH=$(npm root -g) if it is not found).
let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.error('Playwright is not installed. npm i -g playwright && npx playwright install chromium'); process.exit(1); }
const fs = require('fs'), path = require('path'), http = require('http');
const ROOT = path.join(__dirname, '../../docs'), OUT = path.join(__dirname, 'out');
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7);
const tags = JSON.parse(fs.readFileSync(path.join(ROOT, 'tags.json'), 'utf8'));
const top = id => tags[id]?.[0]?.[0];
const want = { 'drum and bass':'Rollers', 'jungle':'Jungle & Breaks', 'house':'House', 'techno':'Techno', 'ambient':'Ambient', 'hip hop':'Hip Hop', 'uk garage':'UKG', 'indie':'Indie' };
const byG = {}; for (const id of Object.keys(tags)) { const g = top(id); if (want[g]) (byG[g] ??= []).push(id); }
const syl = ['ka','ro','mi','dex','vel','an','tor','lu','sen','ray','fo','zi','nor','bel','quin'];
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const nm = n => Array.from({length:n}, () => syl[Math.floor(rnd()*syl.length)]).join('');
const cap = s => s[0].toUpperCase()+s.slice(1);
const artists = {}; const A = id => artists[id] ??= { id, name: cap(nm(2)) + (rnd()<.4 ? ' ' + cap(nm(2)) : '') };
let tn = 0;
const mkTrack = aid => { tn++; return { id: 'tr' + String(tn).padStart(20,'0'), name: cap(nm(2)) + (rnd()<.5 ? ' ' + cap(nm(1)) : ''),
  popularity: 40, duration_ms: 180000 + Math.floor(rnd()*120000), explicit:false, external_ids:{ isrc:'GB' + tn }, track_number:1,
  album:{ id:'al'+tn, name: cap(nm(2)), release_date: String(2005 + Math.floor(rnd()*19)), album_type:'album', images:[] }, artists:[A(aid)] }; };
const playlists = [];
for (const [g, name] of Object.entries(want)) {
  const ids = (byG[g] || []).slice(0, 14);
  const tracks = ids.flatMap(id => [mkTrack(id), mkTrack(id)]);
  playlists.push({ id: 'pl' + playlists.length, name, owner:{ id:'me' }, snapshot_id:'s1', tracks });
}
playlists.push({ id:'plx', name:'Late Night', owner:{id:'me'}, snapshot_id:'s1', tracks: (byG['ambient']||[]).slice(14,20).map(mkTrack) });
playlists.push({ id:'ply', name:'Gym', owner:{id:'me'}, snapshot_id:'s1', tracks: (byG['techno']||[]).slice(14,20).map(mkTrack) });
const liked = [];
for (const g of Object.keys(want)) for (const id of (byG[g]||[]).slice(20, 26)) liked.push(mkTrack(id));
for (const p of playlists) liked.push(...p.tracks.slice(0, 3));
const page = items => ({ items, next:null, total:items.length });
async function shoot(b, FORM, THEME) {
  const srv = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html';
    fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, {'content-type': f.endsWith('.html')?'text/html':f.endsWith('.js')?'text/javascript':f.endsWith('.json')?'application/json':f.endsWith('.svg')?'image/svg+xml':'application/octet-stream'}); r.end(b); }); }).listen(0);
  const PORT = srv.address().port;
  const vp = FORM === 'phone' ? { viewport:{ width:390, height:844 }, deviceScaleFactor:1, isMobile:true, hasTouch:true }
    : { viewport:{ width: FORM === 'wide' ? 1440 : 1280, height:860 } };   // wide: L1's second desktop width
  const ctx = await b.newContext({ ...vp, colorScheme: THEME });
  await ctx.addInitScript(t => { localStorage.setItem('bf_tok', JSON.stringify({ access_token:'x', refresh_token:'y', expires_at: Date.now()+3.6e6 }));
    localStorage.setItem('betterfy-theme', JSON.stringify({ mode:t })); }, THEME);
  await ctx.route(/^https:\/\/(?!127)/, async route => {
    const u = new URL(route.request().url());
    if (u.host === 'api.spotify.com') {
      const p = u.pathname.replace('/v1','');
      let body = {};
      if (p === '/me') body = { id:'me', display_name:'Demo listener' };
      else if (p === '/me/playlists') body = page(playlists.map(({tracks, ...x}) => x));
      else if (/^\/playlists\/[^/]+\/(items|tracks)$/.test(p)) { const pl = playlists.find(x => x.id === p.split('/')[2]); body = page(pl.tracks.map(t => ({ added_at:'2024-03-01T00:00:00Z', item:t }))); }
      else if (p === '/me/tracks') body = page(liked.map(t => ({ added_at:'2024-05-01T00:00:00Z', track:t })));
      else if (p.startsWith('/me/top/') || p.startsWith('/me/player/recently')) body = page([]);
      else body = page([]);
      return route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify(body) });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => console.log(`[${FORM}-${THEME}] page error:`, e.message));
  await pg.goto(`http://127.0.0.1:${PORT}/index.html`);
  await pg.waitForSelector('#app:not([hidden])', { timeout: 30000 });
  await pg.waitForTimeout(800);
  // A full-page screenshot resizes the emulated screen and Chromium drops the
  // touch emulation with it: every phone screen after the first then matched
  // (hover:hover) and (pointer:fine), showing the keyboard hint and hiding the
  // touch-only controls. Turned back on after each shot.
  const cdp = FORM === 'phone' ? await ctx.newCDPSession(pg) : null;
  const touchBack = () => cdp?.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  // The four tabs, then Library's two sub-screens (Engine is a Settings section).
  const views = ['inbox','tidy','discover','lists','new','shuffle'];
  for (const v of views) {
    await pg.evaluate(v => { try { go(v); } catch (e) { console.log(e); } }, v);
    await pg.waitForTimeout(700);
    await pg.screenshot({ path: path.join(OUT, `${FORM}-${THEME}-${v}.png`), fullPage: true });
    await touchBack();
  }
  // Discover with picks (Wave F): the card, then every pick as a playable row. The fake
  // library stands in for a run's results, so no Deezer or Last.fm is asked.
  await pg.evaluate(() => {
    const pl = Object.keys(CFG).filter(id => CFG[id].target);
    S.discover = LIB.playlists.flatMap(p => p.tracks).slice(0, 8).map((t, i) => ({
      id: t.id, track: t.name, artist: t.artists?.[0]?.name, album: t.album, released: t.released, dur: t.duration_ms, art: t.art,
      isrc: i === 3 ? null : 'GBZZZ00000' + i, via: ['Demo artist'], tags: [],
      suggest: pl.length ? [{ id: pl[i % pl.length], name: CFG[pl[i % pl.length]].name, axis: 'genre', score: [0.8, 0.55, 0.3][i % 3] }] : [] }));
    S.discAt = 0; S.discoverFrom = 'everything you listen to';
    go('discover');
  });
  await pg.waitForTimeout(700);
  await pg.screenshot({ path: path.join(OUT, `${FORM}-${THEME}-discover-picks.png`), fullPage: true });
  await touchBack();
  // After Next: the card moved on while the device still plays the first pick. The bar
  // has to belong to the card (▶ for it) and say what is still playing, quietly.
  await pg.evaluate(() => {
    const first = S.discover[0];
    Object.assign(PLAYER, { id: first.id, name: first.track, device: 'Demo phone', dur: first.dur, pos: 61000,
                            playing: true, lastPoll: Date.now() + 60000 });
    S.discAt = 1; render();
  });
  await pg.waitForTimeout(500);
  await pg.locator('.card.disc').screenshot({ path: path.join(OUT, `${FORM}-${THEME}-discover-next.png`) });
  await touchBack();
  // Library's playlist detail sheet (UI-E).
  await pg.evaluate(() => { go('lists'); openPlSheet(Object.keys(CFG)[0]); });
  await pg.waitForTimeout(900);
  await pg.screenshot({ path: path.join(OUT, `${FORM}-${THEME}-lists-sheet.png`) });
  await pg.evaluate(() => closePlSheet());
  await pg.waitForTimeout(400);
  await touchBack();
  // The Settings sheet, closed to open: its sections one at a time (UI-D).
  await pg.evaluate(() => go('inbox'));
  for (const sec of [null, 'sources', 'engine', 'history']) {
    await pg.evaluate(s => { try { S.uhOpen = s; openUnderHood(s); } catch (e) { console.log(e); } }, sec);
    await pg.waitForTimeout(sec === 'engine' ? 2500 : 900);
    await pg.screenshot({ path: path.join(OUT, `${FORM}-${THEME}-settings${sec ? '-' + sec : ''}.png`) });
    await pg.evaluate(() => openSettings(false));
    await pg.waitForTimeout(400);
    await touchBack();
  }
  // File again with a ListenVM fixture (UI-5): the status line's listening part
  // and the listening indicator in the chrome. Until UI-2's listenPill() ships (it
  // returns '' on main) the slot gets a stand-in pill so its placement shows.
  await pg.evaluate(() => {
    go('inbox');
    setListen({ state: 'running', done: 37, total: 412, missed: {}, heard: 1284 });
    const slot = document.getElementById('listenSlot');
    if (slot && !slot.innerHTML) slot.innerHTML = '<span class="ui5-standin" style="display:inline-flex;align-items:center;gap:8px;'
      + 'padding:7px 13px;border-radius:999px;border:1px solid var(--line-2);background:var(--surface-2);color:var(--ink);'
      + 'font:600 12.5px var(--mono);white-space:nowrap">▮▮▮▯▯ Listening · 37 / 412</span>';
  });
  await pg.waitForTimeout(700);
  await pg.screenshot({ path: path.join(OUT, `${FORM}-${THEME}-file-listening.png`), fullPage: FORM !== 'phone' });
  await pg.evaluate(() => setListen(null));
  await ctx.close();
  // The landing page: same server, no token.
  const c2 = await b.newContext({ ...vp, colorScheme: THEME });
  await c2.addInitScript(t => localStorage.setItem('betterfy-theme', JSON.stringify({ mode:t })), THEME);
  await c2.route(/^https:\/\//, r => r.fulfill({ status: 404, body: '' }));
  const lp = await c2.newPage();
  await lp.goto(`http://127.0.0.1:${PORT}/index.html`);
  await lp.waitForSelector('#land:not([hidden])');
  await lp.waitForTimeout(400);
  await lp.screenshot({ path: path.join(OUT, `${FORM}-${THEME}-landing.png`), fullPage: true });
  await c2.close(); srv.close();
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch();
  for (const FORM of ['desk', 'phone', 'wide']) for (const THEME of ['dark', 'light']) {
    if (only && only !== `${FORM}-${THEME}`) continue;
    if (!only && FORM === 'wide' && THEME === 'light') continue;   // 1440 once, in dark: the layout check
    await shoot(b, FORM, THEME);
    console.log(`${FORM}-${THEME}: done`);
  }
  await b.close();
  console.log(`Screenshots in ${path.relative(process.cwd(), OUT)}/`);
}
main().catch(e => { console.error(e); process.exit(1); });
