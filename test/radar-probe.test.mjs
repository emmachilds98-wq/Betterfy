// The Phase 0 endpoint check, shared by `node radar.mjs --probe` and the page's
// "Check it works on this account" (core/release/probe.mjs, web/screens/radar.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeEndpoints, probeVerdict, probeTable, probeRecord, probeDue, probeBlocks, NEEDED, PROBE_KEY } from '../core/release/probe.mjs';
import { probeHTML, radarActions } from '../web/screens/radar.mjs';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const refuse = status => Object.assign(new Error(`Spotify answered ${status}`), { status });

/** A Development Mode app after February 2026: limit 10, no batch reads (the plan's expectation). */
function devModeGet(seen = []) {
  return async path => {
    seen.push(path);
    if (/\/albums\?ids=|\/tracks\?ids=/.test(path)) throw refuse(403);
    if (/limit=50/.test(path)) throw refuse(400);
    if (/^\/artists\/[^/]+\/albums/.test(path)) return { total: 3, items: [
      { id: 'al1', release_date: '2026-10-01', release_date_precision: 'day', album_group: 'single' },
      { id: 'al2', release_date: '2026-01-01', release_date_precision: 'day', album_group: 'single' }] };
    if (path.startsWith('/albums/al1')) return { tracks: { items: [{ id: 'tr1', external_ids: { isrc: 'GBX1' } }] } };
    if (path.startsWith('/tracks/tr1')) return { external_ids: { isrc: 'GBX1' } };
    throw refuse(404);
  };
}

test('the probe reads what the sync needs and reports what Spotify refuses', async () => {
  const seen = [];
  const rows = await probeEndpoints(devModeGet(seen), 'ar 1');
  assert.equal(rows.length, 7);
  assert.ok(seen[0].startsWith('/artists/ar%201/albums?'), 'the artist id is escaped');
  const st = Object.fromEntries(rows.map(r => [r.id, r.status]));
  assert.deepEqual(st, { list: 'ok', cap: '400', groups: 'ok', album: 'ok', albums: '403', track: 'ok', tracks: '403' });
  assert.match(rows[0].note, /2 items, total 3, newest first: true, album_group present: true/);
  const v = probeVerdict(rows);
  assert.deepEqual(v, { ok: true, missing: [] }, 'the refused reads are ones the sync never relies on');
  assert.match(probeTable(rows), /^albums, limit=10 +ok +2 items/);
});

test('a refused artist list means the radar cannot run, and says which read', async () => {
  const rows = await probeEndpoints(async () => { throw refuse(403); }, 'a');
  assert.equal(rows.length, 3, 'nothing further to read without a release');
  assert.deepEqual(probeVerdict(rows), { ok: false, missing: NEEDED });
  assert.deepEqual(probeVerdict([]), { ok: false, missing: NEEDED });
});

test('the page: a button first, then one plain line, with the table and a copy button behind Details (F5)', async () => {
  assert.match(probeHTML({}, esc), /data-act="rrProbe">Check it works on this account</);
  assert.match(probeHTML({ probe: { running: true } }, esc), /disabled>Checking…/);
  const rows = await probeEndpoints(devModeGet(), 'a');
  const ok = probeHTML({ probe: { rows, verdict: probeVerdict(rows) } }, esc);
  assert.match(ok, /<b>Works\.<\/b> Spotify answers everything the radar needs/);
  assert.match(ok, /<details class="rr-pdet"><summary>Details<\/summary>[^]*<table/, 'the table is folded');
  assert.equal((ok.match(/<tr /g) ?? []).length, 7);
  assert.match(ok, /data-act="rrProbeCopy"/);
  const bad = probeHTML({ probe: { rows: [], verdict: probeVerdict([]) } }, esc);
  assert.match(bad, /<p><b>Spotify isn’t sharing new releases with this account right now\.<\/b><\/p>/, 'one plain line');
  assert.match(bad, /Refused: [^]*list, album, track/, 'what was refused is in Details');
  assert.match(probeHTML({ probe: { err: '<x>' } }, esc), /couldn’t run: &lt;x&gt;/);
  const calls = [];
  radarActions.rrProbe({ radar: { probe: () => calls.push('probe') } });
  radarActions.rrProbeCopy({ radar: { probeCopy: () => calls.push('copy') } });
  assert.deepEqual(calls, ['probe', 'copy']);
});

test('a list that answers without release dates counts as refused, and says which field (R1)', async () => {
  const get = async path => {
    if (/^\/artists\/[^/]+\/albums/.test(path)) return { total: 1, items: [{ id: 'al1' }] };
    throw refuse(404);
  };
  const rows = await probeEndpoints(get, 'a');
  const list = rows.find(r => r.id === 'list');
  assert.equal(list.ok, false);
  assert.equal(list.status, 'shape');
  assert.match(list.note, /without release_date/);
  assert.deepEqual(probeVerdict(rows), { ok: false, missing: NEEDED });
  const noItems = await probeEndpoints(async p => (/albums\?/.test(p) ? {} : Promise.reject(refuse(404))), 'a');
  assert.match(noItems.find(r => r.id === 'list').note, /without items/);
});

test('the check runs by itself once per account per build, and only a refusal on this account holds the sync (R1)', async () => {
  assert.equal(PROBE_KEY, 'radar:probe');
  const rows = await probeEndpoints(devModeGet(), 'a');
  const kept = probeRecord(rows, { account: 'u1', build: 'b1', at: 5, artist: 'X' });
  assert.deepEqual({ ...kept, rows: kept.rows.length }, { account: 'u1', build: 'b1', at: 5, artist: 'X', ok: true, missing: [], rows: 7 });
  assert.equal(probeDue(null, { account: 'u1', build: 'b1' }), true, 'never checked');
  assert.equal(probeDue('junk', { account: 'u1', build: 'b1' }), true, 'a corrupt answer is checked again');
  assert.equal(probeDue(kept, { account: 'u1', build: 'b1' }), false, 'same account, same build: not again');
  assert.equal(probeDue(kept, { account: 'u1', build: 'b2' }), true, 'a new build checks again');
  assert.equal(probeDue(kept, { account: 'u2', build: 'b1' }), true, 'another account on this device checks for itself');
  assert.equal(probeDue(null, { account: null, build: 'b1' }), false, 'no account yet: nothing to check');
  assert.equal(probeBlocks(kept, 'u1'), false, 'a good answer holds nothing');
  const bad = probeRecord([], { account: 'u1', build: 'b1', at: 6 });
  assert.equal(bad.ok, false);
  assert.equal(probeBlocks(bad, 'u1'), true);
  assert.equal(probeBlocks(bad, 'u2'), false, 'one account\'s refusal never holds another\'s radar');
  assert.equal(probeBlocks(null, 'u1'), false);
});

test('a held radar shows one plain line instead of an empty feed, and Check again (R1)', async () => {
  const { radarView } = await import('../web/screens/radar.mjs');
  const R = { rows: [], index: null, running: false, check: { account: 'u1', ok: false, missing: ['list', 'album', 'track'], rows: [] } };
  const html = radarView({ esc, LIB: { playlists: [], liked: [] }, radar: { R, held: () => true, now: () => 0 } });
  assert.match(html, /Spotify isn’t sharing new releases with this account right now/);
  assert.match(html, /Refused: list, album, track/);
  assert.match(html, /data-act="rrProbe">Check again</);
  assert.ok(!/data-act="rrStart"/.test(html), 'no Start while held: Check again is the way back');
  const free = radarView({ esc, LIB: { playlists: [], liked: [] }, radar: { R: { ...R, check: null }, held: () => false, now: () => 0 } });
  assert.ok(!/isn’t sharing/.test(free));
});

test('an artist with no singles is not a refusal: the detail is read from the wider list, or not needed (R1)', async () => {
  const get = async path => {
    if (/include_groups=single&/.test(path)) return { total: 0, items: [] };
    if (/include_groups=album,single,appears_on/.test(path)) return { total: 1, items: [{ id: 'al9', release_date: '2025-01-01' }] };
    if (/limit=50/.test(path)) throw refuse(400);
    if (path.startsWith('/albums/al9')) return { tracks: { items: [{ id: 'tr9' }] } };
    if (path.startsWith('/tracks/tr9')) return { external_ids: {} };
    throw refuse(403);
  };
  const rows = await probeEndpoints(get, 'a');
  assert.equal(rows.find(r => r.id === 'album')?.ok, true, 'the album detail came from the wider list');
  assert.deepEqual(probeVerdict(rows), { ok: true, missing: [] });
  const bare = await probeEndpoints(async p => (/artists/.test(p) && !/limit=50/.test(p) ? { total: 0, items: [] } : Promise.reject(refuse(400))), 'a');
  assert.deepEqual(probeVerdict(bare), { ok: true, missing: [] }, 'nothing released: nothing refused');
});

test('no singles, and the wider list answers without dates: still refused (R1)', async () => {
  const get = async path => {
    if (/include_groups=single&/.test(path)) return { total: 0, items: [] };
    if (/include_groups=album,single,appears_on/.test(path)) return { total: 1, items: [{ id: 'al9' }] };
    throw refuse(400);
  };
  const rows = await probeEndpoints(get, 'a');
  assert.equal(rows.find(r => r.id === 'groups').status, 'shape');
  assert.equal(probeVerdict(rows).ok, false);
  assert.ok(probeVerdict(rows).missing.includes('list'));
});
