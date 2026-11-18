// @bundle screens new 60
/* The New playlists screen (docs/archive/BUILD-5-PLAN.md A4): an ES module. Reaches nothing but `ctx`;
 * SCREEN_CTX.new in app/screens.js builds it. The GAPS state and its jobs stay classic in
 * app/screenjobs.js. */

import { newGenreOffers } from './lists.mjs';

/** "New genre?" from the Engine (M5, was Library's "Possible new genres"): tracks it is unsure where to
 *  file, sitting together, most played first and named by sound ID when CLAP has a name. Up to three.
 *  Kept apart from the audio orphans because they come from the Engine's map, not from listening. */
export function engineGenreRows(c) {
  const { COLD, esc } = c;
  const offers = COLD?.status === 'ready' ? newGenreOffers(COLD.newGenre, COLD.active).slice(0, 3) : [];
  const n = x => (x ?? 0).toLocaleString();
  return offers.map((o, i) => `<div class="row prop prop-new"><div class="main">
      <div class="ttl">${esc(o.title)} <span class="tag snd">by sound</span> <span class="tag">${n(o.n)} tracks</span>${
        o.played ? ` <span class="tag ok">${n(o.played)} you're playing</span>` : ''}</div>
      <div class="sub">Tracks Betterfy is unsure where to file, sitting together. Name it if it is a genre to you.</div>
    </div><div class="acts"><input id="newgnm${i}" aria-label="Name for this playlist" ${o.named ? `value="${esc(o.title.replace(/\?$/, ''))}"` : 'placeholder="Name it"'}>
      <button class="b sm p" data-act="newg" data-newg="${i}">Create with ${n(o.n)}</button></div></div>`).join('');
}

/** Proposals by sound: pick one of two, hybrid playlists, new genre? Nothing at all without audio
 *  or the Engine's map. Each drawn as UI-6's proposalCard, so they read as one kind of thing. */
function gapsSoundSection(c) {
  const { GAPS } = c;
  const S = GAPS.sound;
  const eng = engineGenreRows(c);
  if (!S && !eng) return '';
  if (!S) return `<h2 class="newsec">By sound</h2>
    <p class="why">Groups the Engine found among your unfiled tracks. Only suggestions: nothing is made until you tap.</p>
    <div class="rows newrows">${eng}</div>`;
  const made = name => GAPS.made.has(String(name).toLowerCase());
  const hybrids = S.hybrids.map((h, i) => proposalCard(c, { ...h, kind: 'hybrid', i, done: made(h.name) })).join('');
  const orphans = S.orphans.map((o, i) => proposalCard(c, { ...o, kind: 'new', i, done: GAPS.filed.has('o' + i) })).join('');
  const picks = S.pick.map((p, i) => proposalCard(c, { ...p, kind: 'pick', i,
    filedTo: p.between.filter((x, k) => GAPS.filed.has(`p${i}:${k}`)).map(x => x.name) })).join('');
  return `<h2 class="newsec">By sound</h2>
    <p class="why">From listening to your unfiled tracks and comparing them with your own genre playlists. Only
      suggestions: nothing is made or added until you tap.</p>
    <div class="rows newrows">${hybrids}${orphans}${eng}${picks}</div>`;
}

/**
 * The gaps' part of the screen, as sections rather than one string, so vNew()
 * can draw the ones with something in them and fold every empty one into a
 * single empty state (UI-BUILD-PLAN R8: three grey boxes in a row was the
 * screen most libraries saw). While working or after an error it is one card.
 */
function gapsSections(c) {
  const { GAPS, R, esc, fire, gapsCompute, BetterfyGaps } = c;
  if (GAPS.status === 'idle' || (GAPS.status === 'ready' && GAPS.for !== R)) {
    GAPS.status = 'working';
    fire(gapsCompute());
  }
  if (GAPS.status !== 'ready') return { card: `<div class="card"><p class="why">${GAPS.status === 'error'
    ? `Couldn't work out the gaps: ${esc(GAPS.err)} <button class="b sm" data-act="gapsretry" data-gapsretry>Try again</button>`
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
      <button class="b sm p" data-act="gap" data-gap="${i}">Create with ${n(g.size)}</button>`}</div></div>`).join('');
  const splitRows = GAPS.splits.map((s, i) => `<div class="row"><div class="main">
      <div class="ttl">${esc(s.name)} <span class="tag">${n(s.total)} tracks</span></div>
      <div class="sub">${s.parts.map(x => `${x.rest ? 'the rest of ' : ''}${esc(x.label)} ${n(x.size)} (${Math.round(x.share * 100)}%)`).join(' · ')}.
        ${esc(s.name)} stays as it is.</div>
    </div><div class="acts"><button class="b sm p" data-act="wizgap" data-wizgap="${i}">Split into playlists…</button>${
      /* One way in (§7.7 C6, provisional): the per-part "Make X" went; Split… previews every part. */
      s.parts.filter(x => made(x.label)).map(x => ` <span class="tag ok">${esc(x.label)} created</span>`).join('')}</div></div>`).join('');
  // The untagged note went (§7.7 C6, provisional): the backlog groups at the bottom are where those tracks show.
  return { card: '', sections: [
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
export function proposalCard(c, p) {
  const { esc } = c;
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
      <button class="b sm p" data-act="sndh" data-sndh="${p.i}">Create with ${n(p.size)}</button>`;
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
        guess ? `\n      <button class="b sm" data-act="sndn" data-sndn="${p.i}">That’s it</button>` : ''}
      <button class="b sm p" data-act="sndo" data-sndo="${p.i}">Create with ${n(p.size)}</button>`;
  } else {
    ttl = `${esc(a?.name)} or ${esc(b?.name)}?`;
    sub = 'Unfiled tracks that sound as much like one as the other. Pick one for them, or leave them.';
    acts = p.filedTo?.length ? p.filedTo.map(x => `<span class="tag ok">added to ${esc(x)}</span>`).join('')
      : (p.between ?? []).map((x, k) => `<button class="b sm" data-act="sndp" data-sndp="${p.i}:${k}">Add to ${esc(x.name)}</button>`).join(' ');
  }
  return `<div class="row prop prop-${p.kind}"><div class="main">
      <div class="ttl">${ttl} ${by} <span class="tag">${n(p.size)} tracks</span>${played}</div>
      <div class="sub">${sub}${eg ? `<br>${eg}` : ''}</div>${samples}
    </div><div class="acts">${acts}</div></div>`;
}

export function view(c) {
  const { R, esc, emptyState } = c;
  c.engineGenreKick?.();
  const ib = c.infoBtn ?? (() => '');
  const head = `<h1>New playlists</h1>
    <p class="lede">Playlists you could make from music you already have.${ib('new', 'New playlists', `<p>Genres you have music in but no playlist for,
      playlists that are really two genres, and groups in your backlog that fit nothing you have. Nothing moves:
      creating makes a new private playlist holding a copy of the tracks.</p>`)}</p>`;
  const g = gapsSections(c);
  const clusterRows = R.clusters.map((x,i)=>`<div class="row"><div class="main">
      <div class="ttl">${x.size} tracks · ${esc(x.tags.slice(0,4).join(', '))}</div>
      <div class="sub">${esc(x.tracks.slice(0,4).join(' · '))}</div>
    </div><div class="acts"><input id="nm${i}" placeholder="Playlist name" value="${esc(x.tags[0]??'')}">
      <button class="b sm p" data-act="cluster" data-cluster="${i}">Create with ${x.size} tracks</button></div></div>`).join('');
  const sections = [...g.sections, { title: 'Groups in your backlog', rows: clusterRows,
    why: 'Unfiled tracks that sit together and fit none of your existing playlists.',
    none: 'no unfiled tracks sit together outside your playlists' }];
  const sec = x => `<h2 class="newsec">${esc(x.title)}</h2>
    <p class="why">${x.why}</p>
    <div class="rows newrows">${x.rows}</div>`;
  const full = sections.filter(x => x.rows), empty = sections.filter(x => !x.rows);
  const sound = gapsSoundSection(c);
  // Every section empty is one answer. Some empty is one line under the rest,
  // naming each so nothing silently disappears from the screen.
  const none = !empty.length || g.card ? '' : !full.length && !sound
    // One sentence (L3), compact on a phone (.es-phone, 50-components.css).
    ? `<div class="es-phone">${emptyState('Nothing to propose yet', 'No genre without a playlist, no playlist that is really two genres, and no group in your backlog yet: ideas show up here as your library grows.')}</div>`
    : emptyState('Nothing else to propose', empty.map(x => `<strong>${esc(x.title)}:</strong> ${esc(x.none)}.`).join(' '), { compact: true });
  return `${head}
    ${g.card}${full.map(sec).join('')}
    ${sound}${none}`;
}


export const actions = {
  /** Create a playlist for one uncovered genre. */
  async gap(c, el) {
    const g = c.GAPS.gaps?.[+el.dataset.gap];
    const name = c.$('#gapnm' + el.dataset.gap)?.value.trim();
    if (!g) return;
    if (!name) return c.toast('Give it a name first.');
    el.disabled = true;
    try { await c.gapsCreate(name, g.ids); } catch (err) { el.disabled = false; c.toast('Failed: ' + err.message); }
  },

  /** The merge/split wizard (BUILD-6 F4) on this split: preview both halves, rename, move tracks, one undo. */
  wizgap(c, el) {
    const s = c.GAPS.splits?.[+el.dataset.wizgap];
    if (s) c.mergeSplitOpen({ kind: 'split', id: s.playlistId, src: 'tags' });
  },

  /** By sound: a hybrid playlist. */
  sndh(c, el) { return soundCreate(c, el, 'sndh', c.GAPS.sound?.hybrids?.[+el.dataset.sndh], '#sndh' + el.dataset.sndh, false); },
  /** By sound: a new genre. */
  sndo(c, el) { return soundCreate(c, el, 'sndo', c.GAPS.sound?.orphans?.[+el.dataset.sndo], '#sndo' + el.dataset.sndo, true); },

  /** "That's it": keep CLAP's guess as the name. */
  async sndn(c, el) {
    const i = +el.dataset.sndn, g = c.GAPS.sound?.orphans?.[i], name = c.$('#sndo' + i)?.value.trim();
    if (!g) return;
    if (!name) return c.toast('Give it a name first.');
    try { await c.clapConfirm(g.ids, name); g.confirmed = name; g.suggest = null; c.toast(`Kept the name “${name}”.`); c.render(); }
    catch (err) { c.toast('Failed: ' + err.message); }
  },

  /** Pick one of two playlists for tracks that sound like both. */
  async sndp(c, el) {
    const [i, k] = el.dataset.sndp.split(':').map(Number);
    const p = c.GAPS.sound?.pick?.[i], to = p?.between?.[k];
    if (!to || c.GAPS.filed.has(`p${i}:0`) || c.GAPS.filed.has(`p${i}:1`)) return;
    el.disabled = true;
    try { await c.gapsFile(to.id, to.name, p.ids, `p${i}:${k}`); } catch (err) { el.disabled = false; c.toast('Failed: ' + err.message); }
  },

  gapsretry(c) { c.GAPS.status = 'idle'; c.render(); },

  /** A backlog cluster: name it and create it, through gapsCreate so it is in History with one Undo (F3). */
  async cluster(c, el) {
    const R = c.R, i = +el.dataset.cluster, g = R.clusters[i], name = c.$('#nm' + i)?.value.trim();
    if (!g) return;
    if (!name) return c.toast('Give it a name first.');
    el.disabled = true;
    try { await c.gapsCreate(name, g.ids, 'group in your backlog'); R.clusters.splice(R.clusters.indexOf(g), 1); c.render(); }
    catch (err) { el.disabled = false; c.toast('Failed: ' + err.message); }
  },

  /** A "New genre?" from the Engine (M5): make it, and remember the name for CLAP. */
  async newg(c, el) {
    const i = +el.dataset.newg, o = newGenreOffers(c.COLD?.newGenre, c.COLD?.active)[i], name = c.$('#newgnm' + i)?.value.trim();
    if (!o) return;
    if (!name) return c.toast('Give it a name first.');
    el.disabled = true;
    try {
      await c.gapsCreate(name, o.ids, 'new genre');
      if (c.clapConfirm) c.clapConfirm(o.ids, name).catch(() => {});
      c.COLD.newGenre = c.COLD.newGenre.filter(x => (x.ids ?? x.tracks?.map(t => t.id)) !== o.ids);
      c.render();
    } catch (err) { el.disabled = false; c.toast('Failed: ' + err.message); }
  },
};

async function soundCreate(c, el, kind, g, sel, isNew) {
  const i = +el.dataset[kind], name = c.$(sel)?.value.trim();
  if (!g) return;
  if (!name) return c.toast('Give it a name first.');
  el.disabled = true;
  try {
    await c.gapsCreate(name, g.ids);
    if (isNew) { c.GAPS.filed.add('o' + i); if (c.clapConfirm) c.clapConfirm(g.ids, name).catch(() => {}); }
    c.render();
  } catch (err) { el.disabled = false; c.toast('Failed: ' + err.message); }
}
