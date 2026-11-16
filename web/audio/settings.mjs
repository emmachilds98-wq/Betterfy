// "Listen to my music" settings (WP-B2), and the two questions they answer:
// may it download right now, and which tracks is it allowed to hear.
//
// Defaults: on (the owner's call, 2026-11-15: the engine files better once it
// has heard your tracks, so nobody should have to find the switch first), Wi-Fi
// only, and the scope "what I'm playing + unfiled". Switching it off is saved
// and always wins. Nothing downloads until after the first paint, and only on
// Wi-Fi unless the listener says otherwise.
// That scope also takes up to 20 examples from each genre playlist, because
// an unfiled track can only be placed by sound against playlists that have a
// sound fingerprint; without them the default would hear tracks and have
// nothing to compare them to.

export const AUDIO_SETTINGS_KEY = 'bf_audio';

export const SCOPES = Object.freeze({
  'playing+unfiled': 'What I’m playing + unfiled',
  all: 'My whole library',
});

// A saved "off" counts only when the listener switched it off themselves
// (`offChosen`, written with it from 2026-11-16). An older build saved `on:
// false` whenever any listening setting changed, back when off was the default,
// so those saves read as the default (on) now. The owner's call, 2026-11-16:
// "it should listen by default".
export const DEFAULT_AUDIO_SETTINGS = Object.freeze({ on: true, wifiOnly: true, scope: 'playing+unfiled' });

/** Settings from a localStorage-like store, each field checked; anything odd falls back to its default. */
export function readAudioSettings(ls) {
  let raw = null;
  try { raw = JSON.parse(ls?.getItem?.(AUDIO_SETTINGS_KEY) ?? 'null'); } catch { raw = null; }
  const d = DEFAULT_AUDIO_SETTINGS;
  if (!raw || typeof raw !== 'object') return { ...d };
  return {
    on: raw.on === true ? true : raw.on === false && raw.offChosen === true ? false : d.on,
    wifiOnly: typeof raw.wifiOnly === 'boolean' ? raw.wifiOnly : d.wifiOnly,
    scope: Object.hasOwn(SCOPES, raw.scope) ? raw.scope : d.scope,
  };
}

/** Merge a change in and save it. Returns the saved settings. */
export function writeAudioSettings(ls, change) {
  const next = { ...readAudioSettings(ls), ...change };
  // A write that leaves it off is the listener's own choice: it came from the switch, or kept one.
  const clean = readAudioSettings({ getItem: () => JSON.stringify(next.on === false ? { ...next, offChosen: true } : next) });
  const stored = clean.on === false ? { ...clean, offChosen: true } : clean;
  try { ls?.setItem?.(AUDIO_SETTINGS_KEY, JSON.stringify(stored)); } catch { /* memory only */ }
  return clean;
}

/**
 * May it download now? `connection` is navigator.connection, which only some
 * browsers have (Chromium on Android does; Safari and Firefox do not).
 *  - 'ok'      go ahead
 *  - 'metered' cellular, or Data Saver on: wait for Wi-Fi
 *  - 'offline'
 *  - 'unknown' the browser will not say: ask the listener once per session
 */
export function connectionVerdict(connection, { wifiOnly = true, confirmed = false } = {}) {
  if (connection?.type === 'none') return 'offline';
  if (!wifiOnly) return 'ok';
  if (!connection) return confirmed ? 'ok' : 'unknown';
  if (connection.saveData) return 'metered';
  const type = connection.type;
  if (type === 'wifi' || type === 'ethernet') return 'ok';
  if (type === 'cellular' || type === 'wimax' || type === 'bluetooth') return 'metered';
  // Desktop Chromium has `connection` but no `type`; effectiveType says how fast, not how billed.
  return confirmed ? 'ok' : 'unknown';
}

/**
 * The ids the scope allows, for filtering the queue's order. 'all' allows
 * everything (returns null). The default allows the queue's tiers 1, 2 and 4
 * (core/audio/queue.mjs): tracks by artists being played, unfiled liked
 * songs, and up to `exemplarsPerPlaylist` examples per genre playlist, spread
 * through the playlist the same way the queue spreads them.
 *
 * @param {object} lib  { playlists: [{ id, tracks }], liked: [track] }
 * @param {object} o
 * @param {string} o.scope
 * @param {{weights?: Map<string, number>, recentlyActive?: Set<string>}} [o.listening]
 * @param {Iterable<string>} [o.targets]  genre playlist ids
 * @param {(p: object) => boolean} [o.isMirror]
 * @returns {Set<string>|null}
 */
export function scopeIds(lib, { scope = DEFAULT_AUDIO_SETTINGS.scope, listening = null, targets = null,
                                isMirror = () => false, exemplarsPerPlaylist = 20 } = {}) {
  if (scope === 'all') return null;
  const out = new Set();
  const weights = listening?.weights ?? new Map();
  const active = listening?.recentlyActive ?? null;
  const playlists = (lib?.playlists ?? []).filter(p => p?.id && !isMirror(p));
  const played = t => (t?.artists ?? []).some(a => a?.name && (active?.has?.(a.name) || (weights.get?.(a.name) ?? 0) > 1));

  const filed = new Set(playlists.flatMap(p => (p.tracks ?? []).map(t => t?.id).filter(Boolean)));
  for (const t of lib?.liked ?? []) if (t?.id && (played(t) || !filed.has(t.id))) out.add(t.id);
  for (const p of playlists) for (const t of p.tracks ?? []) if (t?.id && played(t)) out.add(t.id);

  const genre = targets ? new Set(targets) : null;
  for (const p of playlists) {
    if (genre && !genre.has(p.id)) continue;
    const own = [...new Map((p.tracks ?? []).filter(t => t?.id && !t.is_local).map(t => [t.id, t])).values()];
    const n = Math.min(exemplarsPerPlaylist, own.length), step = own.length / Math.max(1, n);
    for (let i = 0; i < n; i++) out.add(own[Math.floor(i * step)].id);
  }
  return out;
}
