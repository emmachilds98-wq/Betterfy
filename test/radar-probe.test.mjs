// The Phase 0 endpoint check, shared by `node radar.mjs --probe` and the page's
// "Check it works on this account" (core/release/probe.mjs, web/screens/radar.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeEndpoints, probeVerdict, probeTable, NEEDED } from '../core/release/probe.mjs';
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
  assert.match(bad, /<p><b>Spotify isn’t sharing new releases with this account\.<\/b><\/p>/, 'one plain line');
  assert.match(bad, /Refused: [^]*list, album, track/, 'what was refused is in Details');
  assert.match(probeHTML({ probe: { err: '<x>' } }, esc), /couldn’t run: &lt;x&gt;/);
  const calls = [];
  radarActions.rrProbe({ radar: { probe: () => calls.push('probe') } });
  radarActions.rrProbeCopy({ radar: { probeCopy: () => calls.push('copy') } });
  assert.deepEqual(calls, ['probe', 'copy']);
});
