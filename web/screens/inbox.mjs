// @bundle screens inbox 20
import { buildDigest, digestLines, digestBaseline, parseBaseline, playlistMap } from '../../core/measure/digest.mjs';
/* ---------- artist roll-forward: docs/SMARTER-GENRES-PLAN.md, phase 4 ----------
 * File one track by an artist and the same artist's other unfiled tracks usually
 * belong in the same place. So the File screen offers them, as a list you can see
 * and untick, never a silent bulk move. Tracks already turned down for that
 * playlist are left out: a rejection is an answer. */
const ROLL_MAX = 40;
const BAND_LOG = { HIGH: 'sure', LIKELY: 'likely', AMBIGUOUS: 'unsure' };
/** How long after a filing another one is ignored: the card's flight, about. */
const FLIGHT_MS = 300;

/** How many other cards are looked at for a matching sound ID (each is a lookup). */
const SOUND_SCAN = 200;

/**
 * Other backlog tracks that could follow `track` into `playlistIds`, each with
 * why (`how`): by the same first-billed artist; by the same sure sound ID (its
 * most specific genre, when both have been heard); or from the same label (ISRC
 * registrant) when the engine's own top pick for it is one of these playlists,
 * since a label alone says too little. `by.sound(t)` and `by.registrant(t)` come
 * from the page; without them it is the artist roll-forward it always was.
 * Tracks already turned down for that playlist are left out.
 */
export function rollForwardFor(track, backlog, playlistIds, fb = {}, by = {}) {
  if (!playlistIds?.length || !track) return [];
  const lead = track.artists?.[0]?.id;
  const open = b => b.id !== track.id && !playlistIds.some(pid => fb?.[b.id]?.rejected?.includes(pid));
  const out = [], seen = new Set();
  const add = (b, how) => { if (!seen.has(b.id)) { seen.add(b.id); out.push({ ...b, how }); } };
  if (lead) for (const b of backlog ?? []) if (open(b) && b.artists?.[0]?.id === lead) add(b, 'artist');
  const leaf = by.sound ? by.sound(track) : null, reg = by.registrant ? by.registrant(track) : null;
  if (leaf || reg) {
    let scanned = 0;
    for (const b of backlog ?? []) {
      if (out.length >= ROLL_MAX) break;
      if (!open(b) || seen.has(b.id)) continue;
      if (leaf && scanned++ < SOUND_SCAN && by.sound(b) === leaf) add(b, 'sound');
      else if (reg && by.registrant(b) === reg && playlistIds.includes(b.suggest?.[0]?.id)) add(b, 'label');
    }
  }
  return out.slice(0, ROLL_MAX);
}

export function rollForwardHTML({ S, esc }) {
  const rf = S.roll;
  if (!rf?.rows?.length) return '';
  const on = rf.rows.filter(r => !rf.off.has(r.id)).length;
  const where = rf.names.length > 1 ? `those ${rf.names.length} playlists` : esc(rf.names[0]);
  const alike = rf.rows.filter(r => r.how === 'sound' || r.how === 'label').length;
  const head = alike ? `<b>${rf.rows.length} more</b> waiting, by ${esc(rf.artist)} or sounding or released alike`
    : `<b>${rf.rows.length} more by ${esc(rf.artist)}</b> waiting to be filed`;
  const note = r => r.how === 'sound' ? ' <span class="sub">sounds alike</span>' : r.how === 'label' ? ' <span class="sub">same label</span>' : '';
  return `<div class="card" id="rollCard" style="margin:0 0 16px">
    <p style="margin:0 0 8px">${head}. Put ${
      rf.rows.length === 1 ? 'it' : 'them'} in ${where} too?</p>
    <div class="rows" style="max-height:220px; overflow:auto">${rf.rows.map(r => `
      <label class="check-row"><input type="checkbox" data-act="rollpick" data-rollpick="${esc(r.id)}" ${rf.off.has(r.id) ? '' : 'checked'}>
        ${esc(r.title)}${note(r)}</label>`).join('')}</div>
    <div class="rowbtns" style="margin-top:10px">
      <button class="b sm p" data-act="roll" data-roll="go" ${on ? '' : 'disabled'}>File ${on} into ${where}</button>
      <button class="b sm" data-act="roll" data-roll="no">Not now</button>
    </div>
  </div>`;
}

/** File the ticked ones, one History entry per playlist, one undo for the lot. */
export async function rollForwardGo(ctx) {
  const { S, R, CFG, addTracks, logAction, getLog, undoAction, toast, render } = ctx;
  const rf = S.roll;
  if (!rf) return;
  const ids = rf.rows.map(r => r.id).filter(id => !rf.off.has(id));
  if (!ids.length) { S.roll = null; return render(); }
  const ats = [];
  for (const pid of rf.playlistIds) {
    await addTracks(pid, ids);
    await logAction({ op:'add', playlistId:pid, playlistName:CFG[pid]?.name ?? pid, trackIds:ids,
                      reason:`filed with the rest of ${rf.artist}` });
    ats.push((await getLog())[0]?.at);
  }
  // In place, and keeping whichever track is on screen on screen.
  const keep = R.backlog[inboxIndex(ctx)]?.id, gone = new Set(ids);
  for (let k = R.backlog.length - 1; k >= 0; k--) if (gone.has(R.backlog[k].id)) R.backlog.splice(k, 1);
  S.inboxAt = Math.max(0, R.backlog.findIndex(b => b.id === keep));
  S.roll = null;
  const undoAll = async () => { for (const at of [...ats].reverse()) if (at) await undoAction(at); };
  toast(`Filed ${ids.length} more by ${rf.artist}.`, undoAll);
  render();
}

/* ---------- "Since you last opened": docs/BUILD-6-PLAN.md F5 ----------
 * One dismissible card at the top of File, worked out once per session from
 * what the page already holds (core/measure/digest.mjs): no request, never a
 * notification, and nothing at all when there is nothing to say. The baseline
 * for next time and the dismissed/expanded counts stay in this browser. */
export const DIGEST_SEEN = 'bf_digest_seen';
export const DIGEST_MEASURE = 'bf_digest_measure';

const coldGenres = ({ COLD }) => (COLD?.status === 'ready' && Array.isArray(COLD.newGenre) ? COLD.newGenre : null);
const plMap = ({ LIB, isMirrorPlaylist }) => playlistMap(LIB?.playlists, isMirrorPlaylist ?? (() => false));

/** The local-only measure: how often the card was shown, opened up and dismissed. */
export function digestMeasure({ LS }) {
  try { const m = JSON.parse(LS?.getItem(DIGEST_MEASURE) ?? 'null'); if (m && typeof m === 'object') return { shown: m.shown | 0, expanded: m.expanded | 0, dismissed: m.dismissed | 0 }; }
  catch { /* a malformed record starts again */ }
  return { shown: 0, expanded: 0, dismissed: 0 };
}
function bumpMeasure(ctx, k) {
  const m = digestMeasure(ctx); m[k]++;
  try { ctx.LS?.setItem(DIGEST_MEASURE, JSON.stringify(m)); } catch { /* the measure only */ }
}

/** The digest for this session, or null while it loads or has nothing to say. */
export function digestNow(ctx) {
  const { S, R, LIB } = ctx, D = S.digest;
  if (!D || D.status !== 'ready' || D.hidden) return null;
  // A brand-new account has no last open and no History: nothing to look back on.
  if (!D.base && !D.log?.length) return null;
  const genres = coldGenres(ctx), pls = LIB?.playlists;
  const m = D.memo;
  if (m && m.R === R && m.n === R.backlog.length && m.genres === genres && m.pls === pls) return m.d.empty ? null : m.d;
  const d = buildDigest({ base: D.base, now: D.at, log: D.log, backlog: R.backlog, liked: LIB?.liked,
                          misfiled: R.misfiled, genres, playlists: D.base?.pls ? plMap(ctx) : null, listening: D.listening });
  D.memo = { R, n: R.backlog.length, genres, pls, d };
  return d.empty ? null : d;
}

export function digestHTML(ctx) {
  const { S, esc } = ctx;
  const d = digestNow(ctx), L = digestLines(d);
  if (!L) return '';
  const open = !!S.digest.open;
  const summary = L.lines.filter(l => l.short).map(l => esc(l.short)).join(' · ');
  const line = l => l.go ? `<li><button class="dg-go" data-go="${esc(l.go)}">${esc(l.text)}</button></li>` : `<li>${esc(l.text)}</li>`;
  return `<section class="card digest${open ? ' open' : ''}" id="digestCard" aria-labelledby="digestHead">
    <div class="dg-top">
      <h2 id="digestHead">${esc(L.head)}</h2>
      <button class="dg-x" data-act="digestHide" aria-label="Dismiss this summary" title="Dismiss"><span aria-hidden="true">✕</span></button>
    </div>
    ${open ? `<ul class="dg-lines">${L.lines.map(line).join('')}</ul>`
      : `<p class="dg-sum">${summary} <button class="dg-more" data-act="digestMore" aria-expanded="false">Details</button></p>`}
  </section>`;
}

/** Once per session: read the last open's record and the log, then store this open as the next baseline. */
export async function digestLoad(ctx) {
  const { S, R, LS, getLog, listeningRaw, render } = ctx, D = S.digest;
  try {
    const base = parseBaseline(LS?.getItem(DIGEST_SEEN));
    const log = (await getLog?.()) ?? [];
    let listening = null;
    try { listening = (await listeningRaw?.()) ?? null; } catch { /* no cached listening: no line */ }
    const genres = coldGenres(ctx);
    Object.assign(D, { status: 'ready', base, log, listening, savedGenres: !!genres });
    try { LS?.setItem(DIGEST_SEEN, JSON.stringify(digestBaseline({ prev: base, now: D.at, misfiled: R.misfiled, genres, playlists: plMap(ctx) }))); }
    catch { /* nothing kept: next time looks back a week */ }
    if (digestNow(ctx)) render();
  } catch { D.status = 'error'; }
}

export function digestMount(ctx) {
  const { S, LS } = ctx;
  if (!S.digest) { S.digest = { status: 'loading', at: Date.now() }; return digestLoad(ctx); }
  const D = S.digest;
  if (D.status !== 'ready') return;
  if (!D.counted && !D.hidden && globalThis.document?.getElementById('digestCard')) { D.counted = true; bumpMeasure(ctx, 'shown'); }
  // The new-genre clusters arrive whenever Library works them out: remember them once they exist.
  const genres = coldGenres(ctx);
  if (genres && !D.savedGenres) {
    D.savedGenres = true;
    const rec = parseBaseline(LS?.getItem(DIGEST_SEEN));
    if (rec) try { LS.setItem(DIGEST_SEEN, JSON.stringify({ ...rec, genres: digestBaseline({ now: D.at, genres }).genres })); } catch { /* next time */ }
  }
}

/* ---------- "File the N sure ones": docs/BUILD-5-PLAN.md §5.2 ----------
 * The cards whose leading pick is calibrated sure, filed in one go: one History
 * group (a step per playlist), one undo. Only among the first cards of the queue. */
const sureList = ctx => { try { return ctx.fileSure?.() ?? []; } catch { return []; } };

export function sureBatchHTML(ctx) {
  const { S, esc } = ctx;
  if (S.roll) return '';
  const n = sureList(ctx).length;
  // E1: a batch that stopped partway says what landed and offers the rest.
  if (S.partial && n) return `<div class="card surebatch" role="status" style="margin:0 0 16px; display:flex; gap:12px; align-items:center; justify-content:space-between; flex-wrap:wrap">
    <span><b>${esc(String(S.partial.landed))} of ${esc(String(S.partial.total))} landed.</b> <span class="sub">${esc(String(n))} didn't. What did land is in History as one group.</span></span>
    <button class="b sm p" data-act="filesure">Retry the rest</button>
  </div>`;
  if (n < 2) return '';
  return `<div class="card surebatch" style="margin:0 0 16px; display:flex; gap:12px; align-items:center; justify-content:space-between; flex-wrap:wrap">
    <span><b>${n} are sure.</b> <span class="sub">The engine's checked answer for each is a single playlist.</span></span>
    <button class="b sm p" data-act="filesure">File the ${esc(String(n))} sure ones</button>
  </div>`;
}

/**
 * File every sure card into its playlist: one add per playlist, all logged under
 * one group with `band:'sure'` (Score's §7 reads it), so History shows one row
 * and one undo takes the whole batch back.
 */
export async function fileSureOnes(ctx) {
  const { S, R, CFG, addTracks, landedIn, logAction, getLog, undoAction, newGroup, recordAccept, forgetAccept, toast, render } = ctx;
  const now = Date.now();
  if (S.filing || now < (S.fileLockUntil ?? 0)) return;
  const batch = sureList(ctx);
  if (!batch.length) return;
  S.filing = true;
  const byPl = new Map();
  batch.forEach(({ row, playlistId }) => {
    const at = R.backlog.findIndex(b => b.id === row.id);
    (byPl.get(playlistId) ?? byPl.set(playlistId, []).get(playlistId)).push({ id: row.id, at });
  });
  // E1: a retry after a partial failure carries on the same History group.
  const prior = S.partial, before = prior?.done.length ?? 0;
  const group = prior?.group ?? newGroup(), ats = [...(prior?.ats ?? [])], done = [...(prior?.done ?? [])];
  const total = (prior?.total ?? 0) + batch.length;
  const logAdd = async (pid, ids, rows, reason) => {
    await logAction({ op:'add', playlistId:pid, playlistName:CFG[pid]?.name ?? pid, trackIds:ids,
                      reason, band:'sure', queuePos:Math.min(...rows.map(r => r.at)), group });
    ats.push((await getLog())[0]?.at);
    done.push([pid, ids]);
  };
  const logged = new Set();
  let failure = null;
  try {
    for (const [pid, rows] of byPl) {
      const ids = rows.map(r => r.id);
      await addTracks(pid, ids);
      await logAdd(pid, ids, rows, 'filed the sure ones');
      logged.add(pid);
    }
  } catch (e) { failure = e; }
  if (failure) {
    // Re-read what Spotify actually holds for the playlists not yet logged, and
    // log whatever landed (a write whose answer was lost, or a chunk that got in).
    let unread = false;
    for (const [pid, rows] of byPl) {
      if (logged.has(pid)) continue;
      const ids = rows.map(r => r.id), got = landedIn ? await landedIn(pid, ids) : null;
      if (got === null) { unread = true; continue; }
      if (got.length) await logAdd(pid, got, rows.filter(r => got.includes(r.id)), 'filed the sure ones (found after a failure)');
    }
    const landedIds = new Set(done.flatMap(([, ids]) => ids));
    for (const [pid, ids] of done.slice(before)) for (const id of ids) await recordAccept(id, [pid]);
    S.filing = false;
    if (done.length === before) {
      toast('Failed: ' + failure.message + (unread ? ' Could not check what landed.' : ''));
      return render();
    }
    for (let k = R.backlog.length - 1; k >= 0; k--) if (landedIds.has(R.backlog[k].id)) R.backlog.splice(k, 1);
    S.inboxAt = Math.max(0, Math.min(S.inboxAt, R.backlog.length - 1));
    S.partial = { group, ats, done, total, landed: landedIds.size };
    toast(`${landedIds.size} of ${total} landed. ${failure.message}`, null, { label: 'Retry the rest', run: () => fileSureOnes(ctx) });
    return render();
  }
  for (const [pid, ids] of done.slice(before)) for (const id of ids) await recordAccept(id, [pid]);
  S.partial = null;
  S.filing = false;
  const keep = R.backlog[inboxIndex(ctx)]?.id, gone = new Set(done.flatMap(([, ids]) => ids));
  for (let k = R.backlog.length - 1; k >= 0; k--) if (gone.has(R.backlog[k].id)) R.backlog.splice(k, 1);
  S.inboxAt = Math.max(0, R.backlog.findIndex(b => b.id === keep));
  S.roll = null; S.fileSel = new Set();
  const n = gone.size;
  toast(`Filed ${n} sure ${n === 1 ? 'one' : 'ones'}.`, async () => {
    if (ats[0]) await undoAction(ats[0]);
    for (const [pid, ids] of done) for (const id of ids) await forgetAccept(id, [pid]);
  });
  render();
}

export function view(ctx) {
  const { S, R, CFG, esc, filePicks, soundWarm, artHTML, ICON_PLAY, mmss, trackChip, tagChips, trackStrip,
          soundIdHTML, soundNote, pickEvidence, pickBand, matchMedia } = ctx;
  const rows = R.backlog;
  // A new account has nothing to file yet: say what to do, not "that's the lot".
  if (!rows.length && !ctx.LIB?.liked?.length) {
    const hasPl = ctx.LIB?.playlists?.some(p => p.tracks?.length);
    return `<h1>File</h1><div class="empty-state"><span class="es-mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
      <div class="es-body"><b>${hasPl ? 'No liked songs yet' : 'Your library is empty'}</b>
      <p>${hasPl ? 'File sorts your liked songs into your playlists. Like a few songs in Spotify and they will show up here.'
        : 'Like some songs in Spotify, or make a playlist, then reopen Betterfy. It files your liked songs into your playlists.'}</p></div></div>`;
  }
  if (!rows.length) return `<h1>File</h1>${digestHTML(ctx)}
    <div class="empty done">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <rect x="7.75" y="4.9" width="7" height="3.4" rx="1.7" style="fill:var(--m0)"/>
        <rect x="7.75" y="9.6" width="12" height="3.4" rx="1.7" style="fill:var(--m1)"/>
        <rect x="7.75" y="14.3" width="16.5" height="3.4" rx="1.7" style="fill:var(--m2)"/>
        <rect x="7.75" y="19" width="12" height="3.4" rx="1.7" style="fill:var(--m3)"/>
        <rect x="7.75" y="23.7" width="7" height="3.4" rx="1.7" style="fill:var(--m4)"/>
      </svg>
      <b>That's the lot.</b>Every liked song sits in at least one playlist. Nothing left to file.</div>`;

  const i = Math.min(S.inboxAt, rows.length - 1), t = rows[i];
  // A tap only ever builds a selection now — it never writes to Spotify by
  // itself, which is what a misclick used to cost. The selection belongs to
  // whichever track is on screen, so it clears the moment that changes.
  if (S.fileSelFor !== t.id) { S.fileSel = new Set(); S.fileSelFor = t.id; }
  if (typeof soundWarm === 'function') soundWarm();
  const promote = !!S.promote; S.promote = false;   // the peek card springing up, once
  const picks = filePicks(t);
  const opts = Object.entries(CFG).filter(([, v]) => v.target).map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const nameOf = id => opts.find(o => o.id === id)?.name ?? picks.find(s => s.id === id)?.name ?? id;
  const best = picks[0];
  // The calibrated band for the leading pick on every card, not only the sound ones.
  const topBand = ctx.fileBand?.(t, picks) ?? best?.band ?? null;
  ctx.fileOrderKick?.();
  const canFile = S.fileSel.size > 0 || !!best;
  const fileLabel = S.fileSel.size > 1 ? `File into ${S.fileSel.size} playlists`
    : S.fileSel.size === 1 ? `File in ${esc(nameOf([...S.fileSel][0]))}`
    : best ? `File in ${esc(best.name)}` : 'Pick a playlist below';
  // Say whichever of the two is actually available to the hand on the device.
  const touch = matchMedia('(hover:none) and (pointer:coarse)').matches;
  const how = touch
    ? `Tap to pick one or more, swipe <b>right</b> to file, <b>left</b> to skip.`
    : '';

  return `${digestHTML(ctx)}${sureBatchHTML(ctx)}${rollForwardHTML(ctx)}<div class="counter" style="margin:0 0 16px">
      <span style="font-family:var(--mono); font-size:11.5px; letter-spacing:.12em; text-transform:uppercase; color:var(--accent)">${i + 1} of ${rows.length.toLocaleString()} · liked ${esc(t.added)}</span>
      <span${touch ? ' class="how-touch"' : ''}>${how}</span>
    </div>
    <div class="deck">
      ${rows[i + 1] ? '<div class="peek" aria-hidden="true"></div>' : ''}
      <div class="card swipecard${promote ? ' promote' : ''}" id="swipeCard" ${canFile ? `data-best="${esc(best?.id ?? '')}"` : ''}>
        <div class="verdicts" aria-hidden="true">
          <span class="verdict file">${S.fileSel.size ? `${S.fileSel.size} playlist${S.fileSel.size>1?'s':''}` : best ? esc(best.name) : 'No pick'}</span>
          <span class="verdict skip">Skip</span>
        </div>
        <h2 style="margin:0 0 20px; font-size:26px; font-weight:800; letter-spacing:-.025em">Where does this one go?</h2>
        <div class="now">
          <div class="artwrap">
            ${artHTML(t)}
            <button class="pfab" data-act="play" aria-label="Play">${ICON_PLAY}</button>
          </div>
          <div class="txt">
            <p class="t">${esc(t.title)}</p><p class="a">${esc(t.artist)}</p>
            <div class="m"><span>${esc(t.album ?? '')}</span><span>${esc((t.released ?? '').slice(0, 4))}</span><span>${mmss(t.dur)}</span></div>${trackChip(t)}
            ${t.tags.length ? tagChips(t.tags, t.thinData) : ''}
          </div>
        </div>${trackStrip(t)}${soundIdHTML(t)}
        ${picks.length ? `<div class="picks">${picks.slice(0, 3).map((sg, n) => `
          <div class="pickw"><button class="pick ${n === 0 ? 'best' : ''}" data-act="selfile" data-selfile="${esc(sg.id)}"
            ${S.fileSel.has(sg.id) ? 'style="border-color:var(--accent); background:var(--surface-2)"' : ''}>
            <span class="k">${S.fileSel.has(sg.id) ? '✓' : n + 1}</span>
            <span class="mid"><span class="nm">${esc(sg.name)}</span><span class="ax">${sg.via === 'history'
              ? `${sg.count} of ${sg.total} other tracks by this artist are already here`
              : sg.via === 'sound' ? `sounds like this playlist${sg.tagsAgree ? ' · tags agree' : ''}`
              : sg.via === 'blend' ? (sg.untagged ? 'where you file this artist and ones like them'
                : sg.similar ? 'tags, and where you file artists like this' : 'tags, and where you file this kind of record')
              : `${esc(sg.axis ?? '')} playlist`}</span>${pickEvidence(sg)}</span>
            <span class="rt">${pickBand(n === 0 && topBand ? { ...sg, band: topBand } : sg)}<span class="sc">${sg.via === 'history' ? 'no tags yet' : (sg.score * 100).toFixed(0) + '%'}</span>
              <span class="bar"><i style="width:${(sg.score * 100).toFixed(0)}%"></i></span></span>
          </button><button class="nope" type="button" data-act="reject" data-reject="${esc(sg.id)}"
            title="Never suggest ${esc(sg.name)} for this track" aria-label="Never suggest ${esc(sg.name)} for this track"><span aria-hidden="true">✕</span></button></div>`).join('')}</div>`
        : `<p class="why" style="margin-top:22px">No confident suggestion — no tags for this artist, it fits nothing you have, and none of their other tracks are filed anywhere yet either. Pick a playlist below.</p>`}
        ${soundNote(t, picks)}${[...S.fileSel].filter(id => !picks.some(sg => sg.id === id)).length ? `<div class="rowbtns" style="margin-top:10px">
          ${[...S.fileSel].filter(id => !picks.some(sg => sg.id === id)).map(id =>
            `<button class="chip" data-act="selfile" data-selfile="${esc(id)}" title="Remove">${esc(nameOf(id))} ✕</button>`).join('')}
        </div>` : ''}
        <div class="rowbtns" style="margin-top:22px">
          <button class="b big go grow" data-act="filesel" data-filesel="1" ${canFile ? '' : 'disabled'}>${fileLabel}</button>
          <button class="b big" data-act="skip">Skip</button>
        </div>
        <details class="cardmore"><summary aria-label="More: unlike, or add another playlist" title="More">\u22EF</summary>
          <div class="rowbtns">
            <button class="b sm" data-act="unlike">Unlike</button>
            <select id="anyPl" data-act="anyPl"><option value="">Add another playlist…</option>${opts.filter(o => !S.fileSel.has(o.id)).map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select>
          </div>
        </details>
      </div>
    </div>
    <div class="prog" style="margin-top:16px"><i style="width:${(i / rows.length * 100).toFixed(2)}%"></i></div>
    ${touch ? '' : `<div class="swipehint" role="note"><span>← <b>Skip</b></span><span>tap art to <b>play</b></span><span><b>File</b> →</span>
      <span><b>1–3</b> pick · <b>Enter</b> file · <b>S</b> skip · <b>U</b> unlike</span></div>`}`;
}

/** Toggle one playlist in or out of the pending selection for the track on screen. */
export function toggleFileSel({ S, render }, id) {
  if (S.fileSel.has(id)) S.fileSel.delete(id); else S.fileSel.add(id);
  render();
}

/**
 * The track the File screen is actually showing. vInbox() clamps its index to
 * the end of the queue, and every action below used to read R.backlog[S.inboxAt]
 * raw — so once filing had shortened the queue past the position "Next up to
 * file" had jumped to, the card on screen and the track the buttons acted on
 * were different rows, and at the very end of the queue there was no such row
 * at all: File, Skip, Unlike and Play each returned silently, with the card
 * still sitting there. Clamped in one place instead, so the screen and its
 * buttons cannot disagree.
 */
export const inboxIndex = ({ S, R }) => Math.min(Math.max(S.inboxAt | 0, 0), Math.max(R.backlog.length - 1, 0));
export const inboxTrack = ctx => ctx.R.backlog[inboxIndex(ctx)] ?? null;

/** File the current inbox track into one or several playlists at once. Takes
 *  a single id (the swipe gesture, keyboard 1-3 followed by Enter's fallback)
 *  or an array (the multi-select confirm button) — either way nothing is
 *  written until this actually runs. */
export async function fileCurrent(ctx, playlistIds) {
  const { S, R, CFG, FB, addTracks, logAction, getLog, undoAction, recordAccept, forgetAccept, toast, render } = ctx;
  const ids = (Array.isArray(playlistIds) ? playlistIds : [playlistIds]).filter(Boolean);
  if (!ids.length) return;
  // Optimistic (docs/BUILD-5-PLAN.md §4.2): the card leaves now and the writes
  // happen behind it. The flight lock is what keeps a double tap, or a swipe
  // that lands on top of a tap, from filing the *next* card by accident,
  // since by the time the second one arrives the queue has already advanced.
  const now = Date.now();
  if (S.filing || now < (S.fileLockUntil ?? 0)) return;
  const at = inboxIndex(ctx), t = R.backlog[at]; if (!t) return;
  const deckLen = R.backlog.length;
  S.fileLockUntil = now + FLIGHT_MS; S.filing = true;
  const names = ids.map(id => CFG[id]?.name ?? id);
  // Logged with each filing so the Score summary can measure itself (§7):
  // where in the queue it was filed from, and the band File showed for it.
  let picks = [];
  try { picks = ctx.filePicks?.(t) ?? []; } catch { /* no band, still filed */ }
  // 'sure' / 'likely' / 'unsure': the words core/measure/history.mjs counts.
  const lead = ctx.fileBand?.(t, picks) ?? picks[0]?.band;
  const bandOf = id => { const b = id === picks[0]?.id ? lead : picks.find(p => p.id === id)?.band;
                         return BAND_LOG[b]; };
  const picked = new Set(S.fileSel);
  try { ctx.flyCard?.(1); } catch { /* the animation is a bonus */ }
  S.fileSel = new Set();
  R.backlog.splice(at, 1); S.inboxAt = inboxIndex(ctx);
  S.promote = true;
  render();
  // One log entry per playlist, so History and its per-row undo stay exact;
  // the toast just chains all of them for the common "undo the lot" case.
  const ats = [];
  try {
    for (const id of ids) {
      await addTracks(id, [t.id]);
      await logAction({ op:'add', playlistId:id, playlistName:CFG[id]?.name ?? id, trackIds:[t.id], reason:'filed from inbox', queuePos:at, deck:deckLen, band:bandOf(id) });
      ats.push((await getLog())[0]?.at);
    }
    // An accept is a verdict too (FB.accepted, read by audio-feedback.mjs), so
    // the sound learner hears "yes, there" before the next sync shows it.
    await recordAccept(t.id, ids);
  } catch (e) {
    // Put the card back where it was, with its selection, and say why.
    for (const a of [...ats].reverse()) { try { if (a) await undoAction(a); } catch { /* best effort */ } }
    S.fileLockUntil = 0; S.filing = false;
    if (!R.backlog.some(b => b.id === t.id)) R.backlog.splice(Math.min(at, R.backlog.length), 0, t);
    S.inboxAt = Math.max(0, R.backlog.findIndex(b => b.id === t.id));
    S.fileSelFor = t.id; S.fileSel = picked.size ? picked : new Set(ids);
    S.roll = null;
    toast('Failed: ' + e.message);
    render();
    return;
  }
  S.filing = false;
  const undoAll = async () => { for (const at of [...ats].reverse()) if (at) await undoAction(at);
                                await forgetAccept(t.id, ids); };
  toast(names.length > 1 ? `Filed “${t.title}” into ${names.length} playlists.` : `Filed “${t.title}” into ${names[0]}.`, undoAll);
  const more = rollForwardFor(t, R.backlog, ids, FB, { sound: ctx.rollSound, registrant: ctx.rollRegistrant });
  S.roll = more.length ? { artist: t.artists?.[0]?.name ?? t.artist, playlistIds: ids, names,
                           rows: more.map(b => ({ id: b.id, title: b.title, how: b.how })), off: new Set() } : null;
  render();
}
export async function inboxAct(ctx, a) {
  const { S, R, recordSkip, libraryCall, logAction, getLog, undoAction, playTrack, toast, render } = ctx;
  const at = inboxIndex(ctx), t = R.backlog[at]; if (!t) return;
  if (a === 'play') { try { toast('Playing on ' + await playTrack(t.id)); } catch(e){ toast(e.message); } return; }
  if (a === 'skip') {
    await recordSkip(t.id);
    try { await logAction({ op:'skip', trackIds:[t.id], reason:'skipped from inbox', queuePos:at, deck:R.backlog.length }); } catch { /* the measure only */ }
    // Move it to the back rather than stepping past it, so the rest of the
    // queue advances now and the skip still holds after a reload.
    t.skips = (t.skips ?? 0) + 1;
    R.backlog.splice(at, 1);
    R.backlog.push(t);
    // The skipped card is now the last row, so staying on the last index would
    // show it straight back — which is what skipping the final track in the
    // queue used to do: the skip was recorded, and nothing on screen moved.
    S.inboxAt = at >= R.backlog.length - 1 ? 0 : at;
    S.fileSel = new Set();
    return render();
  }
  if (a === 'unlike') {
    try {
      await libraryCall('DELETE', [t.id]);
      await logAction({ op:'unlike', trackIds:[t.id], reason:'from inbox' });
      const logAt = (await getLog())[0]?.at;
      toast(`Unliked “${t.title}”.`, () => undoAction(logAt));
      R.backlog.splice(at, 1); S.inboxAt = inboxIndex(ctx); render();
    } catch(e){ toast('Failed: '+e.message); }
  }
}


/** data-act handlers: the File screen's clicks and changes, moved out of events.js. */
export const actions = {
  selfile: (ctx, el) => toggleFileSel(ctx, el.dataset.selfile),
  anyPl: (ctx, el) => { if (el.value) toggleFileSel(ctx, el.value); },
  filesure: (ctx) => fileSureOnes(ctx),
  digestMore(ctx) {
    const D = ctx.S.digest; if (!D) return;
    if (!D.expandedOnce) { D.expandedOnce = true; bumpMeasure(ctx, 'expanded'); }
    D.open = true; ctx.render();
  },
  digestHide(ctx) {
    const D = ctx.S.digest; if (!D) return;
    D.hidden = true; bumpMeasure(ctx, 'dismissed'); ctx.render();
  },
  filesel: (ctx) => fileCurrent(ctx, ctx.S.fileSel.size ? [...ctx.S.fileSel] : ctx.filePicks(inboxTrack(ctx))[0]?.id),
  play: (ctx) => inboxAct(ctx, 'play'),
  skip: (ctx) => inboxAct(ctx, 'skip'),
  unlike: (ctx) => inboxAct(ctx, 'unlike'),
  async roll(ctx, el) {
    if (el.dataset.roll === 'no') { ctx.S.roll = null; return ctx.render(); }
    el.disabled = true;
    try { await rollForwardGo(ctx); } catch (err) { el.disabled = false; ctx.toast('Failed: ' + err.message); }
  },
  rollpick({ S, render }, el) {
    if (!S.roll) return;
    const id = el.dataset.rollpick;
    if (S.roll.off.has(id)) S.roll.off.delete(id); else S.roll.off.add(id);
    render();
  },
  async reject(ctx, el, e) {
    const { S, R, LIB, CFG, FB, TAGS, toast, render, recordReject, backlogSuggest, gateTags, tagGate,
            artistRejectMemory, fbUnstamp, saveFeedback, rebuildReports } = ctx;
    e?.stopPropagation?.();
    const t = inboxTrack(ctx); if (!t) return;
    const pid = el.dataset.reject, pname = CFG[pid]?.name ?? pid;
    await recordReject(t.id, pid);
    S.fileSel.delete(pid);
    // Re-rank this one track now, so the slot fills with the next real
    // candidate instead of leaving a gap, through the same backlogSuggest()
    // that made the card, so the filing-history fallback and `via` survive.
    const raw = LIB.liked.find(x => x.id === t.id);
    t.suggest = raw ? backlogSuggest(raw, LIB, CFG, gateTags(TAGS, tagGate(TAGS)), R.profiles, R.idf) : [];
    // The artist's other cards re-rank too: the rejection lowers this playlist
    // for them (backlogSuggest reads it through rejectFactors).
    const lead = t.artists?.[0]?.id;
    if (lead) {
      const gated = gateTags(TAGS, tagGate(TAGS)), mem = artistRejectMemory(FB, LIB);
      for (const b of R.backlog) {
        if (b.id === t.id || b.artists?.[0]?.id !== lead) continue;
        const rb = LIB.liked.find(x => x.id === b.id);
        if (rb) b.suggest = backlogSuggest(rb, LIB, CFG, gated, R.profiles, R.idf, undefined, mem);
      }
    }
    toast(`Won't suggest ${pname} for this track again.`, async () => {
      const f = FB[t.id]; if (f) { f.rejected = f.rejected.filter(x => x !== pid); fbUnstamp(f, 'rejectedAt', [pid]); }
      await saveFeedback(); rebuildReports(); render();
    });
    render();
  },
};

// E1: patch() keeps the menu open across a repaint of the same card (a late
// listening re-sort used to close it); a different card starts with it shut.
let menuFor = null;
export function mount(ctx) {
  digestMount(ctx);
  const id = inboxTrack(ctx)?.id ?? null;
  if (id !== menuFor) { menuFor = id; document.querySelector("#swipeCard details.cardmore")?.removeAttribute("open"); }
}
