// Betterfy — local app server.
// Serves the UI and a small JSON API over the library. Runs on the machine that
// holds the tokens; nothing is exposed beyond 127.0.0.1.
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import { spawn } from 'node:child_process';
import { api } from './spotify.mjs';
import { removeFrom, addTo, undo, history, devices, playTrack, pause, log } from './actions.mjs';
import { findOrCreate } from './write.mjs';

const PORT = 8787;
const readJson = f => existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;

// Loaded once at boot and refreshed when a report is regenerated.
let lib = readJson('library.json');
let cfg = readJson('playlists.config.json');
let dupes = readJson('report-dupes.json');
let misfile = readJson('report-misfile.json');
let discover = readJson('report-discover.json');

if (!lib) { console.error('No library.json — run: npm run snapshot'); process.exit(1); }

const reload = () => {
  lib = readJson('library.json'); cfg = readJson('playlists.config.json');
  dupes = readJson('report-dupes.json'); misfile = readJson('report-misfile.json');
  discover = readJson('report-discover.json');
};

/* ---------------- derived views ---------------- */

function summary() {
  const uniq = new Set();
  let placements = 0;
  for (const p of lib.playlists) for (const t of p.tracks) if (t.id) { uniq.add(t.id); placements++; }
  const filed = new Set([...uniq]);
  const backlog = lib.liked.filter(t => t?.id && !filed.has(t.id)).length;
  const within = dupes?.within ?? [];
  return {
    playlists: lib.playlists.length,
    tracks: uniq.size,
    placements,
    liked: lib.liked.length,
    backlog,
    exact: within.filter(w => w.verdict === 'same-recording').length,
    clash: within.filter(w => w.verdict !== 'same-recording').length,
    crossFiled: dupes?.across?.length ?? 0,
    misfiled: misfile?.misfiled?.length ?? 0,
    clusters: misfile?.clusters?.length ?? 0,
    captured: lib.captured_at,
    reports: {
      dupes: !!dupes, misfile: !!misfile, discover: !!discover,
    },
  };
}

/** The filing queue: unfiled liked songs, newest first, with suggestions. */
function backlog(limit = 400) {
  const suggestions = new Map((misfile?.placed ?? []).concat(misfile?.homeless ?? []).map(r => [r.id, r]));
  const filed = new Set();
  for (const p of lib.playlists) for (const t of p.tracks) filed.add(t.id);
  const targets = Object.entries(cfg?.playlists ?? {})
    .filter(([, v]) => v.target)
    .map(([id, v]) => ({ id, name: v.name, axis: v.axis }));

  const rows = lib.liked.filter(t => t?.id && !filed.has(t.id)).map(t => {
    const s = suggestions.get(t.id);
    return {
      id: t.id, artist: (t.artists ?? []).map(a => a.name).join(', '), title: t.name,
      album: t.album, released: t.released, added: (t.added_at ?? '').slice(0, 10),
      dur: t.duration_ms,
      tags: s?.tags ?? [],
      suggest: (s?.suggest ?? []).map(x => ({
        ...x, id: targets.find(t2 => t2.name === x.name)?.id ?? null,
        axis: targets.find(t2 => t2.name === x.name)?.axis ?? null,
      })).filter(x => x.id),
    };
  });
  rows.sort((a, b) => (b.added ?? '').localeCompare(a.added ?? ''));
  return { total: rows.length, targets, rows: rows.slice(0, limit) };
}

/* ---------------- routing ---------------- */

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml' };

async function readBody(req) {
  const parts = [];
  for await (const c of req) parts.push(c);
  return parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {};
}

const ROUTES = {
  'GET /api/summary':   async () => summary(),
  'GET /api/backlog':   async () => backlog(),
  'GET /api/dupes':     async () => dupes ?? { within: [], across: [] },
  'GET /api/misfile':   async () => misfile ?? { misfiled: [], placed: [], homeless: [], clusters: [] },
  'GET /api/discover':  async () => discover ?? [],
  'GET /api/playlists': async () => Object.entries(cfg?.playlists ?? {}).map(([id, v]) => ({ id, ...v })),
  'GET /api/history':   async () => history(),
  'GET /api/devices':   async () => devices(),

  'POST /api/play':     async b => playTrack(b.trackId, b.deviceId),
  'POST /api/pause':    async () => { await pause(); return { ok: true }; },

  'POST /api/file':     async b => {
    const name = cfg?.playlists?.[b.playlistId]?.name ?? b.playlistId;
    return addTo(b.playlistId, name, [b.trackId], b.reason ?? 'filed from inbox');
  },
  'POST /api/remove':   async b => {
    const name = cfg?.playlists?.[b.playlistId]?.name ?? b.playlistId;
    return removeFrom(b.playlistId, name, b.trackIds, b.reason ?? 'removed in review');
  },
  'POST /api/unlike':   async b => {
    await api(`/me/tracks?ids=${b.trackId}`, { method: 'DELETE' });
    log({ op: 'unlike', trackIds: [b.trackId], undoable: true });
    return { ok: true };
  },
  'POST /api/newPlaylist': async b => {
    const me = await api('/me');
    const pl = await findOrCreate(me.id, b.name, b.description ?? '');
    if (b.trackIds?.length) await addTo(pl.id, b.name, b.trackIds, 'new playlist from cluster');
    log({ op: 'create-playlist', playlistId: pl.id, playlistName: b.name });
    return { id: pl.id, created: pl.created };
  },
  'POST /api/undo':     async b => {
    const entry = history(500).find(h => h.at === b.at);
    if (!entry) throw new Error('No such action in the log');
    return undo(entry);
  },
  'POST /api/refresh':  async b => {
    // Re-run a pipeline step in a child process, then reload the reports.
    const script = { snapshot:'snapshot.mjs', dupes:'dupes.mjs', misfile:'misfile.mjs' }[b.step];
    if (!script) throw new Error('Unknown step');
    await new Promise((ok, bad) => {
      const p = spawn(process.execPath, [script], { stdio: 'inherit' });
      p.on('exit', c => c === 0 ? ok() : bad(new Error(`${script} exited ${c}`)));
    });
    reload();
    return summary();
  },
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const key = `${req.method} ${url.pathname}`;

  if (ROUTES[key]) {
    try {
      const body = req.method === 'POST' ? await readBody(req) : null;
      return json(res, 200, await ROUTES[key](body, url));
    } catch (e) {
      return json(res, 500, { error: String(e.message ?? e) });
    }
  }

  // static
  let file = url.pathname === '/' ? 'ui/index.html' : 'ui' + url.pathname;
  if (!existsSync(file) || file.includes('..')) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`\n  Betterfy running at ${url}\n`);
  const s = summary();
  console.log(`  ${s.playlists} playlists · ${s.tracks} tracks · ${s.backlog} unfiled`);
  console.log(`  reports: dupes=${s.reports.dupes} misfile=${s.reports.misfile} discover=${s.reports.discover}\n`);
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', url], { shell: true, detached: true });
});
