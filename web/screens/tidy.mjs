// @bundle screens tidy 40
/* The Tidy screen (docs/BUILD-5-PLAN.md A4): an ES module. It touches nothing outside `ctx`
 * (web/README.md, "Screen modules"); SCREEN_CTX.tidy in app/screens.js builds it. The sound
 * misfit state and jobs, and emptyState, stay classic in app/screenjobs.js. */

/* ---------- Tidy: three screens' worth of the same question ----------
 *
 * Duplicates, Misfiles and Cross-filed were three destinations all asking "is
 * this in the right place?", and nobody visited the last two. They are one
 * screen now, with a section each and the counts on the switcher, so the
 * question is asked once and the answer is a row you tap.
 */
const TIDY_SECTIONS = [['misfile', 'Wrong place'], ['dupes', 'Repeats'], ['cross', 'Cross-filed']];

export function secDupes(c) {
  const { R, esc, thumbHTML, cmpTable, shownOf, emptyState, moreButton } = c;
  const exact = R.within.filter(x => x.verdict === 'same-recording');
  const clash = R.within.filter(x => x.verdict !== 'same-recording');
  const sec = (title, list, note, key) => `<h2>${esc(title)} <span class="mono" style="color:var(--ink-3);font-size:14px">${list.length}</span></h2>
    <p class="lede">${note}</p>
    <div class="rows">${list.slice(0, shownOf(key)).map(c => `<div class="row" data-flip data-key="${esc(`dup:${c.playlistId}:${c.options.map(o => o.id).join(',')}`)}">${thumbHTML(c)}<div class="main">
      <div class="ttl">${esc(c.title)} <span class="sub">— ${esc(c.artist ?? '')}</span></div>
      <div class="sub mono">${esc(c.playlist)}</div><div class="why">${esc(c.why)}</div>${cmpTable(c.options)}
    </div><div class="acts">${c.options.map(o =>
      `<button class="b sm" data-act="keep" data-keep="${esc(o.id)}" data-pl="${esc(c.playlistId)}" data-drop="${esc(c.options.filter(z => z.id !== o.id).map(z => z.id).join(','))}">Keep ${esc(o.dur)}</button>`).join('')}
    </div></div>`).join('') || emptyState('None found', 'Nothing in your library matches this.', { compact: true })}</div>
    ${moreButton(key, list.length)}`;
  const lede = `<p class="lede">Only duplicates <b>inside a single playlist</b> are offered for removal. A track in several playlists is treated as deliberate — that is the Cross-filed section.</p>`;
  // Both lists empty is one answer, not two grey boxes under two headings.
  if (!exact.length && !clash.length) return `${lede}
    ${emptyState('No repeats', 'None of your playlists has the same track in it twice, as the same recording or as a different cut.')}`;
  return `${lede}
    ${sec('The same recording, twice', exact, 'Both copies share an ISRC: the same master on two releases. Removing one loses nothing.', 'dupes-exact')}
    ${sec('Version clashes', clash, 'Genuinely different cuts in one playlist. Differing values are marked.', 'dupes-clash')}`;
}

export function secCross(c) {
  const { S, R, esc, thumbHTML, shownOf, emptyState, moreButton } = c;
  const a = R.across.filter(x => x.placements.length >= S.crossMin);
  return `<p class="lede">Tracks in several playlists. Usually deliberate — nothing is preselected. Tap a playlist to remove the track from just that one.</p>
    <div class="rowbtns" style="margin-bottom:14px">${[2, 3, 4, 5, 6].map(n =>
      `<button class="b sm ${S.crossMin === n ? 'p' : ''}" data-act="cmin" data-cmin="${n}">${n}+ playlists</button>`).join('')}</div>
    <div class="rows">${a.slice(0, shownOf('cross-' + S.crossMin)).map(c => `<div class="row" data-flip data-key="${esc(`x:${c.placements[0]?.trackId ?? c.title}`)}">${thumbHTML(c)}<div class="main">
      <div class="ttl">${esc(c.title)} <span class="sub">— ${esc(c.artist ?? '')}</span></div>
      ${c.mixedRecordings ? '<div class="why">Different recordings across these playlists.</div>' : c.mixedReleases ? '<div class="why">Same song, different pressings.</div>' : ''}
      <div class="acts" style="margin-top:8px">${c.placements.map(p =>
        `<button class="chip" data-act="xpl" data-xpl="${esc(p.playlistId)}" data-xtr="${esc(p.trackId)}" title="${esc(p.axis)}">${esc(p.playlist)}</button>`).join('')}</div>
    </div></div>`).join('')
      || (R.across.length
        ? emptyState(`Nothing at ${S.crossMin}+ playlists`, 'Lower the threshold to see tracks filed in fewer places.', { compact: true })
        : emptyState('Nothing cross-filed', 'Every track you have filed sits in one playlist only.'))}</div>
    ${moreButton('cross-' + S.crossMin, a.length)}`;
}

/* The misfile confidence tiers, in calibrate's words (UI-BUILD-PLAN R5): the
 * stored value stays high/medium/low so a remembered filter still works; what
 * the listener reads is the same Sure / Likely / Unsure as everywhere else. */
const MF_BANDS = [['high', 'HIGH', 'sure', 'Sure'], ['medium', 'LIKELY', 'likely', 'Likely'], ['low', 'AMBIGUOUS', 'unsure', 'Unsure']];
const MF_TIER = { high: 'sure', medium: 'likely', low: 'unsure' };
const mfBandWord = b => (MF_BANDS.find(x => x[0] === b) ?? MF_BANDS[0])[3];
/** UI-2's bandChip when it draws one, else the same chip in UI-1's classes. */
function mfBandChip(c, b) {
  const [, vm, cls, word] = MF_BANDS.find(x => x[0] === b) ?? MF_BANDS[0];
  return (typeof c.bandChip === 'function' && c.bandChip(vm)) || `<span class="band band-${cls}">${word}</span>`;
}

function tidySections(c) {
  return c.tidySoundOn() ? [...TIDY_SECTIONS, ['sound', 'By sound']] : TIDY_SECTIONS;
}
function tidySoundTrack(LIB, id) {
  for (const p of LIB?.playlists ?? []) for (const t of p.tracks ?? []) if (t?.id === id)
    return { id, title: t.name ?? '', artist: (t.artists ?? []).map(a => a?.name).filter(Boolean).join(', '), art: t.art ?? null, dur: t.duration_ms ?? 0 };
  return { id, title: id, artist: '', art: null, dur: 0 };
}
const TS_BANDS = [['sure', 'HIGH'], ['likely', 'LIKELY']];
export function secSound(c) {
  const { S, esc, thumbHTML, shownOf, emptyState, moreButton, TSOUND, LIB, tidySoundRows } = c;
  const rows = tidySoundRows();
  const band = S.tsBand ?? 'sure';
  const counts = { sure: 0, likely: 0 };
  for (const x of rows) counts[x.band]++;
  const acc = TSOUND.res?.accuracy;
  const pct = v => `${Math.round(v * 100)}%`;
  const checked = acc?.scored ? `<p class="sub tsacc">Checked on ${acc.scored.toLocaleString()} tracks you filed yourself: put in the wrong playlist on purpose, ${pct(acc.caught)} were caught and sent home${
    acc.sure?.precision != null ? ` (${pct(acc.sure.precision)} of the sure ones right)` : ''}; ${pct(acc.falseAlarm)} of tracks left where you filed them were flagged anyway.</p>` : '';
  const lede = `<p class="lede">Filed in a genre playlist, but <b>the tracks it sounds most like</b> are almost all in another one, and its sound doesn't place it where it is. Only heard tracks, and only playlists with at least five heard tracks, are judged.</p>`;
  if (TSOUND.status === 'working' && !TSOUND.res) return lede + emptyState('Listening through your playlists', 'Comparing every heard track with the ones it sounds like. This takes a few seconds.', { compact: true }) + (c.skeleton ? c.skeleton('rows', 3) : '');
  if (TSOUND.status === 'error' && !TSOUND.res) return lede + emptyState('Couldn’t compare by sound', esc(TSOUND.err ?? ''), { compact: true });
  const m = rows.filter(x => x.band === band);
  return `${lede}${checked}
    ${rows.length ? `<div class="seg mfbands tsbands" role="group" aria-label="How sure">${TS_BANDS.map(([b, vm]) =>
      `<button type="button" aria-pressed="${band === b}" data-act="tsb" data-tsb="${b}">${mfBandChip(c, vm === 'HIGH' ? 'high' : 'medium')} <span class="n">${counts[b].toLocaleString()}</span></button>`).join('')}</div>` : ''}
    <div class="rows">${m.slice(0, shownOf('tsound-' + band)).map(x => {
      const t = tidySoundTrack(c.LIB, x.id), done = S.moved.has(x.id);
      return `<div class="row tsrow ${done ? 'done' : ''}" data-flip data-key="${esc(`ts:${x.id}`)}">${thumbHTML(t)}<div class="main">
        <div class="ttl">${esc(t.title)} <span class="sub">— ${esc(t.artist)}</span></div>
        <div class="tssound">${x.sound ? `Sounds like <b>${esc(x.sound)}</b>` : 'Sounds like'}${x.bpm ? ` <span class="mono">${x.bpm} BPM</span>` : ''}, sits in <b>${esc(x.fromName)}</b></div>
        <div class="swap"><span class="from">${esc(x.fromName)}</span><span class="arw">→</span><span class="to">${esc(x.toName)}</span>
          <span class="mono" style="color:var(--ink-3)">${x.near.from} → ${x.near.to} of ${x.near.k} sound-alikes</span></div>
        <div class="why">${esc(x.why.join('; '))}.</div>
      </div><div class="acts">
        <button class="b sm ${done ? '' : 'go'}" ${done ? 'disabled' : ''} data-mvtier="${esc(x.band)}" data-act="move" data-mvtr="${esc(x.id)}" data-mvfrom="${esc(x.from)}" data-mvto="${esc(x.to)}">${done ? 'Moved' : 'Move'}</button>
        ${done ? '' : `<button class="b sm" data-act="tskeep" data-tsfrom="${esc(x.from)}" data-tskeep="${esc(x.id)}" data-tsto="${esc(x.to)}">Keep here</button>`}
        <button class="b sm" data-dplay="${esc(x.id)}" data-ddur="${t.dur}">Play</button></div></div>`;
    }).join('')
      || (rows.length
        ? emptyState(`Nothing ${band === 'sure' ? 'sure' : 'likely'}`, band === 'sure' ? 'Likely has the more speculative ones.' : 'Try Sure.', { compact: true })
        : emptyState('Everything sounds where it is', 'No heard track sits in a genre playlist its sound-alikes avoid. More show up as listening hears more of your library.'))}</div>
    ${moreButton('tsound-' + band, m.length)}`;
}

export function secMisfile(c) {
  const { S, R, esc, thumbHTML, shownOf, emptyState, moreButton, tagChips, tagEditorHTML, store, getListening } = c;
  const LISTENING_CACHE = c.LISTENING_CACHE, LISTENING_PENDING = c.LISTENING_PENDING;
  const counts = { high: 0, medium: 0, low: 0 };
  for (const x of R.misfiled) counts[x.confidence]++;
  const m = R.misfiled.filter(x => x.confidence === S.mfBand);
  // Best-effort, fetched once and reused: a "misfiled" track you actually
  // play a lot is more likely a deliberate keep than a mistake. Doesn't
  // change the confidence tier — just gives you the context to judge it —
  // and the row renders immediately either way; the note appears once the
  // fetch resolves, without blocking anything on it.
  const recentlyActive = LISTENING_CACHE?.recentlyActive ?? null;
  if (!recentlyActive && !LISTENING_PENDING) getListening().then(() => store.touch('ui.tidy'));
  // Only draw the (stateful, id-bearing) editor once, even if the artist
  // being fixed has several other misfiled tracks in the same list.
  let editorDrawn = false;
  return `<p class="lede">Filed somewhere that fits far worse than another playlist <b>on the same axis</b>. Each row is a move, not a score — and every one of them lands in History.</p>
    ${R.misfiled.length ? `<div class="seg mfbands" role="group" aria-label="How sure">${MF_BANDS.map(([b]) =>
      `<button type="button" aria-pressed="${S.mfBand === b}" data-act="mfb" data-mfb="${b}">${mfBandChip(c, b)} <span class="n">${counts[b].toLocaleString()}</span></button>`).join('')}</div>` : ''}
    <div class="rows">${m.slice(0, shownOf('misfile-' + S.mfBand)).map(x => {
      const to = x.suggest.filter(sg => sg.id)[0];
      const done = S.moved.has(x.id);
      const playedALot = recentlyActive?.has(x.artist);
      return `<div class="row ${done ? 'done' : ''}" data-flip data-key="${esc(`mf:${x.id}:${x.currentPlaylistId}`)}">${thumbHTML(x)}<div class="main">
        <div class="ttl">${esc(x.title)} <span class="sub">— ${esc(x.artist ?? '')}</span></div>
        ${to ? `<div class="swap"><span class="from">${esc(x.current)}</span><span class="arw">→</span><span class="to">${esc(to.name)}</span>
          <span class="mono" style="color:var(--ink-3)">${(x.currentScore * 100).toFixed(0)}% → ${(to.score * 100).toFixed(0)}%</span></div>`
        : `<div class="sub">in <b>${esc(x.current)}</b> <span class="mono">${(x.currentScore * 100).toFixed(0)}% fit</span></div>`}
        ${playedALot ? `<div class="sub" style="color:var(--accent)">You play this a lot right now — might be deliberate.</div>` : ''}
      </div><div class="acts">
        ${to ? `<button class="b sm ${done ? '' : 'go'}" ${done ? 'disabled' : ''} data-act="move" data-mvtr="${esc(x.id)}" data-mvfrom="${esc(x.currentPlaylistId)}" data-mvto="${esc(to.id)}" data-mvtier="${MF_TIER[S.mfBand] ?? ""}">${done ? 'Moved' : 'Move'}</button>` : ''}
        ${x.suggest.filter(sg => sg.id).slice(1, 2).map(sg =>
          `<button class="b sm" data-act="move" data-mvtr="${esc(x.id)}" data-mvfrom="${esc(x.currentPlaylistId)}" data-mvto="${esc(sg.id)}" data-mvtier="${MF_TIER[S.mfBand] ?? ""}">→ ${esc(sg.name)}</button>`).join('')}
        ${done ? '' : `<button class="b sm" data-act="mfkeep" data-mfkeep="${esc(x.id)}" data-mffrom="${esc(x.currentPlaylistId)}" data-mfaway="${esc(x.suggest.filter(sg => sg.id).slice(0, 2).map(sg => sg.id).join(','))}">Keep here</button>`}
        <button class="b sm" data-dplay="${esc(x.id)}" data-ddur="${x.dur ?? 0}">Play</button></div>
      ${x.tags?.length ? `<div style="flex-basis:100%; margin-top:6px">
        ${tagChips(x.tags, x.thinData)}
        <div class="rowbtns" style="margin-top:6px">${(x.artists ?? []).map(a =>
          `<button class="b sm" data-editartist="${esc(a.id)}">${S.editingArtist === a.id ? 'Close' : 'Wrong tags?'} ${esc(a.name)}</button>`).join('')}</div>
        ${!editorDrawn && S.editingArtist && x.artists?.some(a => a.id === S.editingArtist)
          ? (editorDrawn = true, tagEditorHTML(S.editingArtist, x.artists.find(a => a.id === S.editingArtist).name)) : ''}
      </div>` : ''}</div>`;
    }).join('')
      || (R.misfiled.length
        ? emptyState(`Nothing ${mfBandWord(S.mfBand)}`, S.mfBand === 'high'
            ? 'Nothing is clearly in the wrong place. Likely has the more speculative ones.' : 'Try another of the three.', { compact: true })
        : emptyState('Everything fits where it is', 'No track sits in a playlist that fits far worse than another one on the same axis. New ones show up here after a sync.'))}</div>
    ${moreButton('misfile-' + S.mfBand, m.length)}`;
}

export function view(c) {
  const { S, R, esc } = c;
  c.tidySoundWarm();
  const n = { misfile: R.misfiled.length, dupes: R.within.length, cross: R.across.length, sound: c.tidySoundCount() };
  const secs = tidySections(c);
  // Opens on the first section with something in it rather than on "Wrong
  // place 0" while Repeats has work. A section the listener picked (S.tidySec,
  // set only by a tap) is kept; one that has gone away falls back the same way.
  const first = (secs.find(([id]) => n[id] > 0) ?? secs[0])[0];
  if (S.tidySec != null && !secs.some(([id]) => id === S.tidySec)) S.tidySec = first;
  const sec = S.tidySec ?? first;
  const body = { misfile: secMisfile, dupes: secDupes, cross: secCross, sound: secSound }[sec];
  return `<h1>Tidy</h1>
    <div class="seg tidysecs" role="group" aria-label="Section">${secs.map(([id, label]) =>
      `<button type="button" aria-pressed="${sec === id}" data-act="section" data-tidy="${id}">${label} <span class="n">${n[id].toLocaleString()}</span></button>`).join('')}</div>
    ${body(c)}`;
}


export const actions = {
  section(c, el) { c.S.tidySec = el.dataset.tidy; c.render(); },

  cmin(c, el) {
    const { S, T } = c;
    S.crossMin = +el.dataset.cmin;
    if (T.rememberFilters) { T.crossMin = S.crossMin; c.saveTheme(); }
    c.render();
  },

  tsb(c, el) { c.S.tsBand = el.dataset.tsb; c.render(); },

  async tskeep(c, el) {
    await c.recordKeep(el.dataset.tskeep, el.dataset.tsfrom, [el.dataset.tsto]);
    c.toast('Kept where it is. It won’t be offered there again.');
    c.render();
  },

  // Wrong place's Keep here: the same record as By sound's, and the row leaves both tiers.
  async mfkeep(c, el) {
    const id = el.dataset.mfkeep, from = el.dataset.mffrom;
    await c.recordKeep(id, from, el.dataset.mfaway.split(',').filter(Boolean));
    c.R.misfiled = c.R.misfiled.filter(m => !(m.id === id && m.currentPlaylistId === from));
    c.toast('Kept where it is. It won’t be offered as wrong there again.');
    c.render();
  },

  mfb(c, el) {
    const { S, T } = c;
    S.mfBand = el.dataset.mfb;
    if (T.rememberFilters) { T.mfBand = S.mfBand; c.saveTheme(); }
    c.render();
  },

  /** Keep one copy of a within-playlist duplicate, drop the others. */
  async keep(c, el) {
    const { R, CFG } = c;
    const drop = el.dataset.drop.split(',').filter(Boolean), pl = el.dataset.pl;
    const plName = CFG[pl]?.name ?? pl;
    try {
      const before = await c.playlistIds(pl);
      const positions = {};
      before.forEach((id, i) => { if (drop.includes(id)) (positions[id] ??= []).push(i); });
      await c.delTracks(pl, drop);
      await c.logAction({ op:'remove', playlistId:pl, playlistName:plName, trackIds:drop, positions, reason:'duplicate' });
      const at = (await c.getLog())[0]?.at;
      c.toast(`Removed ${drop.length} from ${plName}.`, () => c.undoAction(at));
      R.within = R.within.filter(x => !(x.playlistId === pl && x.options.some(o => drop.includes(o.id)))); c.render();
    } catch (err) { c.toast('Failed: ' + err.message); }
  },

  /** Cross-filed: take the track out of just this playlist. */
  async xpl(c, el) {
    const pl = el.dataset.xpl, tr = el.dataset.xtr, plName = c.CFG[pl]?.name ?? pl;
    try {
      const before = await c.playlistIds(pl);
      const positions = {}; before.forEach((id, i) => { if (id === tr) (positions[id] ??= []).push(i); });
      await c.delTracks(pl, [tr]);
      await c.logAction({ op:'remove', playlistId:pl, playlistName:plName, trackIds:[tr], positions, reason:'cross-file trim' });
      const at = (await c.getLog())[0]?.at;
      el.classList.add('cut');
      c.toast(`Removed from ${plName}.`, () => c.undoAction(at));
    } catch (err) { c.toast('Failed: ' + err.message); }
  },

  async move(c, el) {
    el.disabled = true;
    const { mvto:to, mvfrom:from, mvtr:tr, mvtier:tier } = el.dataset;
    const { CFG } = c;
    const toName = CFG[to]?.name ?? to, fromName = CFG[from]?.name ?? from;
    try {
      // Add first: if the removal then fails the track is still filed somewhere
      // rather than lost between playlists. Both steps share a group, so one
      // Undo (toast or History) reverses the pair: back where it was, at its
      // position, and out of the playlist it was moved to.
      const group = c.newGroup();
      await c.addTracks(to, [tr]);
      const at = await c.logAction({ op:'add', playlistId:to, playlistName:toName, trackIds:[tr], reason:`moved from ${fromName}`, group });
      const before = await c.playlistIds(from);
      const positions = {}; before.forEach((id, i) => { if (id === tr) (positions[id] ??= []).push(i); });
      await c.delTracks(from, [tr]);
      await c.logAction({ op:'remove', playlistId:from, playlistName:fromName, trackIds:[tr], positions, reason:`moved to ${toName}`, group,
                          move:{ trackId:tr, from, to, fromName, toName, ...(tier ? { tier } : {}) } });
      c.toast(`Moved to ${toName}.`, () => c.undoAction(at));
      // What the sound learner reads as a move: yes to `to`, no to `from`.
      await c.recordMove(tr, from, to).catch(() => {});
      c.S.moved.add(tr);
      el.closest('.row').classList.add('done');
      el.classList.remove('go'); el.textContent = 'Moved';
    } catch (err) { c.toast('Failed: ' + err.message); el.disabled = false; }
  },
};
