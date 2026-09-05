// Betterfy — local app server.
// Serves the UI and a small JSON API over the library. Runs on the machine that
// holds the tokens; nothing is exposed beyond 127.0.0.1.
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import { spawn } from 'node:child_process';
import { api } from './spotify.mjs';
import { removeFrom, addTo, undo, historyGrouped, devices, playTrack, pause, log, transaction } from './actions.mjs';
import { findOrCreate } from './write.mjs';
import { refuse } from './guard.mjs';
import { trackKey } from './norm.mjs';
import { buildProfiles, rank, topTags } from './profile.mjs';

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
  model = null;                       // rebuilt from the new library on demand
  invalidateIndex();
  dropped.clear();
};

/* ---------------- keeping the local copy true ---------------- */

// v1 mutated Spotify and left `lib` at whatever the last snapshot said, so
// every count went stale the moment you filed anything. These apply the same
// change locally, so the UI stays correct without a two-minute re-snapshot.

const playlistById = id => lib.playlists.find(p => p.id === id);

// Tracks we have dropped locally, kept so an undo can put the real record
// back rather than a stub. Bounded: this is a review session, not a cache.
const dropped = new Map();
const remember = t => { if (t?.id) { dropped.set(t.id, t); if (dropped.size > 5000) dropped.delete(dropped.keys().next().value); } };

/** Any copy of a track we hold — in a playlist, in liked songs, or just dropped. */
function knownTrack(id) {
  for (const p of lib.playlists) { const t = p.tracks.find(x => x.id === id); if (t) return t; }
  return lib.liked.find(t => t?.id === id) ?? dropped.get(id) ?? null;
}

function localAdd(playlistId, trackIds) {
  const p = playlistById(playlistId);
  if (!p) return;
  invalidateIndex();
  for (const id of trackIds) {
    if (p.tracks.some(t => t.id === id)) continue;
    const t = knownTrack(id);
    if (t) p.tracks.push({ ...t, added_at: new Date().toISOString() });
  }
}

function localRemove(playlistId, trackIds) {
  const p = playlistById(playlistId);
  if (!p) return;
  invalidateIndex();
  const drop = new Set(trackIds);
  for (const t of p.tracks) if (drop.has(t.id)) remember(t);
  p.tracks = p.tracks.filter(t => !drop.has(t.id));
  // A duplicate pair that no longer exists shouldn't keep being counted.
  if (dupes?.within) dupes.within = dupes.within.filter(w =>
    w.playlistId !== playlistId || !w.options.some(o => drop.has(o.id)));
}

function localUnlike(trackId) {
  invalidateIndex();
  remember(lib.liked.find(t => t?.id === trackId));
  lib.liked = lib.liked.filter(t => t?.id !== trackId);
}

function localRelike(trackId) {
  invalidateIndex();
  if (lib.liked.some(t => t?.id === trackId)) return;
  const t = dropped.get(trackId);
  if (t) lib.liked.unshift(t);
}

/** Cover art by track id, for report rows that carry only ids. */
function artOf(id) {
  return knownTrack(id)?.art ?? null;
}

/** A track that has been moved or filed is no longer a pending misfile. */
function localResolveMisfile(trackId) {
  if (misfile?.misfiled) misfile.misfiled = misfile.misfiled.filter(x => x.id !== trackId);
}

/** Mirror an undone transaction back into the local copy, newest step first. */
function localUndo(row) {
  for (const step of [...row.steps].reverse()) {
    if (step.op === 'add') localRemove(step.playlistId, step.trackIds);
    else if (step.op === 'remove') localAdd(step.playlistId, step.trackIds);
    else if (step.op === 'unlike') step.trackIds.forEach(localRelike);
    else if (step.op === 'create-playlist') {
      invalidateIndex();
      lib.playlists = lib.playlists.filter(p => p.id !== step.playlistId);
      if (cfg?.playlists) delete cfg.playlists[step.playlistId];
    }
  }
}

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
      album: t.album, released: t.released, added: (t.added_at ?? '').slice(0, 10), art: t.art ?? null,
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

/* ---------------- search and add ---------------- */

// The filing model is built on first use rather than at boot: it needs the tag
// file, which is optional, and a search is the only thing that wants it here.
let model = null;
function filingModel() {
  if (model !== null) return model;
  try {
    const tags = JSON.parse(readFileSync('tags-lastfm.json', 'utf8'));
    const targets = new Set(Object.entries(cfg?.playlists ?? {}).filter(([, v]) => v.target).map(([id]) => id));
    const { profiles, idf } = buildProfiles(lib, tags, targets, id => cfg.playlists[id]?.axis ?? null);
    model = { tags, profiles, idf };
  } catch {
    model = false;                 // no tags yet — search still works, unranked
  }
  return model;
}

const shapeSearchHit = t => ({
  id: t.id,
  name: t.name,
  artists: (t.artists ?? []).map(a => ({ id: a.id, name: a.name })),
  album: t.album?.name,
  albumType: t.album?.album_type,
  released: t.album?.release_date,
  duration_ms: t.duration_ms,
  isrc: t.external_ids?.isrc,
  popularity: t.popularity,
  art: t.album?.images?.at(-1)?.url ?? null,
});

// Search compares every hit against the whole library, so the identity keys
// are built once and reused until something changes underneath.
let index = null;
const invalidateIndex = () => { index = null; };

function libraryIndex() {
  if (index) return index;
  const byId = new Map(), byKey = new Map();
  for (const p of lib.playlists) {
    for (const t of p.tracks) {
      if (!t?.id) continue;
      if (!byId.has(t.id)) byId.set(t.id, []);
      byId.get(t.id).push(p.name);
      const k = trackKey(t);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push({ id: t.id, playlist: p.name, album: t.album, released: t.released });
    }
  }
  index = { byId, byKey, liked: new Set(lib.liked.filter(t => t?.id).map(t => t.id)) };
  return index;
}

/**
 * Where a search hit already lives. Two kinds of answer, and the difference
 * matters: the same id is the same entry, while the same trackKey under a
 * different id is another pressing of a record you already own — exactly the
 * duplicate you would otherwise add without noticing.
 */
function alreadyHave(track) {
  const ix = libraryIndex();
  return {
    exact: [...new Set(ix.byId.get(track.id) ?? [])],
    samesong: (ix.byKey.get(trackKey(track)) ?? [])
      .filter(x => x.id !== track.id)
      .map(({ playlist, album, released }) => ({ playlist, album, released })),
    liked: ix.liked.has(track.id),
  };
}

function targetList() {
  return Object.entries(cfg?.playlists ?? {})
    .filter(([, v]) => v.target)
    .map(([id, v]) => ({ id, name: v.name, axis: v.axis }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Rank filing destinations for a track we do not own yet. */
function suggestFor(track) {
  const m = filingModel();
  if (!m) return { suggest: [], tags: [] };
  const best = rank(track, m.tags, m.profiles, m.idf, { top: 3 });
  const targets = targetList();
  return {
    tags: topTags(track, m.tags, m.idf),
    suggest: best.map(b => ({
      id: b.id, name: b.name, score: +b.score.toFixed(3),
      axis: targets.find(t => t.id === b.id)?.axis ?? null,
    })),
  };
}

async function search(q) {
  if (!q?.trim()) return { rows: [], targets: targetList() };
  const r = await api(`/search?q=${encodeURIComponent(q.trim())}&type=track&limit=20`);
  const rows = (r.tracks?.items ?? []).filter(t => t?.id).map(t => {
    const shaped = shapeSearchHit(t);
    return { ...shaped, have: alreadyHave(shaped), ...suggestFor(shaped) };
  });
  return { rows, targets: targetList(), ranked: !!filingModel() };
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
  // The report files predate cover art, so it is attached from the library here
  // rather than by regenerating every report.
  'GET /api/dupes':     async () => dupes ? {
    ...dupes,
    within: dupes.within.map(w => ({ ...w, art: artOf(w.options?.[0]?.id) })),
    across: dupes.across.map(a => ({ ...a, art: artOf(a.placements?.[0]?.trackId) })),
  } : { within: [], across: [] },
  'GET /api/misfile':   async () => misfile ? {
    ...misfile,
    misfiled: misfile.misfiled.map(m => ({ ...m, art: artOf(m.id) })),
  } : { misfiled: [], placed: [], homeless: [], clusters: [] },
  'GET /api/discover':  async () => discover ?? [],
  'GET /api/playlists': async () => Object.entries(cfg?.playlists ?? {}).map(([id, v]) => ({ id, ...v })),
  'GET /api/history':   async () => historyGrouped(),
  'GET /api/devices':   async () => devices(),
  'GET /api/search':    async (_b, url) => search(url.searchParams.get('q')),

  'POST /api/play':     async b => playTrack(b.trackId, b.deviceId),
  'POST /api/pause':    async () => { await pause(); return { ok: true }; },

  'POST /api/file':     async b => {
    const name = cfg?.playlists?.[b.playlistId]?.name ?? b.playlistId;
    // A track added from search is not in the library yet, so the client sends
    // the record along with it and the local copy learns it here.
    if (b.track) remember(b.track);
    const r = await transaction(`file into ${name}`, () =>
      addTo(b.playlistId, name, [b.trackId], b.reason ?? 'filed from inbox'));
    localAdd(b.playlistId, [b.trackId]);
    localResolveMisfile(b.trackId);
    return r;
  },
  'POST /api/remove':   async b => {
    const name = cfg?.playlists?.[b.playlistId]?.name ?? b.playlistId;
    const r = await transaction(`remove from ${name}`, () =>
      removeFrom(b.playlistId, name, b.trackIds, b.reason ?? 'removed in review'));
    localRemove(b.playlistId, b.trackIds);
    return r;
  },
  'POST /api/move':     async b => {
    // One transaction, so undo puts the track back in a single step. Add
    // first: if the remove then fails the track is still filed somewhere
    // rather than lost between playlists.
    const from = cfg?.playlists?.[b.fromId]?.name ?? b.fromId;
    const to = cfg?.playlists?.[b.toId]?.name ?? b.toId;
    await transaction(`move ${from} → ${to}`, async () => {
      await addTo(b.toId, to, [b.trackId], `moved from ${from}`);
      await removeFrom(b.fromId, from, [b.trackId], `moved to ${to}`);
    });
    localAdd(b.toId, [b.trackId]);
    localRemove(b.fromId, [b.trackId]);
    localResolveMisfile(b.trackId);
    return { from, to };
  },
  'POST /api/unlike':   async b => {
    await transaction('unlike', async () => {
      await api(`/me/tracks?ids=${b.trackId}`, { method: 'DELETE' });
      log({ op: 'unlike', trackIds: [b.trackId], undoable: true });
    });
    localUnlike(b.trackId);
    return { ok: true };
  },
  'POST /api/newPlaylist': async b => {
    const me = await api('/me');
    return transaction(`create ${b.name}`, async () => {
      const pl = await findOrCreate(me.id, b.name, b.description ?? '');
      if (pl.created) log({ op: 'create-playlist', playlistId: pl.id, playlistName: b.name, undoable: true });
      // Register it locally so it is a filing destination straight away —
      // but findOrCreate also returns playlists that already existed.
      if (!lib.playlists.some(p => p.id === pl.id)) {
        lib.playlists.push({ id: pl.id, name: b.name, description: b.description ?? '', tracks: [] });
        invalidateIndex();
      }
      cfg.playlists ??= {};
      cfg.playlists[pl.id] ??= { name: b.name, axis: 'genre', target: false, tracks: 0 };
      if (b.trackIds?.length) await addTo(pl.id, b.name, b.trackIds, 'new playlist from cluster');
      localAdd(pl.id, b.trackIds ?? []);
      return { id: pl.id, created: pl.created };
    });
  },
  'POST /api/undo':     async b => {
    const entry = historyGrouped(500).find(h => h.at === b.at);
    if (!entry) throw new Error('No such action in the log');
    if (!entry.undoable) throw new Error('That action cannot be undone');
    // The grouped row carries the transaction; undo reverses every step in it.
    const r = await undo(entry.steps[0]);
    localUndo(entry);
    return r;
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

  const bad = refuse(req, PORT);
  if (bad) return json(res, 403, { error: `Refused: ${bad}.` });

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
  // Browsers resolve *.localhost to loopback themselves (RFC 6761), so this
  // reads as a real address without a hosts-file entry or admin rights.
  const url = `http://betterfy.localhost:${PORT}`;
  console.log(`\n  Betterfy running at ${url}`);
  console.log(`  (also http://127.0.0.1:${PORT})\n`);
  const s = summary();
  console.log(`  ${s.playlists} playlists · ${s.tracks} tracks · ${s.backlog} unfiled`);
  console.log(`  reports: dupes=${s.reports.dupes} misfile=${s.reports.misfile} discover=${s.reports.discover}\n`);
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', url], { shell: true, detached: true });
});
