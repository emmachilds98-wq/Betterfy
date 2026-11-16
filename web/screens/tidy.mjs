// @bundle screens tidy 40
/* The Tidy screen (docs/BUILD-5-PLAN.md A4): an ES module. It touches nothing outside `ctx`
 * (web/README.md, "Screen modules"); SCREEN_CTX.tidy in app/screens.js builds it. The sound
 * misfit state and jobs, and emptyState, stay classic in app/screenjobs.js. */
/* The library health report and the keyboard cleanup sprint (BUILD-6 F9) are at the end of
 * this file; their pure parts (ranking, the sprint's counts) are core/review/health.mjs. */
import { tidyCounts, healthInputs, rankHealth, sprintStart, sprintDecide, sprintUndo, sprintStats, sprintSave, sprintTotals } from '../../core/review/health.mjs';

/* ---------- Tidy: three screens' worth of the same question ----------
 *
 * Duplicates, Misfiles and Cross-filed were three destinations all asking "is
 * this in the right place?", and nobody visited the last two. They are one
 * screen now, with a section each and the counts on the switcher, so the
 * question is asked once and the answer is a row you tap.
 */
const TIDY_SECTIONS = [['misfile', 'Wrong place'], ['dupes', 'Repeats'], ['cross', 'Cross-filed']];

export function secDupes(c) {
  const ib = c.infoBtn ?? (() => '');
  const { R, esc, thumbHTML, cmpTable, shownOf, emptyState, moreButton } = c;
  const within = onlyPl(c, R.within, x => x.playlistId);
  const exact = within.filter(x => x.verdict === 'same-recording');
  const clash = within.filter(x => x.verdict !== 'same-recording');
  const sec = (title, list, note, key) => `<h2>${esc(title)} <span class="mono" style="color:var(--ink-3);font-size:14px">${list.length}</span></h2>
    <p class="lede">${note}</p>
    <div class="rows">${list.slice(0, shownOf(key)).map(c => `<div class="row" data-flip data-key="${esc(`dup:${c.playlistId}:${c.options.map(o => o.id).join(',')}`)}">${thumbHTML(c)}<div class="main">
      <div class="ttl">${esc(c.title)} <span class="sub">— ${esc(c.artist ?? '')}</span></div>
      <div class="sub mono">${esc(c.playlist)}</div><div class="why">${esc(c.why)}</div>${cmpTable(c.options)}
    </div><div class="acts">${c.options.map(o =>
      `<button class="b sm" data-act="keep" data-keep="${esc(o.id)}" data-pl="${esc(c.playlistId)}" data-drop="${esc(c.options.filter(z => z.id !== o.id).map(z => z.id).join(','))}">Keep ${esc(o.dur)}</button>`).join('')}
    </div></div>`).join('') || emptyState('None found', 'Nothing in your library matches this.', { compact: true })}</div>
    ${moreButton(key, list.length)}`;
  const lede = `<p class="lede">Same track twice in one playlist.${ib('tidy-dupes', 'Repeats', '<p>Only duplicates <b>inside a single playlist</b> are offered for removal. A track in several playlists is treated as deliberate — that is the Cross-filed section.</p>')}</p>${plChip(c)}`;
  // Both lists empty is one answer, not two grey boxes under two headings.
  if (!exact.length && !clash.length) return `${lede}
    ${emptyState('No repeats', 'None of your playlists has the same track in it twice, as the same recording or as a different cut.')}`;
  return `${lede}
    ${sec('The same recording, twice', exact, 'Both copies share an ISRC: the same master on two releases. Removing one loses nothing.', 'dupes-exact')}
    ${sec('Version clashes', clash, 'Genuinely different cuts in one playlist. Differing values are marked.', 'dupes-clash')}`;
}

/** Why a cross-filed row is ranked where it is: the reading behind its suspicion. */
function crossNote(x) {
  return x.suspicion === 3 ? '<div class="why">Two genre playlists: usually one is a slip.</div>'
    : x.suspicion === 2 ? '<div class="why">Two playlists of the same kind.</div>' : '';
}

export function secCross(c) {
  const ib = c.infoBtn ?? (() => '');
  const { S, R, esc, thumbHTML, shownOf, emptyState, moreButton } = c;
  const a = R.across.filter(x => x.placements.length >= S.crossMin);
  return `<p class="lede">Tracks in several playlists. Usually deliberate, so nothing is removed unless you tap. The likeliest slips come first, with the best-fitting playlist starred.${ib('tidy-cross', 'Cross-filed', '<p>Tap a playlist to remove the track from just that one. Nothing is removed unless you tap it.</p>')}</p>
    <div class="rowbtns" style="margin-bottom:14px">${[2, 3, 4, 5, 6].map(n =>
      `<button class="b sm ${S.crossMin === n ? 'p' : ''}" data-act="cmin" data-cmin="${n}">${n}+ playlists</button>`).join('')}</div>
    <div class="rows">${a.slice(0, shownOf('cross-' + S.crossMin)).map(c => `<div class="row" data-flip data-key="${esc(`x:${c.placements[0]?.trackId ?? c.title}`)}">${thumbHTML(c)}<div class="main">
      <div class="ttl">${esc(c.title)} <span class="sub">— ${esc(c.artist ?? '')}</span></div>
      ${c.mixedRecordings ? '<div class="why">Different recordings across these playlists.</div>' : c.mixedReleases ? '<div class="why">Same song, different pressings.</div>' : ''}
      ${crossNote(c)}
      <div class="acts" style="margin-top:8px">${c.placements.map(p =>
        `<button class="chip${p.playlistId === c.keeper ? ' keeper' : ''}" data-act="xpl" data-xpl="${esc(p.playlistId)}" data-xtr="${esc(p.trackId)}" title="${esc(p.axis)}${p.playlistId === c.keeper ? ' — the best fit' : ''}">${p.playlistId === c.keeper ? '★ ' : ''}${esc(p.playlist)}</button>`).join('')}
        ${c.keeper && c.suspicion >= 2 ? `<button class="b sm" data-act="xkeep" data-xkeeper="${esc(c.keeper)}" data-xtr="${esc(c.placements[0].trackId)}" data-xall="${esc(c.placements.map(p => p.playlistId).join(','))}">Keep only in ${esc(c.placements.find(p => p.playlistId === c.keeper)?.playlist ?? '')}</button>` : ''}</div>
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

/** The tag tier's rows, minus any the sound tier judged differently: where the two
 *  disagree about a track in a playlist, sound wins and the tag row is dropped. */
export function tagMisfiles(c) {
  const sound = (typeof c.tidySoundRows === 'function' ? c.tidySoundRows() : null) ?? [];
  if (!sound.length) return c.R.misfiled;
  const heard = new Map(sound.map(x => [`${x.id}|${x.from}`, x.to]));
  return c.R.misfiled.filter(m => {
    const to = heard.get(`${m.id}|${m.currentPlaylistId}`);
    return to == null || to === m.suggest.find(sg => sg.id)?.id;
  });
}

/** A cosine fit in words, not a percentage nobody can calibrate. */
const mfFitWord = v => v >= 0.5 ? 'strong' : v >= 0.25 ? 'fair' : v >= 0.1 ? 'weak' : 'barely';

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
  const ib = c.infoBtn ?? (() => '');
  const { S, esc, thumbHTML, shownOf, emptyState, moreButton, TSOUND, LIB, tidySoundRows } = c;
  const rows = onlyPl(c, tidySoundRows(), x => x.from);
  const band = S.tsBand ?? 'sure';
  const counts = { sure: 0, likely: 0 };
  for (const x of rows) counts[x.band]++;
  const acc = TSOUND.res?.accuracy;
  const pct = v => `${Math.round(v * 100)}%`;
  const checked = acc?.scored ? `<p class="sub tsacc">Checked on ${acc.scored.toLocaleString()} tracks you filed yourself: put in the wrong playlist on purpose, ${pct(acc.caught)} were caught and sent home${
    acc.sure?.precision != null ? ` (${pct(acc.sure.precision)} of the sure ones right)` : ''}; ${pct(acc.falseAlarm)} of tracks left where you filed them were flagged anyway.</p>` : '';
  const lede = `<p class="lede">Filed in one playlist, but it sounds like another.${ib('tidy-sound', 'Sounds wrong', '<p>Filed in a genre playlist, but <b>the tracks it sounds most like</b> are almost all in another one, and its sound doesn\'t place it where it is. Only heard tracks, and only playlists with at least five heard tracks, are judged.</p>')}</p>${plChip(c)}`;
  if (TSOUND.status === 'working' && !TSOUND.res) return lede + emptyState('Listening through your playlists', 'Comparing every heard track with the ones it sounds like. This takes a few seconds.', { compact: true }) + (c.skeleton ? c.skeleton('rows', 3) : '');
  if (TSOUND.status === 'error' && !TSOUND.res) return lede + emptyState('Couldn’t compare by sound', esc(TSOUND.err ?? ''), { compact: true });
  if (S.sprint?.sec === 'sound') return lede + sprintPanel(c, 'sound');
  const m = rows.filter(x => x.band === band);
  return `${lede}${checked}
    ${rows.length ? `<div class="seg mfbands tsbands" role="group" aria-label="How sure">${TS_BANDS.map(([b, vm]) =>
      `<button type="button" aria-pressed="${band === b}" data-act="tsb" data-tsb="${b}">${mfBandChip(c, vm === 'HIGH' ? 'high' : 'medium')} <span class="n">${counts[b].toLocaleString()}</span></button>`).join('')}</div>` : ''}
    ${sprintBar(c, 'sound', sprintRows(c, 'sound').length)}
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
  const ib = c.infoBtn ?? (() => '');
  const { S, R, esc, thumbHTML, shownOf, emptyState, moreButton, tagChips, tagEditorHTML, store, getListening } = c;
  const LISTENING_CACHE = c.LISTENING_CACHE, LISTENING_PENDING = c.LISTENING_PENDING;
  const counts = { high: 0, medium: 0, low: 0 };
  const MF = onlyPl(c, tagMisfiles(c), x => x.currentPlaylistId);
  for (const x of MF) counts[x.confidence]++;
  const m = MF.filter(x => x.confidence === S.mfBand);
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
  const lede = `<p class="lede">Filed somewhere that fits worse than another playlist.${ib('tidy-misfile', 'Wrong place', '<p>Only playlists <b>on the same axis</b> are compared. Each row is a move, not a score, and every move lands in History.</p>')}</p>${plChip(c)}`;
  if (S.sprint?.sec === 'misfile') return lede + sprintPanel(c, 'misfile');
  return `${lede}
    ${MF.length ? `<div class="seg mfbands" role="group" aria-label="How sure">${MF_BANDS.map(([b]) =>
      `<button type="button" aria-pressed="${S.mfBand === b}" data-act="mfb" data-mfb="${b}">${mfBandChip(c, b)} <span class="n">${counts[b].toLocaleString()}</span></button>`).join('')}</div>` : ''}
    ${sprintBar(c, 'misfile', sprintRows(c, 'misfile').length)}
    <div class="rows">${m.slice(0, shownOf('misfile-' + S.mfBand)).map(x => {
      const to = x.suggest.filter(sg => sg.id)[0];
      const done = S.moved.has(x.id);
      const playedALot = recentlyActive?.has(x.artist);
      return `<div class="row ${done ? 'done' : ''}" data-flip data-key="${esc(`mf:${x.id}:${x.currentPlaylistId}`)}">${thumbHTML(x)}<div class="main">
        <div class="ttl">${esc(x.title)} <span class="sub">— ${esc(x.artist ?? '')}</span></div>
        ${to ? `<div class="swap"><span class="from">${esc(x.current)}</span><span class="arw">→</span><span class="to">${esc(to.name)}</span>
          <span class="mono" style="color:var(--ink-3)">${esc(mfFitWord(x.currentScore))} → ${esc(mfFitWord(to.score))} fit</span></div>`
        : `<div class="sub">in <b>${esc(x.current)}</b> <span class="mono">${esc(mfFitWord(x.currentScore))} fit</span></div>`}
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
      || (MF.length
        ? emptyState(`Nothing ${mfBandWord(S.mfBand)}`, S.mfBand === 'high'
            ? 'Nothing is clearly in the wrong place. Likely has the more speculative ones.' : 'Try another of the three.', { compact: true })
        : emptyState('Everything fits where it is', 'No track sits in a playlist that fits far worse than another one on the same axis. New ones show up here after a sync.'))}</div>
    ${moreButton('misfile-' + S.mfBand, m.length)}`;
}

export function view(c) {
  const { S, R, esc } = c;
  c.tidySoundWarm();
  const report = healthReport(c);
  const n = { misfile: tagMisfiles(c).length, dupes: R.within.length, cross: R.across.length, sound: c.tidySoundCount(), health: report.length };
  const secs = report.length ? [...tidySections(c), ['health', 'Health']] : tidySections(c);
  // Opens on the first section with something in it rather than on "Wrong
  // place 0" while Repeats has work. A section the listener picked (S.tidySec,
  // set only by a tap) is kept; one that has gone away falls back the same way.
  // Health is a report, not a list of work: it is never opened for you.
  const first = (secs.find(([id]) => n[id] > 0 && id !== 'health') ?? secs[0])[0];
  if (S.tidySec != null && !secs.some(([id]) => id === S.tidySec)) S.tidySec = first;
  const sec = S.tidySec ?? first;
  const body = { misfile: secMisfile, dupes: secDupes, cross: secCross, sound: secSound, health: secHealth }[sec];
  return `<h1>Tidy</h1>
    <div class="seg tidysecs" role="group" aria-label="Section">${secs.map(([id, label]) =>
      `<button type="button" aria-pressed="${sec === id}" data-act="section" data-tidy="${id}">${label} <span class="n">${n[id].toLocaleString()}</span></button>`).join('')}</div>
    ${body(c)}`;
}


export const actions = {
  section(c, el) {
    if (c.S.sprint) endSprint(c);
    c.S.tidySec = el.dataset.tidy; c.S.tidyPl = null; c.render();
  },

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

  /** Cross-filed: keep the track in the suggested playlist only, out of every other. */
  async xkeep(c, el) {
    const keeper = el.dataset.xkeeper, tr = el.dataset.xtr;
    const drops = el.dataset.xall.split(',').filter(id => id && id !== keeper);
    try {
      const group = c.newGroup();
      for (const pl of drops) {
        const before = await c.playlistIds(pl);
        const positions = {}; before.forEach((id, i) => { if (id === tr) (positions[id] ??= []).push(i); });
        await c.delTracks(pl, [tr]);
        await c.logAction({ op:'remove', playlistId:pl, playlistName:c.CFG[pl]?.name ?? pl, trackIds:[tr], positions, reason:'cross-file trim', group });
      }
      const at = (await c.getLog())[0]?.at;
      c.toast(`Kept only in ${c.CFG[keeper]?.name ?? keeper}.`, () => c.undoAction(at));
      c.R.across = c.R.across.filter(x => !x.placements.some(p => p.trackId === tr));
      c.render();
    } catch (err) { c.toast('Failed: ' + err.message); }
  },

  async move(c, el) {
    el.disabled = true;
    const { mvto:to, mvfrom:from, mvtr:tr, mvtier:tier } = el.dataset;
    const toName = c.CFG[to]?.name ?? to;
    try {
      const at = await writeMove(c, { tr, from, to, tier });
      c.toast(`Moved to ${toName}.`, () => c.undoAction(at));
      c.S.moved.add(tr);
      el.closest('.row').classList.add('done');
      el.classList.remove('go'); el.textContent = 'Moved';
    } catch (err) { c.toast('Failed: ' + err.message); el.disabled = false; }
  },
  /* ---- the library health report (BUILD-6 F9) ---- */

  /** Open Tidy at one playlist: its first section with rows, on the first band that has some. */
  hgo(c, el) {
    const { S } = c, pl = el.dataset.hpl, sec = el.dataset.hsec;
    if (S.sprint) endSprint(c);
    S.tidyPl = pl; S.tidySec = sec;
    if (sec === 'misfile') {
      const mine = tagMisfiles(c).filter(x => x.currentPlaylistId === pl);
      S.mfBand = ['high', 'medium', 'low'].find(b => mine.some(x => x.confidence === b)) ?? S.mfBand;
    }
    if (sec === 'sound') {
      const mine = c.tidySoundRows().filter(x => x.from === pl);
      S.tsBand = ['sure', 'likely'].find(b => mine.some(x => x.band === b)) ?? S.tsBand;
    }
    S.tidyFocus = 'rows';
    c.render();
  },
  /** Nothing Tidy can act on: the playlist's own sheet in Library says the rest. */
  hopen(c, el) { c.go?.('lists'); c.openPlSheet?.(el.dataset.hpl); },
  hclear(c) { if (c.S.sprint) endSprint(c); c.S.tidyPl = null; c.S.tidyFocus = 'rows'; c.render(); },

  /* ---- the keyboard sprint (BUILD-6 F9, D7) ---- */

  spstart(c, el) {
    const sec = el.dataset.spsec, n = sprintRows(c, sec).length;
    if (!n) return;
    c.S.sprint = { sec, s: sprintStart(Date.now(), { sec, pl: c.S.tidyPl ?? null }) };
    c.S.tidyFocus = 'sprint';
    announce(c, `Sprint: ${n} to decide. Right arrow moves, left arrow keeps, U undoes, Escape stops.`);
    c.render();
  },

  /** → : move the current track to the suggested playlist. The screen moves on at once; the
   *  Spotify writes run one after another behind it, and a failed one puts the track back. */
  spmove(c) {
    const sp = c.S.sprint; if (!sp) return;
    const rows = sprintRows(c, sp.sec), x = rows[0]; if (!x) return;
    c.S.moved.add(x.id);
    const d = { id: x.id, at: null, failed: false };
    d.p = CHAIN = CHAIN.then(() => writeMove(c, { tr: x.id, from: x.from, to: x.to, tier: x.tier }))
      .then(at => { d.at = at; }, err => {
        d.failed = true; c.S.moved.delete(x.id);
        const i = sp.s.stack.findIndex(y => y.d === d);
        if (i >= 0) { sp.s.stack.splice(i, 1); sp.s.moves--; }
        c.toast('Failed: ' + (err?.message ?? err)); c.render();
      });
    sprintDecide(sp.s, 'move', { d }, Date.now());
    c.S.tidyFocus = 'sprint';
    announce(c, `Moved ${x.title} to ${x.toName}. ${left(rows.length - 1)}`);
    c.render();
  },

  /** ← : keep it where it is, the same record as the rows' Keep here. */
  spkeep(c) {
    const sp = c.S.sprint; if (!sp) return;
    const rows = sprintRows(c, sp.sec), x = rows[0]; if (!x) return;
    const f = c.FB?.[x.id];
    const u = { id: x.id, from: x.from, newKept: !(f?.kept ?? []).includes(x.from),
      newRej: x.away.filter(p => !(f?.rejected ?? []).includes(p)), row: x.row ?? null, idx: -1 };
    // recordKeep changes FB before its first await, so the row has left the list by the next key.
    Promise.resolve(c.recordKeep(x.id, x.from, x.away)).catch(err => c.toast('Failed: ' + (err?.message ?? err)));
    if (x.row) {
      u.idx = c.R.misfiled.indexOf(x.row);
      c.R.misfiled = c.R.misfiled.filter(m => m !== x.row);
    }
    sprintDecide(sp.s, 'keep', u, Date.now());
    c.S.tidyFocus = 'sprint';
    announce(c, `Kept ${x.title} in ${x.fromName}. ${left(rows.length - 1)}`);
    c.render();
  },

  /** U : take the newest sprint decision back. */
  spundo(c) {
    const sp = c.S.sprint; if (!sp) return;
    const d = sprintUndo(sp.s, Date.now()); if (!d) return;
    c.S.tidyFocus = 'sprint';
    if (d.kind === 'move') {
      const m = d.d;
      c.S.moved.delete(m.id);
      CHAIN = CHAIN.then(() => m.p).then(() => (m.failed || !m.at ? null : c.undoAction(m.at)))
        .catch(err => c.toast('Undo failed: ' + (err?.message ?? err)));
      announce(c, `Move undone. ${trackName(c, m.id)} is back.`);
    } else {
      unkeep(c, d);
      announce(c, `Keep undone. ${trackName(c, d.id)} is back.`);
    }
    c.render();
  },

  /** Esc : stop, and keep this sprint's counts on this device. */
  spend(c) { endSprint(c, true); c.render(); },
};

/* ---------- the library health report (BUILD-6 F9) ----------
 * Library's own health score (lists.mjs's playlistHealth, read through ctx.libHealth) for every
 * playlist, the worst five listed with why, and one tap into Tidy at that playlist. */

const HCACHE = new WeakMap();
export function healthReport(c) {
  const H = c.libHealth;
  if (typeof H?.playlistHealth !== 'function' || !c.CFG || !c.LIB?.playlists || !c.R) return [];
  const sound = (typeof c.tidySoundRows === 'function' ? c.tidySoundRows() : null) ?? [];
  const splits = c.healthSplits?.() ?? [];
  const key = [c.R.misfiled?.length, c.R.within?.length, sound.length, Object.keys(c.CFG).length, c.LIB.playlists.length, splits.length].join('|');
  const hit = HCACHE.get(c.R);
  if (hit?.key === key) return hit.out;
  const byId = new Map(c.LIB.playlists.map(p => [p.id, p]));
  const twins = typeof H.twinsOf === 'function' ? H.twinsOf(c.twinPairs?.()) : new Map();
  const splitIds = new Set(splits);
  const undecidedIds = new Set(Object.entries(c.CFG).filter(([, v]) => c.NO_SIGNAL != null && v?.why === c.NO_SIGNAL).map(([id]) => id));
  const counts = tidyCounts({ misfiled: tagMisfiles(c), soundRows: sound, within: c.R.within });
  const rows = Object.entries(c.CFG).filter(([id, v]) => !c.isMirrorPlaylist?.({ id, name: v?.name ?? byId.get(id)?.name })).map(([id, v]) => {
    const list = byId.get(id)?.tracks ?? [];
    const tracks = v?.tracks ?? list.length;
    const health = H.playlistHealth(healthInputs({ id, tracks, list, misfiled: c.R.misfiled, drift: c.R.drift, splitIds, undecidedIds, twins }, H));
    return { id, name: v?.name ?? byId.get(id)?.name ?? id, tracks, health, tidy: counts.get(id) };
  });
  const out = rankHealth(rows);
  HCACHE.set(c.R, { key, out });
  return out;
}

export function secHealth(c) {
  const { esc, emptyState } = c;
  const ib = c.infoBtn ?? (() => '');
  const rep = healthReport(c);
  return `<p class="lede">The playlists in the worst shape, by the health score Library shows for each.${ib('tidy-health', 'Health', '<p>The same score as a playlist’s sheet in Library: tracks that look misfiled, newest additions that read differently, two genres in one, a twin it can’t be told from, repeats, nothing added for a year, no axis decided. Only playlists under 85 are listed, worst first.</p>')}</p>
    ${rep.length ? `<ol class="hrep">${rep.map(h => `<li class="hrow">
      <div class="hmain"><div class="ttl">${esc(h.name)}</div>
        <p class="plhealth plh-${h.score >= 65 ? 'fine' : 'low'}"><b class="mono">${h.score}</b> ${esc(h.word)}</p>
        ${h.why.length ? `<ul class="plnotes">${h.why.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</div>
      ${h.section
        ? `<button type="button" class="b sm go" data-act="hgo" data-hpl="${esc(h.id)}" data-hsec="${h.section}" aria-label="${esc(`Tidy ${h.fixable} in ${h.name}`)}">Tidy ${h.fixable.toLocaleString()}</button>`
        : `<button type="button" class="b sm" data-act="hopen" data-hpl="${esc(h.id)}" aria-label="${esc(`Open in Library: ${h.name}`)}">Open in Library</button>`}</li>`).join('')}</ol>`
      : emptyState('Every playlist is healthy', 'None scores under 85.', { compact: true })}`;
}

/** Rows of one playlist only, when the report opened Tidy at it. */
function onlyPl(c, list, key) {
  const pl = c.S.tidyPl;
  return pl ? (list ?? []).filter(x => key(x) === pl) : list;
}
function plChip(c) {
  const pl = c.S.tidyPl;
  if (!pl) return '';
  const name = c.CFG?.[pl]?.name ?? c.LIB?.playlists?.find(p => p.id === pl)?.name ?? pl;
  return `<p class="tidypl">Only <b>${c.esc(name)}</b> <button type="button" class="b sm" data-act="hclear">Show every playlist</button></p>`;
}

/* ---------- the keyboard sprint (BUILD-6 F9, D7) ----------
 * One track at a time from Wrong place or By sound (the band showing, and the playlist the
 * report opened, if any): → moves it to the suggested playlist, ← keeps it where it is, U
 * undoes the newest decision, Esc stops. The buttons do the same for a pointer. Every
 * decision is said in a live region, and focus stays on the track being decided. Decisions a
 * minute and the share of moves kept are counted on this device only (SPRINT_KEY). */

const SPRINT_KEY = 'bf_tidy_sprint';
let CHAIN = Promise.resolve();
const left = n => (n ? `${n} left.` : 'That was the last one.');

/** What the sprint walks, in the list's own order, decided ones gone. */
export function sprintRows(c, sec) {
  const { S } = c;
  if (sec === 'misfile') return onlyPl(c, tagMisfiles(c), x => x.currentPlaylistId)
    .filter(x => x.confidence === S.mfBand && !S.moved.has(x.id))
    .map(x => {
      const to = (x.suggest ?? []).find(sg => sg.id);
      return to ? { id: x.id, title: x.title ?? '', artist: x.artist ?? '', art: x.art ?? null, from: x.currentPlaylistId, fromName: x.current ?? '',
        to: to.id, toName: to.name ?? to.id, tier: MF_TIER[S.mfBand] ?? '', away: x.suggest.filter(sg => sg.id).slice(0, 2).map(sg => sg.id),
        why: `${mfFitWord(x.currentScore)} fit here, ${mfFitWord(to.score)} there`, row: x } : null;
    }).filter(Boolean);
  if (sec === 'sound' && typeof c.tidySoundRows === 'function') return onlyPl(c, c.tidySoundRows(), x => x.from)
    .filter(x => x.band === (S.tsBand ?? 'sure') && !S.moved.has(x.id))
    .map(x => {
      const t = tidySoundTrack(c.LIB, x.id);
      return { id: x.id, title: t.title, artist: t.artist, art: t.art, from: x.from, fromName: x.fromName, to: x.to, toName: x.toName,
        tier: x.band, away: [x.to], why: (x.why ?? []).join('; ') };
    });
  return [];
}

function readSprints(c) {
  try { const v = JSON.parse(c.LS?.getItem(SPRINT_KEY) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

function sprintBar(c, sec, n) {
  if (!n) return '';
  const tot = sprintTotals(readSprints(c));
  const past = tot.perMin != null ? ` <span class="sub">Your sprints so far: ${tot.perMin} decisions a minute${tot.kept != null ? `, ${Math.round(tot.kept * 100)}% of moves kept` : ''}.</span>` : '';
  return `<div class="sprintbar"><button type="button" class="b sm" id="sprintGo" data-act="spstart" data-spsec="${sec}" aria-describedby="sprintHint">Sprint through ${n.toLocaleString()}</button>
    <span class="hint" id="sprintHint">One at a time by keyboard: <kbd>→</kbd> move, <kbd>←</kbd> keep, <kbd>U</kbd> undo, <kbd>Esc</kbd> stop.</span>${past}</div>`;
}

function sprintTally(st) {
  return `${st.decisions} decided${st.perMin != null ? ` · ${st.perMin} a minute` : ''}${st.kept != null ? ` · ${Math.round(st.kept * 100)}% of moves kept` : ''}`;
}

function sprintPanel(c, sec) {
  const { S, esc } = c, sp = S.sprint;
  const rows = sprintRows(c, sec), x = rows[0];
  const tally = sprintTally(sprintStats(sp.s));
  const undo = `<button type="button" class="b sm" data-act="spundo" aria-keyshortcuts="U"${sp.s.stack.length ? '' : ' disabled'}>Undo <kbd>U</kbd></button>`;
  const stop = `<button type="button" class="b sm" data-act="spend" aria-keyshortcuts="Escape">${x ? 'Stop' : 'Done'} <kbd>Esc</kbd></button>`;
  if (!x) return `<section class="sprint" id="sprint" aria-labelledby="sprintH"><h2 id="sprintH">Sprint done</h2>
      <div class="sprintcard sprintdone" id="sprintCard" tabindex="-1"><p>Nothing left in this list. ${esc(tally)}.</p></div>
      <div class="sprintacts">${undo}${stop}</div></section>`;
  return `<section class="sprint" id="sprint" aria-labelledby="sprintH">
    <h2 id="sprintH">Sprint <span class="mono">${rows.length.toLocaleString()} left</span></h2>
    <div class="sprintcard" id="sprintCard" tabindex="-1" role="group" aria-roledescription="track" data-sptr="${esc(x.id)}"
      aria-label="${esc(`${x.title}${x.artist ? ` by ${x.artist}` : ''}: in ${x.fromName}, suggested ${x.toName}`)}" aria-describedby="sprintKeys">
      ${c.thumbHTML(x)}<div class="main"><div class="ttl">${esc(x.title)} <span class="sub">— ${esc(x.artist)}</span></div>
      <div class="swap"><span class="from">${esc(x.fromName)}</span><span class="arw">→</span><span class="to">${esc(x.toName)}</span></div>
      ${x.why ? `<div class="why">${esc(x.why)}</div>` : ''}</div></div>
    <div class="sprintacts">
      <button type="button" class="b" data-act="spkeep" aria-keyshortcuts="ArrowLeft"><kbd>←</kbd> Keep in ${esc(x.fromName)}</button>
      <button type="button" class="b go" data-act="spmove" aria-keyshortcuts="ArrowRight">Move to ${esc(x.toName)} <kbd>→</kbd></button>
      ${undo}${stop}</div>
    <p class="hint" id="sprintKeys">Right arrow moves it, left arrow keeps it where it is, U undoes the last one, Escape stops.</p>
    <p class="sprintstat mono">${esc(tally)}</p></section>`;
}

/** Add, then remove: the same order and the same History entries as the rows' Move button. */
async function writeMove(c, { tr, from, to, tier }) {
  const { CFG } = c;
  const toName = CFG[to]?.name ?? to, fromName = CFG[from]?.name ?? from;
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
  // What the sound learner reads as a move: yes to `to`, no to `from`.
  await c.recordMove(tr, from, to).catch(() => {});
  return at;
}

/** Take a sprint's Keep here back: only what that keep added to FB, and the row where it was. */
function unkeep(c, u) {
  const f = c.FB?.[u.id];
  if (f) {
    if (u.newKept && f.kept) { f.kept = f.kept.filter(p => p !== u.from); if (!f.kept.length) delete f.kept; }
    if (u.newRej.length) {
      f.rejected = (f.rejected ?? []).filter(p => !u.newRej.includes(p));
      if (f.rejectedAt) { for (const p of u.newRej) delete f.rejectedAt[p]; if (!Object.keys(f.rejectedAt).length) delete f.rejectedAt; }
    }
    Promise.resolve(c.saveFeedback?.()).catch(() => {});
  }
  if (u.row && !c.R.misfiled.includes(u.row)) {
    const list = c.R.misfiled.slice();
    list.splice(u.idx >= 0 ? Math.min(u.idx, list.length) : 0, 0, u.row);
    c.R.misfiled = list;
  }
}

function trackName(c, id) {
  return c.R?.misfiled?.find(m => m.id === id)?.title ?? tidySoundTrack(c.LIB, id).title;
}

function endSprint(c, say) {
  const sp = c.S.sprint; if (!sp) return;
  const st = sprintStats(sp.s);
  try { c.LS?.setItem(SPRINT_KEY, JSON.stringify(sprintSave(readSprints(c), st, new Date().toISOString()))); } catch { /* counts only */ }
  c.S.sprint = null;
  c.S.tidyFocus = 'sprintstart';
  if (say) announce(c, st.decisions ? `Sprint stopped. ${sprintTally(st)}.` : 'Sprint stopped.');
}

/** Say it in the live region (made once by mount). */
function announce(c, text) {
  const el = c.document?.getElementById?.('tidyLive');
  if (el) el.textContent = text;
}

/** The sprint's keys press its own buttons, so a key and a click run the same action. Captured
 *  before the page's own ←/→ (walk the tabs) and Up/Down handlers, and only while the sprint
 *  is on screen, nothing is typed into, and no sheet is open. A held key does not repeat. */
const SPRINT_KEYS = { ArrowRight: 'spmove', ArrowLeft: 'spkeep', u: 'spundo', U: 'spundo', Escape: 'spend' };
function sprintKeys(doc) {
  return e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const act = SPRINT_KEYS[e.key]; if (!act) return;
    const panel = doc.getElementById('sprint');
    if (!panel || !panel.isConnected || !panel.offsetParent) return;
    if (e.target?.matches?.('input,select,textarea,[contenteditable]')) return;
    if (doc.querySelector('#settingsPanel.open, #plSheet.open, dialog[open]')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.repeat) return;
    const b = panel.querySelector(`[data-act="${act}"]`);
    if (b && !b.disabled) b.click();
  };
}

export function mount(c) {
  const doc = c.document;
  if (!doc?.body) return;
  if (!doc.getElementById('tidyLive')) {
    const d = doc.createElement('div');
    d.id = 'tidyLive'; d.className = 'sprint-live';
    d.setAttribute('role', 'status'); d.setAttribute('aria-live', 'polite'); d.setAttribute('aria-atomic', 'true');
    doc.body.appendChild(d);
  }
  if (!doc.__tidySprintKeys) { doc.__tidySprintKeys = true; doc.addEventListener('keydown', sprintKeys(doc), true); }
  const want = c.S.tidyFocus;
  c.S.tidyFocus = null;
  const a = doc.activeElement;
  const lost = !a || a === doc.body;
  if (c.S.sprint && (want === 'sprint' || lost)) doc.getElementById('sprintCard')?.focus();
  else if (want === 'sprintstart') (doc.getElementById('sprintGo') ?? doc.querySelector('#main .tidysecs [aria-pressed="true"]'))?.focus();
  else if (want === 'rows') (doc.querySelector('#main .rows .row .acts button:not([disabled])') ?? doc.querySelector('#main .tidypl button'))?.focus();
}
