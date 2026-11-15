/* ---------- tag corrections and playlist types, synced the same way ----------
 * docs/SMARTER-GENRES-PLAN.md phase 4 / UPGRADE-PLAN §4. Unlike feedback these
 * are plain values with no natural union ("this artist's tags are X", "this
 * playlist is a genre playlist"), so each key carries the time it was set and
 * the newer edit wins, per key. Two devices converge whichever syncs first, and
 * a fresh edit on this device is never reverted by an older one from another. */

/** Stable JSON, so equal state compares equal whatever order its keys arrived in. */
const canonJSON = v => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x);

/** Per-key newest-wins over { key: { …, at } }. Ties go to whichever value sorts
 *  first, so both devices pick the same one. Nothing is ever dropped. */
function mergeStamped(local, remote) {
  const out = {};
  for (const k of new Set([...Object.keys(local ?? {}), ...Object.keys(remote ?? {})])) {
    const l = local?.[k], r = remote?.[k];
    if (!l || !r) { out[k] = l ?? r; continue; }
    const la = +l.at || 0, ra = +r.at || 0;
    out[k] = la > ra ? l : ra > la ? r : (canonJSON(l) <= canonJSON(r) ? l : r);
  }
  return out;
}

/**
 * Pull one piece of stamped state, merge, hand the result to `apply` when this
 * device gained anything, and push back when the other side did. Same opt-in as
 * syncFeedback(): nothing at all happens on a device that has never been linked.
 * Never throws — a failed sync is retried next time and costs nothing now.
 */
async function syncStamped(doc, local, apply) {
  if (!syncAvailable() || !LS.getItem(SYNC_GROUP_KEY)) return false;
  try {
    const groupId = await ensureSyncMembership();
    const got = await syncDoc('GET', `syncGroups/${groupId}/state/${doc}`).catch(() => null);
    const remote = got?.fields?.data?.stringValue ? JSON.parse(got.fields.data.stringValue) : {};
    const merged = mergeStamped(local, remote);
    const m = canonJSON(merged);
    const gained = m !== canonJSON(local ?? {});
    if (gained) await apply(merged, local ?? {});
    if (m !== canonJSON(remote)) {
      await syncDoc('PATCH', `syncGroups/${groupId}/state/${doc}`, { fields: { data: { stringValue: m } } });
    }
    return gained;
  } catch { return false; }
}

async function discogsTags(name, token) {
  const r = await fetch('https://api.discogs.com/database/search?' + new URLSearchParams({
    artist: name, type: 'release', per_page: '50', token })).then(x => x.json());
  const tally = new Map();
  for (const hit of r.results ?? [])
    for (const style of hit.style ?? []) {
      const s = style.toLowerCase();
      tally.set(s, (tally.get(s) ?? 0) + 1);
    }
  /* Rescaled to Last.fm's 0-100, where the top tag is 100 and the rest are
   * relative to it. Discogs counts releases, so a style seen on six of an
   * artist's records came back as 6 — and trackVec() divides every count by
   * 100, so a Discogs-filled artist arrived in the model an order of magnitude
   * quieter than a Last.fm one. That is not a rounding difference: their tags
   * all but vanished from the playlist centroids they belong in, and on a
   * collaboration a single Last.fm-tagged co-artist drowned them out entirely.
   * The two sources have to be on one scale to be averaged at all. */
  const ranked = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const most = ranked[0]?.[1] || 1;
  return ranked.map(([style, n]) => [style, Math.round(100 * n / most)]);
}

// Last.fm's crowd tags and Discogs' catalogue both grow over time, so an
// empty or thin answer should not be a permanent verdict — see cache.mjs's
// worthReasking() for the Node-side twin of this. Kept as a small inline
// check rather than a shared import: everything else in this function is
// already IndexedDB/browser-fetch-specific, unlike the scoring math bundled
// in from profile.mjs.
const REASK_TAG_FLOOR = 3;
const REASK_AFTER_MS = 1000 * 60 * 60 * 24 * 180; // ~6 months
const worthReasking = e => !e || (e.tags?.length ?? 0) < REASK_TAG_FLOOR && (Date.now() - (e.checkedAt ?? 0)) > REASK_AFTER_MS;

/** Fill tag gaps for artists the shipped set doesn't cover, using the viewer's own key. */
async function enrichMissing() {
  const key = LS.getItem('bf_lfm');
  if (!key) return toast('Add a Last.fm key first.');
  const discogsToken = LS.getItem('bf_discogs');
  // "Missing" means thin, not just "no entry at all" — fewer tags than
  // REASK_TAG_FLOOR is treated the same as zero, so a gap Last.fm barely
  // answered still gets a real second look rather than staying thin forever.
  // Genres filled from Wikidata are a stand-in for crowd tags, not a
  // replacement: with a key, Last.fm is still asked about those artists.
  const gap = id => (TAGS[id]?.tags?.length ?? 0) < REASK_TAG_FLOOR || TAGS[id]?.source === 'wikidata';
  const names = new Map();
  for (const p of LIB.playlists) for (const t of p.tracks) for (const a of t.artists ?? []) if (a.id && gap(a.id)) names.set(a.id, a.name);
  for (const t of LIB.liked) for (const a of t.artists ?? []) if (a.id && gap(a.id)) names.set(a.id, a.name);
  let todo = [...names];
  if (!todo.length) return toast('Nothing missing.');

  // Hundreds of gaps can take a while — cover what you actually listen to
  // first, so leaving the screen partway through still improves the
  // suggestions that matter most.
  try { todo = byListening(todo, (await getListening()).weights); } catch { /* library order is fine */ }

  const cached = (await idb.get('tags_extra')) ?? {};
  let done = 0, viaDiscogs = 0, failed = 0, blank = 0;
  for (const [id, name] of todo) {
    // Already asked about, and not stale-thin enough to be worth asking
    // again yet. A real, well-tagged answer is never re-asked — there's no
    // upside — and a thin or empty one only gets a second look after
    // REASK_AFTER_MS, so a re-run mostly costs no requests at all.
    if (cached[id] && cached[id].source !== 'wikidata' && !worthReasking(cached[id])) { TAGS[id] = cached[id]; if (cached[id].tags?.length) done++; else blank++; continue; }
    let tags = [];
    // "Last.fm has nothing for this artist" and "that request failed" are the
    // same empty array, and only the first is an answer worth keeping. Caching
    // both wrote the network's bad afternoon into IndexedDB as a permanent
    // verdict: the artist was never asked about again, on any later run.
    let answered = false;
    try {
      const r = await fetch('https://ws.audioscrobbler.com/2.0/?' + new URLSearchParams({
        method:'artist.gettoptags', artist:name, autocorrect:'1', api_key:key, format:'json' })).then(x => x.json());
      if (r?.error) throw new Error(r.message || `Last.fm error ${r.error}`);
      tags = (r.toptags?.tag ?? []).filter(t => +t.count >= 10).slice(0, 10).map(t => [t.name.toLowerCase(), +t.count]);
      answered = true;
      contributeTags(id, tags);
    } catch { tags = []; failed++; }
    await new Promise(r => setTimeout(r, 200));   // Last.fm's documented ~5/s

    // Last.fm's answer is thin or empty — blend in Discogs release styles
    // rather than leaving it that way. A total gap is filled outright; a thin
    // answer keeps its own tags in front and only gets Discogs tags it didn't
    // already have added alongside them (see mergeTagSources in tagstore.mjs
    // for the Node-side twin of this).
    if (answered && tags.length < REASK_TAG_FLOOR && discogsToken) {
      try {
        const extra = await discogsTags(name, discogsToken);
        const seen = new Set(tags.map(([t]) => t));
        const fresh = extra.filter(([t]) => !seen.has(t));
        if (fresh.length) { tags = [...tags, ...fresh]; viaDiscogs++; }
      } catch { /* leave it as Last.fm had it */ }
      await new Promise(r => setTimeout(r, 1100));  // Discogs: 60 req/min with a token
    }

    // An empty Last.fm answer does not throw away genres Wikidata already gave.
    const keepWikidata = answered && !tags.length && cached[id]?.source === 'wikidata' && cached[id].tags?.length;
    if (answered && !keepWikidata) { cached[id] = { tags, checkedAt: Date.now() }; TAGS[id] = { tags }; done++; }
    if (done && done % 25 === 0) { await idb.set('tags_extra', cached); stage(`Fetching genre tags… ${done} of ${todo.length}`, done/todo.length); }
  }
  await idb.set('tags_extra', cached);
  store.set('reports', buildReports(LIB, CFG, TAGS));
  $('#land').hidden = true; $('#app').hidden = false;
  toast(`Tags filled for ${done} of ${todo.length} artists.`
    + (viaDiscogs ? ` ${viaDiscogs} from Discogs, where Last.fm had nothing.` : '')
    + (blank ? ` ${blank} have no tags anywhere.` : '')
    + (failed ? ` ${failed} could not be reached — run it again to pick those up.` : ''));
}

