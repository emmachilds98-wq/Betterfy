import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The Discover card is built as a string, so it can be built here and read
// back. These run the shipped vDiscover against a small fake library and check
// what actually lands on the page: a cover that plays this track rather than
// the inbox's, a real range input for the position, the suggested playlists,
// and the dropdown for overruling them.

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');

const between = (from, to, what) => {
  const i = BUNDLE.indexOf(from), j = BUNDLE.indexOf(to);
  assert.ok(i > 0 && j > i, `${what} not found — rebuild with npm run build:web`);
  return BUNDLE.slice(i, j);
};
const line = re => {
  const m = BUNDLE.match(re);
  assert.ok(m, `could not lift ${re} out of the bundle`);
  return m[0];
};

function load({ discover = [], discAt = 0, key = 'lfm-key' } = {}) {
  const added = [];
  const sandbox = {
    LIB: { playlists: [
      { id: 'p1', name: 'Jungle & Breaks', tracks: Array(40).fill({ id: 'x' }) },
      { id: 'p2', name: 'Late Night <Deep>', tracks: Array(20).fill({ id: 'y' }) },
      { id: 'p3', name: 'Tiny', tracks: Array(3).fill({ id: 'z' }) },
    ] },
    CFG: { p1: { name: 'Jungle & Breaks', axis: 'genre', target: true },
           p2: { name: 'Late Night <Deep>', axis: 'mood', target: true },
           p3: { name: 'Tiny', axis: 'genre', target: false } },
    S: { discover, discAt, discoverFrom: 'Jungle & Breaks' },
    LS: { getItem: k => (k === 'bf_lfm' ? key : null) },
    hueOf: () => 200,
    ICON_PLAY: '<svg id="playicon"></svg>',
    toast: () => {},
    render: () => {},
    addTracks: async (pl, ids) => { added.push([pl, ...ids]); },
    logAction: async () => {},
    getLog: async () => [{ at: '2026-01-01T00:00:00Z' }],
    undoAction: async () => {},
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(line(/const esc = [^\n]+/), sandbox);
  vm.runInContext(line(/const mmss = [^\n]+/), sandbox);
  vm.runInContext(between('function artHTML(t', 'function vInbox()', 'artHTML'), sandbox);
  vm.runInContext(between('/** The discovery currently on the card. */', 'function vHistory()', 'the Discover view'), sandbox);
  return Object.assign(sandbox, { added });
}

const FOUND = [
  { id: 't1', artist: 'Tim Reaper', track: 'Rinse It', album: 'Future Retro', released: '2023-04-01',
    dur: 254000, art: 'https://i.test/a.jpg', via: ['dwarde', 'Sherelle'],
    tags: ['jungle', 'breakbeat'],
    suggest: [{ id: 'p1', name: 'Jungle & Breaks', axis: 'genre', score: 0.61 },
              { id: 'p2', name: 'Late Night <Deep>', axis: 'mood', score: 0.33 }] },
  { id: 't2', artist: 'Nia Archives', track: 'Off Wiv Ya Headz', album: 'Sunrise', released: '2024-02-02',
    dur: 181000, art: null, via: ['Tim Reaper'], tags: [], suggest: [] },
];

test('with nothing found yet, the seed picker stands alone', () => {
  const app = load();
  const html = app.vDiscover();
  assert.match(html, /id="discPl"/, 'you can still choose a seed');
  assert.match(html, /id="discRun"/);
  assert.match(html, /Nothing found yet/);
  assert.match(html, /Pick what to seed from above/);
  assert.doesNotMatch(html, /id="seek"/, 'no player until there is something to play');
});

test('without a Last.fm key the run button is disabled and an inline form offers one', () => {
  // Used to just point at the Playlists screen and leave you to find your own
  // way there; now the key can be pasted and saved right where it's needed.
  const html = load({ key: null }).vDiscover();
  assert.match(html, /Discovery needs a free Last\.fm key/);
  assert.match(html, /id="discRun" disabled/);
  assert.match(html, /id="lfmKeyDisc"/, 'the key can be entered on this screen');
  assert.match(html, /id="saveLfmDiscover"/, 'and saving it is one click, not a trip to another screen');
  assert.match(html, /Add a key above to get started/, 'and the empty state points at the same form');
});

test('with a key already saved, no inline form clutters the screen', () => {
  const html = load({ key: 'lfm-key' }).vDiscover();
  assert.doesNotMatch(html, /id="lfmKeyDisc"/);
  assert.doesNotMatch(html, /id="saveLfmDiscover"/);
});

test('the card carries the cover, the track and a real position slider', () => {
  const html = load({ discover: FOUND }).vDiscover();
  assert.match(html, /<img class="art" src="https:\/\/i\.test\/a\.jpg"/, 'the album cover');
  assert.match(html, /data-dplay="t1"/, 'and tapping it plays this track, not the inbox one');
  assert.match(html, /<input class="seek" id="seek" type="range" min="0" max="254000"/);
  assert.match(html, /id="pTime">0:00<|id="pTime"/);
  assert.match(html, /id="pDur">4:14</, 'the track length, read from Spotify');
  assert.match(html, /id="pToggle"/);
  assert.match(html, /Rinse It/);
  assert.match(html, /Tim Reaper/);
  assert.match(html, /Future Retro/);
  assert.match(html, /2023/);
});

test('the slider starts disabled, because nothing is playing yet', () => {
  const html = load({ discover: FOUND }).vDiscover();
  assert.match(html, /id="seek"[^>]*\sdisabled/);
});

test('the suggested playlists are ranked, with the best one marked', () => {
  const html = load({ discover: FOUND }).vDiscover();
  // The top pick is lifted out of the ranked list into its own callout — it is
  // the recommendation, not one option among three — but it still files in one
  // tap, and the runners-up stay behind it in order.
  assert.match(html, /class="fitcall" data-dfile="p1"/, 'the top pick leads');
  assert.match(html, /61% fit/);
  // The runners-up carry a score bar rather than the words, so the number is
  // all that is asserted here.
  assert.match(html, /data-dfile="p2"/);
  assert.match(html, /33%/);
  assert.match(html, />genre</);
});

test('a dropdown offers every filing playlist, and only those', () => {
  const html = load({ discover: FOUND }).vDiscover();
  assert.match(html, /id="discAnyPl"/);
  assert.match(html, /Add to another playlist…/);
  assert.match(html, /<option value="p1">/);
  assert.match(html, /<option value="p2">/);
  assert.doesNotMatch(html, /<option value="p3">/, 'Tiny is not a filing target');
});

test('a track nothing fits still gets the dropdown, and is told why', () => {
  const html = load({ discover: FOUND, discAt: 1 }).vDiscover();
  assert.match(html, /No confident suggestion/);
  assert.match(html, /Pick a playlist below/);
  assert.match(html, /id="discAnyPl"/);
  assert.doesNotMatch(html, /data-dfile=/, 'nothing to suggest, so no picks');
  assert.match(html, /class="art ph"/, 'no cover art, so the coloured tile');
});

test('paging stops at both ends and counts where you are', () => {
  const first = load({ discover: FOUND }).vDiscover();
  assert.match(first, /data-dnav="-1" disabled/, 'nothing before the first');
  assert.match(first, /data-dnav="1" (?!disabled)/);
  assert.match(first, /1 of 2</);

  const last = load({ discover: FOUND, discAt: 1 }).vDiscover();
  assert.match(last, /data-dnav="1" disabled/, 'nothing after the last');
  assert.match(last, /2 of 2</);
});

test('an out-of-range position lands on the last card rather than blank', () => {
  const html = load({ discover: FOUND, discAt: 99 }).vDiscover();
  assert.match(html, /Off Wiv Ya Headz/);
  assert.match(html, /2 of 2</);
});

test('playlist and track names are escaped, not injected', () => {
  const nasty = [{ ...FOUND[0], track: '<script>bad()</script>', artist: 'A & B' }];
  const html = load({ discover: nasty }).vDiscover();
  assert.doesNotMatch(html, /<script>bad\(\)<\/script>/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html, /Late Night &lt;Deep&gt;/, 'and so are playlist names');
});

test('adding puts the track in the playlist and takes it off the pile', async () => {
  const app = load({ discover: [...FOUND] });
  await app.discAdd('p1');
  assert.deepEqual(app.added, [['p1', 't1']]);
  assert.equal(app.S.discover.length, 1);
  assert.equal(app.S.discover[0].id, 't2', 'the one you filed is gone, the rest stay');
});

test('adding the last one leaves the position somewhere real', async () => {
  const app = load({ discover: [FOUND[0]], discAt: 0 });
  await app.discAdd('p1');
  assert.equal(app.S.discover.length, 0);
  assert.equal(app.S.discAt, 0);
});
