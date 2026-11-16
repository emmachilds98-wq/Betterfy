/* The service worker (docs/BUILD-6-PLAN.md F6). build-web.mjs writes it to
 * docs/sw.js with the build stamp filled in; web/app/offline.js registers it.
 *
 * What it does, and only this:
 *   - keeps the page's shell (the page, the shipped genre table, the manifest
 *     and icons) in a cache named after this build, so a reload with no signal
 *     opens the app instead of a browser error;
 *   - keeps each lazy bundle (engine, listening, the workers) once the page has
 *     fetched it, by its exact `?v=<build>` address, so nobody downloads a
 *     bundle for a screen they never open (CLAUDE.md: optional is zero-cost);
 *   - leaves everything else alone. It never answers for another origin
 *     (api.spotify.com, Last.fm, Deezer, Firestore, jsDelivr...), never for a
 *     request that asked to skip caches (version.js's update check is
 *     `cache: 'no-store'`, its install is `cache: 'reload'`), and never for
 *     the models, which are tens of MB and only for whoever switched listening on.
 *
 * No Background Sync: iOS Safari and Firefox have none, so decisions made
 * offline are replayed by the page itself when it is next open and online
 * (web/app/offline.js). */
const BUILD = '__BUILD__';
const PREFIX = 'betterfy-shell-';
const CACHE = PREFIX + BUILD;

// Fetched at install. The page under './' (its directory address, as REDIRECT
// is), the genre table the page cannot draw a screen without, and the install
// assets. The lazy bundles are not here on purpose (see above).
const SHELL = ['./', 'tags.json?v=' + BUILD, 'reports-worker.js?v=' + BUILD, 'manifest.webmanifest',
  'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];
// The page's own files that may be kept once fetched, when they carry this build's stamp.
const VERSIONED = /^(index\.html|tags\.json|engine\.js|audio\.js|engine-worker\.js|reports-worker\.js|audio-worker\.js|maest-worker\.js)$/;
const STATIC = /^(manifest\.webmanifest|icon\.svg|icon-192\.png|icon-512\.png|icon-maskable-512\.png|apple-touch-icon\.png)$/;

const scopeUrl = () => new URL(self.registration ? self.registration.scope : './', self.location.href);

/** Put whatever of the shell is missing into this build's cache. Each file on
 *  its own: one that fails (a deploy mid-way) does not keep out the rest. */
async function warm() {
  const c = await caches.open(CACHE);
  await Promise.all(SHELL.map(async f => {
    const u = new URL(f, scopeUrl()).href;
    if (await c.match(u)) return;
    try { const r = await fetch(u, { cache: 'no-cache' }); if (r.ok) await c.put(u, r); } catch { /* next time */ }
  }));
}

self.addEventListener('install', e => {
  // Take over at once: the shell in the new cache is the one a reload should
  // get. The page that is open keeps running what it loaded, and is offered
  // the new version through the existing update bar (offline.js).
  e.waitUntil(warm().then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith(PREFIX) && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
    for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'bf-sw', build: BUILD });
  })());
});

self.addEventListener('message', e => {
  const m = e.data || {};
  // "Update now" clears every cache before it reloads; the page asks for the
  // shell back once it is up, so the next reload offline still has one.
  if (m.type === 'warm') e.waitUntil(warm());
  if (m.type === 'build' && e.source) e.source.postMessage({ type: 'bf-sw', build: BUILD });
});

/** Which requests this worker answers. Exported shape for the unit test: a
 *  string saying how, or null for "not mine, let the browser do it". */
function route(req) {
  if (req.method !== 'GET') return null;
  const url = new URL(req.url);
  const scope = scopeUrl();
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return null;
  if (req.cache === 'no-store' || req.cache === 'reload' || url.searchParams.has('_')) return null;
  if (req.mode === 'navigate') return 'page';
  const name = url.pathname.slice(scope.pathname.length);
  if (VERSIONED.test(name) && url.searchParams.get('v') === BUILD) return 'kept';
  if (STATIC.test(name)) return 'kept';
  return null;
}

self.addEventListener('fetch', e => {
  const how = route(e.request);
  if (!how) return;
  e.respondWith(how === 'page' ? page(e.request) : kept(e.request));
});

/** The page: the network first, so a signal always gets the newest build; the
 *  cached copy when there is none. Stored under './' whatever the address
 *  (`/`, `/index.html`, `/?v=...`), since all of them are the same page. */
async function page(req) {
  const key = new URL('./', scopeUrl()).href;
  try {
    const r = await fetch(req);
    if (r.ok && r.type === 'basic') {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(key, copy)).catch(() => {});
    }
    return r;
  } catch (err) {
    const hit = await caches.match(key);
    if (hit) return hit;
    throw err;
  }
}

/** A file stamped with this build (or an icon): the cache first, since a
 *  stamped address never changes what it holds; kept on first fetch. */
async function kept(req) {
  const hit = await caches.match(req.url);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok && r.type === 'basic') {
    const copy = r.clone();
    caches.open(CACHE).then(c => c.put(req.url, copy)).catch(() => {});
  }
  return r;
}
