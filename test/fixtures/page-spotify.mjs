// A sandbox for the page's Spotify write helpers (sp, plCall, delTracks,
// playlistEntries, logAction, undoAction ...) sliced out of the built
// docs/index.html, with an in-memory IndexedDB and a fake Spotify that keeps
// real playlists as arrays of slots. Shared by webundo-group.test.mjs and
// spotify-feb2026.test.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const BUNDLE = readFileSync(new URL('../../docs/index.html', import.meta.url), 'utf8');

export function slice(from, to, what) {
  const i = BUNDLE.indexOf(from), j = BUNDLE.indexOf(to, i + 1);
  assert.ok(i > 0 && j > i, `${what} not found — rebuild with node build-web.mjs`);
  return BUNDLE.slice(i, j);
}

/** Cross-realm values (built inside the vm) brought home for deepEqual. */
export const own = x => JSON.parse(JSON.stringify(x));

/** Just enough IndexedDB for the app's `idb` helper, held in memory. */
function fakeIndexedDB() {
  const data = new Map();
  const later = (r, prop, value) => setTimeout(() => { r.result = value; r[prop]?.call(r); }, 0);
  const store = {
    get: k => { const r = {}; later(r, 'onsuccess', data.has(k) ? JSON.parse(JSON.stringify(data.get(k))) : undefined); return r; },
    getAllKeys: () => { const r = {}; later(r, 'onsuccess', [...data.keys()]); return r; },
    put: (v, k) => data.set(k, JSON.parse(JSON.stringify(v))),
    delete: k => data.delete(k),
    clear: () => data.clear(),
  };
  return {
    data,
    open: () => {
      const req = {};
      setTimeout(() => {
        req.result = {
          createObjectStore: () => store,
          transaction: () => { const tx = { objectStore: () => store }; setTimeout(() => tx.oncomplete?.(), 0); return tx; },
        };
        req.onsuccess?.();
      }, 0);
      return req;
    },
  };
}

const res = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body });

/**
 * @param {object} o
 * @param {Record<string, Array<string|{id,isrc}>>} o.playlists  playlist id → slots
 * @param {(body: object) => number|null} [o.rejectDelete]  a status to answer a DELETE body with, or null
 */
export function loadPage({ playlists = {}, rejectDelete = null } = {}) {
  const pls = Object.fromEntries(Object.entries(playlists).map(([id, slots]) =>
    [id, slots.map(s => (typeof s === 'string' ? { id: s, isrc: null } : { id: s.id ?? null, isrc: s.isrc ?? null }))]));
  const calls = [];
  const store = new Map([['bf_tok', JSON.stringify(
    { access_token: 'tok', refresh_token: 'r', expires_at: Date.now() + 3600e3 })]]);
  const sandbox = {
    clientId: () => 'test-client',
    REDIRECT: 'https://example.test/Betterfy/',
    indexedDB: fakeIndexedDB(),
    LS: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
    fetch: async (url, opts = {}) => {
      const method = opts.method ?? 'GET';
      const body = opts.body ? JSON.parse(opts.body) : null;
      calls.push({ method, url, body });
      const m = url.match(/\/playlists\/([^/?]+)\/(items|tracks)/);
      if (!m) throw new Error(`unexpected fetch ${method} ${url}`);
      const slots = (pls[m[1]] ??= []);
      if (method === 'GET')
        return res(200, { next: null, items: slots.map(s => ({
          item: s.id ? { id: s.id, ...(s.isrc ? { external_ids: { isrc: s.isrc } } : {}) } : null })) });
      if (method === 'POST') { slots.push(...body.uris.map(u => ({ id: u.replace('spotify:track:', ''), isrc: null }))); return res(201, { snapshot_id: 's' }); }
      if (method === 'PUT') {
        const { range_start: from, insert_before: before } = body;
        const [it] = slots.splice(from, 1);
        slots.splice(before > from ? before - 1 : before, 0, it);
        return res(200, { snapshot_id: 's' });
      }
      if (method === 'DELETE') {
        const status = rejectDelete?.(body);
        if (status) return res(status, { error: { status, message: 'Bad request' } });
        const list = body.items ?? body.tracks;
        const uris = new Set(list.map(t => t.uri.replace('spotify:track:', '')));
        pls[m[1]] = slots.filter(s => !uris.has(s.id));
        return res(200, { snapshot_id: 's' });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    },
    URLSearchParams, setTimeout, clearTimeout, console,
    LIB: { user: { id: 'emma' }, playlists: [], liked: [] },
    CFG: {}, TAGS: {}, S: {}, R: null,
    toast: () => {}, render: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(slice('const RATE_LIMITED', '/* ---------- axis classification', 'spotify/idb block'), sandbox);
  vm.runInContext(slice('async function logAction(entry)', '/* ---------- player: Spotify Connect', 'log/write-helper block'), sandbox);
  return Object.assign(sandbox, {
    calls,
    ids: id => (pls[id] ?? []).map(s => s.id),
    run: code => vm.runInContext(code, sandbox),
    log: () => sandbox.indexedDB.data.get('actions') ?? [],
  });
}
