// The Phase 0 endpoint check (docs/RELEASE-RADAR-PLAN.md), shared by
// `node radar.mjs --probe` and the page's "Check it works on this account"
// button, so any account can run it from the hosted app, with nothing to
// install. Seven reads, one artist: what Spotify allows this app, today.
import { PAGE_LIMIT } from './plan.mjs';
import { parseDate } from './dates.mjs';

/** What the sync needs to answer, by row id. The rest are informational: the sync never relies on them. */
export const NEEDED = ['list', 'album', 'track'];

/**
 * Run the probe. `get(path)` resolves to Spotify's JSON or rejects with `.status`.
 * @returns {Promise<Array<{ id: string, label: string, ok: boolean, status: string, note: string }>>}
 */
export async function probeEndpoints(get, artistId) {
  const rows = [];
  const a = encodeURIComponent(artistId);
  // `shape(b)` names a field the sync needs that the answer left out: the read
  // answered, but not in a form the radar can use, so it counts as refused.
  const tryGet = async (id, label, path, look = () => '', shape = () => '') => {
    try {
      const b = await get(path);
      const bad = shape(b);
      if (bad) { rows.push({ id, label, ok: false, status: 'shape', note: `answered without ${bad}` }); return null; }
      rows.push({ id, label, ok: true, status: 'ok', note: look(b) }); return b;
    }
    catch (e) { rows.push({ id, label, ok: false, status: String(e?.status || 'error'), note: String(e?.message ?? e).split('\n')[0].slice(0, 70) }); return null; }
  };
  const page = await tryGet('list', `albums, limit=${PAGE_LIMIT}`, `/artists/${a}/albums?include_groups=single&market=from_token&limit=${PAGE_LIMIT}`,
    b => {
      const items = b?.items ?? [];
      const ts = items.map(i => parseDate(i.release_date, i.release_date_precision).ts);
      const sorted = ts.every((t, i) => i === 0 || t <= ts[i - 1]);
      return `${items.length} items, total ${b?.total}, newest first: ${sorted}, album_group present: ${items.some(i => 'album_group' in i)}`;
    }, b => !Array.isArray(b?.items) ? 'items' : missingField(b.items, ['id', 'release_date']));
  await tryGet('cap', 'albums, limit=50 (cap check)', `/artists/${a}/albums?include_groups=single&market=from_token&limit=50`,
    b => `${b?.items?.length} items: the 10 cap is lifted`);
  const all = await tryGet('groups', 'albums, all groups at once', `/artists/${a}/albums?include_groups=album,single,appears_on&market=from_token&limit=${PAGE_LIMIT}`,
    b => `${b?.items?.length} items`, b => !Array.isArray(b?.items) ? 'items' : missingField(b.items, ['id', 'release_date']));
  // An artist with no singles still has a release to read the detail of: take it from the wider list.
  const pool = page?.items?.length ? page.items : (all?.items ?? []).filter(i => i?.id);
  if (page && !page.items?.length) rows.find(r => r.id === 'list').empty = true;
  const first = page ? pool[0]?.id : undefined, second = pool[1]?.id ?? first;
  const album = first ? await tryGet('album', 'album detail /albums/{id}', `/albums/${encodeURIComponent(first)}?market=from_token`,
    b => `${b?.tracks?.items?.length} tracks, track ISRCs present: ${(b?.tracks?.items ?? []).some(t => t.external_ids?.isrc)}`,
    b => !Array.isArray(b?.tracks?.items) ? 'tracks' : missingField(b.tracks.items, ['id'])) : null;
  if (first) await tryGet('albums', 'several albums /albums?ids=', `/albums?ids=${first},${second}`, b => `${b?.albums?.length} albums: still served`);
  const tid = album?.tracks?.items?.[0]?.id;
  if (tid) await tryGet('track', 'track /tracks/{id}', `/tracks/${encodeURIComponent(tid)}?market=from_token`, b => `ISRC: ${b?.external_ids?.isrc ?? 'absent'}`);
  if (tid) await tryGet('tracks', 'several tracks /tracks?ids=', `/tracks?ids=${tid}`, b => `${b?.tracks?.length} tracks: still served`);
  return rows;
}

/** The first of `fields` some item lacks, as a word for the table, or ''. */
function missingField(items, fields) {
  for (const f of fields) if (items.some(i => i?.[f] == null || i[f] === '')) return f;
  return '';
}

/** Whether the radar can run as built: every read it relies on answered. `missing` names the ones that did not. */
export function probeVerdict(rows) {
  const by = new Map((rows ?? []).map(r => [r.id, r]));
  // A read that was never tried because the artist had nothing to read is not a refusal;
  // a read that was never tried because the list itself failed is.
  // An empty singles list leans on the wider list, so a reshaped wider list counts against it.
  const listOk = !!by.get('list')?.ok && !(by.get('list').empty && by.get('groups')?.status === 'shape');
  const missing = NEEDED.filter(id => (by.has(id) || !listOk) && !(id === 'list' ? listOk : by.get(id)?.ok));
  return { ok: missing.length === 0, missing };
}

/** The table as text: what `--probe` prints and what the page copies. */
export function probeTable(rows) {
  const w = Math.max(0, ...(rows ?? []).map(r => r.label.length));
  return (rows ?? []).map(r => `${r.label.padEnd(w)}  ${r.status.padEnd(5)}  ${r.note}`).join('\n');
}

/* ---------- the check runs by itself (docs/BUILD-7-PLAN.md R1) ----------
 * Once per account per build, the page runs the probe without a button and
 * keeps the answer in IndexedDB `radar:probe`. A refused or reshaped route then
 * holds the sync and the radar says so in one line, instead of an empty feed. */

export const PROBE_KEY = 'radar:probe';

/** The answer as kept: who, which build, when, and the verdict with its rows. */
export function probeRecord(rows, { account, build = '', at = Date.now(), artist = null } = {}) {
  const v = probeVerdict(rows);
  return { account: account ?? null, build, at, artist, ok: v.ok, missing: v.missing, rows: rows ?? [] };
}

/** Whether the automatic check is due: never for an unknown account, else once per account per build. */
export function probeDue(saved, { account, build = '' } = {}) {
  if (!account) return false;
  if (!saved || typeof saved !== 'object' || !Number.isFinite(saved.at)) return true;
  return saved.account !== account || saved.build !== build;
}

/** Whether the kept answer holds the sync: this account's last check found a needed read refused. */
export function probeBlocks(saved, account) {
  return !!saved && typeof saved === 'object' && !!account && saved.account === account && saved.ok === false;
}
