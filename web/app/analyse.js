/* ===========================================================================
 * "Analyse my library" — one tap (docs/BUILD-5-PLAN.md, owner's ask).
 *
 * One button runs the two things that make File's suggestions good, in the
 * background and under one status line: the tag gaps are filled (enrichMissing
 * already goes in listening order) and listening to the liked songs is started
 * (audioStart, on by default). When the tags are in, it opens File, where the
 * playlist and genre/mood/BPM suggestions already live. Nothing here writes to
 * Spotify, and nothing is asked of anyone without a key or without data: with
 * no Last.fm key it only listens, and with nothing to do it only routes.
 *
 * analyseRun() takes its collaborators as `d` so it can be tested with stubs;
 * analyseGo()/analyseAuto() wire the real ones.
 * ======================================================================== */
const ANALYSE = { running: false, tags: [0, 0], listen: null, timer: null };

/** Artists whose tags are thin — the same gap enrichMissing() fills. */
function analyseGapCount() {
  if (typeof LIB === 'undefined' || !LIB) return 0;
  const ids = new Set();
  const gap = id => (TAGS[id]?.tags?.length ?? 0) < REASK_TAG_FLOOR || TAGS[id]?.source === 'wikidata';
  for (const p of LIB.playlists) for (const t of p.tracks) for (const a of t.artists ?? []) if (a.id && gap(a.id)) ids.add(a.id);
  for (const t of LIB.liked) for (const a of t.artists ?? []) if (a.id && gap(a.id)) ids.add(a.id);
  return ids.size;
}

/** "Reading tags 120/400 · listening 37/412", from whatever has started. */
function analyseStatus(st) {
  const parts = [];
  const [td, tt] = st.tags ?? [0, 0];
  if (tt) parts.push(`Reading tags ${td.toLocaleString()}/${tt.toLocaleString()}`);
  const l = st.listen;
  if (l && l.total) parts.push(`listening ${Math.min(l.done ?? 0, l.total).toLocaleString()}/${l.total.toLocaleString()}`);
  else if (l?.state === 'paused') parts.push('listening waits for Wi-Fi');
  return parts.length ? parts.join(' · ') : 'Starting…';
}

/** Is there something worth offering? Gaps to fill, or listening that has not run. */
function analyseWanted(d = {}) {
  const gaps = (d.gaps ?? analyseGapCount)();
  const ran = (d.listenRan ?? (() => typeof listenEverRan === 'function' && listenEverRan()))();
  const canListen = (d.canListen ?? (() => audioSettings().on))();
  return { gaps, listen: canListen && !ran, any: (!!(d.key ?? lfmKey)() && gaps > 0) || (canListen && !ran) };
}

/**
 * Run it. Resolves with what was done; never throws (a failed half just stops).
 * `d`: key(), gaps(), enrich({quiet,onProgress}), listen(), listenVM(), status(st), go(view).
 */
async function analyseRun(d, { route = true } = {}) {
  if (ANALYSE.running) return { skipped: true };
  ANALYSE.running = true; ANALYSE.tags = [0, 0]; ANALYSE.listen = null;
  const push = () => d.status?.({ tags: ANALYSE.tags, listen: ANALYSE.listen, running: true });
  const out = { tags: false, listen: false };
  try {
    // Listening first: it runs by itself while the tags are read.
    try { await d.listen(); out.listen = true; } catch { /* its own error shows on Sources */ }
    const poll = () => { ANALYSE.listen = d.listenVM?.() ?? null; push(); };
    ANALYSE.timer = setInterval(poll, 600); poll();
    if (d.key() && d.gaps() > 0) {
      await d.enrich({ quiet: true, onProgress: (n, t) => { ANALYSE.tags = [n, t]; push(); } });
      out.tags = true;
    }
    poll();
  } catch { /* leave whatever finished */ }
  finally {
    clearInterval(ANALYSE.timer); ANALYSE.timer = null; ANALYSE.running = false;
    d.status?.({ tags: ANALYSE.tags, listen: ANALYSE.listen, running: false });
  }
  if (route) d.go('inbox');
  return out;
}

function analyseDeps() {
  return {
    key: lfmKey, gaps: analyseGapCount,
    enrich: o => enrichMissing(o),
    listen: () => audioStart({ quiet: true }),
    listenVM: () => AUDIO.vm,
    status: st => {
      const el = document.getElementById('analyseStrip');
      if (el) { el.hidden = !st.running; el.querySelector('.txt').textContent = analyseStatus(st); }
      const b = document.getElementById('analyseGo'); if (b) b.disabled = !!st.running;
    },
    go: v => { if (view === 'inbox') go(v); },
  };
}

/** The button. */
function analyseGo() { LS.setItem('bf_analysed', '1'); return analyseRun(analyseDeps()); }

/** Once, after the first load with a key: the same run, without taking the screen away. */
function analyseAuto() {
  if (LS.getItem('bf_analysed') || !lfmKey() || ANALYSE.running) return;
  if (!analyseWanted().any) return;
  LS.setItem('bf_analysed', '1');
  analyseRun(analyseDeps(), { route: false });
}

/** Home's button and its progress strip. Empty when there is nothing to offer. */
function analyseHTML() {
  if (ANALYSE.running) return `<div class="analyse" id="analyseStrip" role="status" aria-live="polite"><span class="txt">${esc(analyseStatus({ tags: ANALYSE.tags, listen: ANALYSE.listen }))}</span></div>`;
  if (!analyseWanted().any) return '';
  return `<div class="analyse"><button class="b p" id="analyseGo" data-act="analyseGo">Analyse my library</button>
    ${LS.getItem('bf_analysed') ? '' : `<span class="d">Reads tags and listens to your liked songs, then suggests where each goes.</span>`}</div>
    <div class="analyse" id="analyseStrip" role="status" aria-live="polite" hidden><span class="txt"></span></div>`;
}
