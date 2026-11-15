/** Toggle one playlist in or out of the pending selection for the track on screen. */
function toggleFileSel(id) {
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
const inboxIndex = () => Math.min(Math.max(S.inboxAt | 0, 0), Math.max(R.backlog.length - 1, 0));
const inboxTrack = () => R.backlog[inboxIndex()] ?? null;

/** File the current inbox track into one or several playlists at once. Takes
 *  a single id (the swipe gesture, keyboard 1-3 followed by Enter's fallback)
 *  or an array (the multi-select confirm button) — either way nothing is
 *  written until this actually runs. */
async function fileCurrent(playlistIds) {
  const ids = (Array.isArray(playlistIds) ? playlistIds : [playlistIds]).filter(Boolean);
  if (!ids.length) return;
  const at = inboxIndex(), t = R.backlog[at]; if (!t) return;
  const names = ids.map(id => CFG[id]?.name ?? id);
  try {
    // One log entry per playlist, so History and its per-row undo stay exact —
    // the toast just chains all of them for the common "undo the lot" case.
    const ats = [];
    for (const id of ids) {
      await addTracks(id, [t.id]);
      await logAction({ op:'add', playlistId:id, playlistName:CFG[id]?.name ?? id, trackIds:[t.id], reason:'filed from inbox', queuePos:at });
      ats.push((await getLog())[0]?.at);
    }
    // An accept is a verdict too (FB.accepted, read by audio-feedback.mjs), so
    // the sound learner hears "yes, there" before the next sync shows it.
    await recordAccept(t.id, ids);
    const undoAll = async () => { for (const at of [...ats].reverse()) if (at) await undoAction(at);
                                  await forgetAccept(t.id, ids); };
    toast(names.length > 1 ? `Filed “${t.title}” into ${names.length} playlists.` : `Filed “${t.title}” into ${names[0]}.`, undoAll);
    S.fileSel = new Set();
    R.backlog.splice(at, 1); S.inboxAt = inboxIndex();
    const more = rollForwardFor(t, R.backlog, ids, FB);
    S.roll = more.length ? { artist: t.artists?.[0]?.name ?? t.artist, playlistIds: ids, names,
                             rows: more.map(b => ({ id: b.id, title: b.title })), off: new Set() } : null;
    render();
  } catch (e) { toast('Failed: '+e.message); }
}
async function inboxAct(a) {
  const at = inboxIndex(), t = R.backlog[at]; if (!t) return;
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
      R.backlog.splice(at, 1); S.inboxAt = inboxIndex(); render();
    } catch(e){ toast('Failed: '+e.message); }
  }
}
// Keyboard parity for the swipe: the same walk through VORDER, for anyone not
// using a touchscreen.
document.addEventListener('keydown', guard(async e => {
  if ($('#app').hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  // Enter in Discover's "sounds like" box searches (WP-C3).
  if (e.key === 'Enter' && e.target.id === 'sndq') { e.preventDefault(); return clapSearch(e.target.value); }
  if (e.target.matches('input,select,textarea')) return;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const next = VORDER[VORDER.indexOf(view) + (e.key === 'ArrowRight' ? 1 : -1)];
  if (!next) return;
  if (next === 'history') S.history = await getLog();
  go(next);
}));

document.addEventListener('keydown', e => {
  if (view !== 'inbox' || e.target.matches('input,select,textarea')) return;
  const t = inboxTrack(); if (!t) return;
  if (['1','2','3'].includes(e.key)) { const s = filePicks(t)[+e.key-1]; if (s) toggleFileSel(s.id); }
  if (e.key === 'Enter' && (S.fileSel.size || filePicks(t)[0])) fire(fileCurrent(S.fileSel.size ? [...S.fileSel] : filePicks(t)[0].id));
  if (e.key.toLowerCase()==='p') inboxAct('play');
  if (e.key.toLowerCase()==='s') inboxAct('skip');
  if (e.key.toLowerCase()==='u') inboxAct('unlike');
});

