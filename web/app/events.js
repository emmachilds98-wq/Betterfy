document.addEventListener('click', guard(async e => {
  if (await dispatchAct(e)) return;
  const nav = e.target.closest('.nav');
  if (nav) {
    closeSheet();
    if (nav.dataset.v === 'history') S.history = await getLog();
    return go(nav.dataset.v);
  }

  if (e.target.id === 'syncAllSongs') {
    const btn = e.target; btn.disabled = true; btn.textContent = 'Working…';
    try { await syncAllSongsPlaylist(); }
    catch (err) { toast('Failed: ' + err.message); render(); }
    return;
  }

  if (e.target.id === 'shufApply' || e.target.id === 'shufPlay') {
    const btn = e.target, playIt = btn.id === 'shufPlay';
    // vShuffle() always sets S.shufPl to whatever it last showed as selected
    // by the time this button is reachable, so this and the screen agree.
    const src = LIB.playlists.find(p => p.id === S.shufPl);
    const order = S.shufOrder ?? [];
    if (!order.length) return;
    btn.disabled = true; btn.textContent = 'Working…';
    const dj = S.shufOrderMode ? MIX_MODES[S.shufOrderMode] : null;
    try {
      const name = dj ? `🎧 ${src.name}` : `🔀 ${src.name}`;
      // Remembered by id, like the All Songs mirror and for the same reason:
      // found by name alone, renaming the shuffled playlist (or its source)
      // made the next shuffle build a second one beside it instead of
      // replacing what was already there.
      const key = (dj ? 'bf_mix_' : 'bf_shuf_') + src.id;
      const pinned = LS.getItem(key);
      const mine = await paged('/me/playlists?limit=50');
      const ours = p => p?.owner?.id === LIB.user.id;
      let pl = mine.find(p => p.id === pinned && ours(p)) ?? mine.find(p => p.name === name && ours(p));
      if (!pl) pl = await sp('/me/playlists', { method:'POST',
        body:JSON.stringify({ name, public:false, description: dj
          ? `${dj} of "${src.name}": each next track beatmatches the last. Play with Spotify shuffle OFF.`
          : `Spaced shuffle of "${src.name}". Play with Spotify shuffle OFF.` }) });
      LS.setItem(key, pl.id);
      // PUT replaces wholesale, so re-shuffling the same playlist doesn't pile up
      await plCall(pl.id, 'PUT', { uris: order.slice(0,100).map(t => 'spotify:track:'+t.id) });
      for (const part of chunk(order.slice(100), 100)) await plCall(pl.id, 'POST', { uris: part.map(t => 'spotify:track:'+t.id) });
      await logAction({ op:'shuffle', playlistId:pl.id, playlistName:pl.name ?? name, trackIds:order.map(t=>t.id), reason:`${dj ? dj.toLowerCase() + ' ' : ''}from ${src.name}` });
      if (playIt) {
        const d = await sp('/me/player/devices');
        const dev = (d.devices??[]).find(x=>x.is_active) ?? (d.devices??[])[0];
        if (!dev) toast(`"${pl.name ?? name}" is ready — no open Spotify device to play it on.`);
        else {
          await sp(`/me/player/shuffle?state=false&device_id=${dev.id}`, { method:'PUT' });
          await sp(`/me/player/play?device_id=${dev.id}`, { method:'PUT', body:JSON.stringify({ context_uri:`spotify:playlist:${pl.id}` }) });
          toast(`Playing "${pl.name ?? name}" on ${dev.name}, Spotify shuffle off.`);
        }
      } else toast(`"${pl.name ?? name}" — ${order.length} tracks, ready. Play it with Spotify shuffle OFF.`);
    } catch (err) { toast('Failed: ' + err.message); }
    render(); return;
  }

  if (e.target.id === 'shufAgain') { S.shufCache = null; return render(); }

  if (e.target.id === 'discRun') return runDiscovery(S.discSeed || null);

  // Saving the key and finding new music used to be two screens and two
  // clicks — go to Playlists, paste it, come back, hit Find new music. Doing
  // it right here removes the trip: the key is saved and discovery starts in
  // the same action, so a first-time listener never has to go looking for it.
  if (e.target.id === 'saveLfmDiscover') {
    const v = $('#lfmKeyDisc')?.value.trim();
    if (!v) return toast('Paste a Last.fm key first.');
    LS.setItem('bf_lfm', v);
    toast('Key saved — finding new music…');
    return runDiscovery(S.discSeed || null);
  }

  const like = e.target.closest('[data-like]');
  if (like) { try { await libraryCall('PUT', [like.dataset.like]);
      await logAction({ op:'add-liked', trackIds:[like.dataset.like], reason:'from discovery' });
      like.textContent = 'Liked'; like.disabled = true; toast('Added to your Liked Songs.'); }
    catch (err) { toast('Failed: '+err.message); } return; }

  const gto = e.target.closest('[data-go]'); if (gto) return go(gto.dataset.go);
  // A card under "Next up to file" opens the queue on that track, not at the top.
  const gi = e.target.closest('[data-goinbox]');
  // The cards under "Next up to file" show the head of the queue, so their
  // index is an absolute position in it. Adding it to wherever the queue
  // happened to be left instead opened a different track than the one tapped.
  if (gi) { S.inboxAt = Math.min(+gi.dataset.goinbox || 0, Math.max(R.backlog.length - 1, 0)); return go('inbox'); }
  const more = e.target.closest('[data-more]');
  if (more) { S.shown[more.dataset.more] = shownOf(more.dataset.more) + TIDY_PAGE; return render(); }

  // Checked before the pick itself, since the ✕ sits inside that button.
  const reject = e.target.closest('[data-reject]');
  if (reject) {
    e.stopPropagation();
    const t = inboxTrack(); if (!t) return;
    // nameOf() is local to the File view; CFG is the global source of names.
    const pid = reject.dataset.reject, pname = CFG[pid]?.name ?? pid;
    await recordReject(t.id, pid);
    S.fileSel.delete(pid);
    // Re-rank this one track now, so the slot fills with the next real
    // candidate instead of leaving a gap — through the same backlogSuggest()
    // that made the card, so the filing-history fallback and `via` survive.
    const raw = LIB.liked.find(x => x.id === t.id);
    t.suggest = raw ? backlogSuggest(raw, LIB, CFG, gateTags(TAGS, tagGate(TAGS)), R.profiles, R.idf) : [];
    // The artist's other cards re-rank too: the rejection lowers this playlist
    // for them (backlogSuggest reads it through rejectFactors).
    const lead = t.artists?.[0]?.id;
    if (lead) {
      const gated = gateTags(TAGS, tagGate(TAGS)), mem = artistRejectMemory(FB, LIB);
      for (const b of R.backlog) {
        if (b.id === t.id || b.artists?.[0]?.id !== lead) continue;
        const rb = LIB.liked.find(x => x.id === b.id);
        if (rb) b.suggest = backlogSuggest(rb, LIB, CFG, gated, R.profiles, R.idf, undefined, mem);
      }
    }
    toast(`Won't suggest ${pname} for this track again.`, async () => {
      const f = FB[t.id]; if (f) { f.rejected = f.rejected.filter(x => x !== pid); fbUnstamp(f, 'rejectedAt', [pid]); }
      await saveFeedback(); R = buildReports(LIB, CFG, TAGS); render();
    });
    return render();
  }

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
  const selfile = e.target.closest('[data-selfile]'); if (selfile) return toggleFileSel(selfile.dataset.selfile);
  const filesel = e.target.closest('[data-filesel]');
  if (filesel) return fileCurrent(S.fileSel.size ? [...S.fileSel] : filePicks(inboxTrack())[0]?.id);
  const act = e.target.closest('[data-act]'); if (act) return inboxAct(act.dataset.act);

  const dp = e.target.closest('[data-dplay]');
  if (dp) return playFrom(dp.dataset.dplay, +dp.dataset.ddur || 0);
  if (e.target.closest('#pToggle')) return playerToggle();
  const dnav = e.target.closest('[data-dnav]');
  if (dnav) {
    const d = S.discover ?? [];
    S.discAt = Math.max(0, Math.min((S.discAt ?? 0) + (+dnav.dataset.dnav), d.length - 1));
    return render();
  }
  const dfile = e.target.closest('[data-dfile]'); if (dfile) return discAdd(dfile.dataset.dfile);

  if (e.target.id === 'analyseGo') return analyseGo();
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

  const rl = e.target.closest('[data-roll]');
  if (rl) {
    if (rl.dataset.roll === 'no') { S.roll = null; return render(); }
    rl.disabled = true;
    try { await rollForwardGo(); } catch (err) { rl.disabled = false; toast('Failed: ' + err.message); }
    return;
  }
  const rp = e.target.closest('[data-rollpick]');
  if (rp && S.roll) {
    const id = rp.dataset.rollpick;
    if (S.roll.off.has(id)) S.roll.off.delete(id); else S.roll.off.add(id);
    return render();
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
}));

document.addEventListener('change', guard(async e => {
  if (await dispatchAct(e)) return;
  if (e.target.id === 'anyPl' && e.target.value) return toggleFileSel(e.target.value);
  if (e.target.id === 'shufPl') { S.shufPl = e.target.value; S.shufCache = null; return render(); }
  if (e.target.id === 'shufMode') { S.shufMode = e.target.value; try { LS.setItem('bf_shuf_mode', S.shufMode); } catch {} return render(); }
  if (e.target.id === 'discPl') { S.discSeed = e.target.value; return; }
  if (e.target.id === 'discAnyPl' && e.target.value) return discAdd(e.target.value);
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
}));
