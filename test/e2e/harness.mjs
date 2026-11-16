// Shared plumbing for the browser specs: a fake Spotify (test/fixtures), the
// built page served from it, and a Chromium context that signs in with a test
// token instead of PKCE and sends api.spotify.com / accounts.spotify.com to
// the fake. The page itself is unmodified.
//
// Locally a missing Playwright skips the specs; in CI (CI set) it is a failure.
import { createRequire } from 'node:module';
import { makeAccount } from '../fixtures/accounts.mjs';
import { startFakeSpotify } from '../fixtures/fake-spotify.mjs';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
export const skip = !chromium && !process.env.CI && 'playwright not installed';

export async function launch() {
  if (!chromium) throw new Error('playwright must be installed in CI');
  return chromium.launch();
}

/**
 * @param {import('playwright').Browser} browser
 * @param {{ kind?: string, account?: object, phone?: boolean, tokenExpiresIn?: number, serviceWorkers?: boolean }} [o]
 *   serviceWorkers: let the page register docs/sw.js (blocked otherwise, as before).
 */
export async function openApp(browser, { kind = 'small', account, phone = true, tokenExpiresIn = 3.6e6, serviceWorkers = false } = {}) {
  const fake = await startFakeSpotify(account ?? makeAccount(kind));
  const vp = phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 860 } };
  const ctx = await browser.newContext({ ...vp, serviceWorkers: serviceWorkers ? 'allow' : 'block' });
  await ctx.addInitScript(ms => {
    // Init scripts run in every frame, the sandboxed Deezer lookup frame too,
    // which has no storage: sign in from the page itself only.
    if (window !== window.top) return;
    if (localStorage.getItem('bf_tok')) return;   // only the first load of a context signs in
    localStorage.setItem('bf_tok', JSON.stringify({ access_token: 'x', refresh_token: 'y', expires_at: Date.now() + ms }));
  }, tokenExpiresIn);
  // Wrapped so the airplane switch below can take the routes off and put them back.
  const routeAll = async () => {
    await ctx.route(/^https:\/\/(api|accounts)\.spotify\.com\//, async route => {
      const req = route.request(), u = new URL(req.url());
      let r;
      try {
        r = await fetch(fake.url + u.pathname + u.search, {
          method: req.method(), headers: req.headers(), body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postDataBuffer() ?? undefined });
      } catch { return route.abort('connectionreset').catch(() => {}); }   // the fake cut the connection on purpose
      const headers = Object.fromEntries(r.headers);
      delete headers['content-encoding']; delete headers['content-length'];
      await route.fulfill({ status: r.status, headers, body: Buffer.from(await r.arrayBuffer()) });
    });
    await ctx.route(/^https:\/\/(?!(api|accounts)\.spotify\.com)/, r => r.fulfill({ status: 404, body: '' }));
  };
  await routeAll();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => {
    // The sandboxed Deezer lookup frame (web/app/engine.js deezerFrame) has no
    // storage or service worker on purpose; the browser's own injected setup
    // tripping over that there is not the page's error.
    if (/context is sandboxed and lacks the 'allow-same-origin' flag/.test(e.message)) return;
    errors.push(e.message);
  });
  await page.goto(fake.url + '/index.html');
  // Airplane mode for a page with its service worker (serviceWorkers: true).
  // Playwright bypasses service workers while any route is installed, so the
  // routes come off for the offline stretch (nothing reaches Spotify then
  // anyway) and go back on when the signal returns.
  const airplane = async on => {
    if (on) { await ctx.unrouteAll({ behavior: 'ignoreErrors' }); await ctx.setOffline(true); }
    else { await ctx.setOffline(false); await routeAll(); }
  };
  return { page, fake, ctx, errors, airplane, close: async () => { await ctx.close(); await fake.close(); } };
}

/** Wait until the app has read the library and drawn a screen. */
export async function ready(page, timeout = 45000) {
  await page.waitForSelector('#app:not([hidden])', { timeout });
}

/** Wait for File to show a card with a leading suggestion; returns the track id and that playlist id. */
export async function fileCard(page, timeout = 45000) {
  await page.waitForSelector('#swipeCard[data-best]', { timeout });
  // The queue is re-sorted and the screen repainted once the listening fetch
  // (top artists / tracks / recently played) lands, a second or two after the
  // first card shows. Let that happen first, or a tap can land on a card that
  // is about to be redrawn.
  await page.waitForFunction(() => typeof LISTENING_CACHE !== 'undefined' && !!LISTENING_CACHE?.weights, null, { timeout })
    .catch(() => {});
  await page.waitForTimeout(500);
  await page.waitForSelector('#swipeCard[data-best]', { timeout });
  return page.evaluate(() => {
    const c = document.querySelector('#swipeCard');
    return { track: R.backlog[Math.min(S.inboxAt, R.backlog.length - 1)].id, best: c.dataset.best, left: R.backlog.length };
  });
}

/** Poll until `fn()` is truthy (fn runs in node), or fail with `what`. */
export async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await new Promise(r => setTimeout(r, 50));
  }
}

/** A one-finger horizontal drag on `sel` as real touch events: dx px over `ms`. */
export async function swipe(page, sel, dx, ms = 300, { exact = false } = {}) {
  await page.evaluate(({ sel, dx, ms, exact }) => new Promise(done => {
    const el = document.querySelector(sel), r = el.getBoundingClientRect();
    const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
    const mk = (x, y) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
    const fire = (type, x, y) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true,
      touches: type === 'touchend' ? [] : [mk(x, y)], changedTouches: [mk(x, y)] }));
    fire('touchstart', x0, y0);
    const steps = 10; let i = 0;
    // exact: space the moves by spinning in one task, so the gesture's speed is
    // what was asked even when a loaded machine runs timers late (a flick's
    // verdict depends on event timeStamps, which setTimeout drift stretches).
    if (exact) {
      const spin = until => { while (performance.now() < until) { /* wait */ } };
      let t = performance.now();
      for (i = 1; i <= steps; i++) { spin(t += ms / steps); fire('touchmove', x0 + dx * i / steps, y0); }
      fire('touchend', x0 + dx, y0); done(); return;
    }
    const tick = () => {
      i++; fire('touchmove', x0 + dx * i / steps, y0);
      if (i < steps) setTimeout(tick, ms / steps); else { fire('touchend', x0 + dx, y0); done(); }
    };
    setTimeout(tick, ms / steps);
  }), { sel, dx, ms, exact });
}
