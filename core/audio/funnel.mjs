// The hearing coverage funnel (SOUND-ENGINE-PLAN L4): of the tracks in this
// library, how many have an ISRC, are found on Deezer, have a preview, were
// downloaded and are heard, and why the rest are not. Display only: it reads
// what listening already stored (records and cached misses) and changes
// nothing. Every count is per account, from this device's own store.

import { MISS } from './record.mjs';

/**
 * @param {{ id: string, isrc?: string|null }[]} tracks  the library (duplicates by id are counted once)
 * @param {Map<string, object>|null} records  audio store contents: heard records and cached misses by track id
 * @returns {{ total: number, withIsrc: number, onDeezer: number, hasPreview: number, downloaded: number, heard: number,
 *             misses: Record<string, number>, waiting: number }}
 *   `misses` counts NO_ISRC, NOT_ON_DEEZER, NO_PREVIEW, IDENTITY and TOO_SHORT;
 *   `foundBySearch` is heard tracks whose ISRC missed and Deezer's name search found (F1,
 *   source.kind 'deezer-name'); `waiting` is tracks with an ISRC not tried yet (or only failed this session).
 *   Each stage is the tracks still in after the ones turned away before it.
 */
export function hearingFunnel(tracks, records) {
  const misses = { [MISS.NO_ISRC]: 0, [MISS.NOT_ON_DEEZER]: 0, [MISS.NO_PREVIEW]: 0, [MISS.IDENTITY]: 0, [MISS.TOO_SHORT]: 0 };
  const seen = new Set();
  let total = 0, heard = 0, waiting = 0, foundBySearch = 0;
  for (const t of tracks ?? []) {
    if (!t?.id || seen.has(t.id)) continue;
    seen.add(t.id);
    total++;
    const r = records?.get?.(t.id);
    if (r && !r.miss) { heard++; if (r.source?.kind === 'deezer-name') foundBySearch++; continue; }
    if (r?.miss === MISS.NO_ISRC || (!r && !t.isrc)) { misses[MISS.NO_ISRC]++; continue; }
    if (r?.miss && r.miss in misses) { misses[r.miss]++; continue; }
    waiting++;
  }
  const withIsrc = total - misses[MISS.NO_ISRC];
  const onDeezer = withIsrc - waiting - misses[MISS.NOT_ON_DEEZER];
  const hasPreview = onDeezer - misses[MISS.NO_PREVIEW] - misses[MISS.IDENTITY];
  // A usable preview is downloaded as soon as the track is tried; a clip too short to hear is lost after that.
  return { total, withIsrc, onDeezer, hasPreview, downloaded: hasPreview, heard, misses, waiting, foundBySearch };
}

const n = x => Number(x).toLocaleString('en-US');
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/** The plain-words funnel: "Heard 7,161 of 7,450. Not on Deezer 180, no preview 60, ..."; "Nothing heard yet." when none. */
export function funnelText(f) {
  if (!f || !f.total) return 'Nothing heard yet.';
  const parts = [];
  const add = (c, label) => { if (c > 0) parts.push(`${label} ${n(c)}`); };
  add(f.misses[MISS.NOT_ON_DEEZER], 'not on Deezer');
  add(f.misses[MISS.NO_PREVIEW], 'no preview');
  add(f.misses[MISS.IDENTITY], 'a different version');
  add(f.misses[MISS.TOO_SHORT], 'too short');
  add(f.misses[MISS.NO_ISRC], 'no ISRC');
  add(f.waiting, 'not tried yet');
  const tail = parts.length ? ` ${cap(parts.join(', '))}.` : '';
  if (!f.heard) return `Nothing heard yet.${tail}`;
  const by = f.foundBySearch > 0 ? ` Found by search: ${n(f.foundBySearch)}.` : '';
  return `Heard ${n(f.heard)} of ${n(f.total)}.${by}${tail}`;
}

/** The stages in order: [label, count]. */
export function funnelStages(f) {
  if (!f) return [];
  return [['In your library', f.total], ['Have a recording code (ISRC)', f.withIsrc], ['Found on Deezer', f.onDeezer],
          ['Have a preview', f.hasPreview], ['Downloaded', f.downloaded], ['Heard', f.heard]];
}

/** What happens instead, per reason (SOUND-ENGINE-PLAN §5), one plain line each. */
export const FUNNEL_INSTEAD = Object.freeze({
  [MISS.NO_ISRC]: 'no recording code from Spotify (usually local files): placed by tags instead',
  [MISS.NOT_ON_DEEZER]: 'not on Deezer: placed by tags, similar artists and the artist’s other heard tracks',
  [MISS.NO_PREVIEW]: 'Deezer has it but no clip: placed the same way',
  [MISS.IDENTITY]: 'Deezer’s version is a different length, so probably another recording: not heard, on purpose',
  [MISS.TOO_SHORT]: 'the clip was too short to hear',
});

/** Score report lines. */
export function funnelLines(f) {
  if (!f) return [];
  const lines = [`Hearing: ${funnelText(f)}`];
  const top = Object.entries(f.misses).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1])[0];
  if (top) lines.push(`Hearing, biggest miss (${n(top[1])}): ${FUNNEL_INSTEAD[top[0]]}`);
  return lines;
}
