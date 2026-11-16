/** Redraw only the panel, and only while it is on screen: progress ticks every few seconds. */
let AUDIO_DRAW = 0;
function audioRedraw() {
  setListen(AUDIO.vm);
  if (!settingsOpen() || S.uhOpen !== 'sources') return;
  if (AUDIO_DRAW) return;
  AUDIO_DRAW = requestAnimationFrame(() => {
    AUDIO_DRAW = 0;
    const el = document.getElementById('audioPanel');
    if (el) el.outerHTML = audioPanelHTML();
  });
}

/** What the queue should hear next, in order, cut to the chosen scope. */
async function audioTracks() {
  const A = BetterfyAudio, set = audioSettings();
  let listening = null;
  try { listening = await getListening(); } catch { listening = null; }
  const targets = Object.entries(CFG ?? {}).filter(([, c]) => c.target).map(([id]) => id);
  const isMirror = p => isMirrorPlaylist(p);
  const store = AUDIO.records ?? new Map();
  const allowed = A.scopeIds(LIB, { scope: set.scope, listening, targets, isMirror });
  const ids = A.audioQueue(LIB, { listening, store, mel: A.MEL_VERSION, targets, isMirror })
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
  try { return matchMedia('(pointer: fine)').matches && !(navigator.maxTouchPoints > 0); } catch { return false; }
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
  // Listening has the store: the second ear starts again when that run ends.
  if (AUDIO.ctrl?.running) return;
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
    onChange: vm => { AUDIO.maestVm = vm; audioRedraw(); },
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
  const status = !set.on ? 'Off.'
    : running ? (vm.total ? `Listening… ${vm.done.toLocaleString()} of ${vm.total.toLocaleString()} this run.` : 'Starting…')
      + (vm.reason && vm.reason !== 'stopped' ? ` (${esc(vm.reason)})` : '')
    : vm.reason === 'ask' ? ''
    : vm.reason === 'waiting for Wi-Fi' ? 'Paused: waiting for Wi-Fi.'
    : vm.reason === 'offline' ? 'Paused: offline.'
    : vm.state === 'done' ? 'Up to date for this scope.'
    : vm.state === 'paused' ? `Stopped${vm.reason && vm.reason !== 'stopped' ? ': ' + esc(vm.reason) : ''}. It carries on where it left off.`
    : 'Ready.';
  return `<div id="audioPanel">
    <div class="srchead"><h2 id="src-listening-h">Listen to my music</h2><span class="tag ${!set.on ? 'idle' : running || vm.state === 'done' ? 'ok' : 'idle'}">${
      !set.on ? 'Off' : running ? 'Listening' : vm.state === 'done' ? 'Up to date' : 'Paused'}</span></div>
    <p class="srcline">Places tracks by how they sound against your own playlists, not only by tags. On by default; untick it to stop.</p>
    ${infoBtn('listen', 'Listening', `<p>Betterfy listens to a 20-second sample of each track (two short windows of Deezer’s
      30-second preview, found by the track’s ISRC) and remembers what it sounds like. The audio is never stored, only a
      ~2.5 KB summary on this device. Switching it on downloads the listening model once (about 37 MB),
      then about 330 KB per track. “What I’m playing + unfiled” also hears up to 20 tracks from each genre
      playlist, so there is something to compare the rest against.</p>`)}
    <div class="rowbtns" style="margin-bottom:8px;align-items:center;flex-wrap:wrap">
      <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="audioOn" ${set.on ? 'checked' : ''}> Listen to my music</label>
      <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="audioWifi" ${set.wifiOnly ? 'checked' : ''}> Wi-Fi only</label>
      <select id="audioScope" aria-label="Which tracks to listen to">${Object.entries(scopes).map(([k, v]) =>
        `<option value="${k}" ${set.scope === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
      ${running ? '<button class="b" id="audioStop">Stop</button>'
        : set.on ? '<button class="b p" id="audioGo">Listen now</button>' : ''}
    </div>
    ${set.on && vm.reason === 'ask' ? `<p class="sub" style="margin:8px 0">This browser doesn’t say whether it is on Wi-Fi.
      <button class="b sm" id="audioWifiYes">I’m on Wi-Fi, go ahead</button></p>` : ''}
    <p class="sub" id="audioStatus" style="margin:8px 0">${status}
      ${vm.heard ? ` ${vm.heard.toLocaleString()} track${vm.heard === 1 ? '' : 's'} heard so far.` : ''}
      ${running && vm.total ? `<progress max="${vm.total}" value="${vm.done}" style="width:100%"></progress>` : ''}</p>
    ${listenPill(vm)}
    ${missedList(vm) || (nMissed ? `<details class="sub" style="margin:8px 0"><summary>${nMissed.toLocaleString()} track${nMissed === 1 ? '' : 's'} couldn’t be heard</summary>
      <ul>${missed.map(([k, n]) => `<li><b>${n.toLocaleString()}</b> ${esc(missText[k] ?? k)}</li>`).join('')}</ul></details>` : '')}
    ${AUDIO.err ? `<p class="sub">${esc(AUDIO.err)}</p>` : ''}
    ${set.on ? deepPanelHTML() : ''}
  </div>`;
}

/* The two Option C ears, each its own switch, both Wi-Fi only. MAEST (WP-C1)
 * and CLAP (WP-C2) each add their status line inside this block. */
function deepPanelHTML() {
  const d = deepSettings();
  const why = ear => { const a = deepAllowed(ear); return d[ear] && a !== 'ok' && a !== 'off'
    ? `<p class="sub" style="margin:4px 0">${esc(globalThis.BetterfyAudio?.DEEP_TEXT?.[a] ?? a)}</p>` : ''; };
  return `<div id="deepPanel" style="margin-top:12px">
    <h3 id="src-deep-h">Deep listen (laptop)</h3>
    <p class="srcline">Larger listening models, for a computer on Wi-Fi. Both are on: each downloads once, only on Wi-Fi. Untick one to skip it.</p>
    <div class="rowbtns" style="margin-bottom:8px;align-items:center;flex-wrap:wrap">
      <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="deepMaest" ${d.maest ? 'checked' : ''}> Second ear (MAEST, about 90 MB)</label>
      <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="deepClap" ${d.clap ? 'checked' : ''}> Search by description (CLAP, about 77 MB)</label>
      <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="deepMemory" ${d.memoryOverride ? 'checked' : ''}> This computer has the memory (8 GB or more)</label>
    </div>
    ${why('maest')}${d.maest ? maestLineHTML() : ''}${why('clap')}${clapStatusHTML(d)}
  </div>`;
}

function maestLineHTML() {
  const v = AUDIO.maestVm, run = v?.state === 'running';
  const text = globalThis.BetterfyAudio?.maestStatusText ? BetterfyAudio.maestStatusText(v) : '';
  const ok = deepAllowed('maest') === 'ok';
  return `<p class="sub" id="maestStatus" style="margin:4px 0">${esc(text)}
    ${run ? '<button class="b sm" id="maestStop">Stop</button>' : ok && audioSettings().on ? '<button class="b sm" id="maestGo">Listen with the second ear now</button>' : ''}
    ${deepAllowed('maest') === 'unknown' ? '<button class="b sm" id="audioWifiYes">I’m on Wi-Fi, go ahead</button>' : ''}</p>
    <p class="sub">It changes no suggestion until a Score run (More → Engine) shows it places your tracks better than the first ear.</p>`;
}

/** CLAP's line in the Deep listen block: how many heard tracks it has described. Nothing while off. */
function clapStatusHTML(d) {
  if (!d.clap || deepAllowed('clap') !== 'ok' || !globalThis.BetterfyAudio?.needsClap) return '';
  const heard = [...(AUDIO.records?.values() ?? [])].filter(r => !r.miss);
  const done = heard.filter(r => !BetterfyAudio.needsClap(r)).length;
  return `<p class="sub" style="margin:4px 0">Described ${done.toLocaleString()} of ${heard.length.toLocaleString()} heard track${heard.length === 1 ? '' : 's'}${
    done < heard.length ? `, ${BetterfyAudio.CLAP_FILL_PER_RUN} more each time it listens` : ''}. The model is about 77 MB, downloaded once.</p>`;
}
