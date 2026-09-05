// Playlist write helpers. Spotify renamed /tracks -> /items on reads; try the
// new path first on writes too and fall back if the account is on the old shape.
import { api } from './spotify.mjs';

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

async function post(id, path, body) {
  return api(`/playlists/${id}/${path}`, { method: 'POST', body: JSON.stringify(body) });
}
async function put(id, path, body) {
  return api(`/playlists/${id}/${path}`, { method: 'PUT', body: JSON.stringify(body) });
}

async function tryBoth(fn) {
  try { return await fn('items'); }
  catch (e) {
    if (!/^40[34]/.test(e.message)) throw e;
    return await fn('tracks');
  }
}

export async function findOrCreate(userId, name, description = '', create = true) {
  const all = [];
  let page = await api('/me/playlists?limit=50');
  while (page) { all.push(...page.items); if (!page.next) break; page = await api(page.next); }
  const hit = all.find(p => p.name === name && p.owner?.id === userId);
  if (hit) return { id: hit.id, created: false, total: hit.items?.total ?? hit.tracks?.total ?? 0 };

  if (!create) return { id: null, created: false, total: 0, wouldCreate: true };

  const made = await api('/me/playlists', {
    method: 'POST',
    body: JSON.stringify({ name, description, public: false }),
  });
  return { id: made.id, created: true, total: 0 };
}

/** Replace a playlist's entire contents with `uris`, in order. */
export async function replaceAll(id, uris) {
  const parts = chunk(uris, 100);
  await tryBoth(p => put(id, p, { uris: parts[0] ?? [] }));   // PUT clears then sets
  for (const part of parts.slice(1)) await tryBoth(p => post(id, p, { uris: part }));
  return uris.length;
}

/** Append `uris` to the end. */
export async function append(id, uris) {
  for (const part of chunk(uris, 100)) await tryBoth(p => post(id, p, { uris: part }));
  return uris.length;
}
