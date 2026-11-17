// The words for a weak playlist's diagnosis (core/intrinsic/weak.mjs), apart
// from the engine so Library can say them without loading it. No imports.

export const WEAK = Object.freeze({
  minN: 5,             // scored tracks before a playlist is judged at all
  below: 0.5,          // offered in the top three on fewer than this share
  max: 5,              // playlists reported
  few: 20,             // tracks a playlist needs before "too few" stops being the answer
                       // (12 make it a genre playlist at all, axes.mjs MIN_FOR_TARGET)
  minHeard: 5,         // heard members before sound can describe a playlist
  partnerShare: 0.4,   // share of its misses one playlist must take to be "the" partner
  partnerMin: 2,       // and at least this many
  shareArtists: 0.3,   // artists shared with the partner, of its own, for "twin"
  viewShare: 0.5,      // tracks also in the partner, of its own, for "view"
  sameSound: 0.6,      // a pair check below this two-way accuracy: they sound alike
});

/** The short label for each fix. */
export const FIX_WORDS = Object.freeze({ merge: 'merge?', add: 'add tracks', wait: 'listening', none: 'working' });

const pc = x => (x == null ? '—' : `${Math.round(x * 100)}%`);

/** One playlist's diagnosis (weak.mjs diagnoseWeak, or a weakSummary row) in words: the reason, then what would fix it. Plain text. */
export function weakWords(d, nameOf = id => id) {
  // A diagnosis carries `partner` as { id, … }; Library's saved summary as the id alone.
  const pid = d.partner?.id ?? d.partner ?? null;
  const q = pid ? nameOf(pid) : null;
  switch (d.cause) {
    case 'view': return {
      why: `${pc(d.sharedTracks)} of its tracks are also in ${q}, so picks go there.`,
      fix: `If it is meant to be a smaller pick of ${q}, that is fine. If not, merge the two, or keep only tracks that belong here.` };
    case 'working': return {
      why: `Usually mistaken for ${q}.`,
      fix: `A sound check now tells the two apart (right ${pc(d.pair?.accuracy)} of ${d.pair?.n ?? 0} held out) and puts it first when a track sounds like it. Nothing to do.` };
    case 'few': return {
      why: `Only ${d.size} track${d.size === 1 ? '' : 's'}${q ? `, and usually mistaken for ${q}` : ''}.`,
      fix: `Add ${d.add} more that only belong here and it will have a sound of its own.` };
    case 'twin': return {
      why: `Usually mistaken for ${q}${d.sharedArtists >= WEAK.shareArtists ? `: they share ${pc(d.sharedArtists)} of its artists` : ''}${
        d.pair?.accuracy != null && d.pair.accuracy < WEAK.sameSound ? `${d.sharedArtists >= WEAK.shareArtists ? ' and' : ':'} they sound alike (${pc(d.pair.accuracy)} told apart)` : ''}.`,
      fix: `If they are the same kind of music, merge them. If not, add a few tracks that only belong here.` };
    case 'unheard': return {
      why: `Listening has heard ${d.heard} of its ${d.size} tracks, too few to compare by sound.`,
      fix: `Its tracks are next in line to be heard. Nothing to do.` };
    case 'partner': return {
      why: `Usually mistaken for ${q}.`,
      fix: `Add ${d.add} tracks that sound unlike ${q}, so the two have something to tell them apart.` };
    default: return {
      why: `Its misses go all over${d.loners >= 0.5 ? `, and ${pc(d.loners)} of its tracks are by artists filed nowhere else` : ''}.`,
      fix: `Add ${d.add} more example tracks, ideally more by the artists already in it.` };
  }
}
