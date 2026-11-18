/* Tidy's "Hard to find" section: songs in your playlists that Spotify's search
 * shows as a different track, so the tick never appears and the song looks lost
 * (core/review/hidden.mjs says why that happens). Not a screen of its own: tidy.mjs
 * imports it, draws hiddenView() as a section and spreads hiddenActions into its own.
 *
 * Like a screen module it reaches nothing but ctx. The one long job (asking search
 * about each song) lives here too, because nothing else needs it; it calls Spotify
 * only through ctx.sp, so in tests and on a page without sp it is simply idle.
 *
 * Two ways in:
 *   - "Find a song": type what you would type into Spotify. Your library answers
 *     at once (where it sits, liked or not), and "Ask Spotify" runs that search
 *     and marks every answer that is the same song under another id.
 *   - "Check my playlists": the same question for every song, oldest adds first,
 *     a run of RUN_SIZE at a time, remembered on this device for RECHECK_MS.
 * Every fix asks first, says where it will change, and lands in History with Undo. */
import { songsToCheck, judge, shapeHit, searchQuery, hiddenRows, hiddenProgress, findInLibrary,
         sameSong, versionNote, artistLine, RUN_SIZE } from '../../core/review/hidden.mjs';

const KEY = 'hidden_checks';
/** Module state: the saved checks, the run in progress, the search box. */
export const H = { checks: null, loading: null, running: false, done: 0, of: 0, err: null,
                   q: '', web: null, asking: false, confirm: null, busy: null };

const enc = encodeURIComponent;
const searchPath = q => `/search?q=${enc(q)}&type=track&limit=5&market=from_token`;

export function hiddenLoad(c) {
  if (H.checks || H.loading) return;
  if (!c.idb) { H.checks = {}; return; }
  H.loading = Promise.resolve(c.idb.get(KEY)).then(v => { H.checks = v ?? {}; }, () => { H.checks = {}; })
    .finally(() => { H.loading = null; c.store?.touch?.('ui.tidy'); });
}
const save = c => c.idb?.set?.(KEY, H.checks);

/** Rows still worth showing: flagged and still in the library. */
export function hiddenCount(c) { return H.checks ? hiddenRows(c.LIB, H.checks).filter(r => r.state === 'version').length : 0; }

/** Ask search about the next RUN_SIZE songs. One at a time, through the page's paced sp(). */
export async function hiddenRun(c) {
  if (H.running || !c.sp) return;
  if (!H.checks) await (H.loading ?? Promise.resolve(c.idb?.get?.(KEY)).then(v => { H.checks = v ?? {}; }));
  const todo = songsToCheck(c.LIB, H.checks).slice(0, RUN_SIZE);
  H.running = true; H.done = 0; H.of = todo.length; H.err = null;
  c.store?.touch?.('ui.tidy');
  try {
    for (const e of todo) {
      const res = await c.sp(searchPath(searchQuery(e.track)));
      const hits = (res?.tracks?.items ?? []).map(shapeHit).filter(Boolean);
      const j = judge(e.track, hits);
      H.checks[e.track.id] = { state: j.state, ...(j.to ? { to: j.to } : {}), at: Date.now() };
      H.done++;
      if (H.done % 10 === 0) { await save(c); c.store?.touch?.('ui.tidy'); }
    }
  } catch (err) { H.err = err?.message ?? String(err); }
  finally { H.running = false; await save(c); c.store?.touch?.('ui.tidy'); }
}

/** Library copies of the same song as a search answer, under any id. */
function libraryCopies(c, hit) {
  return songsToCheck(c.LIB, {}, 0).filter(e => e.track.id === hit.id || sameSong(e.track, hit));
}

/** Swap every copy of `fromId` in your playlists for `to`, and like `to` where `fromId` was liked. */
export async function hiddenSwap(c, fromId, to) {
  const e = songsToCheck(c.LIB, {}, 0).find(x => x.track.id === fromId);
  if (!e) throw new Error('That song is no longer in your library');
  const group = c.newGroup();
  for (const p of e.places) {
    const entries = await c.playlistEntries(p.id);
    const at = entries.filter(x => x.id === fromId).map(x => x.pos);
    if (!at.length) continue;
    // In at the first old slot, then the old copy out: the playlist keeps its order.
    await c.plCall(p.id, 'POST', { uris: ['spotify:track:' + to.id], position: at[0] });
    await c.logAction({ op: 'add', playlistId: p.id, playlistName: p.name, trackIds: [to.id], reason: 'version search shows', group });
    await c.delTracks(p.id, [fromId]);
    // Positions as they were before the add above, so Undo puts it back in place.
    await c.logAction({ op: 'remove', playlistId: p.id, playlistName: p.name, trackIds: [fromId],
                        positions: { [fromId]: at }, reason: 'version search shows', group });
  }
  if (e.liked) {
    await c.libraryCall('PUT', [to.id]);
    await c.logAction({ op: 'like', trackIds: [to.id], reason: 'version search shows', group });
  }
  // The local copy follows, so the row goes and Find answers right away; the next
  // sync reads the real playlists back (their snapshot ids are cleared).
  const row = { ...to }; delete row.playable;
  for (const p of c.LIB?.playlists ?? []) {
    if (!e.places.some(x => x.id === p.id)) continue;
    p.tracks = p.tracks.map(t => t.id === fromId ? { added_at: t.added_at, ...row } : t);
    p.snapshot_id = null;
  }
  if (e.liked && !(c.LIB.liked ?? []).some(t => t.id === to.id)) c.LIB.liked = [{ added_at: new Date().toISOString(), ...row }, ...(c.LIB.liked ?? [])];
  await c.idb?.set?.('library', c.LIB);
  if (H.checks) { H.checks[fromId] = { ...(H.checks[fromId] ?? {}), fixed: true, at: Date.now() };
                  H.checks[to.id] = { state: 'ok', at: Date.now() }; await save(c); }
  return { group, playlists: e.places.length, liked: e.liked };
}

/* ---------- view ---------- */

const where = (c, e) => {
  const { esc } = c;
  const pl = e.places.map(p => `<span class="chip">${esc(p.name)}</span>`).join('');
  return `<div class="hd-where">${e.liked ? '<span class="chip on">♥ Liked</span>' : ''}${pl}</div>`;
};
const tag = s => `<span class="hd-tag">${s}</span>`;

function findBlock(c) {
  const { esc } = c;
  const mine = findInLibrary(c.LIB, H.q, 8);
  const web = H.web && H.web.q === H.q ? H.web : null;
  const webRows = web ? web.hits.map(h => {
    const copies = libraryCopies(c, h);
    const exact = copies.find(x => x.track.id === h.id);
    const other = !exact && copies[0];
    const state = exact ? tag('✓ This copy is in your library')
      : other ? tag('Same song, but your copy is a different version') : tag('Not in your library');
    return `<div class="row" data-key="${esc('hw:' + h.id)}">${c.thumbHTML({ id: h.id, title: h.name, art: h.art })}<div class="main">
      <div class="ttl">${esc(h.name)} <span class="sub">— ${esc(artistLine(h))}</span></div>
      <div class="sub">${esc(h.album)}${h.released ? ' · ' + esc(String(h.released).slice(0, 4)) : ''}</div>
      ${state}${other ? where(c, other) : exact ? where(c, exact) : ''}
    </div>${other ? `<div class="acts">${fixButton(c, other.track.id, h, other)}</div>` : ''}</div>`;
  }).join('') : '';
  return `<div class="hd-find">
      <input id="hdSearch" type="search" autocomplete="off" placeholder="Find a song in your library" aria-label="Find a song in your library" value="${esc(H.q)}">
      ${H.q.trim() ? `<div class="rows">${mine.map(e => `<div class="row" data-key="${esc('hl:' + e.track.id)}">${c.thumbHTML({ id: e.track.id, title: e.track.name, art: e.track.art })}<div class="main">
          <div class="ttl">${esc(e.track.name)} <span class="sub">— ${esc(artistLine(e.track))}</span></div>
          <div class="sub">${esc(e.track.album ?? '')}</div>${where(c, e)}</div></div>`).join('')
        || c.emptyState('Not in your library', 'Nothing in your playlists or Liked Songs matches that.', { compact: true })}</div>
      <div class="rowbtns"><button class="b sm" data-act="hdAsk" ${H.asking || !c.sp ? 'disabled' : ''}>${H.asking ? 'Asking Spotify…' : 'Compare with Spotify search'}</button></div>
      ${web ? `<p class="sub">What Spotify’s search shows for “${esc(web.q)}”:</p><div class="rows">${webRows || c.emptyState('Search found nothing', 'Spotify returned no tracks for that.', { compact: true })}</div>` : ''}` : ''}
    </div>`;
}

function fixButton(c, fromId, to, e) {
  const { esc } = c;
  const key = fromId + '>' + to.id;
  if (H.busy === key) return `<button class="b sm" disabled>Fixing…</button>`;
  if (H.confirm === key) {
    const n = e.places.length;
    const what = [n ? `${n} playlist${n === 1 ? '' : 's'}` : '', e.liked ? 'Liked Songs' : ''].filter(Boolean).join(' and ');
    return `<span class="hd-ask">Swap in ${esc(what)}?</span>
      <button class="b sm go" data-act="hdYes" data-from="${esc(fromId)}" data-to="${esc(to.id)}">Swap</button>
      <button class="b sm" data-act="hdNo">Cancel</button>`;
  }
  return `<button class="b sm" data-act="hdFix" data-from="${esc(fromId)}" data-to="${esc(to.id)}">Use this version</button>`;
}

export function hiddenView(c) {
  const ib = c.infoBtn ?? (() => '');
  const { esc } = c;
  hiddenLoad(c);
  const lede = `<p class="lede">Songs Spotify’s search shows as a different version from the one in your playlist, so the tick never appears.${ib('tidy-hidden', 'Hard to find',
    '<p>A song added long ago is often kept under an old Spotify id: an earlier pressing, a single later put on an album, or a release Spotify replaced. Search shows the current one, which isn’t the copy in your playlist, so there is no tick.</p><p><b>Use this version</b> swaps your playlist copy for the one search shows, in the same place, and likes it if the old one was liked. Nothing changes until you confirm, and History can undo it.</p>')}</p>`;
  if (!H.checks) return lede + findBlock(c) + (c.skeleton ? c.skeleton('rows', 3) : '');
  const prog = hiddenProgress(c.LIB, H.checks);
  const rows = hiddenRows(c.LIB, H.checks);
  const vers = rows.filter(r => r.state === 'version'), gone = rows.filter(r => r.state === 'missing');
  const status = H.running ? `Checking with Spotify search: ${H.done.toLocaleString()} of ${H.of.toLocaleString()}…`
    : `${prog.checked.toLocaleString()} of ${prog.total.toLocaleString()} songs checked${prog.left ? '' : ', all of them'}.${H.err ? ` Stopped: ${esc(H.err)}` : ''}`;
  const run = prog.left && !H.running && c.sp
    ? `<button class="b sm ${prog.checked ? '' : 'go'}" data-act="hdRun">${prog.checked ? `Check ${Math.min(RUN_SIZE, prog.left)} more` : `Check my oldest ${Math.min(RUN_SIZE, prog.left)}`}</button>` : '';
  const vRow = r => `<div class="row" data-flip data-key="${esc('hv:' + r.id)}">${c.thumbHTML({ id: r.id, title: r.track.name, art: r.track.art })}<div class="main">
      <div class="ttl">${esc(r.track.name)} <span class="sub">— ${esc(artistLine(r.track))}</span></div>
      <div class="why">${esc(versionNote(r.track, r.to))}</div>${where(c, r)}
    </div><div class="acts">${fixButton(c, r.id, r.to, r)}</div></div>`;
  const gRow = r => `<div class="row" data-key="${esc('hg:' + r.id)}">${c.thumbHTML({ id: r.id, title: r.track.name, art: r.track.art })}<div class="main">
      <div class="ttl">${esc(r.track.name)} <span class="sub">— ${esc(artistLine(r.track))}</span></div>${where(c, r)}</div></div>`;
  return `${lede}${findBlock(c)}
    <h2>Shown as another version <span class="mono" style="color:var(--ink-3);font-size:14px">${vers.length}</span></h2>
    <p class="sub hd-status" role="status">${status}</p>
    <div class="rowbtns">${run}</div>
    <div class="rows">${vers.slice(0, c.shownOf('hidden-v')).map(vRow).join('')
      || (prog.checked ? c.emptyState('Nothing hidden so far', 'Every song checked shows up in search as the copy you have.', { compact: true }) : '')}</div>
    ${c.moreButton('hidden-v', vers.length)}
    ${gone.length ? `<h2>Search can’t find these <span class="mono" style="color:var(--ink-3);font-size:14px">${gone.length}</span></h2>
      <p class="sub">Not in Spotify’s search under any version: usually pulled, or not available in your country. Open the playlist to play them while they last.</p>
      <div class="rows">${gone.slice(0, c.shownOf('hidden-g')).map(gRow).join('')}</div>${c.moreButton('hidden-g', gone.length)}` : ''}`;
}

/* ---------- actions ---------- */

function target(c, fromId, toId) {
  const r = H.checks?.[fromId]?.to;
  if (r?.id === toId) return r;
  const w = H.web?.hits?.find(h => h.id === toId);
  return w ?? null;
}

export const hiddenActions = {
  hdRun(c) { hiddenRun(c).catch(() => {}); },
  async hdAsk(c) {
    const q = H.q.trim(); if (!q || !c.sp) return;
    H.asking = true; c.render();
    try {
      const res = await c.sp(searchPath(q));
      H.web = { q: H.q, hits: (res?.tracks?.items ?? []).map(shapeHit).filter(Boolean) };
    } catch (err) { c.toast('Search failed: ' + (err?.message ?? err)); }
    finally { H.asking = false; c.render(); }
  },
  hdFix(c, el) { H.confirm = el.dataset.from + '>' + el.dataset.to; c.render(); },
  hdNo(c) { H.confirm = null; c.render(); },
  async hdYes(c, el) {
    const from = el.dataset.from, to = target(c, from, el.dataset.to);
    H.confirm = null;
    if (!to) { c.toast('That version is no longer offered. Check again.'); return c.render(); }
    H.busy = from + '>' + to.id; c.render();
    try {
      const r = await hiddenSwap(c, from, to);
      const at = (await c.getLog()).find(x => x.group === r.group)?.at;
      c.toast(`Swapped to the version search shows${r.playlists ? ` in ${r.playlists} playlist${r.playlists === 1 ? '' : 's'}` : ''}.`,
        at ? () => c.undoAction(at) : undefined);
    } catch (err) { c.toast('Failed: ' + (err?.message ?? err)); }
    finally { H.busy = null; c.render(); }
  },
};

/** After paint: the search box types into H.q and redraws in place. */
export function hiddenMount(c) {
  const input = c.document?.getElementById?.('hdSearch');
  if (input && !input.dataset.bound) {
    input.dataset.bound = '1';
    input.addEventListener('input', () => { H.q = input.value; c.render(); });
  }
}
