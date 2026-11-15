/* ======================= gaps: docs/SMARTER-GENRES-PLAN.md, phase 3 =======================
 * "Make new playlists where I'm not covering genres." Two proposals on top of the
 * backlog clusters this screen always had: genres you have music in but no genre
 * playlist for, and genre playlists that are really two genres. Worked out from
 * your tags, your genre playlists' names and what Spotify says you're playing, in
 * core/recommend/gaps.mjs — fetched with the engine the first time this screen
 * opens, since it brings the genre vocabulary with it.
 *
 * Nothing moves. Creating makes a new private playlist holding a copy of the
 * tracks; a playlist being split is left exactly as it is.
 * ======================================================================== */
const GAPS = { status:'idle', err:null, gaps:null, splits:null, untagged:0, homeless:0, made:new Set(), for:null,
  sound:null, filed:new Set() };

/** Audio records, only if listening is on or was: proposals by sound need nothing else, and are skipped without. */
async function gapsRecords() {
  if (typeof engineAudio !== 'function') return null;
  try { return await engineAudio(); } catch { return null; }
}

/** Work the proposals out. Listening only reorders them, so failing to get it costs nothing. */
async function gapsCompute() {
  // R is rebuilt whenever the library, its tags or its genre playlists change,
  // so the reports object this was worked out against says whether it is stale.
  GAPS.status = 'working'; GAPS.err = null; GAPS.for = R;
  try {
    await engineLoad();
    let active = null;
    try { active = (await getListening())?.recentlyActive ?? null; } catch { active = null; }
    const common = { lib: LIB, targets: engineTargets(), tagsOf: id => TAGS?.[id]?.tags ?? [], isMirror: isMirrorPlaylist };
    const u = BetterfyGaps.uncoveredGenres({ ...common, active });
    const split = BetterfyGaps.splitCandidates(common);
    // By sound (WP-H2): suggestions to create, so shown whatever the gate says.
    const records = await gapsRecords();
    const sound = records && globalThis.BetterfyAudioGaps
      ? BetterfyAudioGaps.soundProposals({ ...common, records, active }) : null;
    // WP-C3: a suggested name for each "new genre?", from CLAP, when it has heard them.
    if (sound?.orphans?.length && typeof clapNameOrphans === 'function') await clapNameOrphans(sound.orphans, records);
    Object.assign(GAPS, { status:'ready', gaps:u.gaps, splits:split.splits, untagged:u.untagged, homeless:u.homeless,
      sound: sound && (sound.pick.length || sound.hybrids.length || sound.orphans.length) ? sound : null });
  } catch (e) {
    GAPS.status = 'error'; GAPS.err = e?.message ?? String(e);
  }
  render();
}

/** Make a private playlist holding these tracks. Nothing else in the library changes. */
async function gapsCreate(name, ids) {
  const pl = await sp('/me/playlists', { method:'POST', body:JSON.stringify({ name, public:false }) });
  await addTracks(pl.id, ids);
  GAPS.made.add(name.toLowerCase());
  toast(`Created “${name}” with ${ids.length} tracks. It becomes a place to file into after your next sync.`);
  render();
}

/** Add these tracks to a playlist they already sound like. Nothing is taken out of anywhere. */
async function gapsFile(playlistId, name, ids, key) {
  await addTracks(playlistId, ids);
  GAPS.filed.add(key);
  toast(`Added ${ids.length} track${ids.length === 1 ? '' : 's'} to “${name}”.`);
  render();
}

/** Proposals by sound: pick one of two, hybrid playlists, new genre? Nothing at all without audio.
 *  Each drawn by UI-6's proposalCard, so the three read as one kind of thing. */
function gapsSoundSection() {
  const S = GAPS.sound;
  if (!S) return '';
  const made = name => GAPS.made.has(String(name).toLowerCase());
  const hybrids = S.hybrids.map((h, i) => proposalCard({ ...h, kind: 'hybrid', i, done: made(h.name) })).join('');
  const orphans = S.orphans.map((o, i) => proposalCard({ ...o, kind: 'new', i, done: GAPS.filed.has('o' + i) })).join('');
  const picks = S.pick.map((p, i) => proposalCard({ ...p, kind: 'pick', i,
    filedTo: p.between.filter((x, k) => GAPS.filed.has(`p${i}:${k}`)).map(x => x.name) })).join('');
  return `<h2 class="newsec">By sound</h2>
    <p class="why">From listening to your unfiled tracks and comparing them with your own genre playlists. Only
      suggestions: nothing is made or added until you tap.</p>
    <div class="rows" style="margin-top:10px">${hybrids}${orphans}${picks}</div>`;
}

/**
 * The gaps' part of the screen, as sections rather than one string, so vNew()
 * can draw the ones with something in them and fold every empty one into a
 * single empty state (UI-BUILD-PLAN R8: three grey boxes in a row was the
 * screen most libraries saw). While working or after an error it is one card.
 */
function gapsSections() {
  if (GAPS.status === 'idle' || (GAPS.status === 'ready' && GAPS.for !== R)) {
    GAPS.status = 'working';
    fire(gapsCompute());
  }
  if (GAPS.status !== 'ready') return { card: `<div class="card"><p class="why">${GAPS.status === 'error'
    ? `Couldn't work out the gaps: ${esc(GAPS.err)} <button class="b sm" data-gapsretry>Try again</button>`
    : 'Looking for genres you have no playlist for…'}</p></div>`, sections: [] };
  const n = x => x.toLocaleString();
  const made = name => GAPS.made.has(String(name).toLowerCase());
  const gapRows = GAPS.gaps.map((g, i) => `<div class="row"><div class="main">
      <div class="ttl">${esc(g.label)} <span class="tag">${n(g.size)} tracks</span>${
        g.played ? ` <span class="tag ok">${n(g.played)} you're playing</span>` : ''}</div>
      <div class="sub">e.g. ${esc(g.artists.join(', '))}${g.within ? `<br>Your ${esc(g.withinLabel)} playlist would
        take these, but there are enough for one of their own.` : ''}</div>
    </div><div class="acts">${made(g.label) ? '<span class="tag ok">created</span>'
      : `<input id="gapnm${i}" aria-label="Name for the ${esc(g.label)} playlist" value="${esc(g.label)}">
      <button class="b sm p" data-gap="${i}">Create with ${n(g.size)}</button>`}</div></div>`).join('');
  const splitRows = GAPS.splits.map((s, i) => `<div class="row"><div class="main">
      <div class="ttl">${esc(s.name)} <span class="tag">${n(s.total)} tracks</span></div>
      <div class="sub">${s.parts.map(x => `${x.rest ? 'the rest of ' : ''}${esc(x.label)} ${n(x.size)} (${Math.round(x.share * 100)}%)`).join(' · ')}.
        ${esc(s.name)} stays as it is.</div>
    </div><div class="acts">${s.parts.map((x, k) => made(x.label) ? `<span class="tag ok">${esc(x.label)} created</span>`
      : `<button class="b sm" data-split="${i}:${k}">Make “${esc(x.label)}” (${n(x.size)})</button>`).join(' ')}</div></div>`).join('');
  const untagged = GAPS.untagged ? `<p class="why" style="margin-top:8px">${n(GAPS.untagged)} of the ${n(GAPS.homeless)} tracks
      outside your genre playlists have no genre in their artists' tags, so they can't be placed in one here.
      The groups at the bottom are where those turn up.</p>` : '';
  return { card: '', untagged, sections: [
    { title: 'Genres with no playlist', rows: gapRows,
      why: `Music you've liked or filed somewhere else, in a genre none of your genre playlists is for.
      Genres nothing covers come first, then ones a broader playlist could take; what you're playing at the
      moment comes before both.`,
      none: `every genre you have ${BetterfyGaps.MIN_GAP} or more unfiled tracks of already has a playlist` },
    { title: 'Playlists that are two genres', rows: splitRows,
      why: `A genre playlist whose tracks split into two genres, each a real share of it. Making one
      copies those tracks into a new playlist and leaves the original alone.`,
      none: 'none of your genre playlists is two genres at once' },
  ] };
}

/**
 * One card shape for every proposal by sound (UI-BUILD-PLAN §2.8), so "pick
 * one of these two", "hybrid playlist" and "new genre?" read as the same kind
 * of thing told apart by the strip down the left edge (65-proposals.css):
 * a hybrid blends two hues, "new genre?" is broken, a toss-up is two halves.
 *
 * Takes the objects core/recommend/audio-gaps.mjs (WP-H2) makes, plus the
 * index `i` its click handler keys on and what has already been done:
 *   { kind: 'hybrid'|'new'|'pick', i, name, size, played?, artists?, mixed?,
 *     between?: [{id, name}, {id, name}], nearest?: {name},
 *     samples?: [{title, artist}], done?: boolean, filedTo?: string[] }
 * The attributes (data-sndh / data-sndo / data-sndp, #sndhN / #sndoN) are the
 * ones H2's handler reads. Null renders ''.
 */
function proposalCard(p) {
  if (!p || !['hybrid', 'new', 'pick'].includes(p.kind)) return '';
  const n = x => (x ?? 0).toLocaleString();
  const by = '<span class="tag snd">by sound</span>';
  const played = p.played ? ` <span class="tag ok">${n(p.played)} you're playing</span>` : '';
  const eg = p.artists?.length ? `e.g. ${esc(p.artists.join(', '))}` : '';
  const [a, b] = p.between ?? [];
  const samples = p.samples?.length ? `<ol class="prop-eg">${p.samples.slice(0, 4).map(t =>
    `<li><b>${esc(t.title)}</b> <span>${esc(t.artist ?? '')}</span></li>`).join('')}</ol>` : '';
  let ttl, sub, acts;
  if (p.kind === 'hybrid') {
    ttl = esc(p.name);
    sub = `Sounds between your ${esc(a?.name)} and ${esc(b?.name)} playlists, and like
        neither on its own.${p.mixed ? ` ${n(p.mixed)} of them change style partway through.` : ''}`;
    acts = p.done ? '<span class="tag ok">created</span>'
      : `<input id="sndh${p.i}" aria-label="Name for this playlist" value="${esc(p.name)}">
      <button class="b sm p" data-sndh="${p.i}">Create with ${n(p.size)}</button>`;
  } else if (p.kind === 'new') {
    // WP-C3: a name you confirmed, or CLAP's guess with a question mark until you do.
    const named = p.confirmed || null, guess = !named && p.suggest?.name ? p.suggest : null;
    ttl = named ? esc(named) : guess ? `${esc(guess.name)}?` : 'New genre?';
    sub = `These sit close together and sound like none of your genre playlists
        (the nearest is ${esc(p.nearest?.name)}). ${guess ? `They sound most like ${esc(guess.name)}${
          guess.alts?.length ? `, or ${guess.alts.map(x => esc(x.name)).join(' or ')}` : ''}${
          guess.sounds ? ` (“${esc(guess.sounds)}”)` : ''}: a guess by sound until you say so.`
        : named ? 'You named this group.' : 'Name it if it is a genre to you.'}`;
    const keep = named ?? guess?.name;
    acts = p.done ? '<span class="tag ok">created</span>'
      : `<input id="sndo${p.i}" aria-label="Name for this playlist" ${keep ? `value="${esc(keep)}"` : 'placeholder="Name it"'}>${
        guess ? `\n      <button class="b sm" data-sndn="${p.i}">That’s it</button>` : ''}
      <button class="b sm p" data-sndo="${p.i}">Create with ${n(p.size)}</button>`;
  } else {
    ttl = `${esc(a?.name)} or ${esc(b?.name)}?`;
    sub = 'Unfiled tracks that sound as much like one as the other. Pick one for them, or leave them.';
    acts = p.filedTo?.length ? p.filedTo.map(x => `<span class="tag ok">added to ${esc(x)}</span>`).join('')
      : (p.between ?? []).map((x, k) => `<button class="b sm" data-sndp="${p.i}:${k}">Add to ${esc(x.name)}</button>`).join(' ');
  }
  return `<div class="row prop prop-${p.kind}"><div class="main">
      <div class="ttl">${ttl} ${by} <span class="tag">${n(p.size)} tracks</span>${played}</div>
      <div class="sub">${sub}${eg ? `<br>${eg}` : ''}</div>${samples}
    </div><div class="acts">${acts}</div></div>`;
}

function vNew() {
  const head = `<h1>New playlists</h1>
    <p class="lede">Playlists you could make from music you already have.</p>
    <details class="how"><summary>How this works</summary><p>Genres you have music in but no playlist for,
      playlists that are really two genres, and groups in your backlog that fit nothing you have. Nothing moves:
      creating makes a new private playlist holding a copy of the tracks.</p></details>`;
  const g = gapsSections();
  const clusterRows = R.clusters.map((x,i)=>`<div class="row"><div class="main">
      <div class="ttl">${x.size} tracks · ${esc(x.tags.slice(0,4).join(', '))}</div>
      <div class="sub">${esc(x.tracks.slice(0,4).join(' · '))}</div>
    </div><div class="acts"><input id="nm${i}" placeholder="Playlist name" value="${esc(x.tags[0]??'')}">
      <button class="b sm p" data-cluster="${i}">Create with ${x.size} tracks</button></div></div>`).join('');
  const sections = [...g.sections, { title: 'Groups in your backlog', rows: clusterRows,
    why: 'Unfiled tracks that sit together and fit none of your existing playlists.',
    none: 'no unfiled tracks sit together outside your playlists' }];
  const sec = x => `<h2 class="newsec">${esc(x.title)}</h2>
    <p class="why">${x.why}</p>
    <div class="rows" style="margin-top:10px">${x.rows}</div>`;
  const full = sections.filter(x => x.rows), empty = sections.filter(x => !x.rows);
  const sound = typeof gapsSoundSection === 'function' ? gapsSoundSection() : '';
  // Every section empty is one answer. Some empty is one line under the rest,
  // naming each so nothing silently disappears from the screen.
  const none = !empty.length || g.card ? '' : !full.length && !sound
    ? emptyState('Nothing to propose yet', `${empty.map(x => `<strong>${esc(x.title)}:</strong> ${esc(x.none)}.`).join(' ')}
      New ideas show up here as your library grows.`)
    : emptyState('Nothing else to propose', empty.map(x => `<strong>${esc(x.title)}:</strong> ${esc(x.none)}.`).join(' '), { compact: true });
  return `${head}
    ${g.card}${full.map(x => sec(x) + (x === g.sections[0] ? g.untagged ?? '' : '')).join('')}
    ${g.sections[0]?.rows ? '' : g.untagged ?? ''}${sound}${none}`;
}

