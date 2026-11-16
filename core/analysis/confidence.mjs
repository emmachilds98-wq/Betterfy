// The four confidence labels, on their own so a module that only needs the
// names (core/personal/relevance.mjs, bundled into the page) does not pull the
// whole classifier and ontology in with them. classify.mjs re-exports it.
export const CONFIDENCE = {
  HIGH: 'HIGH',
  LIKELY: 'LIKELY',
  AMBIGUOUS: 'AMBIGUOUS',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
};
