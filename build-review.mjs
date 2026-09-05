// Inject the duplicate report into the review page.
import { readFileSync, writeFileSync } from 'node:fs';

const rep = JSON.parse(readFileSync('report-dupes.json', 'utf8'));
const lib = JSON.parse(readFileSync('library.json', 'utf8'));

const uniq = new Set();
let placements = 0;
for (const p of lib.playlists) for (const t of p.tracks) { if (t.id) { uniq.add(t.id); placements++; } }
for (const t of lib.liked) if (t?.id) uniq.add(t.id);

const data = {
  within: rep.within,
  across: rep.across,
  tracks: uniq.size,
  placements,
  playlists: lib.playlists.length,
};

const html = readFileSync('review.html', 'utf8')
  .replace('__DATA__', JSON.stringify(data).replace(/</g, '\\u003c'));
writeFileSync('review.build.html', html);

const exact = rep.within.filter(w => w.verdict === 'same-recording').length;
console.log(`exact=${exact} clash=${rep.within.length - exact} across=${rep.across.length} | ${(html.length/1024).toFixed(0)} KB`);
