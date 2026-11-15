/* ---------- artist roll-forward: docs/SMARTER-GENRES-PLAN.md, phase 4 ----------
 * File one track by an artist and the same artist's other unfiled tracks usually
 * belong in the same place. So the File screen offers them, as a list you can see
 * and untick, never a silent bulk move. Tracks already turned down for that
 * playlist are left out: a rejection is an answer. */
const ROLL_MAX = 40;

/** Other backlog tracks by `track`'s first-billed artist that could follow it into `playlistIds`. */
function rollForwardFor(track, backlog, playlistIds, fb = {}) {
  const lead = track?.artists?.[0]?.id;
  if (!lead || !playlistIds?.length) return [];
  return (backlog ?? []).filter(b => b.id !== track.id && b.artists?.[0]?.id === lead
      && !playlistIds.some(pid => fb?.[b.id]?.rejected?.includes(pid)))
    .slice(0, ROLL_MAX);
}

function rollForwardHTML() {
  const rf = S.roll;
  if (!rf?.rows?.length) return '';
  const on = rf.rows.filter(r => !rf.off.has(r.id)).length;
  const where = rf.names.length > 1 ? `those ${rf.names.length} playlists` : esc(rf.names[0]);
  return `<div class="card" id="rollCard" style="margin:0 0 16px">
    <p style="margin:0 0 8px"><b>${rf.rows.length} more by ${esc(rf.artist)}</b> waiting to be filed. Put ${
      rf.rows.length === 1 ? 'it' : 'them'} in ${where} too?</p>
    <div class="rows" style="max-height:220px; overflow:auto">${rf.rows.map(r => `
      <label class="check-row"><input type="checkbox" data-rollpick="${esc(r.id)}" ${rf.off.has(r.id) ? '' : 'checked'}>
        ${esc(r.title)}</label>`).join('')}</div>
    <div class="rowbtns" style="margin-top:10px">
      <button class="b sm p" data-roll="go" ${on ? '' : 'disabled'}>File ${on} into ${where}</button>
      <button class="b sm" data-roll="no">Not now</button>
    </div>
  </div>`;
}

/** File the ticked ones, one History entry per playlist, one undo for the lot. */
async function rollForwardGo() {
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
  const keep = R.backlog[inboxIndex()]?.id, gone = new Set(ids);
  for (let k = R.backlog.length - 1; k >= 0; k--) if (gone.has(R.backlog[k].id)) R.backlog.splice(k, 1);
  S.inboxAt = Math.max(0, R.backlog.findIndex(b => b.id === keep));
  S.roll = null;
  const undoAll = async () => { for (const at of [...ats].reverse()) if (at) await undoAction(at); };
  toast(`Filed ${ids.length} more by ${rf.artist}.`, undoAll);
  render();
}

function vInbox() {
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

  return `${rollForwardHTML()}<div class="counter" style="margin:0 0 16px">
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
          <button class="pick ${n === 0 ? 'best' : ''}" data-selfile="${esc(sg.id)}"
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
            <span class="nope" data-reject="${esc(sg.id)}" role="button" tabindex="0"
              title="Never suggest ${esc(sg.name)} for this track">✕</span>
          </button>`).join('')}</div>`
        : `<p class="why" style="margin-top:22px">No confident suggestion — no tags for this artist, it fits nothing you have, and none of their other tracks are filed anywhere yet either. Pick a playlist below.</p>`}
        ${soundNote(t, picks)}${[...S.fileSel].filter(id => !picks.some(sg => sg.id === id)).length ? `<div class="rowbtns" style="margin-top:10px">
          ${[...S.fileSel].filter(id => !picks.some(sg => sg.id === id)).map(id =>
            `<button class="chip" data-selfile="${esc(id)}" title="Remove">${esc(nameOf(id))} ✕</button>`).join('')}
        </div>` : ''}
        <div class="rowbtns" style="margin-top:22px">
          <button class="b big go grow" data-filesel="1" ${canFile ? '' : 'disabled'}>${fileLabel}</button>
          <button class="b big" data-act="skip">Skip</button>
        </div>
        <div class="rowbtns" style="margin-top:10px">
          <button class="b sm" data-act="unlike">Unlike</button>
          <select id="anyPl"><option value="">Add another playlist…</option>${opts.filter(o => !S.fileSel.has(o.id)).map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select>
        </div>
        <p style="margin:14px 0 0; font-size:13px; color:var(--ink-3); text-align:center">Nothing is written to Spotify until you tap File or swipe — and it can be undone after.</p>
      </div>
    </div>
    <div class="prog" style="margin-top:16px"><i style="width:${(i / rows.length * 100).toFixed(2)}%"></i></div>
    <div class="swipehint"><span>← <b>Skip</b></span><span>tap art to <b>play</b></span><span><b>File</b> →</span></div>`;
}

function cmpTable(o) {
  const d = f => new Set(o.map(x=>x[f])).size > 1;
  const [dD,dT,dR,dI] = ['dur','albumType','released','isrc'].map(d);
  return `<table class="cmp"><thead><tr><th>Length</th><th>Release</th><th>Date</th><th>ISRC</th><th>Album</th></tr></thead><tbody>
    ${o.map(x=>`<tr><td class="mono ${dD?'differs':''}">${esc(x.dur)}</td><td class="${dT?'differs':''}">${esc(x.albumType??'—')}</td>
    <td class="mono ${dR?'differs':''}">${esc((x.released??'').slice(0,10))}</td><td class="mono ${dI?'differs':''}">${esc(x.isrc??'—')}</td>
    <td>${esc(x.album)}</td></tr>`).join('')}</tbody></table>`;
}

