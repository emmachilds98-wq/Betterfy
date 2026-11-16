/* ---------- the teach queue on File (BUILD-6 SG; SMARTER-GENRES-PLAN §4.3, phase 4) ----------
 * A few one-tap questions about the waiting tracks whose answers should teach the
 * engine most (core/review/teach.mjs `teachQueue`): the Engine's checked short list
 * where it has one, else the card's own best guesses, said as such. A tap is an
 * ordinary filing through File's own path (fileCurrent: the add, its History
 * entry, the accept, and the artist roll-forward offer), so nothing new is
 * written anywhere and History's undo takes it back.
 *
 * Shown only where it is measured to help: the Score run simulates 20 answers on a
 * hidden fold of this account's own filing (core/validate/teach.mjs `teachGate`)
 * and keeps the verdict in `bf_teach`. No verdict, or one that did not beat: no
 * card, no engine download, nothing. `bf_teach_force` = '1' is the owner's flag to
 * show it anyway (read only; set it by hand). */
const TEACH_KEY = 'bf_teach';
/** Waiting tracks scored by the engine per batch: the cheap order (listening x reach) picks which. */
const TEACH_SCAN = 300;
const TEACH_UI = { status: 'idle', items: [], answered: new Set(), err: null, hidden: false };

/** Keep the Score run's teach measurement for File. */
function teachRemember(m) {
  LS.setItem(TEACH_KEY, JSON.stringify({ pass: !!m.pass, why: m.why ?? null, before: m.before ?? null, after: m.after ?? null,
                                         gain: m.gain ?? null, asked: m.asked ?? 0, scored: m.scored ?? 0, right: m.right ?? null,
                                         at: Date.now() }));
  if (!m.pass) Object.assign(TEACH_UI, { status: 'idle', items: [] });
}
/** The last measurement, or null. */
function teachMeasure() {
  try { return JSON.parse(LS.getItem(TEACH_KEY) ?? 'null'); } catch { return null; }
}
/** Whether File shows the teach questions on this account. */
function teachGateOpen() {
  let forced = false;
  try { forced = LS.getItem('bf_teach_force') === '1'; } catch { /* not forced */ }
  return forced || !!teachMeasure()?.pass;
}

/** The listening half of the order, once it has landed (fileOrderCtx's inputs). */
const teachListening = () => {
  const L = typeof LISTENING_CACHE !== 'undefined' ? LISTENING_CACHE : null;
  return { weights: L?.weights ?? null, tracks: L?.tracks ?? null };
};

/** Find the next batch: the engine's verdict on the likeliest candidates, then teachQueue. */
async function teachStart() {
  if (TEACH_UI.status === 'working') return;
  TEACH_UI.status = 'working'; TEACH_UI.err = null; store.touch('ui.inbox');
  try {
    await engineLoad();
    if (!ENG.space || ENG.status !== 'ready') await engineAnalyse();
    await engineLoadCalibration();
    const space = ENG.space;
    if (!space) throw new Error(ENG.err || 'the engine could not learn this library yet');
    const cal = ENG.calib?.base?.cal ?? null, soundCal = ENG.calib?.audio?.cal ?? cal;
    const { weights, tracks } = teachListening();
    const rows = R.backlog.filter(r => !(r.skips > 0) && !TEACH_UI.answered.has(r.id));
    // Placing every waiting track is too much for a phone on a big backlog; the
    // half of the value that needs no engine (listening x reach) picks which to place.
    const spread = artistSpread(rows);
    const pre = rows.map(r => [r, valueOf(r, { weights, tracks }) * (1 + Math.log2(spread.get(artistKeyOf(r)) ?? 1))])
      .sort((a, b) => b[1] - a[1]).slice(0, TEACH_SCAN).map(([r]) => r);
    const likedById = new Map((LIB.liked ?? []).map(t => [t.id, t]));
    const dec = new Map();
    if (cal) for (const r of pre) {
      const raw = likedById.get(r.id);
      if (!raw) continue;
      const full = BetterfyIntrinsic.placements(raw, space, withFittedWeights({ limit: Infinity, soundFirst: true }, 'plain'));
      const p = full.results?.[0]?.parts ?? {};
      const d = BetterfyCalibrate.decide(BetterfyCalibrate.scoresOf(full.results ?? []), 'audio' in p || 'learned' in p ? soundCal : cal);
      dec.set(r.id, { kind: d.kind, playlists: d.playlists.map(id => ({ id, name: CFG[id]?.name ?? space.destinations.get(id)?.name ?? id })) });
    }
    TEACH_UI.items = teachQueue(pre, { decisionOf: r => dec.get(r.id) ?? null, guesses: r => filePicks(r), weights, tracks,
                                       rejected: (r, pid) => !!FB[r.id]?.rejected?.includes(pid) });
    TEACH_UI.status = 'ready';
  } catch (e) {
    TEACH_UI.status = 'error'; TEACH_UI.err = e?.message ?? String(e);
  }
  store.touch('ui.inbox');
}

/** One tap: file this track where the listener said, through File's own path, and
 *  leave the card the deck was showing where it was. */
async function teachAnswer(id, pid) {
  const q = TEACH_UI.items.find(x => x.row.id === id);
  const at = R.backlog.findIndex(b => b.id === id);
  TEACH_UI.items = TEACH_UI.items.filter(x => x.row.id !== id);
  if (at < 0 || !pid) return render();
  const keep = R.backlog[Math.min(Math.max(S.inboxAt | 0, 0), R.backlog.length - 1)]?.id;
  TEACH_UI.answered.add(id);
  S.inboxAt = at; S.fileSel = new Set(); S.fileSelFor = id;
  await fileCurrent([pid], { via: 'teach' });
  if (R.backlog.some(b => b.id === id)) {
    // It did not land (fileCurrent said why and put the card back): ask again.
    TEACH_UI.answered.delete(id);
    if (q) TEACH_UI.items.unshift(q);
  }
  if (keep && keep !== id) S.inboxAt = Math.max(0, R.backlog.findIndex(b => b.id === keep));
  render();
}

/** The File screen's data-act="teach" buttons. */
function teachAct(el) {
  const what = el?.dataset?.teach;
  if (what === 'start' || what === 'more') return teachStart();
  if (what === 'hide') { TEACH_UI.hidden = true; return render(); }
  if (what === 'pass') {
    TEACH_UI.answered.add(el.dataset.id);
    TEACH_UI.items = TEACH_UI.items.filter(x => x.row.id !== el.dataset.id);
    return render();
  }
  if (what === 'file') return teachAnswer(el.dataset.id, el.dataset.pl);
}

/** The teach card above File's deck, or '' where it does not apply. */
function teachHTML() {
  if (TEACH_UI.hidden || S.roll || !R?.backlog?.length || typeof teachQueue !== 'function' || !teachGateOpen()) return '';
  const head = (sub, extra = '') => `<div class="teach-h"><h2 id="teachH">Teach the engine</h2>
      <button class="teach-x" data-act="teach" data-teach="hide" aria-label="Hide the teach questions" title="Hide"><span aria-hidden="true">✕</span></button>
    </div><p class="sub teach-sub">${sub}</p>${extra}`;
  const wrap = inner => `<section class="card teach" aria-labelledby="teachH">${inner}</section>`;
  if (TEACH_UI.status === 'working') return wrap(head('Finding where an answer helps most…'));
  if (TEACH_UI.status === 'error') return wrap(head(`Couldn't find questions: ${esc(TEACH_UI.err ?? '')}`,
    `<div class="rowbtns"><button class="b sm" data-act="teach" data-teach="start">Try again</button></div>`));
  if (TEACH_UI.status !== 'ready') {
    const m = teachMeasure();
    const proof = m?.pass && m.before != null ? ` On your own filed tracks, 20 answers took the engine from ${Math.round(m.before * 100)}% to ${Math.round(m.after * 100)}% right.` : '';
    return wrap(head(`A few one-tap questions about the tracks where your answer helps the engine most.${esc(proof)}`,
      `<div class="rowbtns"><button class="b sm p" data-act="teach" data-teach="start">Start</button></div>`));
  }
  if (!TEACH_UI.items.length) return wrap(head('Nothing left to ask for now.',
    `<div class="rowbtns"><button class="b sm" data-act="teach" data-teach="more">Look again</button></div>`));
  const n = TEACH_UI.items.length;
  return wrap(head(`${n} ${n === 1 ? 'question' : 'questions'}. One tap files the track there, and History can undo it.`,
    `<ol class="teach-list">${TEACH_UI.items.map(q => {
      const t = q.row;
      return `<li class="teach-q">
        <div class="teach-t"><b>${esc(t.title ?? '')}</b><span class="sub"> — ${esc(t.artist ?? '')}</span></div>
        <div class="teach-how">${q.checked ? 'The engine narrowed it to these' : 'Best guesses'}</div>
        <div class="teach-choices" role="group" aria-label="${esc(`Where does ${t.title ?? 'this track'} go?`)}">
          ${q.choices.map(c => `<button class="b sm" data-act="teach" data-teach="file" data-id="${esc(t.id)}" data-pl="${esc(c.id)}">${esc(c.name)}</button>`).join('')}
          <button class="b sm teach-pass" data-act="teach" data-teach="pass" data-id="${esc(t.id)}">Not sure</button>
        </div></li>`;
    }).join('')}</ol>`));
}
