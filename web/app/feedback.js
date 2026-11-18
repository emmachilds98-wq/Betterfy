/* ---------- what you told it by skipping and rejecting ----------
 * Filing decisions teach the model twice. An accept is learned for free: the
 * track joins the playlist, and the next sync folds it into that playlist's
 * centroid. A rejection taught it nothing, because Skip only advanced an
 * in-memory index — so the same wrong suggestion came back every session, for
 * the same track, forever. This keeps the negative half.
 *
 *   { [trackId]: { skips, lastSkip, rejected: [playlistId, ...],
 *                  accepted?: [playlistId, ...], kept?: [playlistId, ...] } }
 *
 * `accepted` is where you filed it from the File screen: the sound learner
 * (core/intrinsic/audio-feedback.mjs) reads it as "yes, it belongs there"
 * before the next sync shows the track in that playlist. `kept` is Tidy's
 * "Keep here": the track stays in that playlist and neither Tidy tier offers it
 * as wrong there again. Both appear only once used, so a store that never used
 * them is the same object it always was.
 *
 * `rejectedAt` / `acceptedAt` ({ [playlistId]: epoch ms }) say when each
 * verdict was given, so the tag engine's memory of a rejection can fade
 * (profile.mjs `rejectFactors`, BUILD-5-PLAN §5.1). They also appear only once
 * used; a store written before them reads as verdicts of unknown time. A time
 * only counts while its playlist is still in `rejected` / `accepted`.
 */
let FB = {};
const loadFeedback = async () => { FB = (await idb.get('feedback')) ?? {}; };
const saveFeedback = () => idb.set('feedback', FB);
const fbFor = id => (FB[id] ??= { skips: 0, lastSkip: null, rejected: [] });
/** Stamp `ids` in f[key] (rejectedAt / acceptedAt) with now; fbUnstamp() drops them, and the map once empty. */
const fbStamp = (f, key, ids) => { const now = Date.now(); for (const p of ids) (f[key] ??= {})[p] = now; };
const fbUnstamp = (f, key, ids) => {
  if (!f?.[key]) return;
  for (const p of ids) delete f[key][p];
  if (!Object.keys(f[key]).length) delete f[key];
};

async function recordSkip(trackId) {
  const f = fbFor(trackId);
  f.skips++; f.lastSkip = new Date().toISOString();
  await saveFeedback();
}

/** "Not that playlist" for this track. Never suggested for it again. */
async function recordReject(trackId, playlistId) {
  const f = fbFor(trackId);
  if (!f.rejected.includes(playlistId)) f.rejected.push(playlistId);
  fbStamp(f, 'rejectedAt', [playlistId]);
  // The artist's next card already knows (E1, app/soundfirst.js learnRejectNow).
  try { if (typeof learnRejectNow === 'function') learnRejectNow(trackId, playlistId); } catch { /* the rebuild catches up */ }
  await saveFeedback();
}

/** Filed from the File screen into these playlists: "yes, there". The latest
 *  word on a pair wins, so it also lifts an earlier "not that playlist". */
async function recordAccept(trackId, playlistIds) {
  const f = fbFor(trackId), ids = [].concat(playlistIds).filter(Boolean);
  f.accepted = [...new Set([...(f.accepted ?? []), ...ids])];
  f.rejected = f.rejected.filter(p => !ids.includes(p));
  fbStamp(f, 'acceptedAt', ids); fbUnstamp(f, 'rejectedAt', ids);
  // The next card already knows (app/soundfirst.js learnNow).
  try { if (typeof learnNow === 'function') learnNow(trackId, ids); } catch { /* the rebuild catches up */ }
  await saveFeedback();
}

/** The filing was undone: take back the "yes, there". */
async function forgetAccept(trackId, playlistIds) {
  const f = FB[trackId], ids = [].concat(playlistIds);
  if (!f?.accepted) return;
  f.accepted = f.accepted.filter(p => !ids.includes(p));
  if (!f.accepted.length) delete f.accepted;
  fbUnstamp(f, 'acceptedAt', ids);
  // E1: the quick learn is taken back too (app/soundfirst.js learnUndoNow).
  try { if (typeof learnUndoNow === 'function') learnUndoNow(trackId, ids); } catch { /* the rebuild catches up */ }
  await saveFeedback();
}

/** Tidy's "Keep here": the track belongs in `here`, and each playlist in `away`
 *  that a Tidy tier wanted to move it to is a "not that playlist" — the same
 *  verdict the sound tier's Keep here has always recorded. */
async function recordKeep(trackId, here, away = []) {
  const f = fbFor(trackId);
  if (here && !(f.kept ??= []).includes(here)) f.kept.push(here);
  const no = [].concat(away).filter(Boolean);
  for (const p of no) if (!f.rejected.includes(p)) f.rejected.push(p);
  fbStamp(f, 'rejectedAt', no);
  await saveFeedback();
}

/**
 * A move from Tidy is two verdicts at once: yes to where it went, no to where
 * it was. Written the way core/intrinsic/audio-feedback.mjs reads FB — the
 * destination in `accepted`, the source in `rejected` — and with the other
 * half of each pair cleared, since within FB a pair that is both counts as
 * rejected.
 */
async function recordMove(trackId, fromId, toId) {
  const f = fbFor(trackId);
  f.rejected = (f.rejected ?? []).filter(p => p !== toId);
  if (fromId && fromId !== toId && !f.rejected.includes(fromId)) f.rejected.push(fromId);
  f.accepted = (f.accepted ?? []).filter(p => p !== fromId);
  if (toId && !f.accepted.includes(toId)) f.accepted.push(toId);
  fbUnstamp(f, 'rejectedAt', [toId]); fbUnstamp(f, 'acceptedAt', [fromId]);
  if (fromId && fromId !== toId) fbStamp(f, 'rejectedAt', [fromId]);
  if (toId) fbStamp(f, 'acceptedAt', [toId]);
  // E1: a move counts at once, both halves.
  try {
    if (toId && typeof learnNow === 'function') learnNow(trackId, [toId], { fromCard: false });
    if (fromId && fromId !== toId && typeof learnRejectNow === 'function') learnRejectNow(trackId, fromId);
  } catch { /* the rebuild catches up */ }
  await saveFeedback();
}

/** Undoing a move takes its two verdicts back. */
async function unrecordMove(trackId, fromId, toId) {
  const f = FB[trackId]; if (!f) return;
  if (f.accepted) f.accepted = f.accepted.filter(p => p !== toId);
  if (f.rejected) f.rejected = f.rejected.filter(p => p !== fromId);
  fbUnstamp(f, 'acceptedAt', [toId]); fbUnstamp(f, 'rejectedAt', [fromId]);
  await saveFeedback();
}

async function clearFeedback(trackId) { delete FB[trackId]; await saveFeedback(); }

// No `popularity`: Spotify removed it from track objects in February 2026.
const FIELDS = 'next,items(added_at,item(id,name,duration_ms,explicit,external_ids,track_number,album(id,name,release_date,album_type,images),artists(id,name)))';
// One artwork URL per track — the ~300px size, which is what the inbox card
// shows. Libraries synced before this existed simply have none, and the card
// falls back to a coloured tile until the next re-sync.
const artOf = t => {
  const im = t?.album?.images ?? [];
  return (im.find(x => x.width && x.width <= 400) ?? im[im.length - 1] ?? {}).url;
};
const shapeTrack = t => t && ({
  id:t.id, name:t.name, artists:(t.artists??[]).map(a=>({id:a.id,name:a.name})),
  album:t.album?.name, albumType:t.album?.album_type, released:t.album?.release_date,
  art:artOf(t), duration_ms:t.duration_ms, isrc:t.external_ids?.isrc,
});

/* Reading a whole library takes hundreds of calls and several minutes on a
 * phone, and a phone will interrupt it: a rate limit, a locked screen, iOS
 * reclaiming the page behind you. So each finished piece is banked as it
 * lands and the read picks up from there — otherwise every interruption
 * throws the lot away, and trying again spends the same call budget to fail
 * in the same place. Bumped whenever FIELDS or shapeTrack changes, so banked
 * pieces from an older shape are re-read rather than kept forever. */
const SHAPE = 1;
const PART = id => 'part:' + id;
const LIKED_FULL_EVERY = 7 * 24 * 3600 * 1000;   // a full liked re-read catches unlikes the head cannot see
const PART_LIFE = 24 * 3600 * 1000;

async function bankedParts() {
  const out = {};
  const fresh = Date.now() - PART_LIFE;
  for (const k of await idb.keys()) {
    if (typeof k !== 'string' || !k.startsWith('part:')) continue;
    const v = await idb.get(k);
    if (v?.shape === SHAPE && v.at > fresh) out[k] = v; else await idb.del(k);
  }
  return out;
}

async function dropParts() {
  for (const k of await idb.keys()) if (typeof k === 'string' && k.startsWith('part:')) await idb.del(k);
}

async function syncLibrary(force, onProgress) {
  // A forced re-read means "go and ask Spotify again", so the pieces banked by
  // an earlier read are dropped first — but only once, at the top. The pieces
  // this read banks as it goes still count, so a forced re-read that is
  // interrupted resumes like any other rather than starting from nothing.
  if (force) await dropParts();
  heldRun = 0;
  const banked = await bankedParts();

  // Who you are and which playlists you have is two calls and a few pages, and
  // every single retry used to spend them again before reaching the playlist it
  // actually stopped on — on a rate-limited shared quota, sometimes that was the
  // whole budget, so the retry failed in the same place having done no new work.
  let me = banked[PART('index')]?.me, pls = banked[PART('index')]?.playlists;
  if (!me || !pls) {
    me = await sp('/me');
    pls = await paged('/me/playlists?limit=50');
    await idb.set(PART('index'), { shape:SHAPE, at:Date.now(), me,
      playlists: pls.map(p => ({ id:p.id, name:p.name, owner:{ id:p.owner?.id }, snapshot_id:p.snapshot_id })) });
  }
  const owned = pls.filter(p => p.owner?.id === me.id);
  // Spotify stamps every playlist with a snapshot id that changes the moment
  // its contents do, so a playlist that has not moved since the last complete
  // read costs nothing to "read" again.
  const held = {};
  if (!force) for (const p of (await idb.get('library'))?.playlists ?? [])
    if (p.snapshot_id && p.shape === SHAPE) held[p.id] = p;

  const playlists = [];
  for (const [i, p] of owned.entries()) {
    onProgress?.(p.name, i / (owned.length + 1));
    const kept = banked[PART(p.id)]?.playlist ?? held[p.id];
    if (kept?.snapshot_id === p.snapshot_id) { playlists.push(kept); continue; }
    let items = null;
    try {
      items = await paged(`/playlists/${p.id}/items?limit=100&fields=${encodeURIComponent(FIELDS)}`);
    } catch (e) {
      // Carrying on past a failure is only right when Spotify has refused this
      // one playlist and would refuse it again: 403 or 404. Everything else —
      // a rate limit, a 5xx, a dropped connection, a token that stopped
      // working — is about the read, not the playlist, and recording it as an
      // empty playlist would quietly lose every track in it. So it stops the
      // read instead; the banked pieces keep and the retry resumes here.
      if (e?.status !== 403 && e?.status !== 404) throw e;
      // Even a refusal keeps no snapshot id below, so the next read asks again
      // rather than trusting an empty answer forever. Without that, one refusal
      // froze a playlist as empty until somebody happened to edit it.
    }
    const entry = { id:p.id, name:p.name, snapshot_id: items ? p.snapshot_id : null, shape:SHAPE,
                    tracks: (items ?? []).filter(x => (x.item ?? x.track)?.id)
                      .map(x => ({ added_at:x.added_at, ...shapeTrack(x.item ?? x.track) })) };
    playlists.push(entry);
    if (items) await idb.set(PART(p.id), { shape:SHAPE, at:Date.now(), playlist:entry });
  }

  // Liked songs come back fifty at a time with no snapshot id of their own, so
  // they are banked by page instead — every tenth, which is often enough to be
  // worth resuming and rare enough not to rewrite the pile on every page.
  const likedRow = i => ({ added_at:i.added_at, ...shapeTrack(i.track ?? i.item) });
  const hasId = i => (i.track ?? i.item)?.id;
  // Liked songs arrive newest-first with an added_at, so a read that already
  // holds a list only needs the head: page from the start until the first row
  // it already has (same id, same added_at), then stop. That is one request for
  // an unchanged library instead of a hundred. A removal leaves no trace at the
  // head, so the head read is checked against Spotify's own total, and the whole
  // list is re-read anyway once a week.
  const prev = await idb.get('library');   // kept on a forced re-read too: that is the button people press when nothing changed
  const cached = prev?.liked_shape === SHAPE && Array.isArray(prev.liked) && prev.liked_total != null
    && Date.now() - (prev.liked_full_at ?? 0) < LIKED_FULL_EVERY ? prev : null;
  let likedTotal = null, fullAt = Date.now();
  let liked = banked[PART('liked')]?.liked;
  if (!liked && cached) {
    const fresh = [], seen = cached.liked[0];
    let url = '/me/tracks?limit=50', raw = 0, hit = !seen, total = null;
    for (let page = 0; url && !hit && page < 20; page++) {
      onProgress?.('liked songs', 0.95);
      const box = await sp(url);
      total = box?.total ?? total;
      for (const i of box?.items ?? []) {
        if (hasId(i) && seen && (i.track ?? i.item).id === seen.id && i.added_at === seen.added_at) { hit = true; break; }
        raw++; if (hasId(i)) fresh.push(likedRow(i));
      }
      url = box?.next ?? null;
    }
    // Trust the head only if it reached a known row (or the list ended) and the
    // count Spotify reports is exactly what this read expects.
    if ((hit || !url) && total != null && total === cached.liked_total + raw) {
      const ids = new Set(fresh.map(r => r.id));
      liked = { rows: [...fresh, ...cached.liked.filter(r => !ids.has(r.id))], next: null };
      likedTotal = total; fullAt = cached.liked_full_at;
    }
  }
  if (!liked) liked = { rows: [], next: '/me/tracks?limit=50' };
  for (let page = 0; liked.next; page++) {
    // Thousands of liked songs is dozens of pages, and they all used to report
    // the same "liked songs" at the same 95% — several silent minutes that look
    // identical to a hang. A number that moves is the difference.
    onProgress?.(liked.rows.length ? `liked songs — ${liked.rows.length.toLocaleString()} so far` : 'liked songs', 0.95);
    const box = await sp(liked.next);
    likedTotal = box?.total ?? likedTotal;
    liked.rows.push(...(box?.items ?? []).filter(hasId).map(likedRow));
    liked.next = box?.next ?? null;
    if (!liked.next || page % 10 === 9) await idb.set(PART('liked'), { shape:SHAPE, at:Date.now(), liked });
  }

  const lib = { captured_at:new Date().toISOString(), user:{ id:me.id, name:me.display_name },
                playlists, liked: liked.rows, liked_total: likedTotal, liked_shape: SHAPE, liked_full_at: fullAt };
  await idb.set('library', lib);
  await dropParts();
  return lib;
}

