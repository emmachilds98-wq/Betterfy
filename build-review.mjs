import { readFileSync, writeFileSync } from 'node:fs';
const rep = JSON.parse(readFileSync('report-dupes.json', 'utf8'));
const lib = JSON.parse(readFileSync('library.json', 'utf8'));

const same = [], diff = [];
for (const r of rep.within) {
  const rels = new Set([r.keep, ...r.drop].map(x => `${x.album}|${x.released}`));
  (rels.size === 1 ? same : diff).push(r);
}
const across = [...rep.across].sort((a, b) => b.playlists.length - a.playlists.length);

const data = { same, diff, across, playlists: lib.playlists.length };
const html = readFileSync('review.html', 'utf8')
  .replace('__DATA__', JSON.stringify(data).replace(/</g, '\u003c'));
writeFileSync('review.build.html', html);
console.log(`same=${same.length} diff=${diff.length} across=${across.length} | ${(html.length/1024).toFixed(0)} KB`);
