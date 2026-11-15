/* ---------- Tidy: three screens' worth of the same question ----------
 *
 * Duplicates, Misfiles and Cross-filed were three destinations all asking "is
 * this in the right place?", and nobody visited the last two. They are one
 * screen now, with a section each and the counts on the switcher, so the
 * question is asked once and the answer is a row you tap.
 */
const TIDY_SECTIONS = [['misfile', 'Wrong place'], ['dupes', 'Repeats'], ['cross', 'Cross-filed']];

function secDupes() {
  const exact = R.within.filter(x => x.verdict === 'same-recording');
  const clash = R.within.filter(x => x.verdict !== 'same-recording');
  const sec = (title, list, note, key) => `<h2>${esc(title)} <span class="mono" style="color:var(--ink-3);font-size:14px">${list.length}</span></h2>
    <p class="lede">${note}</p>
    <div class="rows">${list.slice(0, shownOf(key)).map(c => `<div class="row">${thumbHTML(c)}<div class="main">
      <div class="ttl">${esc(c.title)} <span class="sub">— ${esc(c.artist ?? '')}</span></div>
      <div class="sub mono">${esc(c.playlist)}</div><div class="why">${esc(c.why)}</div>${cmpTable(c.options)}
    </div><div class="acts">${c.options.map(o =>
      `<button class="b sm" data-keep="${esc(o.id)}" data-pl="${esc(c.playlistId)}" data-drop="${esc(c.options.filter(z => z.id !== o.id).map(z => z.id).join(','))}">Keep ${esc(o.dur)}</button>`).join('')}
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

function secCross() {
  const a = R.across.filter(x => x.placements.length >= S.crossMin);
  return `<p class="lede">Tracks in several playlists. Usually deliberate — nothing is preselected. Tap a playlist to remove the track from just that one.</p>
    <div class="rowbtns" style="margin-bottom:14px">${[2, 3, 4, 5, 6].map(n =>
      `<button class="b sm ${S.crossMin === n ? 'p' : ''}" data-cmin="${n}">${n}+ playlists</button>`).join('')}</div>
    <div class="rows">${a.slice(0, shownOf('cross-' + S.crossMin)).map(c => `<div class="row">${thumbHTML(c)}<div class="main">
      <div class="ttl">${esc(c.title)} <span class="sub">— ${esc(c.artist ?? '')}</span></div>
      ${c.mixedRecordings ? '<div class="why">Different recordings across these playlists.</div>' : c.mixedReleases ? '<div class="why">Same song, different pressings.</div>' : ''}
      <div class="acts" style="margin-top:8px">${c.placements.map(p =>
        `<button class="chip" data-xpl="${esc(p.playlistId)}" data-xtr="${esc(p.trackId)}" title="${esc(p.axis)}">${esc(p.playlist)}</button>`).join('')}</div>
    </div></div>`).join('')
      || (R.across.length
        ? emptyState(`Nothing at ${S.crossMin}+ playlists`, 'Lower the threshold to see tracks filed in fewer places.', { compact: true })
        : emptyState('Nothing cross-filed', 'Every track you have filed sits in one playlist only.'))}</div>
    ${moreButton('cross-' + S.crossMin, a.length)}`;
}

/** UI-1's empty state: the mark's five bars at rest, a title, one line, and
 *  optionally what to do about it. `compact` sits inside a list or a card. */
function emptyState(title, body, { compact = false, acts = '' } = {}) {
  return `<div class="empty-state${compact ? ' compact' : ''}"><span class="es-mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><div class="es-body"><b>${esc(title)}</b><p>${body}</p></div>${
    acts ? `<div class="es-acts">${acts}</div>` : ''}</div>`;
}

/* The misfile confidence tiers, in calibrate's words (UI-BUILD-PLAN R5): the
 * stored value stays high/medium/low so a remembered filter still works; what
 * the listener reads is the same Sure / Likely / Unsure as everywhere else. */
const MF_BANDS = [['high', 'HIGH', 'sure', 'Sure'], ['medium', 'LIKELY', 'likely', 'Likely'], ['low', 'AMBIGUOUS', 'unsure', 'Unsure']];
const mfBandWord = b => (MF_BANDS.find(x => x[0] === b) ?? MF_BANDS[0])[3];
/** UI-2's bandChip when it draws one, else the same chip in UI-1's classes. */
function mfBandChip(b) {
  const [, vm, cls, word] = MF_BANDS.find(x => x[0] === b) ?? MF_BANDS[0];
  return (typeof bandChip === 'function' && bandChip(vm)) || `<span class="band band-${cls}">${word}</span>`;
}

/* ---------- Tidy by sound: core/audio/misfit.mjs ----------
 * Filed tracks whose sound strongly disagrees with their playlist ("sounds
 * like Jungle, sits in House"): the heard tracks each one sounds most like sit
 * mostly in another of your genre playlists, and its sound ID doesn't place it
 * where it is. Worked out in the engine worker from the heard records, and
 * measured there on tracks you filed yourself (planted in the wrong playlist,
 * held out). The section only exists once listening has heard something;
 * without it Tidy draws exactly what it always did. Moves use the same Move
 * button, History entry and undo as "Wrong place"; "Keep here" (recordKeep, in
 * both tiers) is a "not that playlist" verdict plus "it belongs here", so the
 * track is offered as wrong there by neither tier again. */
const TSOUND = { status: 'idle', key: '', res: null, err: null };
const tidySoundKey = () => `${soundHeard()}|${engineTargets().join()}|${Object.values(FB).reduce((n, f) => n + (f.rejected?.length ?? 0), 0)}|${LIB?.playlists?.length ?? 0}`;
// Guarded: the page tests run Tidy in a sandbox without the audio or engine parts.
const tidySoundReady = () => typeof AUDIO !== 'undefined' && typeof soundHeard === 'function' && typeof engineTargets === 'function';
const tidySoundOn = () => tidySoundReady() && !!LIB && soundHeard() > 0;
function tidySections() {
  return tidySoundOn() ? [...TIDY_SECTIONS, ['sound', 'By sound']] : TIDY_SECTIONS;
}
function tidySoundRows() {
  // Not a move you turned down, and not a track you said to keep where it is
  // (Keep here in either tier: FB.kept).
  return (TSOUND.res?.rows ?? []).filter(x => !(FB[x.id]?.rejected ?? []).includes(x.to) && !(FB[x.id]?.kept ?? []).includes(x.from));
}
const tidySoundCount = () => tidySoundRows().length;
/** Load the heard records if listening is on, and work the moves out when they've changed. Cheap when nothing is due. */
function tidySoundWarm() {
  if (!tidySoundReady() || !LIB || TSOUND.status === 'working') return;
  if (!AUDIO.records) { if (audioSettings().on && TSOUND.status === 'idle') { TSOUND.status = 'working'; fire(tidySoundLoad()); } return; }
  if (!tidySoundOn()) return;
  const key = tidySoundKey();
  if (TSOUND.key === key && (TSOUND.status === 'ready' || TSOUND.status === 'error')) return;
  TSOUND.status = 'working';
  fire(tidySoundBuild(key));
}
async function tidySoundLoad() {
  try { await engineAudio(); } catch { /* no records: Tidy stays as it was */ }
  TSOUND.status = 'idle';
  if (view === 'tidy' && tidySoundOn()) render();
}
async function tidySoundBuild(key) {
  try {
    await engineLoad();
    const audio = await engineAudio();
    let res = null;
    if (audio) {
      try { res = (await inEngineWorker('misfits', { lib: LIB, audio: engineAudioIn(audio) }))?.result ?? null; }
      catch { res = null; }
      if (!res) {
        await yieldToPaint();
        res = BetterfyMisfit.soundMisfitsFor(LIB, engineAudioIn(audio), { targets: engineTargets(), isMirror: isMirrorPlaylist });
      }
    }
    Object.assign(TSOUND, { status: 'ready', key, res, err: null });
  } catch (e) {
    Object.assign(TSOUND, { status: 'error', key, err: e?.message ?? String(e) });
  }
  if (view === 'tidy') render();
}
function tidySoundTrack(id) {
  for (const p of LIB?.playlists ?? []) for (const t of p.tracks ?? []) if (t?.id === id)
    return { id, title: t.name ?? '', artist: (t.artists ?? []).map(a => a?.name).filter(Boolean).join(', '), art: t.art ?? null, dur: t.duration_ms ?? 0 };
  return { id, title: id, artist: '', art: null, dur: 0 };
}
const TS_BANDS = [['sure', 'HIGH'], ['likely', 'LIKELY']];
function secSound() {
  const rows = tidySoundRows();
  const band = S.tsBand ?? 'sure';
  const counts = { sure: 0, likely: 0 };
  for (const x of rows) counts[x.band]++;
  const acc = TSOUND.res?.accuracy;
  const pct = v => `${Math.round(v * 100)}%`;
  const checked = acc?.scored ? `<p class="sub tsacc">Checked on ${acc.scored.toLocaleString()} tracks you filed yourself: put in the wrong playlist on purpose, ${pct(acc.caught)} were caught and sent home${
    acc.sure?.precision != null ? ` (${pct(acc.sure.precision)} of the sure ones right)` : ''}; ${pct(acc.falseAlarm)} of tracks left where you filed them were flagged anyway.</p>` : '';
  const lede = `<p class="lede">Filed in a genre playlist, but <b>the tracks it sounds most like</b> are almost all in another one, and its sound doesn't place it where it is. Only heard tracks, and only playlists with at least five heard tracks, are judged.</p>`;
  if (TSOUND.status === 'working' && !TSOUND.res) return lede + emptyState('Listening through your playlists', 'Comparing every heard track with the ones it sounds like. This takes a few seconds.', { compact: true });
  if (TSOUND.status === 'error' && !TSOUND.res) return lede + emptyState('Couldn’t compare by sound', esc(TSOUND.err ?? ''), { compact: true });
  const m = rows.filter(x => x.band === band);
  return `${lede}${checked}
    ${rows.length ? `<div class="seg mfbands tsbands" role="group" aria-label="How sure">${TS_BANDS.map(([b, vm]) =>
      `<button type="button" aria-pressed="${band === b}" data-tsb="${b}">${mfBandChip(vm === 'HIGH' ? 'high' : 'medium')} <span class="n">${counts[b].toLocaleString()}</span></button>`).join('')}</div>` : ''}
    <div class="rows">${m.slice(0, shownOf('tsound-' + band)).map(x => {
      const t = tidySoundTrack(x.id), done = S.moved.has(x.id);
      return `<div class="row tsrow ${done ? 'done' : ''}">${thumbHTML(t)}<div class="main">
        <div class="ttl">${esc(t.title)} <span class="sub">— ${esc(t.artist)}</span></div>
        <div class="tssound">${x.sound ? `Sounds like <b>${esc(x.sound)}</b>` : 'Sounds like'}${x.bpm ? ` <span class="mono">${x.bpm} BPM</span>` : ''}, sits in <b>${esc(x.fromName)}</b></div>
        <div class="swap"><span class="from">${esc(x.fromName)}</span><span class="arw">→</span><span class="to">${esc(x.toName)}</span>
          <span class="mono" style="color:var(--ink-3)">${x.near.from} → ${x.near.to} of ${x.near.k} sound-alikes</span></div>
        <div class="why">${esc(x.why.join('; '))}.</div>
      </div><div class="acts">
        <button class="b sm ${done ? '' : 'go'}" ${done ? 'disabled' : ''} data-mvtr="${esc(x.id)}" data-mvfrom="${esc(x.from)}" data-mvto="${esc(x.to)}">${done ? 'Moved' : 'Move'}</button>
        ${done ? '' : `<button class="b sm" data-tsfrom="${esc(x.from)}" data-tskeep="${esc(x.id)}" data-tsto="${esc(x.to)}">Keep here</button>`}
        <button class="b sm" data-dplay="${esc(x.id)}" data-ddur="${t.dur}">Play</button></div></div>`;
    }).join('')
      || (rows.length
        ? emptyState(`Nothing ${band === 'sure' ? 'sure' : 'likely'}`, band === 'sure' ? 'Likely has the more speculative ones.' : 'Try Sure.', { compact: true })
        : emptyState('Everything sounds where it is', 'No heard track sits in a genre playlist its sound-alikes avoid. More show up as listening hears more of your library.'))}</div>
    ${moreButton('tsound-' + band, m.length)}`;
}

function secMisfile() {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const x of R.misfiled) counts[x.confidence]++;
  const m = R.misfiled.filter(x => x.confidence === S.mfBand);
  // Best-effort, fetched once and reused: a "misfiled" track you actually
  // play a lot is more likely a deliberate keep than a mistake. Doesn't
  // change the confidence tier — just gives you the context to judge it —
  // and the row renders immediately either way; the note appears once the
  // fetch resolves, without blocking anything on it.
  const recentlyActive = LISTENING_CACHE?.recentlyActive ?? null;
  if (!recentlyActive && !LISTENING_PENDING) getListening().then(() => render());
  // Only draw the (stateful, id-bearing) editor once, even if the artist
  // being fixed has several other misfiled tracks in the same list.
  let editorDrawn = false;
  return `<p class="lede">Filed somewhere that fits far worse than another playlist <b>on the same axis</b>. Each row is a move, not a score — and every one of them lands in History.</p>
    ${R.misfiled.length ? `<div class="seg mfbands" role="group" aria-label="How sure">${MF_BANDS.map(([b]) =>
      `<button type="button" aria-pressed="${S.mfBand === b}" data-mfb="${b}">${mfBandChip(b)} <span class="n">${counts[b].toLocaleString()}</span></button>`).join('')}</div>` : ''}
    <div class="rows">${m.slice(0, shownOf('misfile-' + S.mfBand)).map(x => {
      const to = x.suggest.filter(sg => sg.id)[0];
      const done = S.moved.has(x.id);
      const playedALot = recentlyActive?.has(x.artist);
      return `<div class="row ${done ? 'done' : ''}">${thumbHTML(x)}<div class="main">
        <div class="ttl">${esc(x.title)} <span class="sub">— ${esc(x.artist ?? '')}</span></div>
        ${to ? `<div class="swap"><span class="from">${esc(x.current)}</span><span class="arw">→</span><span class="to">${esc(to.name)}</span>
          <span class="mono" style="color:var(--ink-3)">${(x.currentScore * 100).toFixed(0)}% → ${(to.score * 100).toFixed(0)}%</span></div>`
        : `<div class="sub">in <b>${esc(x.current)}</b> <span class="mono">${(x.currentScore * 100).toFixed(0)}% fit</span></div>`}
        ${playedALot ? `<div class="sub" style="color:var(--accent)">You play this a lot right now — might be deliberate.</div>` : ''}
      </div><div class="acts">
        ${to ? `<button class="b sm ${done ? '' : 'go'}" ${done ? 'disabled' : ''} data-mvtr="${esc(x.id)}" data-mvfrom="${esc(x.currentPlaylistId)}" data-mvto="${esc(to.id)}">${done ? 'Moved' : 'Move'}</button>` : ''}
        ${x.suggest.filter(sg => sg.id).slice(1, 2).map(sg =>
          `<button class="b sm" data-mvtr="${esc(x.id)}" data-mvfrom="${esc(x.currentPlaylistId)}" data-mvto="${esc(sg.id)}">→ ${esc(sg.name)}</button>`).join('')}
        ${done ? '' : `<button class="b sm" data-mfkeep="${esc(x.id)}" data-mffrom="${esc(x.currentPlaylistId)}" data-mfaway="${esc(x.suggest.filter(sg => sg.id).slice(0, 2).map(sg => sg.id).join(','))}">Keep here</button>`}
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

function vTidy() {
  tidySoundWarm();
  const n = { misfile: R.misfiled.length, dupes: R.within.length, cross: R.across.length, sound: tidySoundCount() };
  const secs = tidySections();
  // Opens on the first section with something in it rather than on "Wrong
  // place 0" while Repeats has work. A section the listener picked (S.tidySec,
  // set only by a tap) is kept; one that has gone away falls back the same way.
  const first = (secs.find(([id]) => n[id] > 0) ?? secs[0])[0];
  if (S.tidySec != null && !secs.some(([id]) => id === S.tidySec)) S.tidySec = first;
  const sec = S.tidySec ?? first;
  const body = { misfile: secMisfile, dupes: secDupes, cross: secCross, sound: secSound }[sec];
  return `<h1>Tidy</h1>
    <div class="seg tidysecs" role="group" aria-label="Section">${secs.map(([id, label]) =>
      `<button type="button" aria-pressed="${sec === id}" data-tidy="${id}">${label} <span class="n">${n[id].toLocaleString()}</span></button>`).join('')}</div>
    ${body()}`;
}

