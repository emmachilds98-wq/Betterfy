// Splitting collaboration credits into individual artists.
// "Shy FX & T Power" and "dwarde & Tim Reaper" must not slip past an ownership
// test just because the combined string isn't in the library — otherwise a seed
// artist re-enters discovery as one half of a duo.
import { norm } from './norm.mjs';

const SPLIT = /\s*(?:&|\+|,|\/|\bx\b|\bvs\.?\b|\bversus\b|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bpres\.?\b|\bpresents\b)\s*/i;

/** Every individual artist named in a credit string, normalised. */
export const parts = name => String(name ?? '').split(SPLIT).map(norm).filter(Boolean);

/**
 * True if the credit is already owned — tested as the WHOLE name first, then
 * each component. Checking only the components would let a band whose own name
 * contains a separator ("Chase & Status") slip through as unowned.
 */
export const ownsAnyOf = (name, owned) =>
  owned.has(norm(name)) || parts(name).some(p => owned.has(p));
