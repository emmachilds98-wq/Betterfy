// Names that say what a playlist holds (core/playlists/describe.mjs), Library's
// "Names that could say more" and the sheet's Name section (web/screens/lists.mjs),
// and the rename itself with its History undo (web/app/actionlog.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as D from '../core/playlists/describe.mjs';
import * as LISTS from '../web/screens/lists.mjs';
import * as HISTORY from '../web/screens/history.mjs';

const TAGS = {
  dh: [['deep house', 100], ['house', 80], ['chill', 60]],
  th: [['tech house', 100], ['house', 50]],
  hh: [['hip hop', 100], ['boom bap', 70]],
  rk: [['indie rock', 100], ['melancholic', 60]],
  rg: [['reggae', 100], ['roots reggae', 40]],
  jz: [['jazz', 100]],
  none: [['seen live', 100], ['british', 80]],
};
const tagsOf = id => TAGS[id];
const tracks = (artist, n, year = 2018, pre = artist) =>
  Array.from({ length: n }, (_, i) => ({ id: `${pre}${i}`, artists: [{ id: artist }], released: `${year}-05-01` }));
const NOW = { now: new Date('2026-11-18') };

test('describeTracks: shares by first-billed artist, rolled up the genre family, decade and mood', () => {
  const f = D.describeTracks({ tracks: [...tracks('dh', 6), ...tracks('th', 6)] }, tagsOf, NOW);
  assert.equal(f.tagged, 12);
  assert.deepEqual(f.genres.map(g => g.concept), ['deep-house', 'tech-house']);
  assert.equal(f.parents.find(p => p.concept === 'house').share, 1, 'both are house');
  assert.equal(f.decade.start, 2010);
  assert.equal(f.mood.concept, 'relaxed', 'half the tracks are by a chill-tagged artist');
  // A featured artist does not decide the genre: the first one with tags does.
  const feat = D.describeTracks({ tracks: [{ id: 'x', artists: [{ id: 'none' }, { id: 'hh' }] }] }, tagsOf, NOW);
  assert.equal(feat.genres[0].concept, 'hip-hop', 'an artist with no genre tag is passed over');
});

test('describeTracks: the current decade and a spread of years say nothing', () => {
  assert.equal(D.describeTracks({ tracks: tracks('hh', 10, 2024) }, tagsOf, NOW).decade, null);
  const mixed = [...tracks('hh', 4, 1975, 'a'), ...tracks('hh', 4, 1995, 'b'), ...tracks('hh', 4, 2015, 'c')];
  assert.equal(D.describeTracks({ tracks: mixed }, tagsOf, NOW).decade, null);
  assert.equal(D.describeTracks({ tracks: tracks('hh', 10, 1994) }, tagsOf, NOW).decade.start, 1990);
});

test('nameStyle learns case, separator and "and" from the account, with defaults when names say nothing', () => {
  assert.deepEqual(D.nameStyle(['gym - rock and roll', 'sunday - soul and funk', 'late nights', 'road trip']),
    { case: 'lower', sep: ' - ', amp: 'and' });
  assert.deepEqual(D.nameStyle(['DRIVE | NIGHT', 'GYM | HARD', 'FOCUS']), { case: 'upper', sep: ' | ', amp: '&' });
  assert.deepEqual(D.nameStyle(['Sunday Soul', 'Late Nights']), { case: 'title', sep: ' · ', amp: '&' });
  assert.deepEqual(D.nameStyle([]), { case: 'title', sep: ' · ', amp: '&' });
  assert.equal(D.styled('Drum & Bass', { case: 'lower', amp: 'and' }), 'drum and bass');
});

test('isVagueName: Spotify defaults and placeholders only, never somebody\'s own word', () => {
  for (const n of ['My Playlist #7', 'New Playlist', 'playlist 3', 'Untitled', '🔥🔥', 'x', '', 'misc', 'Test 2', 'Favourites'])
    assert.ok(D.isVagueName(n), n);
  for (const n of ['Sunday', 'Bangers', 'Mum\'s car', 'Deep House', 'Gym', 'Rainy day'])
    assert.ok(!D.isVagueName(n), n);
});

test('suggestNames: a vague name gets descriptive names, in the account\'s style', () => {
  const f = D.describeTracks({ tracks: tracks('hh', 12, 1995) }, tagsOf, NOW);
  const s = D.suggestNames('My Playlist #7', f, null, { case: 'lower', sep: ' - ', amp: '&' });
  assert.equal(s.vague, true);
  assert.deepEqual(s.names.map(n => n.name), ['90s hip-hop', 'hip-hop']);
  assert.match(s.names[0].why, /100% released in the 1990s; 100% Hip-Hop/);
});

test('suggestNames: the listener\'s own name is kept first, exactly as written', () => {
  const f = D.describeTracks({ tracks: tracks('rk', 12, 2008) }, tagsOf, NOW);
  const s = D.suggestNames('Rainy Day', f, null, { case: 'lower', sep: ' - ' });
  assert.equal(s.vague, false);
  assert.equal(s.names[0].name, 'Rainy Day - 2000s indie rock', 'their words keep their case; the added part takes the account\'s');
  assert.match(s.names[0].why, /keeps your name/);
});

test('suggestNames: a name that already says its genre only gets a qualifier or its tempo', () => {
  const f = D.describeTracks({ tracks: tracks('dh', 12, 2016) }, tagsOf, NOW);
  const s = D.suggestNames('Deep House', f, { bpm: [120, 124] }, {});
  assert.equal(s.fits, true);
  assert.deepEqual(s.names.map(n => n.name), ['2010s Deep House', 'Deep House · 120–124 BPM']);
  // A family name counts as saying it: "House" on deep and tech house.
  const fam = D.describeTracks({ tracks: [...tracks('dh', 6, 2024), ...tracks('th', 6, 2024)] }, tagsOf, NOW);
  assert.equal(D.suggestNames('House', fam, null, {}).fits, true);
});

test('suggestNames: a name that says another genre is pointed out, plainly', () => {
  const f = D.describeTracks({ tracks: tracks('rg', 12, 2024) }, tagsOf, NOW);
  const s = D.suggestNames('Techno', f, null, {});
  assert.equal(s.misleading, 'Its name says Techno, but 100% is Reggae');
  assert.equal(s.names[0].name, 'Reggae');
});

test('suggestNames: every kind of music, not just one scene', () => {
  for (const [a, want] of [['hh', 'Hip-Hop'], ['rk', 'Indie Rock'], ['rg', 'Reggae'], ['jz', 'Jazz']]) {
    const s = D.suggestNames('New Playlist', D.describeTracks({ tracks: tracks(a, 10, 2025) }, tagsOf, NOW), null, {});
    assert.ok(s.names.some(n => n.name.endsWith(want)), `${a}: ${s.names.map(n => n.name)}`);
  }
});

test('suggestNames: two genres, a family, the sound, or nothing when too little is known', () => {
  const two = D.describeTracks({ tracks: [...tracks('hh', 6, 2024), ...tracks('rk', 6, 2024)] }, tagsOf, NOW);
  assert.ok(D.suggestNames('Mix', two, null, {}).names.some(n => n.name === 'Hip-Hop & Indie Rock'));
  const thin = D.describeTracks({ tracks: tracks('none', 12, 2024) }, tagsOf, NOW);
  assert.deepEqual(D.suggestNames('My Playlist #2', thin, null, {}).names, [], 'no genre, no mood, no sound: no guess');
  const heard = D.suggestNames('My Playlist #2', thin, { styles: [['Drum & Bass', 0.7]], bpm: [172, 176] }, {});
  assert.equal(heard.names[0].name, 'Drum & Bass', 'listening fills in where tags cannot');
  assert.ok(heard.names.some(n => n.name === 'Drum & Bass · 172–176 BPM'));
});

test('namesToImprove: vague names first, then misleading ones; skipped and well-named ones left out', () => {
  const pls = [
    { id: 'a', name: 'Sunday', tracks: tracks('hh', 10) },
    { id: 'b', name: 'My Playlist #1', tracks: tracks('rk', 10) },
    { id: 'c', name: 'Techno', tracks: tracks('rg', 12) },
    { id: 'd', name: 'New Playlist', tracks: tracks('jz', 10) },
  ];
  const out = D.namesToImprove(pls, p => D.describeTracks(p, tagsOf, NOW), { skip: p => p.id === 'd' });
  assert.deepEqual(out.map(r => r.id), ['b', 'c']);
  assert.equal(out[0].best.name, '2010s Indie Rock');
});

/* ---------- the page: Library and the sheet ---------- */

const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
function ctx(extra = {}) {
  const store = new Map();
  const LIB = { captured_at: 't1', playlists: [
    { id: 'p1', name: 'My Playlist #4', tracks: tracks('hh', 12, 1996) },
    { id: 'p2', name: 'Sunday', tracks: tracks('rk', 12, 2024) },
    { id: 'all', name: 'All Songs', tracks: tracks('jz', 12) },
  ] };
  return { LIB, CFG: { p1: { name: 'My Playlist #4' }, p2: { name: 'Sunday' } }, esc,
    TAGS: Object.fromEntries(Object.entries(TAGS).map(([k, v]) => [k, { tags: v }])),
    BetterfyDescribe: D, isMirrorPlaylist: p => p.id === 'all',
    LISTS_SOUND: { profile: () => null },
    LS: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    render() {}, toast() {}, ...extra };
}

test('Library: "Names that could say more" lists vague names with one-tap Rename and Not now', () => {
  const c = ctx();
  const html = LISTS.namesListHTML(c);
  assert.match(html, /Names that could say more/);
  assert.match(html, /My Playlist #4<\/span>\s*<span class="plmeta"><span class="plname-to">→ 90s Hip-Hop<\/span><\/span>/);
  assert.match(html, /data-act="lrename" data-pl="p1" data-name="90s Hip-Hop"/);
  assert.ok(!html.includes('Sunday') && !html.includes('All Songs'), 'a name of their own, and a mirror, are left alone');
  LISTS.actions.lnameskip(c, { dataset: { pl: 'p1' } });
  assert.equal(LISTS.namesListHTML(c), '', 'Not now: gone until the name changes');
});

test('Library and the sheet say nothing about names until the engine bundle is here, and ask for it once', () => {
  let loads = 0;
  const c = ctx({ BetterfyDescribe: undefined, engineLoad: async () => { loads++; } });
  assert.equal(LISTS.namesListHTML(c), '');
  const sheet = LISTS.nameSheetHTML(c, 'p2', c.LIB.playlists[1]);
  assert.match(sheet, /id="plname-in" value="Sunday"/, 'renaming by hand still works');
  assert.ok(!sheet.includes('class="chip"'));
  assert.ok(loads <= 1);
});

test('Sheet: suggestions as chips that fill the field, and Rename sends what the field says', async () => {
  const fields = { '#plname-in': { value: 'Sunday', focus() {} }, '#plname-why': { textContent: '' } };
  const renamed = [];
  const c = ctx({ $: q => fields[q], renamePlaylist: async (id, name) => { renamed.push([id, name]); return 'at1'; } });
  const html = LISTS.nameSheetHTML(c, 'p2', c.LIB.playlists[1]);
  assert.match(html, /Your name stays first/);
  assert.match(html, /data-act="lnamepick" data-pl="p2" data-name="Sunday · Melancholy Indie Rock"/);
  assert.equal(LISTS.nameSheetHTML(c, 'all', c.LIB.playlists[2]), '', 'no renaming the mirror');
  LISTS.actions.lnamepick(c, { dataset: { name: 'Sunday · Indie Rock', why: 'keeps your name' } });
  assert.equal(fields['#plname-in'].value, 'Sunday · Indie Rock');
  assert.equal(fields['#plname-why'].textContent, 'Why: keeps your name.');
  await LISTS.actions.lrename(c, { dataset: { pl: 'p2', from: 'input' } });
  assert.deepEqual(renamed, [['p2', 'Sunday · Indie Rock']]);
});

/* ---------- the rename and its undo ---------- */

const BUNDLE = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const LOG_CODE = (() => {
  const i = BUNDLE.indexOf('/* ---------- action log: every library change, reversible'), j = BUNDLE.indexOf('async function playlistEntries(', i);
  assert.ok(i > 0 && j > i, 'action log not found: rebuild with node build-web.mjs');
  return BUNDLE.slice(i, j);
})();

test('renamePlaylist: PUT to Spotify, the held library follows, History logs it, and Undo puts the old name back', async () => {
  const calls = [], db = new Map();
  const sb = {
    LIB: { playlists: [{ id: 'p1', name: 'My Playlist #4', tracks: [] }] }, CFG: { p1: { name: 'My Playlist #4' } },
    sp: async (url, o) => { calls.push([url, o.method, JSON.parse(o.body)]); return null; },
    idb: { get: async k => db.get(k), set: async (k, v) => { db.set(k, v); } },
  };
  vm.createContext(sb);
  vm.runInContext(LOG_CODE + ';globalThis.api = { renamePlaylist, undoAction, getLog };', sb);
  const at = await sb.api.renamePlaylist('p1', '  90s Hip-Hop  ');
  assert.deepEqual(calls[0], ['/playlists/p1', 'PUT', { name: '90s Hip-Hop' }]);
  assert.equal(sb.LIB.playlists[0].name, '90s Hip-Hop');
  assert.equal(sb.CFG.p1.name, '90s Hip-Hop');
  assert.equal(db.get('library').playlists[0].name, '90s Hip-Hop');
  const [e] = await sb.api.getLog();
  assert.equal(e.op, 'rename');
  assert.equal(e.from, 'My Playlist #4');
  assert.equal(await sb.api.renamePlaylist('p1', '90s Hip-Hop'), null, 'same name: nothing written');
  await assert.rejects(sb.api.renamePlaylist('p1', '   '), /needs a name/);
  await sb.api.undoAction(at);
  assert.deepEqual(calls.at(-1), ['/playlists/p1', 'PUT', { name: 'My Playlist #4' }]);
  assert.equal(sb.LIB.playlists[0].name, 'My Playlist #4');
  const html = HISTORY.view({ S: { history: await sb.api.getLog() }, esc,
    isUndone: (x, log) => !!x.undoneAt || log.some(u => u.op === 'undo' && u.of === x.at), emptyState: () => '' });
  assert.match(html, /Renamed <span class="sub">My Playlist #4 → 90s Hip-Hop<\/span>/);
  assert.match(html, /<span class="sub">Undone<\/span>/);
  assert.ok(!/0 track\(s\)/.test(html.split('Renamed')[1].split('</div></div>')[0]), 'a rename has no track count');
});

test('Library: tapping a suggestion opens the sheet with it in the name field, to change before saving', async () => {
  const opened = [], renamed = [];
  const c = ctx({ openPlSheet: id => opened.push(id), renamePlaylist: async (id, name) => { renamed.push([id, name]); return 'at2'; } });
  const html = LISTS.namesListHTML(c);
  assert.match(html, /data-act="lnameedit" data-pl="p1" data-name="90s Hip-Hop"/);
  LISTS.actions.lnameedit(c, { dataset: { pl: 'p1', name: '90s Hip-Hop', why: '100% Hip-Hop' } });
  assert.deepEqual(opened, ['p1']);
  assert.deepEqual(renamed, [], 'nothing is renamed by opening it');
  const sheet = LISTS.nameSheetHTML(c, 'p1', c.LIB.playlists[0]);
  assert.match(sheet, /id="plname-in" value="90s Hip-Hop"/, 'the suggestion is in the field, editable');
  assert.match(sheet, /Why: 100% Hip-Hop\./);
  assert.match(LISTS.nameSheetHTML(c, 'p2', c.LIB.playlists[1]), /id="plname-in" value="Sunday"/, 'only on the playlist it was picked for');
  // Edited, then saved: what the field says is the name.
  c.$ = q => ({ '#plname-in': { value: '90s Hip-Hop Classics' } })[q];
  await LISTS.actions.lrename(c, { dataset: { pl: 'p1', from: 'input' } });
  assert.deepEqual(renamed, [['p1', '90s Hip-Hop Classics']]);
  assert.match(LISTS.nameSheetHTML(c, 'p1', c.LIB.playlists[0]), /id="plname-in" value="My Playlist #4"/, 'the picked name is let go once saved');
  LISTS.actions.plopen({ ...c, openPlSheet() {} }, { dataset: { pl: 'p1' } });
});
