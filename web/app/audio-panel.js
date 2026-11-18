/** Redraw only the panel, and only while it is on screen: progress ticks every few seconds. */
let AUDIO_DRAW = 0;
function audioRedraw() {
  setListen(AUDIO.vm);
  if (!settingsOpen()) return;
  if (AUDIO_DRAW) return;
  AUDIO_DRAW = requestAnimationFrame(() => {
    AUDIO_DRAW = 0;
    const el = document.getElementById('audioPanel');
    if (el) el.outerHTML = audioPanelHTML();
    if (typeof uhSummaryTick === 'function') uhSummaryTick();
  });
}

/** What the queue should hear next, in order, cut to the chosen scope. */
async function audioTracks() {
  const A = BetterfyAudio, set = audioSettings();
  let listening = null;
  try { listening = await getListening(); } catch { listening = null; }
  // Genre playlists, plus mood and context ones: each needs a few heard members
  // before File can place by sound or offer an "also fits" chip (core/intrinsic/mood.mjs).
  const targets = Object.entries(CFG ?? {}).filter(([, c]) => c.target || c.axis === 'mood' || c.axis === 'context').map(([id]) => id);
  const isMirror = p => isMirrorPlaylist(p);
  const store = AUDIO.records ?? new Map();
  // The last Score run's weakest playlists (core/intrinsic/weak.mjs): their tracks are heard next.
  const focus = (typeof weakSaved === 'function' ? weakSaved()?.rows ?? [] : []).map(d => d.id);
  const allowed = A.scopeIds(LIB, { scope: set.scope, listening, targets, isMirror, focus });
  const ids = A.audioQueue(LIB, { listening, store, mel: A.MEL_VERSION, targets, isMirror, focus })
    .filter(id => !allowed || allowed.has(id));
  const byId = new Map();
  for (const t of LIB.liked ?? []) byId.set(t.id, t);
  for (const p of LIB.playlists ?? []) for (const t of p.tracks ?? []) if (!byId.has(t.id)) byId.set(t.id, t);
  return ids.map(id => byId.get(id)).filter(Boolean).map(t => ({ id: t.id, isrc: t.isrc ?? null, durationMs: t.duration_ms }));
}

/* Listening is on by default, so "is this Wi-Fi?" can't be a question every
 * session. A computer (a fine pointer and no touch screen) is taken as not
 * metered when the browser won't say, and a phone's "yes, I'm on Wi-Fi" is
 * remembered on this device. Cellular and Data Saver still always wait. */
function audioWifiKnown() {
  if (AUDIO.wifiOk) return true;
  try { if (LS.getItem('bf_audio_wifi_ok') === '1') return true; } catch { /* storage off */ }
  return audioOnComputer();
}
function audioConnection() {
  const set = audioSettings();
  return BetterfyAudio.connectionVerdict(navigator.connection, { wifiOnly: set.wifiOnly, confirmed: audioWifiKnown() });
}

/** Start (or resume) listening, if switched on and the connection allows it. */
async function audioStart({ quiet = false } = {}) {
  const set = audioSettings();
  if (!set.on || !LIB) return;
  try { await audioInit(); } catch (e) { AUDIO.err = e.message; audioRedraw(); if (!quiet) toast('Couldn’t start listening: ' + e.message); return; }
  if (AUDIO.ctrl.running) return;
  const conn = audioConnection();
  if (conn !== 'ok') {
    AUDIO.vm = { ...AUDIO.ctrl.vm(), state: 'paused',
      reason: conn === 'offline' ? 'offline' : conn === 'metered' ? 'waiting for Wi-Fi' : 'ask' };
    return audioRedraw();
  }
  await audioRefresh();
  const tracks = await audioTracks();
  // One writer at a time: the second ear finishes its track in flight first,
  // so a listening run's DSP or CLAP top-up never overwrites its answer (or it theirs).
  await AUDIO.maest?.stop('listening');
  await AUDIO.ctrl.start(tracks);
  await audioRefresh();
  audioRedraw();
  maestStart({ quiet: true });
}

/* ---------- the second ear (WP-C1): MAEST on a laptop, behind Deep listen ----------
 * Gives tracks listening already heard a MAEST answer (web/audio/maest-run.mjs),
 * a few dozen per run after each listening run. It changes no suggestion by
 * itself: the File screen places with it only once a Score run has chosen it
 * (engineEar). The model is fetched once (about 90 MB) and freed after each run. */
async function maestStart({ quiet = false } = {}) {
  if (!deepSettings().maest || !LIB) return;
  try { await audioInit(); } catch (e) { if (!quiet) toast('Couldn’t start the second ear: ' + e.message); return; }
  const A = BetterfyAudio;
  if (deepAllowed('maest') !== 'ok') return audioRedraw();
  // Listening has the store (one writer at a time): while it runs, the second
  // ear says it waits and starts by itself when that run ends (DESIGN-PLAN L0).
  if (AUDIO.ctrl?.running) {
    if (AUDIO.maestWaiting) return;
    AUDIO.maestWaiting = true;
    AUDIO.maestVm = { ...(AUDIO.maestVm ?? {}), state: 'waiting', reason: null };
    audioRedraw();
    if (!quiet) toast('The second ear waits for listening to finish, then starts by itself');
    try { while (AUDIO.ctrl?.running) await AUDIO.ctrl.whenIdle(); }
    finally { AUDIO.maestWaiting = false; }
    if (!deepSettings().maest || deepAllowed('maest') !== 'ok') {
      AUDIO.maestVm = AUDIO.maest ? AUDIO.maest.vm() : null;
      return audioRedraw();
    }
  }
  AUDIO.maest ??= A.createMaestRunner({
    store: AUDIO.store,
    lookup: (isrc, o) => A.lookup(isrc, { jsonp: deezerJsonp, ...o }),
    fetchPreview: url => A.fetchPreview(url, { fetch: (u, init) => fetch(u, init) }),
    decode: buf => A.decodeTo16k(buf),
    loadMaest: async () => {
      const w = A.createWorkerMaest(new Worker('maest-worker.js?v=__BUILD__', { type: 'module' }),
        { modelUrl: audioModelUrl(A.MAEST_FILE), ortBase: ORT_BASE });
      try { await w.ready; } catch (e) { w.release(); throw e; }
      return w;
    },
    onChange: vm => { AUDIO.maestVm = vm; audioRedraw(); if (typeof runHistoryWatch === 'function') runHistoryWatch('deep', vm); },
  });
  if (AUDIO.maest.running) return;
  await AUDIO.maest.start();
  await audioRefresh();
  audioRedraw();
}

// A phone that leaves Wi-Fi stops after the track in flight, and carries on when it is back.
try {
  navigator.connection?.addEventListener?.('change', () => {
    if (!AUDIO.ctrl || !globalThis.BetterfyAudio) return;
    if (audioConnection() !== 'ok') { if (AUDIO.ctrl.running) AUDIO.ctrl.stop('waiting for Wi-Fi'); }
    else if (audioSettings().on && !AUDIO.ctrl.running) audioStart({ quiet: true });
    // The second ear holds itself to Wi-Fi as well: off it, it stops after the track in flight.
    if (AUDIO.maest?.running && deepAllowed('maest') !== 'ok') AUDIO.maest.stop('waiting for Wi-Fi');
  });
} catch { /* no connection API: the listener is asked instead */ }

function audioPanelHTML() {
  const set = audioSettings();
  const vm = AUDIO.vm ?? { state: set.on ? 'paused' : 'off', done: 0, total: 0, missed: {}, heard: 0 };
  const scopes = globalThis.BetterfyAudio?.SCOPES
    ?? { 'playing+unfiled': 'What I’m playing + unfiled', all: 'My whole library' };
  const missText = globalThis.BetterfyAudio?.MISS_TEXT ?? {};
  const missed = Object.entries(vm.missed ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const nMissed = missed.reduce((s, [, n]) => s + n, 0);
  const running = vm.state === 'running';
  const tidy = listenTidyText(vm);
  const status = !set.on ? 'Tick “Listen to my music” to start.'
    : running && tidy ? `Tidying up after this run: ${esc(tidy)}.` + (vm.reason && vm.reason !== 'stopped' ? ` (${esc(vm.reason)})` : '')
    : running ? (vm.total ? `Listening… ${vm.done.toLocaleString()} of ${vm.total.toLocaleString()} this run.` : 'Starting…')
      + (vm.reason && vm.reason !== 'stopped' ? ` (${esc(vm.reason)})` : '')
    : vm.reason === 'ask' ? ''
    : vm.reason === 'waiting for Wi-Fi' ? 'Paused: waiting for Wi-Fi.'
    : vm.reason === 'offline' ? 'Paused: offline.'
    : vm.state === 'done' ? 'Up to date for this scope.'
    : vm.state === 'paused' ? `Stopped${vm.reason && vm.reason !== 'stopped' ? ': ' + esc(vm.reason) : ''}. It carries on where it left off.`
    : 'Ready.';
  const state = !set.on ? ['idle', 'Off'] : running ? ['ok', 'Listening'] : vm.state === 'done' ? ['ok', 'Up to date'] : ['idle', 'Paused'];
  const lib = libTrackCount(), heard = (typeof listenHeard === 'function' ? listenHeard() : 0) || vm.heard || 0;
  const bar = running && tidy ? `<progress class="lp-bar" max="${vm.tidy.total}" value="${Math.min(vm.tidy.done, vm.tidy.total)}"></progress>`
    : running && vm.total ? `<progress class="lp-bar" max="${vm.total}" value="${vm.done}"></progress>` : '';
  return `<div id="audioPanel" class="lp">
    <p class="lp-state"><span class="tag ${state[0]}">${state[1]}</span>
      <span class="lp-heard">${heard ? `Heard ${heard.toLocaleString()}${lib >= heard ? ` of ${lib.toLocaleString()}` : ''} track${(lib >= heard ? lib : heard) === 1 ? '' : 's'} so far.` : 'Nothing heard yet.'}</span></p>
    <p class="srcline">Places tracks by how they sound against your own playlists, not only by tags. It is on unless you untick it.${infoBtn('listen', 'Listening', `<p>Betterfy listens to a 20-second sample of each track (two short windows of Deezer’s
      30-second preview, found by the track’s ISRC) and remembers what it sounds like. The audio is never stored, only a
      ~2.5 KB summary on this device. Switching it on downloads the listening model once (about 37 MB),
      then about 330 KB per track. “What I’m playing + unfiled” also hears up to 20 tracks from each genre
      playlist, so there is something to compare the rest against.</p>`)}</p>
    <div class="lp-opts">
      <label class="lp-opt"><input type="checkbox" id="audioOn" ${set.on ? 'checked' : ''}> Listen to my music</label>
      <label class="lp-opt"><input type="checkbox" id="audioWifi" ${set.wifiOnly ? 'checked' : ''}> Only on Wi-Fi, so it never uses mobile data</label>
      <label class="lp-opt lp-sel">Listen to <select id="audioScope" aria-label="Which tracks to listen to">${Object.entries(scopes).map(([k, v]) =>
        `<option value="${k}" ${set.scope === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
    </div>
    <div class="rowbtns">${running ? '<button class="b" id="audioStop">Stop</button>'
        : set.on ? '<button class="b p" id="audioGo">Listen now</button>' : ''}</div>
    ${set.on && vm.reason === 'ask' ? `<p class="sub lp-note">This browser doesn’t say whether it is on Wi-Fi.
      <button class="b sm" id="audioWifiYes">I’m on Wi-Fi, go ahead</button></p>` : ''}
    <p class="sub lp-note" id="audioStatus">${status}</p>${bar}
    ${listenPill(vm)}
    ${missedList(vm) || (nMissed ? `<details class="sub lp-note"><summary>${nMissed.toLocaleString()} track${nMissed === 1 ? '' : 's'} couldn’t be heard</summary>
      <ul>${missed.map(([k, n]) => `<li><b>${n.toLocaleString()}</b> ${esc(missText[k] ?? k)}</li>`).join('')}</ul></details>` : '')}
    ${AUDIO.err ? `<p class="sub">${esc(SCREEN_MODS.settings?.plainProblem?.(AUDIO.err) || AUDIO.err)}</p>` : ''}
    ${set.on ? deepPanelHTML() : ''}
  </div>`;
}

/* The two Option C ears, each its own switch, both Wi-Fi only. MAEST (WP-C1)
 * and CLAP (WP-C2) each add their status line inside this block. */
function deepPanelHTML() {
  const d = deepSettings();
  const why = ear => { const a = deepAllowed(ear); return d[ear] && a !== 'ok' && a !== 'off'
    ? `<p class="sub lp-note">${esc(globalThis.BetterfyAudio?.DEEP_TEXT?.[a] ?? a)}</p>` : ''; };
  return `<div id="deepPanel" class="lp-deep">
    <h3 id="src-deep-h">Deep listen</h3>
    <p class="srcline">Finer listening for a computer on Wi-Fi. Each part downloads once, only on Wi-Fi, and is on until you untick it.</p>
    <div class="lp-opts">
      <label class="lp-opt"><input type="checkbox" id="deepMaest" ${d.maest ? 'checked' : ''}> A second ear for genre (about 90 MB)</label>
      <label class="lp-opt"><input type="checkbox" id="deepClap" ${d.clap ? 'checked' : ''}> Search by description, like “warm dub techno” (about 77 MB)</label>
      <label class="lp-opt"><input type="checkbox" id="deepBeats" ${d.beats ? 'checked' : ''}> Better tempo, fixing half-time and double-time mix-ups (about 10 MB)</label>
      <label class="lp-opt"><input type="checkbox" id="deepMemory" ${d.memoryOverride ? 'checked' : ''}> This computer has 8 GB of memory or more</label>
    </div>
    ${why('maest')}${d.maest ? maestLineHTML() : ''}${why('clap')}${clapStatusHTML(d)}${why('beats')}${beatsStatusHTML(d)}
  </div>`;
}

function maestLineHTML() {
  const v = AUDIO.maestVm, run = v?.state === 'running';
  const text = globalThis.BetterfyAudio?.maestStatusText ? BetterfyAudio.maestStatusText(v) : '';
  const ok = deepAllowed('maest') === 'ok';
  return `<p class="sub lp-note" id="maestStatus">${esc(text)}
    ${run ? '<button class="b sm" id="maestStop">Stop</button>' : v?.state === 'waiting' ? '' : ok && audioSettings().on ? '<button class="b sm" id="maestGo">Listen with the second ear now</button>' : ''}
    ${deepAllowed('maest') === 'unknown' ? '<button class="b sm" id="audioWifiYes">I’m on Wi-Fi, go ahead</button>' : ''}</p>
    <p class="sub lp-note">It changes no suggestion until a score (under “Your score & how it picks”) shows it places your tracks better than the first ear.</p>`;
}

/** Beat This's line: how many octave-unsure tempos it has re-listened to. Nothing while off. */
function beatsStatusHTML(d) {
  if (!d.beats || deepAllowed('beats') !== 'ok' || !globalThis.BetterfyAudio?.needsBeatsFlagged) return '';
  const flagged = [...(AUDIO.records?.values() ?? [])].filter(r => !r.miss && r.dsp?.octaveAmbiguous === true);
  const left = flagged.filter(r => BetterfyAudio.needsBeatsFlagged(r)).length;
  return `<p class="sub lp-note">${left ? `${left.toLocaleString()} track${left === 1 ? '' : 's'} where half or double time was unsure still to re-check, ${BetterfyAudio.BEATS_FILL_PER_RUN} more each time it listens.` : 'Every tempo that was unsure between half and double time has been re-checked.'} Tempos that were already clear are left alone. The model is about 10 MB, downloaded once.</p>`;
}

/** CLAP's line in the Deep listen block: how many heard tracks it has described. Nothing while off. */
function clapStatusHTML(d) {
  if (!d.clap || deepAllowed('clap') !== 'ok' || !globalThis.BetterfyAudio?.needsClap) return '';
  const heard = [...(AUDIO.records?.values() ?? [])].filter(r => !r.miss);
  const done = heard.filter(r => !BetterfyAudio.needsClap(r)).length;
  return `<p class="sub lp-note">Described ${done.toLocaleString()} of ${heard.length.toLocaleString()} heard track${heard.length === 1 ? '' : 's'}${
    done < heard.length ? `, ${BetterfyAudio.CLAP_FILL_PER_RUN} more each time it listens` : ''}. The model is about 77 MB, downloaded once.</p>`;
}
