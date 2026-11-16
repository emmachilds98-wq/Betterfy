/* ---------- 30-second previews (Wave F, USER-REVIEW item 10) ----------
 * Discover's rows play a pick's 30-second Deezer preview right in the page,
 * found by the ISRC Spotify already gives. It needs no Premium, no open
 * Spotify app and no Spotify request, so it works for every account. The
 * preview address is signed and expires within minutes, so it is looked up on
 * each play and never stored (the rule core/audio/fetch.mjs keeps). One
 * preview plays at a time; the screen repaints through store 'ui.discover'.
 * ISRC or nothing: a name match picks the wrong recording too often. */
const PREVIEW = { id: null, state: 'idle', el: null, err: null };

/** idle | loading | playing | none (nothing to play) | error, for one track id. */
function previewState(id) {
  return PREVIEW.id === id ? PREVIEW.state : 'idle';
}

function previewSet(id, state, err = null) {
  Object.assign(PREVIEW, { id, state, err });
  try { store.touch('ui.discover'); } catch { /* before the store is up */ }
}

function previewEl() {
  if (PREVIEW.el) return PREVIEW.el;
  const el = new Audio();
  el.preload = 'none';
  el.addEventListener('ended', () => { if (PREVIEW.state === 'playing') previewSet(PREVIEW.id, 'idle'); });
  el.addEventListener('error', () => { if (PREVIEW.state === 'playing' || PREVIEW.state === 'loading') previewSet(PREVIEW.id, 'error', 'could not play'); });
  return PREVIEW.el = el;
}

function previewStop() {
  if (PREVIEW.el) { try { PREVIEW.el.pause(); } catch { /* not started */ } }
  if (PREVIEW.state === 'playing' || PREVIEW.state === 'loading') previewSet(PREVIEW.id, 'idle');
}

/** Deezer's answer for one ISRC → the preview address, or null. Same checks as listening's lookup. */
function previewUrlFrom(json, isrc) {
  if (!json || typeof json !== 'object' || json.error || !json.preview) return null;
  const n = s => String(s ?? '').replace(/-/g, '').toUpperCase();
  if (json.isrc && n(json.isrc) !== n(isrc)) return null;
  if (json.readable === false) return null;
  return /^https:\/\//.test(json.preview) ? json.preview : null;
}

/** Play `t` ({ id, isrc }), or pause it when it is the one playing. */
async function previewToggle(t) {
  if (!t?.id) return;
  if (PREVIEW.id === t.id && (PREVIEW.state === 'playing' || PREVIEW.state === 'loading')) return previewStop();
  previewStop();
  if (!t.isrc) return previewSet(t.id, 'none');
  previewSet(t.id, 'loading');
  try {
    await engineLoad();   // deezerJsonp checks addresses with the engine bundle's BetterfyDeezer
    const url = previewUrlFrom(await deezerJsonp(`https://api.deezer.com/track/isrc:${encodeURIComponent(String(t.isrc).replace(/-/g, '').toUpperCase())}`), t.isrc);
    if (PREVIEW.id !== t.id) return;   // another row was tapped meanwhile
    if (!url) return previewSet(t.id, 'none');
    // Spotify Connect playback, if any, keeps going: this is the page's own audio.
    const el = previewEl();
    el.src = url;
    await el.play();
    if (PREVIEW.id === t.id) previewSet(t.id, 'playing');
  } catch (e) {
    if (PREVIEW.id === t.id) previewSet(t.id, 'error', String(e?.message ?? e));
  }
}
