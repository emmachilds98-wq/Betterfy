/* ---------- "What's helping your picks": the page's half (web/screens/helpers.mjs draws it) ----------
 * helpersState() reads what the page already holds, with no request.
 * helpersCheck() asks each source one small question, in parallel, through
 * the same transports the features use (sp(), deezerJsonp(), corsJson(),
 * fetch), and keeps the answers for this session. A source that is off is
 * not asked. Nothing is stored. */
const HELPERS = { checks: {}, running: false, at: null };

function helpersState() {
  let audio = { on: false };
  try {
    const set = audioSettings(), vm = AUDIO.vm;
    const why = vm?.reason && !['stopped', 'ask', 'waiting for Wi-Fi', 'offline'].includes(vm.reason) && vm.state !== 'running' && vm.state !== 'done' ? vm.reason : null;
    audio = { on: !!set.on, all: set.scope === 'all', state: vm?.state ?? null, heard: listenHeard() || vm?.heard || 0,
      problem: why ? String(why).replace(/https?:\/\/\S+/g, '').slice(0, 60).trim() : null };
  } catch { /* before the audio glue */ }
  let deep = {};
  try { const d = deepSettings(); const why = deepAllowed('maest');
    deep = { maest: d.maest, clap: d.clap, blocked: why === 'ok' || why === 'off' ? null : String(why).replace(/-/g, ' ') }; } catch { /* none */ }
  let cov = null; try { cov = tagCoverage(); } catch { /* no library */ }
  let br = null; try { const d = sourceCoverage(); br = d ? SCREEN_MODS.sources.artistCoverage(d) : null; } catch { br = null; }
  return {
    lib: LIB ? { playlists: LIB.playlists?.length ?? 0, liked: LIB.liked?.length ?? 0 } : {},
    listening: { artists: LISTENING_CACHE?.recentlyActive?.size ?? 0 },
    cov,
    lfm: { key: !!lfmKey(), own: !!LS.getItem('bf_lfm') },
    bridge: { on: typeof bridgeOn === 'function' ? bridgeOn() : true, ...(br ?? {}) },
    audio, deep,
    discogs: !!LS.getItem('bf_discogs'),
    engine: { status: typeof ENG !== 'undefined' ? ENG.status : null },
    auto: (() => { try { const l = autoScoreLast(); return { at: l?.at ?? null, ok: l?.ok !== false,
      ago: l?.at && typeof agoWords === 'function' ? agoWords(Date.now() - l.at) : null, running: AUTOSCORE_RUN.running }; }
      catch { return {}; } })(),
  };
}

const helperRowsNow = () => SCREEN_MODS.helpers.helperRows(helpersState());

/** The panel, as the Settings sheet and Sources draw it. */
function helpersPanelHTML() {
  try { return SCREEN_MODS.helpers.helpersHTML(helperRowsNow(), { ...HELPERS, esc }); }
  catch (e) { return `<p class="hint">Couldn’t list the sources: ${esc(e.message)}</p>`; }
}

/* One question per source. Each resolves true, or throws with a short reason. */
const HELPER_PROBES = {
  spotify: async () => !!(await sp('/me'))?.id,
  lastfm: async () => {
    const r = await fetch('https://ws.audioscrobbler.com/2.0/?' + new URLSearchParams({ method: 'artist.gettoptags', artist: 'Radiohead', api_key: lfmKey(), format: 'json' }));
    const j = await r.json();
    if (j?.error) throw new Error(j.message || `error ${j.error}`);
    return !!j?.toptags;
  },
  wikidata: async () => {
    await engineLoad();
    const req = BetterfyWikidata.genreRequest(['4Z8W4fKeB5YxbusRsdQVPb']);
    return !!BetterfyWikidata.genresFrom(await corsJson(req.url, req.init)).answered;
  },
  deezer: async () => { await engineLoad(); return !!(await deezerJsonp('https://api.deezer.com/artist/399'))?.id; },
  listenbrainz: async () => Array.isArray(await corsJson('https://labs.api.listenbrainz.org/similar-artists/json?' + new URLSearchParams({
    artist_mbids: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
    algorithm: 'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30' }))),
  sound: async () => {
    // The two downloads listening needs before it can hear anything: the runtime and the model.
    for (const u of [ORT_BASE + 'ort.wasm.bundle.min.mjs', audioModelUrl(AUDIO_MODEL_FILE)]) {
      const r = await fetch(u, { method: 'HEAD' });
      if (!r.ok) throw new Error(`${new URL(u).host} answered ${r.status}`);
    }
    return true;
  },
  discogs: async () => {
    const r = await fetch('https://api.discogs.com/oauth/identity', { headers: { Authorization: 'Discogs token=' + LS.getItem('bf_discogs') } });
    if (!r.ok) throw new Error(`answered ${r.status}`);
    return true;
  },
};

async function helpersCheck() {
  if (HELPERS.running) return;
  const rows = helperRowsNow();
  HELPERS.running = true; HELPERS.checks = {};
  const live = rows.filter(r => HELPER_PROBES[r.id]);
  for (const r of live) HELPERS.checks[r.id] = r.on ? { running: true } : { skip: 'off, not asked' };
  helpersRepaint();
  await Promise.all(live.filter(r => r.on).map(async r => {
    const t0 = performance.now();
    try {
      const ok = await Promise.race([HELPER_PROBES[r.id](), new Promise((_, bad) => setTimeout(() => bad(new Error('no answer in 15 s')), 15000))]);
      HELPERS.checks[r.id] = ok ? { ok: true, ms: Math.round(performance.now() - t0) } : { ok: false, err: 'unexpected answer' };
    } catch (e) {
      HELPERS.checks[r.id] = { ok: false, err: String(e?.message ?? e).replace(/https?:\/\/\S+/g, '').slice(0, 80) };
    }
    helpersRepaint();
  }));
  HELPERS.running = false; HELPERS.at = Date.now();
  helpersRepaint();
}

function helpersRepaint() {
  if (typeof underHoodRefresh === 'function') underHoodRefresh();
  try { store.touch('ui.sources'); } catch { /* before the store */ }
}

document.addEventListener('click', e => {
  if (e.target.closest?.('[data-hcheck]')) return void helpersCheck();
  const go = e.target.closest?.('[data-uhgo]');
  if (go) { S.uhOpen = go.dataset.uhgo; S.uhJump = true; if (typeof underHoodOpen === 'function') underHoodOpen(); }
});
