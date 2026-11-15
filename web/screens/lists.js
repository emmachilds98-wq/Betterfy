const AXES = ['genre','mood','era','event','djset','context','inbox'];
// The exact fallback classify() writes when a playlist's name gives it no clue
// at all — a silent guess, not a real signal, and the one worth confirming.

/* The facet mix of every playlist, for the Playlists screen. A full pass over
 * every track, so it is cached against the library it was built from rather
 * than recomputed on each of the many redraws this screen gets. */
let MIXCACHE = null;
function playlistMixes() {
  const stamp = LIB?.captured_at + '/' + (LIB?.playlists.length ?? 0);
  if (MIXCACHE?.stamp === stamp) return MIXCACHE;
  const mix = new Map();
  for (const p of LIB.playlists) mix.set(p.id, facetMix(p.tracks, TAGS));
  // The same measurement over the library as one pile — the baseline every
  // playlist above is read against, and the honest answer to "how much of my
  // genre data is actually genre".
  const base = facetMix(LIB.playlists.filter(p => !isMirrorPlaylist(p)).flatMap(p => p.tracks ?? []), TAGS);
  MIXCACHE = { stamp, mix, base };
  return MIXCACHE;
}

/** "64% genre · 19% mood" — what a playlist's tags are actually made of,
 *  which is the evidence behind a content-guessed axis and a sanity check on
 *  every other one. Facets under a tenth are left out as noise. */
function mixLabel(mix) {
  if (!mix || !mix.tracks) return '';
  const parts = ['genre','mood','era','occasion','descriptor']
    .map(f => [f, mix[f]]).filter(([, x]) => x >= 0.1)
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([f, x]) => `${Math.round(x * 100)}% ${f}`);
  return parts.join(' · ');
}

/* ---------- sound slot on Playlists ----------
 * profile(playlistId) → ProfileVM | null: one playlist's sound profile, from
 * WP-B2's adapter once listening has heard something. With no records it is
 * null, and every row renders exactly as it would with no sound layer at all
 * (docs/UI-BUILD-PLAN.md §3 rule 3). The Listening settings themselves live
 * on Sources, in the card audioPanelHTML() draws. */
const LISTS_SOUND = {
  profile: id => {
    if (!AUDIO.records || !globalThis.BetterfyAudio) return null;
    const p = LIB.playlists.find(x => x.id === id);
    let vm = BetterfyAudio.profileVM(p, AUDIO.records, AUDIO.labels);
    // What its heard members are, by genre, and the tempo they settle on
    // (core/audio/plprofile.mjs). Until that is worked out, the model's styles.
    const pp = listsProfiles()?.get(id);
    if (vm && pp) vm = { ...vm, ...(pp.mix.length ? { styles: pp.mix.slice(0, 3).map(m => [m.name, m.share]) } : {}),
                         ...(pp.bpm ? { bpm: pp.bpm } : {}) };
    return BetterfyAudio.withProfileEnergy && typeof labelsShownNow === 'function'
      ? BetterfyAudio.withProfileEnergy(vm, p, AUDIO.records, labelsShownNow()) : vm;
  },
};

/* ---------- playlist sound profiles and "two genres?" ----------
 * Each playlist's heard members, named by genre the way the File card names a
 * track, but with the playlist's own tracks left out of their library votes,
 * so a House playlist that is a third jungle can't vouch for itself. Worked
 * out a few tracks at a time between frames, once per change in what has been
 * heard; the screen redraws when it is done. Lookups on this account's own
 * heard tracks only. No records, no engine: nothing here runs or shows. */
const LPROF = { key: null, pr: null, out: null, busy: false, made: new Set(), loading: false };
/** Milliseconds of work per slice, so the screen stays responsive. */
const LPROF_SLICE_MS = 12;

function listsProfiles() {
  if (!AUDIO.records?.size || !LIB) return null;
  if (!globalThis.BetterfyPlProfile) {
    // The engine bundle is fetched on demand; fetch it and draw again.
    if (!LPROF.loading && typeof engineLoad === 'function') {
      LPROF.loading = true;
      fire(Promise.resolve(engineLoad()).then(() => { store.touch('ui.lists'); }, () => {}));
    }
    return null;
  }
  const targets = typeof engineTargets === 'function' ? engineTargets() : null;
  const key = `${AUDIO.records.size}|${LIB.captured_at}|${LIB.playlists.length}|${(targets ?? []).join()}`;
  if (LPROF.key !== key) {
    LPROF.key = key;
    LPROF.out = null;
    const genreOf = a => globalThis.BetterfyGaps?.artistGenre ? BetterfyGaps.artistGenre(TAGS?.[a?.id]?.tags) : null;
    LPROF.pr = BetterfyPlProfile.createProfiler(LIB, AUDIO.records, {
      targets, isMirror: isMirrorPlaylist,
      tagsOf: t => (t?.artists ?? []).map(genreOf).filter(Boolean),
      playlists: LIB.playlists.filter(p => !isMirrorPlaylist(p)).map(p => p.id),
    });
    listsProfileRun(key);
  }
  return LPROF.out;
}

function listsProfileRun(key) {
  if (LPROF.busy) return;
  LPROF.busy = true;
  const slice = () => {
    if (LPROF.key !== key) { LPROF.busy = false; if (LPROF.pr) listsProfileRun(LPROF.key); return; }
    const t0 = Date.now();
    let done = false;
    try { while (!(done = LPROF.pr.step(4)) && Date.now() - t0 < LPROF_SLICE_MS); }
    catch { done = true; }
    if (!done) return void setTimeout(slice, 0);
    LPROF.busy = false;
    try { LPROF.out = LPROF.pr.result(); } catch { LPROF.out = null; }
    store.touch('ui.lists');
  };
  setTimeout(slice, 0);
}

/** Genre playlists that sound like two genres, with the half that would move. */
function listsSplits() {
  const out = listsProfiles();
  if (!out) return [];
  return LIB.playlists.filter(p => CFG[p.id]?.axis === 'genre' && out.get(p.id)?.split)
    .map(p => ({ p, split: out.get(p.id).split }));
}

function listsSplitHTML(splits) {
  if (!splits.length) return '';
  const byId = new Map(LIB.playlists.flatMap(p => p.tracks ?? []).map(t => [t.id, t]));
  const card = ({ p, split }) => {
    const { keep, move } = split, name = BetterfyPlProfile.splitName(p.name, split);
    const made = LPROF.made.has(p.id);
    const eg = move.ids.slice(0, 3).map(id => byId.get(id)).filter(Boolean)
      .map(t => `<li>${esc(t.name ?? '')}<span class="sub"> · ${esc((t.artists ?? []).map(a => a?.name).filter(Boolean).join(', '))}</span></li>`).join('');
    return `<div class="row lsplit${made ? ' done' : ''}"><div class="main">
      <div class="ttl">${esc(p.name)}</div>
      <div class="lsplit-bar" aria-hidden="true"><i style="flex:${keep.n}"></i><i class="mv" style="flex:${move.n}"></i></div>
      <div class="sub"><b>${keep.n}</b> sound like ${esc(keep.name)} · <b>${move.n}</b> sound like ${esc(move.name)}</div>
      ${eg ? `<ul class="lsplit-eg">${eg}</ul>` : ''}
    </div><div class="acts">${made ? '<span class="tag ok">Made</span>'
      : `<button class="b sm" data-lsplit="${esc(p.id)}">Make “${esc(name)}”</button>`}</div></div>`;
  };
  return `<h2>Two genres by sound</h2>
    <p class="lede">${splits.length === 1 ? 'This playlist’s' : 'These playlists’'} heard tracks fall into two groups that
      sound apart and name different genres. Making the new playlist copies the second group into it; nothing is taken
      out of the original until you do that yourself.</p>
    <div class="rows">${splits.map(card).join('')}</div>`;
}

/** Make the playlist a split proposes, holding the half that sounds like the other genre. */
async function listsSplitMake(id) {
  const p = LIB.playlists.find(x => x.id === id), split = listsProfiles()?.get(id)?.split;
  if (!p || !split || LPROF.made.has(id)) return;
  const name = BetterfyPlProfile.splitName(p.name, split);
  const pl = await sp('/me/playlists', { method:'POST', body:JSON.stringify({ name, public:false }) });
  await addTracks(pl.id, split.move.ids);
  LPROF.made.add(id);
  toast(`Created “${name}” with ${split.move.ids.length} tracks. Nothing was taken out of “${p.name}”.`);
  render();
}

/** One row of the axes table, plus a hidden sound-profile row under it when
 *  there is a profile to show. No profile, no toggle and no hidden row. */
function axisRowHTML(p, mix) {
  const m = mixLabel(mix);
  const prof = profileRow(LISTS_SOUND.profile(p.id));
  const few = p.tracks < MIN_FOR_TARGET;
  return `<tr class="axrow" data-axrow="${esc(p.id)}">
      <th scope="row" class="axname">${prof ? `<button class="axexp" data-axexp="${esc(p.id)}" aria-expanded="false"
          aria-controls="axprof-${esc(p.id)}" aria-label="Sound profile of ${esc(p.name)}"></button>` : ''}<span class="ttl">${esc(p.name)}</span>
        <span class="axwhy ${p.why === 'set by you' ? 'mine' : ''}">${esc(p.why ?? '')}</span></th>
      <td class="axn mono">${p.tracks}</td>
      <td class="axmix">${m ? `<span title="which kind of tag its tracks carry">${esc(m)}</span>` : ''}</td>
      <td class="axsel"><select data-ax="${esc(p.id)}" aria-label="Axis of ${esc(p.name)}">${AXES.map(a => `<option value="${a}" ${p.axis===a?'selected':''}>${a}</option>`).join('')}</select></td>
      <td class="axtg"><label><input type="checkbox" data-tg="${esc(p.id)}" ${p.target?'checked':''} ${few ? 'disabled title="too few tracks to model"' : ''}>
        <span class="axtglbl">receives suggestions</span></label></td>
    </tr>${prof ? `
    <tr class="axprof" id="axprof-${esc(p.id)}" hidden><td colspan="5">${prof}</td></tr>` : ''}`;
}

/** The axes table. Columns are labelled once at the top rather than on
 *  every row; on a phone each row folds into a two-line card (62-lists.css). */
function axisTableHTML(list, mixes) {
  return `<div class="axtable"><table class="axtbl">
    <thead><tr><th scope="col">Playlist</th><th scope="col" class="axn">Tracks</th><th scope="col">Tagged as</th>
      <th scope="col">Axis</th><th scope="col">Receives suggestions</th></tr></thead>
    <tbody>${list.map(p => axisRowHTML(p, mixes.get(p.id))).join('')}</tbody></table></div>`;
}

function vLists() {
  const rows = Object.entries(CFG).map(([id,v]) => ({ id, ...v })).sort((a,b) => b.tracks - a.tracks);
  const cov = tagCoverage();
  const { mix: mixes } = playlistMixes();
  // Everything classify() could not read from the name or the dates. Nothing
  // is filed into these until the listener says which ones are genre
  // playlists — the silent "treat it as genre" default used to be exactly what
  // turned "Sunday" or "Favourites" into a wrong suggestion.
  const undecided = rows.filter(p => p.why === NO_SIGNAL);
  const splits = listsSplits();
  return `<h1>Playlists</h1>
    <p class="lede">How each playlist is treated, and which ones Betterfy files tracks into.</p>
    <details class="how"><summary>How this works</summary>
      <p>Tracks are only filed into playlists marked <b>receives suggestions</b> — by default, the ones whose name says what
        genre they are (“Donk”, “D&amp;B Rollers”, “Tech House”). Tick any other playlist to file into it too. A track
        is only ever compared against playlists on its own axis, so a metal track in a mood playlist is not flagged as
        misfiled. Each guess says what it was made from — the name, the dates the tracks were filed, or what kind of
        tags they carry — and correcting one is remembered on this device.</p>
      <p><b>Tagged as</b> is what a playlist's tracks are tagged with. Only the <b>genre</b> share tells a genre
        playlist apart from another one; the mood, decade and occasion tags are what a <b>mood</b> or <b>context</b>
        playlist is really held together by, and each axis weighs them accordingly.</p>
    </details>
    <p class="axcov"><span class="mono">${cov.pct}%</span> of artists have genre tags${cov.pct < 85 ? ', so suggestions will be thin until that improves' : ''}.
      <button class="b sm" data-go="sources">Genre sources</button></p>

    ${undecided.length ? `<h2>Needs your input</h2>
    <p class="lede">${undecided.length} playlist${undecided.length===1?' has':'s have'} no genre in ${undecided.length===1?'its':'their'} name,
      nothing in the dates, and no strong lean in the tags either — so nothing is filed into ${undecided.length===1?'it':'them'} until you say so.
      If one of these <i>is</i> a genre playlist, tick <b>receives suggestions</b> (or set it to genre); otherwise set what it really is.</p>
    ${axisTableHTML(undecided, mixes)}` : ''}

    ${(R.drift ?? []).length ? `<h2>Recently drifting</h2>
    <p class="lede">${R.drift.length} playlist${R.drift.length===1?'':'s'} whose newest additions read differently from everything added before them — not necessarily wrong, just worth a look. This is a trend across many tracks, not a single misfile.</p>
    <div class="rows">${R.drift.map(d => `<div class="row">
      <div class="main"><div class="ttl">${esc(d.playlistName)}</div>
        <div class="sub">newest ${d.recentCount}: <b>${d.recentTags.map(esc).join(', ') || '—'}</b>
          &nbsp;·&nbsp; the other ${d.olderCount}: <b>${d.olderTags.map(esc).join(', ') || '—'}</b>
          &nbsp;·&nbsp; ${Math.round(d.similarity*100)}% alike</div></div>
    </div>`).join('')}</div>` : ''}
${listsSplitHTML(splits)}
    <h2>Axes</h2>
    ${axisTableHTML(rows, mixes)}`;
}

/** Artists with genre tags, for Home, Playlists and the Sources screen's ctx. */
function tagCoverage() {
  const ids = new Set();
  for (const p of LIB.playlists) for (const t of p.tracks) for (const a of t.artists ?? []) if (a.id) ids.add(a.id);
  for (const t of LIB.liked) for (const a of t.artists ?? []) if (a.id) ids.add(a.id);
  const have = [...ids].filter(id => TAGS[id]?.tags?.length).length;
  return { total: ids.size, have, missing: ids.size - have, pct: ids.size ? Math.round(100*have/ids.size) : 0 };
}
