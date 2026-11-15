import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as TIDY from '../web/screens/tidy.mjs';

// The Tidy lists used to stop dead — 60 repeats, 80 cross-filed, 80 misfiles —
// with no way to reach the rest, so on a big library most of what the tool
// found was unreachable. They now draw a page at a time with a "Show more"
// button. These run the real list code out of the built page.

const PAGE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
function slice(from, to, what) {
  const i = PAGE.indexOf(from), j = PAGE.indexOf(to, i);
  assert.ok(i > 0 && j > i, `${what} not found — rebuild with npm run build:web`);
  return PAGE.slice(i, j);
}

function tidy({ exact = 0, clash = 0, cross = 0 } = {}) {
  const dupe = (i, verdict) => ({ title: 'T' + i, artist: 'A', playlist: 'P', playlistId: 'p', why: '',
    verdict, options: [{ id: 'o' + i, dur: '3:00' }, { id: 'q' + i, dur: '3:01' }] });
  const sandbox = { esc: s => String(s ?? ''), S: { shown: {}, crossMin: 2 } };
  vm.createContext(sandbox);
  // The real paging helpers (app/ui.js), with the screen's ctx built around them.
  const { shownOf, moreButton } = vm.runInContext(slice('const TIDY_PAGE', '// Bar order', 'paging') + ';({ shownOf, moreButton })', sandbox);
  return { S: sandbox.S, esc: sandbox.esc, thumbHTML: () => '', cmpTable: () => '', shownOf, moreButton, emptyState: t => t,
    R: {
      within: [...Array(exact)].map((_, i) => dupe(i, 'same-recording'))
        .concat([...Array(clash)].map((_, i) => dupe(i, 'different-cut'))),
      across: [...Array(cross)].map((_, i) => ({ title: 'X' + i, artist: 'A',
        placements: [1, 2, 3].map(n => ({ playlistId: 'p' + n, trackId: 't' + i, playlist: 'P' + n, axis: 'genre' })) })),
    },
  };
}
const rows = html => (html.match(/<div class="row"[ >]/g) ?? []).length;
const more = (c, key) => { c.S.shown[key] = c.shownOf(key) + 60; };

test('a long repeats list shows a page, then the rest a page at a time', () => {
  const s = tidy({ exact: 150 });
  let html = TIDY.secDupes(s);
  assert.equal(rows(html), 60);
  assert.match(html, /data-more="dupes-exact">Show 60 more/);
  assert.match(html, /60 of 150/);

  more(s, 'dupes-exact');
  html = TIDY.secDupes(s);
  assert.equal(rows(html), 120);
  assert.match(html, /Show 30 more/, 'the last page offers only what is left');

  more(s, 'dupes-exact');
  html = TIDY.secDupes(s);
  assert.equal(rows(html), 150, 'everything the tool found is now reachable');
  assert.ok(!/data-more=/.test(html), 'and there is nothing left to offer');
});

test('a short list draws no button at all', () => {
  const html = TIDY.secDupes(tidy({ exact: 12, clash: 3 }));
  assert.equal(rows(html), 15);
  assert.ok(!/data-more=/.test(html));
});

test('the two repeats sections page independently', () => {
  const s = tidy({ exact: 70, clash: 70 });
  more(s, 'dupes-exact');
  const html = TIDY.secDupes(s);
  assert.equal(rows(html), 70 + 60, 'opening one section must not open the other');
  assert.match(html, /data-more="dupes-clash"/);
});

test('cross-filed pages per threshold, so changing the filter starts from the top', () => {
  const s = tidy({ cross: 200 });
  s.S.crossMin = 3; more(s, 'cross-3');
  assert.equal(rows(TIDY.secCross(s)), 120);
  s.S.crossMin = 2;
  const html = TIDY.secCross(s);
  assert.equal(rows(html), 60);
  assert.match(html, /data-more="cross-2"/);
});
