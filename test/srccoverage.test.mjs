// Settings › Sources: what each source knows about this account's own artists
// (BUILD-6 H1, SMARTER-GENRES §6). "Deezer knows N%, Wikidata M%, shared table
// K% of your artists", worked out on the device from what the page holds.
//
// Also reports the shared table's coverage on the committed non-owner fixtures
// (test/fixtures/accounts.mjs, M5), so how well the table fits a taste other
// than the owner's is visible in the test output rather than assumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { artistCoverage, coverageHTML, view } from '../web/screens/sources.mjs';
import { makeAccount } from './fixtures/accounts.mjs';

const A = 'aaaaaaaaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbbbbbbbb', C = 'cccccccccccccccccccccc', D = 'dddddddddddddddddddddd';

test('each source is counted only for what it answered about this account', () => {
  const cov = artistCoverage({
    ids: [A, B, C, D, A],                                   // a repeat is one artist
    shipped: { A_NOT_MINE: [['x', 1]], [A]: [['house', 10]], [B]: { tags: [['techno', 100]] }, [C]: [] },
    extra: { [C]: { source: 'wikidata', tags: [['jazz', 100]] }, [D]: { source: 'wikidata', tags: [] } },
    bridge: { [A]: { deezerId: 5, deezerAt: 1, mbid: 'm', mbidAt: 1 }, [B]: { deezerId: null, deezerAt: 1, mbid: null, mbidAt: 1 } },
  });
  assert.equal(cov.total, 4);
  assert.equal(cov.shared, 2, 'A and B; an empty entry is not coverage, and another account\'s artist is not counted');
  assert.equal(cov.deezer, 1);
  assert.equal(cov.deezerAsked, 2);
  assert.equal(cov.wikidata, 2, 'A by MusicBrainz id, C by genres');
  assert.equal(cov.wikidataAsked, 4);
  assert.deepEqual([cov.sharedPct, cov.deezerPct, cov.wikidataPct], [50, 25, 50]);
});

test('no artists, no data: zeros, never a division by zero', () => {
  assert.deepEqual(artistCoverage({}), { total: 0, shared: 0, deezer: 0, wikidata: 0, musicbrainz: 0, deezerAsked: 0, wikidataAsked: 0,
    sharedPct: 0, deezerPct: 0, wikidataPct: 0 });
});

test('the card says the sentence, and says a source never asked was not asked', () => {
  const html = coverageHTML(artistCoverage({ ids: [A, B], shipped: { [A]: [['h', 1]] },
    bridge: { [A]: { deezerId: 1, deezerAt: 1 } } }));
  assert.match(html, /Deezer knows <b class="mono">50%<\/b>, Wikidata <b>not asked yet<\/b>,\s+the shared tag list <b class="mono">50%<\/b> of your <span class="mono">2<\/span> artists/);
  assert.match(html, /Asked so far: Deezer about 1\./);
  assert.equal(coverageHTML(null), '', 'not read yet: no card');
  assert.equal(coverageHTML(artistCoverage({ ids: [] })), '', 'no artists: no card');
});

test('the Sources screen draws the card from ctx.sourceCoverage, and nothing new without data', () => {
  const ctx = {
    LS: { getItem: () => null }, esc: s => String(s), lfmKey: () => null,
    tagCoverage: () => ({ have: 1, total: 2, missing: 1, pct: 50 }), playlistMixes: () => ({ base: { tracks: 0 } }),
    audioPanelHTML: () => '', labelCheckHTML: () => '',
  };
  const without = view(ctx);
  assert.ok(!without.includes('src-coverage'), 'no data, no card: byte-identical to before it existed');
  assert.equal(view({ ...ctx, sourceCoverage: () => null }), without);
  assert.equal(view({ ...ctx, sourceCoverage: () => ({ ids: [], shipped: {}, extra: {}, bridge: {} }) }), without);
  const withData = view({ ...ctx, sourceCoverage: () => ({ ids: [A, B], shipped: { [A]: [0] }, extra: {}, bridge: {} }) });
  assert.match(withData, /id="src-coverage"/);
  assert.match(withData, /the shared tag list <b class="mono">50%<\/b> of your <span class="mono">2<\/span> artists/);
});

test('the page hands the Sources screen its coverage, read from this device only', () => {
  const page = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
  assert.match(page, /sources: \(\) => \(\{[^}]*sourceCoverage[,\s]/, 'ctx.sourceCoverage');
  const loader = page.slice(page.indexOf('async function loadSourceCoverage'), page.indexOf('async function loadSourceCoverage') + 2000);
  assert.ok(loader.includes("idb.get('tags_extra')") && loader.includes('idb.get(BRIDGE_KEY)'));
  assert.ok(!/fetch\(|fetchDeadline\(|sp\(/.test(loader.slice(0, loader.indexOf('return changed'))), 'nothing is fetched to work it out');
});

/* ---------- the non-owner fixtures ----------
 * The fixtures borrow their artist ids from docs/tags.json so suggestions behave
 * as for a real account, which makes "in the shared table" 100% by
 * construction. What is not by construction is how much the table knows about
 * each taste: how many of the account's artists carry at least three tags, and
 * which of the account's genres the table had no artists for at all (the
 * fixture then fills those playlists with unrelated artists). Both are reported. */
const TAGS = JSON.parse(readFileSync(new URL('../docs/tags.json', import.meta.url), 'utf8'));
const GENRES = ['drum and bass', 'jungle', 'house', 'techno', 'ambient', 'hip hop', 'uk garage', 'indie',
  'rock', 'jazz', 'classical', 'pop', 'folk', 'metal', 'reggae', 'soul'];

function accountArtists(acc) {
  const ids = new Set();
  for (const t of [...acc.playlists.flatMap(p => p.tracks), ...acc.liked]) for (const a of t.artists ?? []) ids.add(a.id);
  return [...ids];
}

test('shared table coverage on the non-owner fixtures, per account', t => {
  const leads = new Map();
  for (const [, tags] of Object.entries(TAGS)) { const g = tags?.[0]?.[0]; if (g) leads.set(g, (leads.get(g) ?? 0) + 1); }
  const rows = [];
  for (const kind of ['small', 'typical', 'large']) {
    const acc = makeAccount(kind);
    const ids = accountArtists(acc);
    const cov = artistCoverage({ ids, shipped: TAGS });
    const thick = ids.filter(id => (TAGS[id]?.length ?? 0) >= 3).length;
    rows.push({ kind, artists: cov.total, sharedPct: cov.sharedPct, thickPct: Math.round(100 * thick / cov.total) });
    assert.ok(cov.total > 0, kind);
    assert.equal(cov.sharedPct, 100, `${kind}: fixture artists come from the table, so this is 100% by construction`);
  }
  const missing = GENRES.filter(g => !leads.get(g));
  const thin = GENRES.filter(g => leads.get(g) && leads.get(g) < 20).map(g => `${g} (${leads.get(g)})`);
  for (const r of rows) t.diagnostic(`${r.kind}: ${r.artists} artists, shared table ${r.sharedPct}%, with >= 3 tags ${r.thickPct}%`);
  t.diagnostic(`fixture genres the table leads no artist with: ${missing.join(', ') || 'none'}`);
  t.diagnostic(`fixture genres the table leads fewer than 20 artists with: ${thin.join(', ') || 'none'}`);
});
