// A fake Spotify for the browser tests (BUILD-6 Q1b). Plain node:http, no
// dependencies. It serves
//   - the built page (docs/) at /, so the page and its API share an origin, and
//   - the Web API calls the page makes, under /v1/, from a synthetic account
//     (test/fixtures/accounts.mjs) held in memory, plus POST /api/token.
//
// The page is not told about it. e2e/harness.mjs routes https://api.spotify.com
// and https://accounts.spotify.com to this server from the browser side, so the
// app code is exactly the shipped code. Failure modes are switches on `.sw`:
//
//   sw.rate429       next N API calls answer 429 with Retry-After: 1
//   sw.expire401     next N authorised API calls answer 401 (the page must
//                    refresh through /api/token and try again)
//   sw.failWrites    every playlist/library write answers 403 until cleared
//   sw.latencyMs     extra delay on every API call
//   sw.failAfterWrites=k   after k playlist writes have landed, every further write answers 403
//   sw.expireAfterWrites=k after k playlist writes, the next call with the old token answers 401 once
//   sw.loseResponse  next N playlist adds are applied, then the connection is cut before the answer
//
// Optional on the account (test/backup.test.mjs): `catalog`, more tracks Spotify
// knows that are in no playlist; `strictIds`, a playlist add holding an id the
// fake does not know answers 400 and adds nothing, as Spotify does. GET
// /search?q=isrc:X finds a known track by ISRC (any other search is empty).
//
// `.log` records every API call as { method, path, body } so a spec can assert
// that a swipe really reached the server, and `.playlist(id)` reads the state.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DOCS = fileURLToPath(new URL('../../docs/', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

export async function startFakeSpotify(account) {
  const playlists = new Map(account.playlists.map(p => [p.id, { ...p, tracks: [...p.tracks] }]));
  const liked = [...account.liked];
  // Newest first, one minute apart, so a client can tell a head it has from one it has not.
  const likedAt = new Map(liked.map((t, i) => [t.id, new Date(Date.UTC(2024, 4, 1) - i * 60000).toISOString()]));
  const created = [];
  const sw = { rate429: 0, expire401: 0, failWrites: false, latencyMs: 0,
    failAfterWrites: -1, expireAfterWrites: -1, loseResponse: 0 };
  let wrote = 0;
  const log = [];
  let issued = 0, base = '';

  const entry = (t, at) => ({ added_at: at, track: t, item: t });
  const page = (items, q, urlPath) => {
    const limit = +q.get('limit') || 20, offset = +q.get('offset') || 0;
    const next = offset + limit < items.length
      ? `https://api.spotify.com/v1${urlPath}?${new URLSearchParams({ ...Object.fromEntries(q), limit, offset: offset + limit })}` : null;
    return { items: items.slice(offset, offset + limit), total: items.length, limit, offset, next, href: '' };
  };
  const uriIds = s => s.split(',').map(u => u.split(':').pop()).filter(Boolean);

  async function api(req, res, url, body) {
    const p = url.pathname.replace(/^\/v1/, ''), q = url.searchParams, m = req.method;
    const write = m !== 'GET' && !p.startsWith('/me/player');
    log.push({ method: m, path: p + (url.search || ''), body });
    if (sw.latencyMs) await new Promise(r => setTimeout(r, sw.latencyMs));
    if (sw.rate429 > 0) { sw.rate429--; return json(res, 429, { error: { status: 429, message: 'rate limited' } }, { 'retry-after': '1' }); }
    if (sw.expire401 > 0 && /^Bearer /.test(req.headers.authorization ?? '') && !/^Bearer fresh/.test(req.headers.authorization)) {
      sw.expire401--; return json(res, 401, { error: { status: 401, message: 'The access token expired' } });
    }
    if (sw.expireAfterWrites >= 0 && wrote >= sw.expireAfterWrites && !/^Bearer fresh/.test(req.headers.authorization ?? '')) {
      sw.expireAfterWrites = -1; return json(res, 401, { error: { status: 401, message: 'The access token expired' } });
    }
    if (write && sw.failAfterWrites >= 0 && wrote >= sw.failAfterWrites) return json(res, 403, { error: { status: 403, message: 'write refused after ' + wrote + ' (test switch)' } });
    if (write && sw.failWrites) return json(res, 403, { error: { status: 403, message: 'write refused (test switch)' } });

    if (p === '/me' && m === 'GET') return json(res, 200, account.me);
    if (p === '/me/playlists' && m === 'GET')
      return json(res, 200, page([...playlists.values(), ...created].map(({ tracks, ...x }) => x), q, p));
    if (p === '/me/playlists' && m === 'POST') {
      const pl = { id: 'plnew' + String(created.length + 1).padStart(4, '0'), name: body?.name ?? 'New', owner: { id: account.me.id }, snapshot_id: 's1', tracks: [],
        public: body?.public, description: body?.description ?? '' };
      created.push(pl); playlists.set(pl.id, pl);
      return json(res, 201, { id: pl.id, name: pl.name, snapshot_id: pl.snapshot_id, owner: pl.owner });
    }
    let mm = p.match(/^\/playlists\/([^/]+)\/(items|tracks)$/);
    if (mm) {
      const pl = playlists.get(mm[1]);
      if (!pl) return json(res, 404, { error: { status: 404, message: 'Not found' } });
      if (m === 'GET') return json(res, 200, page(pl.tracks.map(t => entry(t, '2024-03-01T00:00:00Z')), q, p));
      if (m === 'POST') {
        const ids = uriIds((body?.uris ?? []).join(','));
        if (account.strictIds && ids.some(id => !findTrack(id))) return json(res, 400, { error: { status: 400, message: 'Payload contains a non-existing ID' } });
        // The real endpoint adds duplicates; so does this.
        for (const id of ids) { const t = findTrack(id); if (t) pl.tracks.push(t); }
        pl.snapshot_id = 's' + Date.now();
        wrote++;
        if (sw.loseResponse > 0) { sw.loseResponse--; req.socket.destroy(); return; }
        return json(res, 201, { snapshot_id: pl.snapshot_id });
      }
      if (m === 'DELETE') {
        const gone = new Set(uriIds(((body?.items ?? body?.tracks) ?? []).map(o => o.uri).join(',')));
        pl.tracks = pl.tracks.filter(t => !gone.has(t.id));
        pl.snapshot_id = 's' + Date.now();
        return json(res, 200, { snapshot_id: pl.snapshot_id });
      }
    }
    if (p === '/me/tracks' && m === 'GET') return json(res, 200, page(liked.map(t => entry(t, likedAt.get(t.id))), q, p));
    if (p === '/me/library' && m === 'DELETE' && /spotify:playlist:/.test(q.get('uris') ?? '')) {
      for (const id of uriIds(q.get('uris'))) {
        playlists.delete(id);
        const at = created.findIndex(x => x.id === id); if (at >= 0) created.splice(at, 1);
      }
      return json(res, 200, {});
    }
    if ((p === '/me/library' || p === '/me/tracks') && (m === 'PUT' || m === 'DELETE')) {
      const ids = uriIds(q.get('uris') ?? q.get('ids') ?? '');
      for (const id of ids) {
        const at = liked.findIndex(t => t.id === id);
        if (m === 'DELETE' && at >= 0) liked.splice(at, 1);
        if (m === 'PUT' && at < 0) { const t = findTrack(id); if (t) { liked.unshift(t); likedAt.set(t.id, new Date(Date.now() + liked.length).toISOString()); } }
      }
      return json(res, 200, {});
    }
    if (p.startsWith('/me/top/') || p === '/me/player/recently-played') return json(res, 200, { items: [], total: 0, next: null });
    if (p === '/me/player') { res.writeHead(204); return res.end(); }
    if (p === '/me/player/devices') return json(res, 200, { devices: [] });
    if (p === '/search') {
      const isrc = (q.get('q') ?? '').match(/^isrc:(\w+)$/i)?.[1]?.toUpperCase();
      const hit = isrc ? allTracks().find(t => t.external_ids?.isrc === isrc) : null;
      return json(res, 200, { tracks: { items: hit ? [hit] : [] } });
    }
    json(res, 404, { error: { status: 404, message: 'fake-spotify: no route for ' + m + ' ' + p } });
  }

  function findTrack(id) {
    for (const t of liked) if (t.id === id) return t;
    for (const pl of playlists.values()) for (const t of pl.tracks) if (t.id === id) return t;
    for (const t of account.catalog ?? []) if (t.id === id) return t;
    return null;
  }
  const allTracks = () => [...(account.catalog ?? []), ...liked, ...[...playlists.values()].flatMap(pl => pl.tracks)];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/v1/') || url.pathname === '/api/token') {
        const chunks = []; for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString();
        if (url.pathname === '/api/token') {
          log.push({ method: req.method, path: '/api/token', body: raw });
          return json(res, 200, { access_token: 'fresh' + (++issued), refresh_token: 'refresh-fx', expires_in: 3600, token_type: 'Bearer' });
        }
        let body; try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
        return await api(req, res, url, body);
      }
      let f = path.join(DOCS, decodeURIComponent(url.pathname));
      if (!f.startsWith(DOCS)) { res.writeHead(403); return res.end(); }
      if (f.endsWith(path.sep)) f += 'index.html';
      const data = await readFile(f);
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream' });
      res.end(data);
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'EISDIR') { res.writeHead(404); res.end(); }
      else { res.writeHead(500); res.end(String(e)); }
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  return {
    url: base, sw, log, account,
    playlist: id => playlists.get(id)?.tracks.map(t => t.id) ?? null,
    playlists: () => [...playlists.values()].map(({ tracks, ...x }) => ({ ...x, tracks: tracks.map(t => ({ id: t.id, isrc: t.external_ids?.isrc ?? null })) })),
    liked: () => liked.map(t => t.id),
    writes: () => log.filter(l => l.method !== 'GET' && l.path !== '/api/token'),
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
  };
}
