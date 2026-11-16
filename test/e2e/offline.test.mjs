// F6 (docs/BUILD-6-PLAN.md): the service worker and the offline decision queue,
// in airplane mode against the fake Spotify. Ten decisions made offline are
// held, survive an offline reload (which shows the app, not a browser error),
// and are applied exactly once each when the page is next open online, with
// History matching. The build stamp still matches across page, workers and the
// service worker's cache with the worker registered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skip, launch, openApp, ready, fileCard, swipe, until } from './harness.mjs';

let browser, app;
test.before(async () => { if (!skip) browser = await launch(); });
test.after(async () => { await browser?.close(); });
test.afterEach(async () => { if (app) { await app.close(); app = null; } });

const posts = (fake, pl, track) => fake.writes().filter(w => w.method === 'POST'
  && w.path === `/playlists/${pl}/items` && w.body?.uris?.includes('spotify:track:' + track)).length;
const pageBuild = page => page.evaluate(() => document.querySelector('meta[name="bf-build"]').content);

/** Controlled by the worker, with the shell in its cache. */
async function swReady(page) {
  await page.waitForFunction(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg?.active || !navigator.serviceWorker.controller) return false;
    const c = await caches.open('betterfy-shell-' + BUILD);
    return !!(await c.match(new URL('./', location.href).href)) && !!(await c.match(new URL('tags.json?v=' + BUILD, location.href).href));
  }, null, { timeout: 20000, polling: 200 });
}

test('ten decisions offline are applied once each when the page is next open online, History matching', { skip, timeout: 240000 }, async () => {
  app = await openApp(browser, { kind: 'typical', serviceWorkers: true });
  const { page, fake, airplane, errors } = app;
  await ready(page);
  await swReady(page);

  // The build stamp, with the worker registered: the page, the service
  // worker's cache, and the engine worker it serves all carry one build.
  const build = await pageBuild(page);
  const stamps = await page.evaluate(async () => {
    const keys = await caches.keys();
    const w = await (await fetch('engine-worker.js?v=' + BUILD)).text();
    const sw = await new Promise(ok => {
      navigator.serviceWorker.addEventListener('message', e => e.data?.type === 'bf-sw' && ok(e.data.build));
      navigator.serviceWorker.controller.postMessage({ type: 'build' });
    });
    return { BUILD, keys, worker: w.match(/importScripts\('engine\.js\?v=([\w-]+)'\)/)?.[1], sw };
  });
  assert.equal(stamps.BUILD, build);
  assert.equal(stamps.sw, build, 'the service worker is from the same build');
  assert.equal(stamps.worker, build, 'the engine worker it serves imports the same build');
  assert.deepEqual(stamps.keys.filter(k => k.startsWith('betterfy-shell-')), ['betterfy-shell-' + build]);

  // Airplane mode.
  await airplane(true);
  assert.equal(await page.evaluate(() => navigator.onLine), false);
  const writesBefore = fake.writes().length;
  const made = [];
  for (let i = 0; i < 10; i++) {
    const c = await fileCard(page);
    await swipe(page, '#swipeCard', 220);
    await until(() => page.evaluate(n => R.backlog.length === n && !S.filing, c.left - 1), `decision ${i + 1} to leave the deck`, 10000);
    made.push({ track: c.track, best: c.best });
    await page.waitForTimeout(450);   // past the flight lock
  }
  assert.equal(fake.writes().length, writesBefore, 'nothing reached Spotify while offline');
  await until(() => page.evaluate(() => document.querySelector('#syncWait:not([hidden])')?.textContent ?? ''), 'the waiting line');
  assert.match(await page.textContent('#syncWait'), /^10 decisions waiting to sync/);
  const held = await page.evaluate(async () => (await getLog()).filter(x => x.op === 'add').map(x => ({ t: x.trackIds[0], pl: x.playlistId, q: !!x.queued })));
  assert.equal(held.length, 10);
  assert.ok(held.every(x => x.q), 'History has each one, marked as waiting');

  // A reload with no signal shows the app, from the worker's cache.
  await page.reload();
  await ready(page);
  assert.equal(await page.evaluate(() => navigator.onLine), false);
  await until(() => page.evaluate(() => document.querySelector('#syncWait:not([hidden])')?.textContent ?? ''), 'the waiting line after an offline reload');
  assert.match(await page.textContent('#syncWait'), /^10 decisions waiting to sync/);
  assert.equal(fake.writes().length, writesBefore, 'still nothing sent');

  // Back online, reload: each decision is applied, once.
  await airplane(false);
  await page.reload();
  await ready(page);
  await until(() => page.evaluate(async () => !(await idb.get('offline_queue'))?.length), 'the queue to empty', 120000);
  // A second open must not send anything again.
  await page.reload();
  await ready(page);
  await page.waitForTimeout(2500);

  for (const d of made) {
    assert.equal(posts(fake, d.best, d.track), 1, `${d.track} sent to ${d.best} exactly once`);
    assert.equal(fake.playlist(d.best).filter(x => x === d.track).length, 1, `${d.track} is in ${d.best} once`);
  }
  const log = await page.evaluate(async () => (await getLog()).filter(x => x.op === 'add'));
  assert.equal(log.length, 10, 'one History entry per decision, none doubled by replay');
  assert.deepEqual(log.map(x => `${x.trackIds[0]}>${x.playlistId}`).sort(), made.map(d => `${d.track}>${d.best}`).sort());
  assert.ok(log.every(x => !x.queued && x.syncedAt && !x.undoneAt), 'each entry is marked sent');
  assert.equal(await page.evaluate(() => document.querySelector('#syncWait:not([hidden])')), null, 'the waiting line is gone');
  assert.deepEqual(errors, [], 'no uncaught page errors');
});

test('undoing a decision that has not been sent takes it out of the queue; nothing is sent for it', { skip, timeout: 120000 }, async () => {
  app = await openApp(browser, { kind: 'typical', serviceWorkers: true });
  const { page, fake, airplane, errors } = app;
  await ready(page);
  await swReady(page);
  await airplane(true);
  const c = await fileCard(page);
  await swipe(page, '#swipeCard', 220);
  await until(() => page.evaluate(async () => (await idb.get('offline_queue'))?.length === 1), 'the queued filing');
  await until(() => page.evaluate(async () => !!(await getLog()).find(x => x.op === 'add')?.queued), 'its History entry');
  await page.evaluate(async () => undoAction((await getLog()).find(x => x.op === 'add').at));
  assert.equal(await page.evaluate(async () => (await idb.get('offline_queue')).length), 0);
  await airplane(false);
  await page.reload();
  await ready(page);
  await page.waitForTimeout(2500);
  assert.equal(posts(fake, c.best, c.track), 0, 'an undone decision is never sent');
  const log = await page.evaluate(async () => (await getLog()).map(x => x.op));
  assert.deepEqual(log.slice(0, 2), ['undo', 'add']);
  assert.deepEqual(errors, []);
});

test('the update check is never answered by the worker', { skip, timeout: 120000 }, async () => {
  app = await openApp(browser, { kind: 'small', serviceWorkers: true });
  const { page, ctx, airplane } = app;
  await ready(page);
  await swReady(page);
  // The worker's copy of the page now says another build. version.js asks the
  // server with no-store: it must get the server's answer, never this copy.
  await page.evaluate(async () => {
    const c = await caches.open('betterfy-shell-' + BUILD);
    await c.put(new URL('./', location.href).href, new Response('<meta name="bf-build" content="2000-01-01-0000">', { headers: { 'content-type': 'text/html' } }));
  });
  await airplane(true); await ctx.setOffline(false);   // routes off, so the worker is in the path; signal on
  // Coming back online reaches the service worker a moment after the page, so
  // a fetch through it can still fail at first. Wait for it to answer (or give
  // up after 10 s), then check what it answered: the server's build, not the copy.
  let seen;
  for (const until = Date.now() + 10000; Date.now() < until; await page.waitForTimeout(200)) {
    seen = await page.evaluate(() => publishedBuild().then(b => ({ b }), e => ({ e: String(e?.message ?? e) })));
    if (!seen.e) break;
  }
  assert.equal(seen.b, await pageBuild(page), 'the check reads the server' + (seen.e ? ' (last error: ' + seen.e + ')' : ''));
  assert.equal(await page.evaluate(() => checkForUpdate(true)), false);
  await ctx.setOffline(true);
  assert.match(await page.evaluate(() => publishedBuild().then(b => 'answered ' + b, e => 'failed ' + e.message)), /^failed/,
    'offline, the check fails rather than reading the cached page');
  assert.equal(await page.isVisible('#updateBar'), false);
});
