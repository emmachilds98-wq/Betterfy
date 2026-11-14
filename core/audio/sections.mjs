// Sections and hybrids: what changes inside one clip (WP-H1).
//
// A record keeps, per patch (~4 s of audio, hop ~2 s), its top SECTION_TOP
// styles in time order. Phase 0 saw patch-level top-1 agreement inside one
// preview range from 17% to 100%: an intro that is one thing and a drop that
// is another shows up clearly. That is what a hybrid proposal is built from
// (WP-H2), so this file turns the raw timeline into runs and a verdict.
//
// Labels are hints (29% top-1 on scene genres). "Hybrid" here means the model
// heard two different styles lead different parts of the clip, or could not
// separate two styles overall — not that the track IS two genres. The
// proposals that use it ask the listener.

export const SECTIONS_VERSION = '1.0.0';
/** Each of two styles must lead at least this share of sections. */
export const HYBRID_SHARE = 0.3;
/** Or the overall top two must be this close (absolute probability). */
export const HYBRID_MARGIN = 0.05;
/** And the second style must be a real signal, not two near-zero sigmoids. */
export const MIN_STYLE_P = 0.1;

/**
 * Runs of consistent top-1 style over time.
 * @param {{ sections?: Array<Array<[number, number]>> }} record
 * @returns {Array<{ style: number, from: number, to: number, length: number, meanP: number }>}  patch indices, `to` inclusive
 */
export function sectionsOf(record) {
  const secs = record?.sections ?? [];
  const runs = [];
  secs.forEach((sec, i) => {
    const top = sec?.[0];
    if (!top) return;
    const [style, p] = top;
    const last = runs[runs.length - 1];
    if (last && last.style === style && last.to === i - 1) {
      last.to = i; last.length++; last._sum += p;
    } else runs.push({ style, from: i, to: i, length: 1, _sum: p });
  });
  return runs.map(({ _sum, ...r }) => ({ ...r, meanP: +(_sum / r.length).toFixed(4) }));
}

/** Share of sections each style leads, highest first: [[style, share], ...]. */
export function leadShares(record) {
  const secs = (record?.sections ?? []).filter(s => s?.[0]);
  if (!secs.length) return [];
  const n = new Map();
  for (const s of secs) n.set(s[0][0], (n.get(s[0][0]) ?? 0) + 1);
  return [...n].map(([k, c]) => [k, c / secs.length]).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
}

/** Fraction of sections whose top style is the record's overall top style. 1 = one style throughout. */
export function agreement(record) {
  const top = record?.styles?.[0]?.[0];
  const secs = (record?.sections ?? []).filter(s => s?.[0]);
  if (top == null || !secs.length) return null;
  return secs.filter(s => s[0][0] === top).length / secs.length;
}

/**
 * Is this clip a hybrid of two styles?
 * True when two styles each lead ≥ HYBRID_SHARE of sections, or when the
 * overall top two are within HYBRID_MARGIN of each other (and both above
 * MIN_STYLE_P). A miss or a record with no styles is never a hybrid.
 * @returns {{ hybrid: boolean, styles: [number, number]|null, why: 'sections'|'margin'|null }}
 */
export function hybridOf(record) {
  const none = { hybrid: false, styles: null, why: null };
  if (!record || record.miss || !record.styles?.length) return none;
  const shares = leadShares(record);
  if (shares.length >= 2 && shares[0][1] >= HYBRID_SHARE && shares[1][1] >= HYBRID_SHARE && (record.sections?.length ?? 0) >= 2)
    return { hybrid: true, styles: [shares[0][0], shares[1][0]], why: 'sections' };
  const [a, b] = record.styles;
  if (a && b && b[1] >= MIN_STYLE_P && a[1] - b[1] <= HYBRID_MARGIN)
    return { hybrid: true, styles: [a[0], b[0]], why: 'margin' };
  return none;
}

export const isHybrid = record => hybridOf(record).hybrid;
