/* ---------- shuffle: spacing, not randomness ---------- */
const rnd = a => { for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; };
const artistOf = t => t.artists?.[0]?.name ?? '?';

/**
 * Uniform random clumps: with 200 tracks you routinely get the same artist
 * twice within three slots. This repeatedly takes the artist with the most
 * tracks still unplaced, skipping any used within a cooldown window, which
 * also stops a prolific artist bunching at the tail.
 */
function spacedShuffle(items) {
  const buckets = new Map();
  for (const t of items) { const k = artistOf(t); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(t); }
  for (const v of buckets.values()) rnd(v);
  const cooldown = Math.max(1, Math.min(buckets.size-1, Math.floor(buckets.size/3), 12));

  /* Artists indexed by how many tracks they have left to place, so "who has
   * the most still unplaced" is a lookup instead of a scan over every artist
   * in the library. The scan is what made this quadratic, and it stopped being
   * theoretical the moment "All Songs — Betterfy" became the default source:
   * measured on this build, twelve thousand tracks took about twelve seconds
   * of blocked main thread — and the screen ran the whole thing again on every
   * redraw. levels[c] holds the artists with c tracks left, and `slot` is each
   * artist's index within its level, so moving one down a level is O(1). */
  const levels = [];
  const slot = new Map();                          // artist -> index within its level
  const put = k => { const c = buckets.get(k).length;
    (levels[c] ??= []).push(k); slot.set(k, levels[c].length - 1); };
  const take = k => { const lvl = levels[buckets.get(k).length], i = slot.get(k), last = lvl.pop();
    if (i < lvl.length) { lvl[i] = last; slot.set(last, i); }
    slot.delete(k);
  };
  let top = 0;
  for (const [k, v] of buckets) { put(k); if (v.length > top) top = v.length; }

  // A count, not a set: with few enough artists the same one can sit in the
  // cooldown window twice, and dropping it on the first expiry would let it
  // come back while the window still holds it.
  const out = [], recentA = [], onCooldown = new Map(), recentAl = [];
  const cools = k => { recentA.push(k); onCooldown.set(k, (onCooldown.get(k) ?? 0) + 1);
    if (recentA.length > cooldown) { const old = recentA.shift(), n = onCooldown.get(old) - 1;
      if (n > 0) onCooldown.set(old, n); else onCooldown.delete(old); } };
  /* At most `cooldown` artists are on the naughty step and at most four albums
   * are, so on a level holding hundreds of artists a random draw lands on a
   * usable one almost every time — cheaper, and just as uniform, as filtering
   * the level. A small level is filtered outright, where that is the cheaper
   * of the two. Either way the choice is the same one as before: the busiest
   * artist not heard recently, preferring one whose next track is off an album
   * that has not just played. */
  const pick = lvl => {
    if (lvl.length <= 64) {
      const free = lvl.filter(k => !onCooldown.has(k));
      if (!free.length) return null;
      const fresh = free.filter(k => !recentAl.includes(buckets.get(k).at(-1)?.album));
      const from = fresh.length ? fresh : free;
      return from[Math.floor(Math.random() * from.length)];
    }
    let fallback = null;
    for (let i = 0; i < 24; i++) {
      const k = lvl[Math.floor(Math.random() * lvl.length)];
      if (onCooldown.has(k)) continue;
      if (!recentAl.includes(buckets.get(k).at(-1)?.album)) return k;
      fallback ??= k;
    }
    return fallback;
  };

  while (out.length < items.length) {
    while (top > 0 && !levels[top]?.length) top--;
    if (!top) break;
    let key = null;
    for (let c = top; c > 0 && key === null; c--) {
      if (levels[c]?.length) key = pick(levels[c]);
    }
    // Everything still unplaced is inside the cooldown window: take the
    // busiest of them anyway rather than stalling.
    if (key === null) key = levels[top][Math.floor(Math.random() * levels[top].length)];

    const list = buckets.get(key);
    take(key);
    const t = list.pop(); out.push(t);
    if (list.length) put(key);

    cools(key);
    recentAl.push(t.album); if (recentAl.length > 4) recentAl.shift();
  }
  return out;
}
function shuffleStats(order) {
  const last = new Map(); const gaps = []; let adjacent = 0, within3 = 0;
  order.forEach((t,i) => { const k = artistOf(t);
    if (last.has(k)) { const g = i-last.get(k); gaps.push(g); if (g===1) adjacent++; if (g<=3) within3++; }
    last.set(k,i); });
  return { adjacent, within3, minGap: gaps.length?Math.min(...gaps):'—',
           avgGap: gaps.length?(gaps.reduce((a,b)=>a+b,0)/gaps.length).toFixed(1):'—' };
}

// The playlist syncAllSongsPlaylist() keeps topped up — a distinctive name so
// it is never confused with (or overwritten in place of) something a listener
// already made and happened to call "All Songs". The name is only how the
// *first* one is found, though: see ALL_SONGS_KEY.
const ALL_SONGS_NAME = 'All Songs — Betterfy';

/**
 * The mirror as it exists in the account right now, or null if there isn't one.
 *
 * Found by the id in ALL_SONGS_KEY first. Finding it by name alone meant
 * renaming it — the first thing anyone does to a playlist they mean to keep —
 * made the next refresh unable to see it, so it built a second one and filled
 * that with a copy of the whole library. The id survives a rename; the name is
 * only the fallback for the first refresh after an upgrade, before anything
 * has been pinned.
 *
 * Deliberately still looked up inside /me/playlists rather than fetched by id
 * on its own: Spotify never really deletes a playlist, it unfollows it, and
 * GET /playlists/{id} keeps answering for one you threw away. Requiring it to
 * still be in your library is what makes "delete it, press the button again"
 * mean "build me a new one" rather than quietly topping up something you can
 * no longer see.
 */
async function findAllSongsPlaylist() {
  const mine = await paged('/me/playlists?limit=50');
  const ours = p => p?.owner?.id === LIB.user.id;
  const pinned = pinnedAllSongs();
  return mine.find(p => p.id === pinned && ours(p))
      ?? mine.find(p => p.name === ALL_SONGS_NAME && ours(p))
      ?? null;
}

/** Every track in the library, once each — the union this feeds into
 *  ALL_SONGS_NAME. Order doesn't matter; Shuffle re-orders it regardless. */
function allLibraryTracks() {
  const seen = new Map();
  for (const p of LIB.playlists) for (const t of p.tracks) if (t?.id && !seen.has(t.id)) seen.set(t.id, t);
  for (const t of LIB.liked) if (t?.id && !seen.has(t.id)) seen.set(t.id, t);
  return [...seen.values()];
}

// Spotify's own ceiling. Adding past it fails the whole request with a 403
// that says nothing useful, so it is worth saying it here instead.
const PLAYLIST_MAX = 10000;

/**
 * Delete the surplus copies of anything sitting in the mirror more than once.
 *
 * The mirror holds one of each by construction, so a second copy is always
 * damage — from a refresh before relinked ids were matched properly, from two
 * devices refreshing at the same time, or from a duplicate dragged in by hand.
 * Nothing is ever removed that isn't a repeat of something staying put.
 *
 * A repeat is the same visible id twice. Not the same ISRC: two releases of
 * one recording are two tracks, and an earlier refresh may have put both in
 * on purpose — only an exact repeat is damage. (Relinked copies of one track
 * read back under one visible id, so they are still caught.)
 *
 * Deleted by position, highest first: removing a track at position 900 cannot
 * move anything at position 40, so one read is enough and the indices stay
 * valid across every request. (Deleting by uri alone would take out *all*
 * copies, including the one that should stay.) Spotify's current reference
 * documents only `{ uri }` items, with no `positions`; they are still sent,
 * and if the endpoint ignores them and takes every copy, the read-back in
 * syncAllSongsPlaylist() sees the keeper missing and adds it again.
 */
async function pruneMirrorDuplicates(id, entries) {
  const seen = new Set(), extra = [];
  for (const e of entries) {
    if (!e.id) continue;                  // a local file — never touched
    if (seen.has(e.id)) extra.push(e); else seen.add(e.id);
  }
  if (!extra.length) return 0;
  extra.sort((a, b) => b.pos - a.pos);
  for (const part of chunk(extra, 100)) {
    const byUri = new Map();
    for (const e of part) {
      const uri = 'spotify:track:' + e.id;
      if (!byUri.has(uri)) byUri.set(uri, []);
      byUri.get(uri).push(e.pos);
    }
    await plDelete(id, [...byUri].map(([uri, positions]) => ({ uri, positions })));
  }
  await logAction({ op:'prune', playlistId:id, playlistName:ALL_SONGS_NAME,
    trackIds:extra.map(e => e.id), reason:'duplicate copies in the All Songs mirror' });
  return extra.length;
}

/**
 * Create (once) or top up (every time after) a playlist holding every track
 * in the library. Never removes anything you filed and never re-adds what is
 * already there — it reads the playlist's current contents first and only
 * sends the difference, so running it again costs nothing and duplicates
 * nothing. The one thing it does remove is a duplicate copy of a track the
 * playlist already holds, which is damage from an earlier run rather than
 * anything you put there.
 */
async function syncAllSongsPlaylist() {
  const all = allLibraryTracks();
  if (!all.length) return toast('Nothing to add yet — sync your library first.');
  let pl = await findAllSongsPlaylist();
  const fresh = !pl;
  if (!pl) pl = await sp('/me/playlists', { method:'POST', body:JSON.stringify({
    name: ALL_SONGS_NAME, public:false,
    description:'Every track in your library, kept in one place by Betterfy. Refresh any time — nothing is ever duplicated.',
  }) });
  // Pinned on every run, not just on creation: an existing mirror found by
  // name this once is found by id from here on, and so survives a rename.
  LS.setItem(ALL_SONGS_KEY, pl.id);

  let entries = fresh ? [] : await playlistEntries(pl.id);
  const pruned = await pruneMirrorDuplicates(pl.id, entries);
  // Read back rather than assumed. Removing surplus copies is the one
  // destructive step in here, and if it ever took out more than the surplus —
  // an endpoint that quietly ignores `positions`, say — this is what notices,
  // because everything now missing is put back by the add below.
  if (pruned) entries = await playlistEntries(pl.id);

  // A relinked track counts as present under either id — the one Spotify shows
  // and the one you actually added, matched by ISRC now that linked_from is
  // gone. Without this half every relinked track in the library was re-added
  // on every single refresh.
  const have = new Set(), haveIsrc = new Set();
  for (const e of entries) { if (e.id) have.add(e.id); if (e.isrc) haveIsrc.add(e.isrc); }
  for (const t of all) if (t.isrc && haveIsrc.has(t.isrc)) have.add(t.id);

  const missing = all.filter(t => !have.has(t.id));
  const room = PLAYLIST_MAX - entries.length;
  const adding = missing.slice(0, Math.max(0, room));
  if (adding.length) {
    await addTracks(pl.id, adding.map(t => t.id));
    await logAction({ op:'add', playlistId:pl.id, playlistName:pl.name ?? ALL_SONGS_NAME,
      trackIds:adding.map(t => t.id), reason:'All Songs refresh' });
  }

  // Reflect the result locally so Shuffle can use it immediately, rather than
  // needing a full re-sync to notice a playlist it just wrote to.
  const nowIds = new Set([...have, ...adding.map(t => t.id)]);
  const byId = new Map(all.map(t => [t.id, t]));
  // Ids that are in the playlist but no longer in the library — a track
  // unliked or removed since the last refresh. They used to be kept as a bare
  // { id }, which carries no artist and no title: every one of them shared the
  // same empty identity key, so a handful of them were reported as duplicates
  // of each other, in a row with no name on it. They are simply dropped now.
  const merged = [...nowIds].map(id => byId.get(id)).filter(Boolean);
  const idx = LIB.playlists.findIndex(p => p.id === pl.id);
  const entry = { id:pl.id, name:pl.name ?? ALL_SONGS_NAME, snapshot_id:null, shape:SHAPE, tracks:merged };
  if (idx >= 0) LIB.playlists[idx] = entry; else LIB.playlists.push(entry);
  await idb.set('library', LIB);
  // A meta playlist of everything is not a filing destination on any axis —
  // comparing tracks against it would just mean "matches something you own".
  CFG[pl.id] = { name:entry.name, axis:'context', why:'set by you', target:false, tracks:merged.length };
  const savedAxes = JSON.parse(LS.getItem('bf_axes') || '{}');
  savedAxes[pl.id] = { axis:'context', target:false, at:Date.now() };
  LS.setItem('bf_axes', JSON.stringify(savedAxes));
  R = buildReports(LIB, CFG, TAGS);
  S.shufPl = pl.id; S.shufCache = null;
  const say = [];
  if (adding.length) say.push(`${adding.length} track${adding.length===1?'':'s'} added`);
  if (pruned) say.push(`${pruned} duplicate${pruned===1?'':'s'} cleared out`);
  if (adding.length < missing.length)
    say.push(`${(missing.length - adding.length).toLocaleString()} left over — Spotify caps a playlist at ${PLAYLIST_MAX.toLocaleString()}`);
  toast(say.length ? `${entry.name} refreshed — ${say.join(', ')}.` : `${entry.name} is already up to date.`);
  render();
}

/* ---------- DJ order: Shuffle by tempo and sound (core/audio/order.mjs) ----------
 * Once listening has heard enough of a playlist, Shuffle can order it like a DJ
 * set instead: each next track a tempo you can beatmatch (half and double time
 * count) and close in sound, the same artist never twice running, and if asked
 * along an energy arc. Tracks not heard yet follow in the spaced shuffle. A
 * lookup over this account's own heard tracks; nothing is shown, and the screen
 * is exactly as before, until at least MIN_MIX of the playlist has been heard. */
const MIX_MODES = { flat: 'DJ order', build: 'DJ order, building up', peak: 'DJ order, warm-up → peak → cool-down' };
const MIX_PAGE = { recs: null, n: 0, index: null, err: null };
/** Heard tracks in this list with a tempo sure enough to mix on (match.mjs MIX_MIN_CONF). */
function mixHeardIn(tracks) {
  if (!AUDIO.records?.size) return 0;
  const min = globalThis.BetterfyMatch?.MIX_MIN_CONF ?? 0.3;
  let n = 0;
  for (const t of tracks) { const d = AUDIO.records.get(t.id); const p = d && !d.miss ? d.dsp : null;
    if (p && p.bpm > 0 && (p.bpmConf ?? 0) >= min) n++; }
  return n;
}
function mixIndexNow() {
  if (MIX_PAGE.recs !== AUDIO.records || MIX_PAGE.n !== AUDIO.records.size)
    Object.assign(MIX_PAGE, { recs: AUDIO.records, n: AUDIO.records.size, index: BetterfyOrder.mixIndex(AUDIO.records) });
  return MIX_PAGE.index;
}
/** The DJ order for this source, cached beside the spaced one (re-rolled with it), or
 *  { pending } while engine.js loads. */
function shuffleMix(sel, tracks, mode) {
  if (!globalThis.BetterfyOrder) {
    if (!MIX_PAGE.err) fire(engineLoad().then(() => { if (view === 'shuffle') render(); },
      e => { MIX_PAGE.err = e?.message ?? String(e); if (view === 'shuffle') render(); }));
    return { pending: true };
  }
  const index = mixIndexNow();
  const key = `${sel}|${tracks.length}|${mode}|${index.size}`;
  if (S.shufMix?.key === key && S.shufMix.base === S.shufCache) return S.shufMix.v;
  const m = BetterfyOrder.mixOrder(tracks, index, { arc: mode, seed: 1 + Math.floor(Math.random() * 2147483646), artistOf });
  const rest = m.rest.length ? spacedShuffle(m.rest) : [];
  const v = { order: [...m.order, ...rest], mixed: m.order.length, rest: rest.length, steps: m.steps,
              stats: BetterfyOrder.mixStats(m.order, index), naive: BetterfyOrder.mixStats(rnd([...m.order]), index), index };
  S.shufMix = { key, base: S.shufCache, v };
  return v;
}
const mixPct = x => `${Math.round(x * 100)}%`;
function mixBpmOf(index, id) {
  const d = index.get(id)?.rec?.dsp;
  return d?.bpm > 0 ? Math.round(d.bpm) : null;
}
/** The energy along the mix as a row of bars; only once energy labels have been checked. */
function mixEnergyHTML(energy) {
  const shown = typeof labelsShownNow === 'function' ? labelsShownNow() : null;
  if (!shown?.energy || !(energy?.length >= 2)) return '';
  return `<div class="mx-arc" role="img" aria-label="Energy along the mix, calm to intense">${energy.map(e =>
    `<span style="height:${Math.max(8, Math.round(e * 100))}%"></span>`).join('')}</div>`;
}
function mixHTML(mix, tracks, p) {
  if (mix.pending) return MIX_PAGE.err
    ? emptyState('The mix couldn’t load', esc(MIX_PAGE.err), { compact: true })
    : emptyState('Working out the mix…', 'Matching tempos and sounds across what listening has heard.', { compact: true });
  const st = mix.stats, nv = mix.naive, bpmOn = globalThis.BetterfyAudio?.bpmShown ? BetterfyAudio.bpmShown() : true;
  const row = (t, i) => {
    const heard = i < mix.mixed, step = i > 0 && i < mix.mixed ? mix.steps[i - 1] : null;
    const bpm = heard && bpmOn ? mixBpmOf(mix.index, t.id) : null;
    const jump = step && !step.rel;
    return `<div class="${jump ? 'mx-jump' : ''}${heard ? '' : ' mx-unheard'}">
      <span class="i">${String(i+1).padStart(3,'0')}</span>
      <span class="t">${esc(t.name)}</span>
      <span class="a">${esc(artistOf(t))}</span>${bpm ? `<span class="mx-bpm"${step?.rel && step.rel !== 'same' ? ` title="${step.rel === 'half' ? 'double' : 'half'} time"` : ''}>${bpm}</span>` : ''}${jump ? '<span class="mx-tag">tempo change</span>' : ''}</div>`;
  };
  return `<div class="vs">
      <div class="bad"><div class="l">Shuffled</div><div class="n">${nv.share === null ? '—' : mixPct(nv.share)}</div>
        <div class="d">of track changes can be beatmatched</div></div>
      <div class="good"><div class="l">${esc(MIX_MODES[S.shufMode])}</div><div class="n">${st.share === null ? '—' : mixPct(st.share)}</div>
        <div class="d">can be beatmatched${st.shift !== null ? `, ${(st.shift * 100).toFixed(1)}% pitch change on average` : ''}</div></div>
    </div>
    ${mixEnergyHTML(st.energy)}
    <p class="lede mx-sum">${mix.mixed} heard tracks in the mix${bpmOn && st.bpm ? ` · ${Math.round(st.bpm[0])}–${Math.round(st.bpm[1])} BPM` : ''}${mix.rest ? ` · ${mix.rest} not heard yet follow in the spaced shuffle` : ''}${tracks.length!==p.tracks.length?` · ${p.tracks.length-tracks.length} near-duplicates dropped`:''}</p>
    <h2>Order</h2>
    <div class="order mx-order">${mix.order.slice(0,40).map(row).join('')}</div>`;
}

function vShuffle() {
  const pls = LIB.playlists.filter(p => p.tracks.length >= 8).sort((a,b) => b.tracks.length - a.tracks.length);
  // Once it exists, everything you own beats any single bucket as a shuffle
  // source — that default only loses to a playlist you have since chosen.
  const allSongs = LIB.playlists.find(isMirrorPlaylist);
  // Persisted immediately, not just used locally — otherwise "Create shuffled
  // playlist" (which reads S.shufPl on its own) can act on a different
  // playlist than whichever one the dropdown is actually showing as selected.
  const sel = S.shufPl = S.shufPl ?? allSongs?.id ?? pls[0]?.id;
  const p = LIB.playlists.find(x => x.id === sel);
  const tracks = p ? dedupe(p.tracks) : [];
  // Cached against the source it was built from. Shuffling used to run again on
  // every single redraw of this screen — including the redraw after an
  // unrelated toast — and it is by some distance the most expensive thing the
  // app computes. "Shuffle again" below is how you deliberately re-roll it.
  if (S.shufCache?.id !== sel || S.shufCache?.n !== tracks.length) {
    S.shufCache = { id: sel, n: tracks.length,
      order: tracks.length ? spacedShuffle(tracks) : [],
      naive: tracks.length ? shuffleStats(rnd([...tracks])) : null };
  }
  const order = S.shufCache.order, naive = S.shufCache.naive;
  const good = order.length ? shuffleStats(order) : null;
  // DJ order: offered only once enough of this list has been heard; otherwise nothing changes.
  const canMix = order.length && mixHeardIn(tracks) >= (globalThis.BetterfyOrder?.MIN_MIX ?? 8);
  if (S.shufMode === undefined) { try { S.shufMode = LS.getItem('bf_shuf_mode') || ''; } catch { S.shufMode = ''; } }
  const mix = canMix && MIX_MODES[S.shufMode] ? shuffleMix(sel, tracks, S.shufMode) : null;
  const mixPick = canMix ? ` <select id="shufMode" aria-label="Order">${[['', 'Spaced shuffle'], ...Object.entries(MIX_MODES)].map(([v, l]) =>
    `<option value="${v}" ${v === (mix ? S.shufMode : '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>` : '';
  S.shufOrder = mix && !mix.pending ? mix.order : mix ? [] : order;
  S.shufOrderMode = mix && !mix.pending ? S.shufMode : null;
  return `<h1>Shuffle</h1>
    <p class="lede">Spotify's shuffle clusters artists. This maximises the distance between tracks by the same artist and the same album, then writes the result as a playlist you play with Spotify's own shuffle <b>off</b>.</p>
    <p class="lede" style="margin-top:-8px">${allSongs
      ? `Shuffling from <b>${esc(allSongs.name)}</b> by default — everything in your library, kept in one place.`
      : `No single playlist has everything you own yet.`}
      <button class="b sm" id="syncAllSongs" style="margin-left:6px">${allSongs ? 'Refresh it' : 'Build it'}</button></p>
    <div class="rowbtns" style="margin-bottom:22px">
      <select id="shufPl">${pls.map(x => `<option value="${esc(x.id)}" ${x.id===sel?'selected':''}>${esc(x.name)} (${x.tracks.length})</option>`).join('')}</select>
      <button class="b p" id="shufApply" ${S.shufOrder.length?'':'disabled'}>Create shuffled playlist</button>
      <button class="b" id="shufPlay" ${S.shufOrder.length?'':'disabled'}>Create and play</button>
      <button class="b sm" id="shufAgain" ${order.length?'':'disabled'}>Shuffle again</button>${mixPick}
    </div>
    ${mix ? mixHTML(mix, tracks, p) : good ? `<div class="vs">
      <div class="bad"><div class="l">Spotify's shuffle</div><div class="n">${naive.minGap}</div>
        <div class="d">${naive.minGap === 1 ? 'slot' : 'slots'} between the same artist, ${naive.within3} ${naive.within3 === 1 ? 'pair' : 'pairs'} within three</div></div>
      <div class="good"><div class="l">Betterfy</div><div class="n">${good.minGap}</div>
        <div class="d">${good.minGap === 1 ? 'slot' : 'slots'} minimum, ${good.within3 ? `${good.within3} ${good.within3 === 1 ? 'pair' : 'pairs'} within three` : 'nothing within three'}, average gap ${good.avgGap}</div></div>
    </div>
    <p class="lede" style="margin:-10px 0 20px; font-size:14px">${order.length} tracks · ${new Set(tracks.map(artistOf)).size} artists${tracks.length!==p.tracks.length?` · ${p.tracks.length-tracks.length} near-duplicates dropped`:''}</p>
    <h2>Order</h2>
    <div class="order">${order.slice(0,40).map((t,i) => `<div>
      <span class="i">${String(i+1).padStart(3,'0')}</span>
      <span class="t">${esc(t.name)}</span>
      <span class="a">${esc(artistOf(t))}</span></div>`).join('')}</div>` : emptyState('Pick a playlist', 'Anything with eight tracks or more can be re-spaced.')}`;
}

