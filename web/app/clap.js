/* ---------- CLAP: names for "new genre?" groups, and "sounds like" search ----------
 * docs/AUDIO-BUILD-PLAN.md WP-C3, over core/audio/clap-search.mjs. Both read
 * the records' optional `clap` field (WP-C2's audio encoder, opt-in) and the
 * build-time text table beside the models. Without a single CLAP record the
 * table is never fetched and neither screen draws anything new.
 *
 * Confirmed names live in IndexedDB like every other per-account thing here
 * (cleared on sign-out), and travel between the listener's own linked devices
 * through the same newest-wins sync as tag corrections. Nothing is shared
 * between accounts. */
const CLAPS = { table: null, tableP: null, err: null, names: null, q: '', res: null };
const CLAP_NAMES_KEY = 'cluster_names';

/** The text table, fetched once and only when a CLAP record exists. Null when it can't be had. */
function clapTable() {
  if (CLAPS.table) return Promise.resolve(CLAPS.table);
  return CLAPS.tableP ??= fetch(audioModelUrl('clap-text-table.json'))
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(`phrase list: HTTP ${r.status}`))))
    .then(j => {
      const t = BetterfyAudio.readTable(j);
      if (!t) throw new Error('the phrase list is unreadable');
      CLAPS.err = null;
      return (CLAPS.table = t);
    })
    .catch(e => { CLAPS.err = e?.message ?? String(e); CLAPS.tableP = null; return null; });
}

async function clapNames() { return (CLAPS.names ??= (await idb.get(CLAP_NAMES_KEY)) ?? {}); }

/** Keep a name for a group of tracks: typed, confirmed, or the one a playlist was made with. */
async function clapConfirm(ids, name) {
  CLAPS.names = BetterfyAudio.confirmName(await clapNames(), ids, name);
  await idb.set(CLAP_NAMES_KEY, CLAPS.names);
  syncClusterNames().then(changed => { if (changed) repaint(['gaps']); });
}

/** Names given on the listener's other linked devices. */
async function syncClusterNames() {
  if (!globalThis.BetterfyAudio) return false;
  return syncStamped('clusterNames', await clapNames(), async merged => {
    CLAPS.names = merged;
    await idb.set(CLAP_NAMES_KEY, merged);
  });
}

/** Give each "new genre?" group its confirmed name, or CLAP's suggestion. Changes nothing without CLAP records. */
async function clapNameOrphans(orphans, records) {
  if (!orphans?.length || !globalThis.BetterfyAudio || !BetterfyAudio.clapHeard(records)) return;
  try {
    const table = await clapTable();
    const names = await clapNames();
    const idx = table ? BetterfyAudio.clapIndex(records, { dim: table.dim }) : null;
    const baseline = idx ? BetterfyAudio.libraryMean(idx, table.dim) : null;
    for (const o of orphans) {
      const kept = BetterfyAudio.confirmedName(o.ids, names);
      o.confirmed = kept?.name ?? null;
      o.suggest = !kept && idx ? BetterfyAudio.nameGroup(o.ids, idx, table, { baseline }) : null;
    }
  } catch { /* names are a nicety: the cards stay as they were */ }
}

/** Run a search for what is in the box. Prompts only: free text has no encoder in the page. */
async function clapSearch(q) {
  CLAPS.q = String(q ?? '').trim();
  if (!CLAPS.q) { CLAPS.res = null; return repaint(['ui.discover']); }
  const table = await clapTable();
  if (!table) { CLAPS.res = null; return repaint(['ui.discover']); }
  const idx = BetterfyAudio.clapIndex(AUDIO.records, { dim: table.dim });
  const r = BetterfyAudio.soundsLike(CLAPS.q, idx, table);
  const ids = new Set(r.results.map(x => x.id));
  const info = new Map();
  for (const t of LIB?.liked ?? []) if (ids.has(t.id) && !info.has(t.id)) info.set(t.id, t);
  for (const p of LIB?.playlists ?? []) for (const t of p.tracks ?? []) if (ids.has(t.id) && !info.has(t.id)) info.set(t.id, t);
  CLAPS.res = { q: CLAPS.q, prompt: r.prompt, heard: r.heard,
    results: r.results.map(x => ({ ...x, t: info.get(x.id) ?? null })).filter(x => x.t),
    near: r.prompt ? [] : BetterfyAudio.suggestPrompts(CLAPS.q, table, { limit: 6 }) };
  repaint(['ui.discover']);
}

/** Discover's "sounds like" card. '' unless CLAP has heard something in this library. */
function soundSearchHTML() {
  if (!AUDIO.records || !globalThis.BetterfyAudio) return '';
  const heard = BetterfyAudio.clapHeard(AUDIO.records);
  if (!heard) return '';
  const t = CLAPS.table;
  if (!t && !CLAPS.tableP && !CLAPS.err) fire(clapTable().then(() => repaint(['ui.discover'])));
  const n = x => x.toLocaleString();
  const list = t ? `<datalist id="sndqList">${t.prompts.map(p => `<option value="${esc(p.label)}"></option>`).join('')}</datalist>` : '';
  const res = CLAPS.res;
  let body = '';
  if (CLAPS.err && !t) body = emptyState('The phrase list didn’t load', `${esc(CLAPS.err)}.`,
    { compact: true, acts: '<button class="b sm" data-sndqretry>Try again</button>' });
  else if (res && !res.prompt) body = emptyState(`Nothing in the list is “${res.q}”`, res.near.length
    ? 'Search works from a fixed list of genres and descriptions. Try one of these:'
    : 'Search works from a fixed list of genres and descriptions. Start typing and pick one from it.',
    { compact: true, acts: res.near.map(p => `<button class="b sm" data-sndqpick="${esc(p.label)}">${esc(p.label)}</button>`).join(' ') });
  else if (res && !res.results.length) body = emptyState('Nothing to show', 'None of the tracks listening has heard are in your library now.', { compact: true });
  else if (res) body = `<ol class="prop-eg sndres">${res.results.map(x => `<li><b>${esc(x.t.name ?? x.id)}</b>
      <span>${esc((x.t.artists ?? []).map(a => a?.name).filter(Boolean).join(', '))}</span>
      <a class="open" href="https://open.spotify.com/track/${esc(x.id)}" target="_blank" rel="noopener">Open</a></li>`).join('')}</ol>
    <div class="rowbtns" style="margin-top:12px"><button class="b sm" data-sndqmake>Make a playlist of these ${n(res.results.length)}</button></div>`;
  return `<div class="card sndsearch" id="sndSearch">
    <div class="ttl">Find tracks that sound like… <span class="tag snd">by sound</span></div>
    <div class="rowbtns"><input id="sndq" list="sndqList" autocomplete="off" aria-label="Sounds like"
      placeholder="e.g. ${esc(t?.prompts.find(p => p.kind === 'description')?.label ?? 'dark rolling bassline')}" value="${esc(CLAPS.q)}">
      <button class="b p" data-sndq>Search</button></div>${list}
    <p class="why">Ranks the ${n(heard)} track${heard === 1 ? '' : 's'} listening has heard by how they sound.
      Pick a genre or description from the list; what you type stays on this device.</p>${body}
  </div>`;
}

