// Shared track-identity normalisation.
// Deliberately conservative: remixes, edits, VIPs and live cuts are treated as
// DIFFERENT records (they are, for DJing), while cosmetic release noise —
// remaster tags, feat. credits, punctuation, casing — is stripped.

const COSMETIC = /\s*[-(\[]\s*(\d{4}\s+)?(digital\s+)?remaster(ed)?(\s+\d{4})?( version)?\s*[)\]]?\s*$/i;
const FEAT     = /\s*[\(\[]?\s*(feat\.?|ft\.?|featuring)\s[^)\]]*[\)\]]?/ig;
const VERSION  = /\s*[-(\[]\s*([^)\]]*(mix|edit|version|remix|dub|vip|instrumental|live|acoustic|bootleg|rework|flip)[^)\]]*)\s*[)\]]?\s*$/i;

export const norm = s => (s ?? '').toLowerCase()
  .replace(COSMETIC, '')
  .replace(FEAT, '')
  .replace(/[’'`]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

export const versionOf = s => ((s ?? '').match(VERSION)?.[1] ?? '').trim().toLowerCase();
export const baseTitle = s => norm((s ?? '').replace(VERSION, ''));

/** Identity key that survives re-releases but keeps distinct versions apart. */
export const trackKey = t =>
  norm(t.artists?.[0]?.name ?? '') + ' :: ' + baseTitle(t.name) + ' :: ' + versionOf(t.name);

/** Collapse a track list to one entry per distinct record, preferring the earliest release. */
export function dedupe(tracks) {
  const best = new Map();
  for (const t of tracks) {
    if (!t?.id) continue;
    const k = trackKey(t);
    const cur = best.get(k);
    if (!cur || (t.released ?? '9999') < (cur.released ?? '9999')) best.set(k, t);
  }
  return [...best.values()];
}
