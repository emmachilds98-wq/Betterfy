document.addEventListener('click', guard(async e => {
  if (await dispatchAct(e)) return;
  const nav = e.target.closest('.nav');
  if (nav) {
    return go(nav.dataset.v);
  }

  const gto = e.target.closest('[data-go]'); if (gto) return go(gto.dataset.go);
  const more = e.target.closest('[data-more]');
  if (more) { S.shown[more.dataset.more] = shownOf(more.dataset.more) + TIDY_PAGE; return render(); }

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
    else { const next = { ...audioSettings(), ...change };
           LS.setItem('bf_audio', JSON.stringify(next.on === false ? { ...next, offChosen: true } : next)); }
    const set = audioSettings();
    // Turning it off, narrowing the scope or tightening Wi-Fi stops the run; the next start re-reads all three.
    if (AUDIO.ctrl?.running) await AUDIO.ctrl.stop(set.on ? 'settings changed' : 'stopped');
    if (set.on) audioStart(); else { AUDIO.vm = null; setListen(null); render(); }
    return;
  }
}));
