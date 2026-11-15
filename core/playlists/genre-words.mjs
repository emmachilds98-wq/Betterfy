// Every name the ontology knows a genre by, in the one spelling profile.mjs
// counts tags under: the vocabulary genreInName() (core/playlists/axes.mjs)
// reads playlist names against. build-web.mjs bakes it into the page (~4 KB, so
// the ~100 KB ontology stays out of the inline bundle); axes.mjs reads it here.
// One vocabulary for the whole app rather than a second list to keep in step.
import { GENRES } from '../ontology/genres.mjs';
import { canonTag } from '../../profile.mjs';

/* A few single words are left out because, alone as a playlist name, they are
 * as likely to be a place or an ordinary word as a genre ("Goa", "Detroit",
 * "Lounge"). Their longer forms still count: "detroit techno", "liquid dnb". */
export const NOT_ALONE = new Set(['goa', 'detroit', 'lounge', 'niche', 'liquid', 'neuro', 'score', 'fusion', 'wonky']);

/** Sorted, de-duplicated, canonTag()ed genre names. */
export function genreWords() {
  return [...new Set(Object.entries(GENRES)
    .flatMap(([slug, g]) => [slug.replace(/-/g, ' '), ...(g.aliases ?? [])])
    .map(canonTag)
    .filter(w => w && !NOT_ALONE.has(w)))].sort();
}
