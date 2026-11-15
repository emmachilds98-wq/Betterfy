// @bundle screens inbox 20
/* ---------- artist roll-forward: docs/SMARTER-GENRES-PLAN.md, phase 4 ----------
 * File one track by an artist and the same artist's other unfiled tracks usually
 * belong in the same place. So the File screen offers them, as a list you can see
 * and untick, never a silent bulk move. Tracks already turned down for that
 * playlist are left out: a rejection is an answer. */
const ROLL_MAX = 40;

/** Other backlog tracks by `track`'s first-billed artist that could follow it into `playlistIds`. */
export function rollForwardFor(track, backlog, playlistIds, fb = {}) {
  const lead = track?.artists?.[0]?.id;
  if (!lead || !playlistIds?.length) return [];
  return (backlog ?? []).filter(b => b.id !== track.id && b.artists?.[0]?.id === lead
      && !playlistIds.some(pid => fb?.[b.id]?.rejected?.includes(pid)))
    .slice(0, ROLL_MAX);
}

export function rollForwardHTML({ S, esc }) {
  const rf = S.roll;
  if (!rf?.rows?.length) return '';
  const on = rf.rows.filter(r => !rf.off.has(r.id)).length;
  const where = rf.names.length > 1 ? `those ${rf.names.length} playlists` : esc(rf.names[0]);
  return `<div class="card" id="rollCard" style="margin:0 0 16px">
    <p style="margin:0 0 8px"><b>${rf.rows.length} more by ${esc(rf.artist)}</b> waiting to be filed. Put ${
      rf.rows.length === 1 ? 'it' : 'them'} in ${where} too?</p>
    <div class="rows" style="max-height:220px; overflow:auto">${rf.rows.map(r => `
      <label class="check-row"><input type="checkbox" data-act="rollpick" data-rollpick="${esc(r.id)}" ${rf.off.has(r.id) ? '' : 'checked'}>
        ${esc(r.title)}</label>`).join('')}</div>
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

export function view(ctx) {
  const { S, R, CFG, esc, filePicks, soundWarm, artHTML, ICON_PLAY, mmss, trackChip, tagChips, trackStrip,
          soundIdHTML, soundNote, pickEvidence, pickBand, matchMedia } = ctx;
  const rows = R.backlog;
  if (!rows.length) return `<h1>File</h1>
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
  const picks = filePicks(t);
  const opts = Object.entries(CFG).filter(([, v]) => v.target).map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const nameOf = id => opts.find(o => o.id === id)?.name ?? picks.find(s => s.id === id)?.name ?? id;
  const best = picks[0];
  const canFile = S.fileSel.size > 0 || !!best;
  const fileLabel = S.fileSel.size > 1 ? `File into ${S.fileSel.size} playlists`
    : S.fileSel.size === 1 ? `File in ${esc(nameOf([...S.fileSel][0]))}`
    : best ? `File in ${esc(best.name)}` : 'Pick a playlist below';
  // Say whichever of the two is actually available to the hand on the device.
  const touch = matchMedia('(hover:none) and (pointer:coarse)').matches;
  const how = touch
    ? `Tap to pick one or more, swipe <b>right</b> to file, <b>left</b> to skip.`
    : `Keys: <b>1–3</b> pick, <b>Enter</b> file, <b>P</b> play, <b>S</b> skip, <b>U</b> unlike.`;

  return `${rollForwardHTML(ctx)}<div class="counter" style="margin:0 0 16px">
      <span style="font-family:var(--mono); font-size:11.5px; letter-spacing:.12em; text-transform:uppercase; color:var(--accent)">${i + 1} of ${rows.length.toLocaleString()} · liked ${esc(t.added)}</span>
      <span${touch ? ' class="how-touch"' : ''}>${how}</span>
    </div>
    <div class="deck">
      ${rows[i + 1] ? '<div class="peek" aria-hidden="true"></div>' : ''}
      <div class="card swipecard" id="swipeCard" ${canFile ? `data-best="${esc(best?.id ?? '')}"` : ''}>
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
          <button class="pick ${n === 0 ? 'best' : ''}" data-act="selfile" data-selfile="${esc(sg.id)}"
            ${S.fileSel.has(sg.id) ? 'style="border-color:var(--accent); background:var(--surface-2)"' : ''}>
            <span class="k">${S.fileSel.has(sg.id) ? '✓' : n + 1}</span>
            <span class="mid"><span class="nm">${esc(sg.name)}</span><span class="ax">${sg.via === 'history'
              ? `${sg.count} of ${sg.total} other tracks by this artist are already here`
              : sg.via === 'sound' ? `sounds like this playlist${sg.tagsAgree ? ' · tags agree' : ''}`
              : sg.via === 'blend' ? (sg.untagged ? 'where you file this artist and ones like them'
                : sg.similar ? 'tags, and where you file artists like this' : 'tags, and where you file this kind of record')
              : `${esc(sg.axis ?? '')} playlist`}</span>${pickEvidence(sg)}</span>
            <span class="rt">${pickBand(sg)}<span class="sc">${sg.via === 'history' ? 'no tags yet' : (sg.score * 100).toFixed(0) + '%'}</span>
              <span class="bar"><i style="width:${(sg.score * 100).toFixed(0)}%"></i></span></span>
            <span class="nope" data-act="reject" data-reject="${esc(sg.id)}" role="button" tabindex="0"
              title="Never suggest ${esc(sg.name)} for this track">✕</span>
          </button>`).join('')}</div>`
        : `<p class="why" style="margin-top:22px">No confident suggestion — no tags for this artist, it fits nothing you have, and none of their other tracks are filed anywhere yet either. Pick a playlist below.</p>`}
        ${soundNote(t, picks)}${[...S.fileSel].filter(id => !picks.some(sg => sg.id === id)).length ? `<div class="rowbtns" style="margin-top:10px">
          ${[...S.fileSel].filter(id => !picks.some(sg => sg.id === id)).map(id =>
            `<button class="chip" data-act="selfile" data-selfile="${esc(id)}" title="Remove">${esc(nameOf(id))} ✕</button>`).join('')}
        </div>` : ''}
        <div class="rowbtns" style="margin-top:22px">
          <button class="b big go grow" data-act="filesel" data-filesel="1" ${canFile ? '' : 'disabled'}>${fileLabel}</button>
          <button class="b big" data-act="skip">Skip</button>
        </div>
        <div class="rowbtns" style="margin-top:10px">
          <button class="b sm" data-act="unlike">Unlike</button>
          <select id="anyPl" data-act="anyPl"><option value="">Add another playlist…</option>${opts.filter(o => !S.fileSel.has(o.id)).map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select>
        </div>
        <p style="margin:14px 0 0; font-size:13px; color:var(--ink-3); text-align:center">Nothing is written to Spotify until you tap File or swipe — and it can be undone after.</p>
      </div>
    </div>
    <div class="prog" style="margin-top:16px"><i style="width:${(i / rows.length * 100).toFixed(2)}%"></i></div>
    <div class="swipehint"><span>← <b>Skip</b></span><span>tap art to <b>play</b></span><span><b>File</b> →</span></div>`;
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
  const at = inboxIndex(ctx), t = R.backlog[at]; if (!t) return;
  const names = ids.map(id => CFG[id]?.name ?? id);
  try {
    // One log entry per playlist, so History and its per-row undo stay exact —
    // the toast just chains all of them for the common "undo the lot" case.
    const ats = [];
    for (const id of ids) {
      await addTracks(id, [t.id]);
      await logAction({ op:'add', playlistId:id, playlistName:CFG[id]?.name ?? id, trackIds:[t.id], reason:'filed from inbox' });
      ats.push((await getLog())[0]?.at);
    }
    // An accept is a verdict too (FB.accepted, read by audio-feedback.mjs), so
    // the sound learner hears "yes, there" before the next sync shows it.
    await recordAccept(t.id, ids);
    const undoAll = async () => { for (const at of [...ats].reverse()) if (at) await undoAction(at);
                                  await forgetAccept(t.id, ids); };
    toast(names.length > 1 ? `Filed “${t.title}” into ${names.length} playlists.` : `Filed “${t.title}” into ${names[0]}.`, undoAll);
    S.fileSel = new Set();
    R.backlog.splice(at, 1); S.inboxAt = inboxIndex(ctx);
    const more = rollForwardFor(t, R.backlog, ids, FB);
    S.roll = more.length ? { artist: t.artists?.[0]?.name ?? t.artist, playlistIds: ids, names,
                             rows: more.map(b => ({ id: b.id, title: b.title })), off: new Set() } : null;
    render();
  } catch (e) { toast('Failed: '+e.message); }
}
export async function inboxAct(ctx, a) {
  const { S, R, recordSkip, libraryCall, logAction, getLog, undoAction, playTrack, toast, render } = ctx;
  const at = inboxIndex(ctx), t = R.backlog[at]; if (!t) return;
  if (a === 'play') { try { toast('Playing on ' + await playTrack(t.id)); } catch(e){ toast(e.message); } return; }
  if (a === 'skip') {
    await recordSkip(t.id);
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
