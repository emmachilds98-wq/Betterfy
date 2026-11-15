/* ---------- correcting one artist's tags ----------
 * Last.fm tags are crowd-submitted per artist, not per track, and
 * enrichMissing() only ever fills an artist with *no* tags — an artist Last.fm
 * has simply got wrong (a same-named act, a stray scrobble, a niche artist
 * with three taggers) keeps its wrong tags forever, and every track of theirs
 * inherits the mistake. This is the fix for that: edit, in place, right where
 * a wrong suggestion was spotted, and it sticks — tags_extra already wins over
 * the shipped set, the same mechanism enrichMissing() relies on. */

/* Corrections get their own small store, separate from tags_extra, because
 * tags_extra is mostly bulk Last.fm and Discogs answers — thousands of artists,
 * too big for one Firestore document and nothing another device can't fetch for
 * itself. Only what a person did by hand goes here: an edit, a reset, a refetch. */
const CORR_KEY = 'tag_corrections';

/** This device's corrections, seeded once from what it already had. An edited
 *  entry for an artist the shipped table tags properly can only be a hand
 *  correction: the bulk fetch only ever touches artists with fewer than
 *  REASK_TAG_FLOOR shipped tags. Thin ones are ambiguous, so they start
 *  syncing the next time they are edited rather than being guessed at. */
async function loadCorrections() {
  const have = await idb.get(CORR_KEY);
  if (have) return have;
  const seeded = {};
  const extra = (await idb.get('tags_extra')) ?? {};
  for (const [id, e] of Object.entries(extra))
    if ((RAW_TAGS?.[id]?.tags?.length ?? 0) >= REASK_TAG_FLOOR && e?.tags)
      seeded[id] = { tags: e.tags, at: +e.checkedAt || 0 };
  try { await idb.set(CORR_KEY, seeded); } catch { /* seeded again next time */ }
  return seeded;
}

/** Record a hand correction (null tags = put the shipped tags back) and share it. */
async function noteCorrection(id, tags) {
  const c = await loadCorrections();
  c[id] = { tags, at: Date.now() };
  await idb.set(CORR_KEY, c);
  syncCorrections().then(changed => { if (changed) { R = buildReports(LIB, CFG, TAGS); store.set('reports', R); } });
}

/** Corrections from linked devices, applied exactly as if made here. */
async function syncCorrections() {
  return syncStamped('corrections', await loadCorrections(), async (merged, before) => {
    const extra = (await idb.get('tags_extra')) ?? {};
    for (const [id, e] of Object.entries(merged)) {
      if (canonJSON(before[id] ?? null) === canonJSON(e)) continue;
      if (e.tags) {
        extra[id] = { tags: e.tags, checkedAt: e.at };
        if (TAGS) TAGS[id] = { tags: e.tags };
      } else {
        delete extra[id];
        if (TAGS) TAGS[id] = RAW_TAGS?.[id] ? { tags: [...RAW_TAGS[id].tags] } : { tags: [] };
      }
    }
    await idb.set('tags_extra', extra);
    await idb.set(CORR_KEY, merged);
  });
}

/** Which playlists are genre, mood, event… and which take suggestions, from linked devices. */
async function syncAxes() {
  const local = JSON.parse(LS.getItem('bf_axes') || '{}');
  return syncStamped('axes', local, async (merged, before) => {
    LS.setItem('bf_axes', JSON.stringify(merged));
    for (const [id, v] of Object.entries(merged))
      if (CFG?.[id] && canonJSON(before[id] ?? null) !== canonJSON(v))
        Object.assign(CFG[id], { axis: v.axis, target: v.target, why: 'set by you' });
  });
}

/** Everything that syncs, at once. True when this device gained something. */
async function syncEverything() {
  const got = await Promise.all([syncFeedback(), syncCorrections(), syncAxes(),
    typeof syncClusterNames === 'function' ? syncClusterNames() : false]);
  return got.some(Boolean);
}

async function saveArtistTags(id, tags) {
  const extra = (await idb.get('tags_extra')) ?? {};
  // Stamped fresh so a deliberate hand-correction — including trimming a
  // wrong tag down to just one or two right ones — isn't itself "thin and
  // stale" and silently overwritten by the next bulk Fetch missing tags run.
  extra[id] = { tags, checkedAt: Date.now() };
  await idb.set('tags_extra', extra);
  TAGS[id] = { tags };
  R = buildReports(LIB, CFG, TAGS);
  await noteCorrection(id, tags);
}

async function resetArtistTags(id) {
  const extra = (await idb.get('tags_extra')) ?? {};
  delete extra[id];
  await idb.set('tags_extra', extra);
  TAGS[id] = RAW_TAGS?.[id] ? { tags: [...RAW_TAGS[id].tags] } : { tags: [] };
  R = buildReports(LIB, CFG, TAGS);
  await noteCorrection(id, null);
}

/** Ask Last.fm again for one artist, ignoring whatever it is shipped with —
 *  for the case where autocorrect or the crowd tags have since improved. */
async function refetchArtist(id, name) {
  const key = lfmKey();
  if (!key) return toast('Add a Last.fm key on the Sources screen first.');
  try {
    const r = await fetch('https://ws.audioscrobbler.com/2.0/?' + new URLSearchParams({
      method:'artist.gettoptags', artist:name, autocorrect:'1', api_key:key, format:'json' })).then(x => x.json());
    const tags = (r.toptags?.tag ?? []).filter(t => +t.count >= 10).slice(0, 10).map(t => [t.name.toLowerCase(), +t.count]);
    contributeTags(id, tags);
    await saveArtistTags(id, tags);
    toast(tags.length ? `Refetched — ${tags.length} tag(s) for ${name}.` : `Last.fm has no tags for ${name}.`);
  } catch (e) { toast('Failed: ' + e.message); }
}

function tagEditorHTML(id, name) {
  const tags = TAGS[id]?.tags ?? [];
  return `<div class="tagedit" style="margin-top:8px; padding:10px; border-radius:10px; background:var(--surface-2)">
    <p class="sub" style="margin:0 0 8px">Tags for <b>${esc(name)}</b> — a wrong one here throws off every suggestion this artist is part of.</p>
    <div class="tagrow">${tags.length ? tags.map(([t], idx) =>
      `<span class="tag" style="cursor:pointer" data-rmtag="${esc(id)}|${idx}" title="Remove">${esc(t)} ✕</span>`).join('')
      : '<span class="sub">No tags.</span>'}</div>
    <div class="rowbtns" style="margin-top:8px">
      <input id="newTagVal" placeholder="Add a tag" size="16">
      <button class="b sm" data-addtag="${esc(id)}">Add</button>
      <button class="b sm" data-refetchtags="${esc(id)}" data-artistname="${esc(name)}"
        ${lfmKey() ? '' : 'disabled title="Add a Last.fm key on the Sources screen first"'}>Refetch from Last.fm</button>
      <button class="b sm" data-resettags="${esc(id)}">Reset to shipped</button>
      <button class="b sm" data-closetagedit="1">Done</button>
    </div>
  </div>`;
}

