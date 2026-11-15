document.addEventListener('click', guard(async e => {
  if (await dispatchAct(e)) return;
  const nav = e.target.closest('.nav');
  if (nav) {
    return go(nav.dataset.v);
  }

  const gto = e.target.closest('[data-go]'); if (gto) return go(gto.dataset.go);
  const ti = e.target.closest('[data-tidy]'); if (ti) { S.tidySec = ti.dataset.tidy; return render(); }
  const more = e.target.closest('[data-more]');
  if (more) { S.shown[more.dataset.more] = shownOf(more.dataset.more) + TIDY_PAGE; return render(); }
  const cmin = e.target.closest('[data-cmin]');
  if (cmin) { S.crossMin = +cmin.dataset.cmin; if (T.rememberFilters) { T.crossMin = S.crossMin; saveTheme(); } return render(); }
  const tsb = e.target.closest('[data-tsb]');
  if (tsb) { S.tsBand = tsb.dataset.tsb; return render(); }
  const tsk = e.target.closest('[data-tskeep]');
  if (tsk) { await recordKeep(tsk.dataset.tskeep, tsk.dataset.tsfrom, [tsk.dataset.tsto]); toast('Kept where it is. It won’t be offered there again.'); return render(); }
  // Wrong place's Keep here: the same record as By sound's, and the row leaves both tiers.
  const mfk = e.target.closest('[data-mfkeep]');
  if (mfk) {
    const id = mfk.dataset.mfkeep, from = mfk.dataset.mffrom;
    await recordKeep(id, from, mfk.dataset.mfaway.split(',').filter(Boolean));
    R.misfiled = R.misfiled.filter(m => !(m.id === id && m.currentPlaylistId === from));
    toast('Kept where it is. It won’t be offered as wrong there again.');
    return render();
  }
  const mfb = e.target.closest('[data-mfb]');
  if (mfb) { S.mfBand = mfb.dataset.mfb; if (T.rememberFilters) { T.mfBand = S.mfBand; saveTheme(); } return render(); }

  // The File screen's "listen to my music" nudge: the same switch as Sources'.
  if (e.target.closest('[data-soundon]')) {
    await audioLoad().catch(() => {});
    if (globalThis.BetterfyAudio) BetterfyAudio.writeAudioSettings(LS, { on: true });
    else LS.setItem('bf_audio', JSON.stringify({ ...audioSettings(), on: true }));
    toast('Listening is on. Picks switch to sound as tracks are heard — see Sources for progress.');
    audioStart();
    return render();
  }
  if (e.target.closest('[data-soundno]')) { LS.setItem('bf_sound_nudge', 'no'); return render(); }

  const keep = e.target.closest('[data-keep]');
  if (keep) {
    const drop = keep.dataset.drop.split(',').filter(Boolean), pl = keep.dataset.pl;
    const plName = CFG[pl]?.name ?? pl;
    try {
      const before = await playlistIds(pl);
      const positions = {};
      before.forEach((id, i) => { if (drop.includes(id)) (positions[id] ??= []).push(i); });
      await delTracks(pl, drop);
      await logAction({ op:'remove', playlistId:pl, playlistName:plName, trackIds:drop, positions, reason:'duplicate' });
      const at = (await getLog())[0]?.at;
      toast(`Removed ${drop.length} from ${plName}.`, () => undoAction(at));
      R.within = R.within.filter(c => !(c.playlistId===pl && c.options.some(o=>drop.includes(o.id)))); render(); }
    catch (err) { toast('Failed: '+err.message); }
    return;
  }
  const x = e.target.closest('[data-xpl]');
  if (x) {
    const pl = x.dataset.xpl, tr = x.dataset.xtr, plName = CFG[pl]?.name ?? pl;
    try {
      const before = await playlistIds(pl);
      const positions = {}; before.forEach((id,i) => { if (id === tr) (positions[id] ??= []).push(i); });
      await delTracks(pl, [tr]);
      await logAction({ op:'remove', playlistId:pl, playlistName:plName, trackIds:[tr], positions, reason:'cross-file trim' });
      const at = (await getLog())[0]?.at;
      x.classList.add('cut');
      toast(`Removed from ${plName}.`, () => undoAction(at));
    } catch (err) { toast('Failed: '+err.message); } return; }

  const mv = e.target.closest('[data-mvto]');
  if (mv) {
    mv.disabled = true;
    const { mvto:to, mvfrom:from, mvtr:tr } = mv.dataset;
    const toName = CFG[to]?.name ?? to, fromName = CFG[from]?.name ?? from;
    try {
      // Add first: if the removal then fails the track is still filed somewhere
      // rather than lost between playlists. Both steps share a group, so one
      // Undo (toast or History) reverses the pair: back where it was, at its
      // position, and out of the playlist it was moved to.
      const group = newGroup();
      await addTracks(to, [tr]);
      const at = await logAction({ op:'add', playlistId:to, playlistName:toName, trackIds:[tr], reason:`moved from ${fromName}`, group });
      const before = await playlistIds(from);
      const positions = {}; before.forEach((id,i) => { if (id === tr) (positions[id] ??= []).push(i); });
      await delTracks(from, [tr]);
      await logAction({ op:'remove', playlistId:from, playlistName:fromName, trackIds:[tr], positions, reason:`moved to ${toName}`, group,
                        move:{ trackId:tr, from, to, fromName, toName } });
      toast(`Moved to ${toName}.`, () => undoAction(at));
      // What the sound learner reads as a move: yes to `to`, no to `from`.
      await recordMove(tr, from, to).catch(() => {});
      S.moved.add(tr);
      const row = mv.closest('.row');
      row.classList.add('done');
      mv.classList.remove('go'); mv.textContent = 'Moved';
    } catch (err) { toast('Failed: '+err.message); mv.disabled = false; } return; }

  const dp = e.target.closest('[data-dplay]');
  if (dp) return playFrom(dp.dataset.dplay, +dp.dataset.ddur || 0);
  if (e.target.closest('#pToggle')) return playerToggle();
  if (e.target.id === 'audioGo') return audioStart();
  if (e.target.id === 'maestGo') return maestStart();
  if (e.target.id === 'maestStop') { AUDIO.maest?.stop(); return; }
  const lchk = e.target.closest('[data-lchk]');
  if (lchk && globalThis.BetterfyAudio) return labelVerdict(lchk);
  if (e.target.id === 'labelCheckMore') { LABELS.seed++; LABELS.sample = null; return labelCheckRedraw(); }
  if (e.target.id === 'audioStop') { AUDIO.ctrl?.stop(); return; }
  if (e.target.id === 'audioWifiYes') { AUDIO.wifiOk = true; try { LS.setItem('bf_audio_wifi_ok', '1'); } catch { /* memory only */ } return audioStart(); }

  const ea = e.target.closest('[data-editartist]');
  if (ea) { S.editingArtist = S.editingArtist === ea.dataset.editartist ? null : ea.dataset.editartist; render(); return; }
  const closeEdit = e.target.closest('[data-closetagedit]');
  if (closeEdit) { S.editingArtist = null; render(); return; }
  const rmtag = e.target.closest('[data-rmtag]');
  if (rmtag) {
    const i = rmtag.dataset.rmtag.lastIndexOf('|');
    const id = rmtag.dataset.rmtag.slice(0, i), idx = +rmtag.dataset.rmtag.slice(i + 1);
    await saveArtistTags(id, (TAGS[id]?.tags ?? []).filter((_, n) => n !== idx));
    render(); return;
  }
  const addtag = e.target.closest('[data-addtag]');
  if (addtag) {
    const v = $('#newTagVal')?.value.trim().toLowerCase();
    if (!v) return;
    await saveArtistTags(addtag.dataset.addtag, [...(TAGS[addtag.dataset.addtag]?.tags ?? []), [v, 50]]);
    render(); return;
  }
  const refetch = e.target.closest('[data-refetchtags]');
  if (refetch) { await refetchArtist(refetch.dataset.refetchtags, refetch.dataset.artistname); render(); return; }
  const reset = e.target.closest('[data-resettags]');
  if (reset) { await resetArtistTags(reset.dataset.resettags); render(); return; }

  const gp = e.target.closest('[data-gap]');
  if (gp) {
    const g = GAPS.gaps?.[+gp.dataset.gap];
    const name = $('#gapnm' + gp.dataset.gap)?.value.trim();
    if (!g) return;
    if (!name) return toast('Give it a name first.');
    gp.disabled = true;
    try { await gapsCreate(name, g.ids); } catch (err) { gp.disabled = false; toast('Failed: ' + err.message); }
    return;
  }
  const spl = e.target.closest('[data-split]');
  if (spl) {
    const [i, k] = spl.dataset.split.split(':').map(Number);
    const part = GAPS.splits?.[i]?.parts?.[k];
    if (!part) return;
    spl.disabled = true;
    try { await gapsCreate(part.label, part.ids); } catch (err) { spl.disabled = false; toast('Failed: ' + err.message); }
    return;
  }
  const sh = e.target.closest('[data-sndh]'), so = e.target.closest('[data-sndo]');
  if (sh || so) {
    const i = +(sh ?? so).dataset[sh ? 'sndh' : 'sndo'];
    const g = sh ? GAPS.sound?.hybrids?.[i] : GAPS.sound?.orphans?.[i];
    const name = $((sh ? '#sndh' : '#sndo') + i)?.value.trim();
    if (!g) return;
    if (!name) return toast('Give it a name first.');
    (sh ?? so).disabled = true;
    try {
      await gapsCreate(name, g.ids);
      if (so) { GAPS.filed.add('o' + i); if (typeof clapConfirm === 'function') clapConfirm(g.ids, name).catch(() => {}); }
      render();
    }
    catch (err) { (sh ?? so).disabled = false; toast('Failed: ' + err.message); }
    return;
  }
  const sn = e.target.closest('[data-sndn]');
  if (sn) {
    const i = +sn.dataset.sndn, g = GAPS.sound?.orphans?.[i], name = $('#sndo' + i)?.value.trim();
    if (!g) return;
    if (!name) return toast('Give it a name first.');
    try { await clapConfirm(g.ids, name); g.confirmed = name; g.suggest = null; toast(`Kept the name “${name}”.`); render(); }
    catch (err) { toast('Failed: ' + err.message); }
    return;
  }
  const sq = e.target.closest('[data-sndq], [data-sndqpick]');
  if (sq) return clapSearch(sq.dataset.sndqpick ?? $('#sndq')?.value);
  if (e.target.closest('[data-sndqretry]')) { CLAPS.err = null; return render(); }
  const sqm = e.target.closest('[data-sndqmake]');
  if (sqm) {
    const r = CLAPS.res, label = r?.prompt?.label;
    if (!r?.results?.length || !label) return;
    sqm.disabled = true;
    try {
      const name = `Sounds like ${label}`;
      const pl = await sp('/me/playlists', { method:'POST', body:JSON.stringify({ name, public:false }) });
      await addTracks(pl.id, r.results.map(x => x.id));
      toast(`Created “${name}” with ${r.results.length} tracks.`);
    } catch (err) { sqm.disabled = false; toast('Failed: ' + err.message); }
    return;
  }
  const spk = e.target.closest('[data-sndp]');
  if (spk) {
    const [i, k] = spk.dataset.sndp.split(':').map(Number);
    const p = GAPS.sound?.pick?.[i], to = p?.between?.[k];
    if (!to || GAPS.filed.has(`p${i}:0`) || GAPS.filed.has(`p${i}:1`)) return;
    spk.disabled = true;
    try { await gapsFile(to.id, to.name, p.ids, `p${i}:${k}`); } catch (err) { spk.disabled = false; toast('Failed: ' + err.message); }
    return;
  }
  if (e.target.closest('[data-gapsretry]')) { GAPS.status = 'idle'; return render(); }

  const cl = e.target.closest('[data-cluster]');
  if (cl) {
    const i = +cl.dataset.cluster, name = $('#nm'+i).value.trim();
    if (!name) return toast('Give it a name first.');
    try { const pl = await sp('/me/playlists', { method:'POST', body:JSON.stringify({ name, public:false }) });
      await addTracks(pl.id, R.clusters[i].ids);
      toast(`Created “${name}” with ${R.clusters[i].ids.length} tracks.`);
      R.clusters.splice(i,1); render(); }
    catch (err) { toast('Failed: '+err.message); }
  }
}));

document.addEventListener('change', guard(async e => {
  if (await dispatchAct(e)) return;
  if (e.target.id === 'deepMaest' || e.target.id === 'deepClap' || e.target.id === 'deepMemory') {
    await audioLoad().catch(() => {});
    const change = e.target.id === 'deepMaest' ? { maest: e.target.checked }
      : e.target.id === 'deepClap' ? { clap: e.target.checked } : { memoryOverride: e.target.checked };
    if (globalThis.BetterfyAudio?.writeDeepSettings) BetterfyAudio.writeDeepSettings(LS, change);
    else LS.setItem('bf_audio_deep', JSON.stringify({ ...deepSettings(), ...change }));
    // Ticking CLAP describes the tracks already heard; the next run picks it up, so start one now.
    if (change.clap && audioSettings().on && !AUDIO.ctrl?.running) audioStart({ quiet: true });
    // The second ear: off stops the run in flight; on (or the memory override) starts one.
    if (e.target.id !== 'deepClap') {
      if (!deepSettings().maest) await AUDIO.maest?.stop();
      else maestStart();
    }
    return audioRedraw();
  }
  if (e.target.id === 'audioOn' || e.target.id === 'audioWifi' || e.target.id === 'audioScope') {
    await audioLoad().catch(() => {});
    const change = e.target.id === 'audioOn' ? { on: e.target.checked }
      : e.target.id === 'audioWifi' ? { wifiOnly: e.target.checked } : { scope: e.target.value };
    if (globalThis.BetterfyAudio) BetterfyAudio.writeAudioSettings(LS, change);
    else LS.setItem('bf_audio', JSON.stringify({ ...audioSettings(), ...change }));
    const set = audioSettings();
    // Turning it off, narrowing the scope or tightening Wi-Fi stops the run; the next start re-reads all three.
    if (AUDIO.ctrl?.running) await AUDIO.ctrl.stop(set.on ? 'settings changed' : 'stopped');
    if (set.on) audioStart(); else { AUDIO.vm = null; setListen(null); render(); }
    return;
  }

  // A playlist's sound profile: shown under its row on demand. Only rendered
  // at all when listening has produced one (see LISTS_SOUND).
  const axexp = e.target.closest('[data-axexp]');
  if (axexp) {
    const open = axexp.getAttribute('aria-expanded') !== 'true';
    axexp.setAttribute('aria-expanded', String(open));
    const pr = document.getElementById(axexp.getAttribute('aria-controls'));
    if (pr) pr.hidden = !open;
    return;
  }

  // "Two genres by sound": make the playlist for the half that sounds apart.
  const lsp = e.target.closest('[data-lsplit]');
  if (lsp) {
    lsp.disabled = true;
    try { await listsSplitMake(lsp.dataset.lsplit); } catch (err) { lsp.disabled = false; toast('Failed: ' + err.message); }
    return;
  }

  // Axis / target edits are per-viewer and persist on this device.
  const ax = e.target.closest('[data-ax]'), tg = e.target.closest('[data-tg]');
  if (ax || tg) {
    const id = (ax ?? tg).dataset.ax ?? tg.dataset.tg;
    if (ax) {
      CFG[id].axis = ax.value;
      // Matches what a reload would do via classify()'s saved-override merge —
      // done here too so a playlist just fixed drops out of "Needs your input"
      // immediately rather than waiting for the next full sync.
      CFG[id].why = 'set by you';
      // Saying a playlist is a genre playlist is saying "file into it", so it
      // starts taking suggestions; any axis that takes none stops.
      if (ax.value === 'genre') CFG[id].target = CFG[id].tracks >= MIN_FOR_TARGET && !isMirrorPlaylist({ id, name: CFG[id].name });
      else if (ax.value !== 'mood') CFG[id].target = false;
    } else {
      CFG[id].target = tg.checked;
    }
    const saved = JSON.parse(LS.getItem('bf_axes') || '{}');
    saved[id] = { axis: CFG[id].axis, target: CFG[id].target, at: Date.now() };
    LS.setItem('bf_axes', JSON.stringify(saved));
    R = buildReports(LIB, CFG, TAGS);
    toast('Updated — suggestions recomputed.');
    render();
    // Shared with linked devices straight away, not only at the next load.
    syncAxes().then(changed => { if (changed) { R = buildReports(LIB, CFG, TAGS); store.set('reports', R); } });
  }
}));

