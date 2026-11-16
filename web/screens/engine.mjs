// @bundle screens engine 30
/* The Engine screen (docs/BUILD-5-PLAN.md A4): an ES module, not a page script.
 * It touches nothing outside `ctx` (see web/README.md, "Screen modules"); the
 * ctx for it is built by SCREEN_CTX.engine in web/app/screens.js. The long
 * jobs (learn, score, the similar-artist lookups) stay in web/app/engine.js,
 * which this screen calls through ctx. */

/**
 * Phase 0's question, answered from one run: does the bridge lift tracks by
 * artists never filed in a genre playlist by at least 5 points, without
 * costing anything overall? The bar is the plan's (§7), set before anyone saw
 * a number. Null when there is nothing to judge.
 */
export function bridgeVerdict(v) {
  const w = v?.mine?.withBridge, nf = v?.mine?.neverFiled;
  if (!w || !nf) return null;
  const lift = (w.neverFiled.top1 ?? 0) - (nf.top1 ?? 0);
  const overall = (w.top1 ?? 0) - (v.mine.top1 ?? 0);
  const pts = x => `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 1000) / 10)} points`;
  if (nf.scored < 20) return { pass: null, lift, overall,
    text: `Only ${nf.scored} of the scored tracks are by artists not yet in a genre playlist — too few to judge it on.` };
  if (overall < 0) return { pass: false, lift, overall,
    text: `It helps never-filed artists by ${pts(lift)} but costs ${pts(overall)} overall, so it stays off.` };
  if (lift >= 0.05) return { pass: true, lift, overall,
    text: `${pts(lift)} on tracks by artists you hadn't filed in a genre playlist yet, and ${pts(overall)} overall.` };
  return { pass: false, lift, overall,
    text: `Not enough lift on never-filed artists (${pts(lift)}; the bar is +5 points), so it stays off.` };
}

/** One track's checked answer, for the comparison's "this engine" column. */
export function decisionHtml(d, esc) {
  const names = d.playlists.map(x => `<b>${esc(x.name)}</b>`);
  if (d.kind === 'confident') return `${names[0]} <span class="tag ok">confident</span>`;
  if (d.kind === 'choose' && names.length === 1) return `${names[0]} <span class="tag">probably</span>`;
  if (d.kind === 'choose') return `${names.join(' or ')} <span class="tag warn">pick one</span>`;
  return '<i>not sure</i>';
}

/** One line per calibration, for the pasteable summary. */
function calibLine(label, rep, pc) {
  const c = rep?.checked;
  if (!c?.n) return null;
  const conf = rep.cal?.tau != null && c.confidentN
    ? `confident ${pc(c.confidentShare)} of tracks, right ${pc(c.confidentRight)}` : 'confident: none earned yet';
  return `${label}: ${conf}; short list ${pc(c.chooseShare)} (avg ${c.chooseSize ?? '—'}), held it ${pc(c.chooseContains)}; `
    + `not sure ${pc(c.unsureShare)}${rep.holds === true ? '; holds' : rep.holds === false ? "; doesn't hold yet" : ''}`;
}

/** "How sure it is", checked on tracks the thresholds were not fitted on. */
function calibCard(p, calib) {
  const c = calib;
  if (!c?.base?.checked?.n) return '';
  const k = c.base.checked, earned = c.base.cal?.tau != null && k.confidentN > 0;
  const verdict = c.base.holds === true
    ? `<b>Holds.</b> When it said "confident" it was right ${p(k.confidentRight)} of the time, on tracks those thresholds were never fitted on. The target is ${p(c.base.target)}.`
    : c.base.holds === false
    ? `<b>Doesn't hold yet.</b> "Confident" was right ${p(k.confidentRight)} on tracks it hadn't been fitted on, short of the ${p(c.base.target)} it has to mean, so read those as "probably".`
    : `<b>Nothing is sure enough to call confident yet.</b> No score level was right ${p(c.base.target)} of the time on enough of your tracks. More filed tracks per playlist, or a stronger signal, would change that. The short lists are where it helps for now.`;
  const b = c.bridge?.checked;
  return `<h3 style="margin:18px 0 6px; font-size:16px">How sure it is, checked</h3>
    <p class="why">Fitted on half of the tracks above and checked on the other half, then swapped, so these
      numbers come from tracks it wasn't tuned on. Each track gets one of three answers; the share of
      tracks given each is on the right.</p>
    <div class="facts" style="margin-top:10px">
      ${earned ? `<div><span><b>Confident</b>: names one playlist</span><b class="mono">${p(k.confidentShare)}</b></div>
      <div><span>…and was right</span><b class="mono">${p(k.confidentRight)}</b></div>` : ''}
      <div><span><b>Short list</b>, ${k.chooseSize == null ? '—' : k.chooseSize.toFixed(1)} playlists on average</span><b class="mono">${p(k.chooseShare)}</b></div>
      <div><span>…and the right one was in it</span><b class="mono">${p(k.chooseContains)}</b></div>
      <div><span><b>Not sure</b>, and says so instead of guessing</span><b class="mono">${p(k.unsureShare)}</b></div>
      ${b?.n ? `<hr><div><span>With similar artists: short list / not sure</span><b class="mono">${p(b.chooseShare)} / ${p(b.unsureShare)}</b></div>
      ${c.bridge.cal?.tau != null && b.confidentN ? `<div><span>…confident, and right</span><b class="mono">${p(b.confidentShare)}, ${p(b.confidentRight)}</b></div>` : ''}` : ''}
    </div>
    <p class="why" style="margin-top:12px">${verdict}</p>`;
}

/** The with/without comparison on the score card. Empty when there is none. */
function bridgeCard(v, p, esc) {
  if (!v || v.error) return '';
  if (v.bridgeOff) return '';
  const w = v.mine?.withBridge;
  if (!w) return v.bridgeErr ? `<p class="why" style="margin-top:14px">Similar artists couldn't be looked up
    (${esc(v.bridgeErr)}), so this was scored without them.</p>` : '';
  const nf = v.mine.neverFiled, c = w.coverage ?? {}, verdict = bridgeVerdict(v);
  return `<h3 style="margin:18px 0 6px; font-size:16px">Adding similar artists</h3>
    <p class="why">Deezer's "fans also like" and ListenBrainz's listening sessions say who sits near each artist.
      They never name a genre: only where <b>you</b> filed those neighbours counts. Same tracks, same folds as above.</p>
    <div class="facts" style="margin-top:10px">
      <div><span><b>With similar artists</b> — right first time</span><b class="mono">${p(w.top1)}</b></div>
      <div><span>…without</span><b class="mono">${p(v.mine.top1)}</b></div>
      <hr>
      <div><span>Tracks by artists not in any genre playlist yet</span><b class="mono">${nf.scored.toLocaleString()}</b></div>
      <div><span>…right first time, with similar artists</span><b class="mono">${p(w.neverFiled.top1)}</b></div>
      <div><span>…without</span><b class="mono">${p(nf.top1)}</b></div>
      <hr>
      <div><span>Artists looked up</span><b class="mono">${(c.asked ?? 0).toLocaleString()}</b></div>
      <div><span>…with neighbours in your library</span><b class="mono">${(c.withNeighbours ?? 0).toLocaleString()}</b></div>
      <div><span>Tracks it had a say on</span><b class="mono">${w.judged.toLocaleString()}</b></div>
      ${v.bridgeStats?.quota ? `<p>Deezer asked the app to slow down partway, so some artists weren't looked up this time.
        Running it again later picks up where it stopped.</p>` : ''}
    </div>
    ${verdict ? `<p class="why" style="margin-top:12px"><b>${verdict.pass === true ? 'Helps.' : verdict.pass === false ? 'Not yet.' : 'Undecided.'}</b>
      ${esc(verdict.text)}</p>` : ''}`;
}

/**
 * Sound against the same folds (WP-E2). Empty until a run was given audio
 * records. The verdict is the engine's own (core/validate/gate.mjs), carried
 * on the run: until it passes, sound is shown here and changes no suggestion.
 */
/**
 * One metric as a pair of bars, without sound and with it, on the same scale
 * (UI-BUILD-PLAN §2.9). `line` draws the gate's bar on the with-sound track:
 * where with-sound has to reach for this metric to count as earning it.
 */
function pairBars(esc, label, without, withSound, p, line = null, names = ['without', 'with sound']) {
  if (without == null || withSound == null) return '';
  const clamp = x => Math.max(0, Math.min(1, x));
  const d = Math.round((withSound - without) * 1000) / 10;
  const delta = d === 0 ? 'level' : `${d > 0 ? '+' : '−'}${Math.abs(d)} points`;
  const met = line ? withSound + 1e-9 >= line.at : null;
  return `<div class="pair" role="img" aria-label="${esc(label)}: ${p(without)} ${esc(names[0])}, ${p(withSound)} ${esc(names[1])}${
      line ? `; ${esc(line.label)} at ${p(line.at)}` : ''}">
    <div class="pair-h"><span>${esc(label)}</span><span class="pair-d mono ${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${delta}</span></div>
    <div class="pbar"><span class="pl">${esc(names[0])}</span><span class="trk"><i style="--v:${clamp(without).toFixed(4)}"></i></span><b class="mono">${p(without)}</b></div>
    <div class="pbar with"><span class="pl">${esc(names[1])}</span><span class="trk"><i style="--v:${clamp(withSound).toFixed(4)}"></i>${
      line ? `<s class="gate ${met ? 'met' : ''}" style="--g:${clamp(line.at).toFixed(4)}" title="${esc(line.label)}"></s>` : ''}</span><b class="mono">${p(withSound)}</b></div>
  </div>`;
}

export function audioCard(v, p, esc, maestScoreText) {
  const w = v && !v.error ? v.mine?.withAudio : null;
  if (!w) return '';
  const nf = v.mine.neverFiled, g = w.gate ?? {};
  const lift = g.bar?.minLift ?? 0.05;
  const liftPts = Math.round(lift * 100);
  const tone = g.pass === true ? 'ok' : g.pass === false ? 'warn' : 'idle';
  return `<div class="sndscore">
    <h3 style="margin:18px 0 6px; font-size:16px">Adding how it sounds</h3>
    <p class="why">Each playlist's sound is learned from the tracks you filed there that have been listened to.
      A track never hears itself: same tracks, same folds as above.</p>
    <div class="pairs">
      ${pairBars(esc, 'Right first time, every scored track', v.mine.top1, w.top1, p,
        v.mine.top1 != null ? { at: v.mine.top1, label: 'no loss overall' } : null)}
      ${pairBars(esc, 'Right first time, artists not in any genre playlist yet',
        nf.top1, w.neverFiled?.top1, p, nf.top1 != null ? { at: nf.top1 + lift, label: `+${liftPts} points` } : null)}
    </div>
    <p class="gateline"><s class="gate" aria-hidden="true"></s><span>The bar it has to clear: <b>+${liftPts} points</b> right first
      time on never-filed artists, and no loss overall. ${w.soundFirst
        ? 'The File screen leads with sound for heard tracks either way (your call); this is how that measures up on your own filing.'
        : 'Below it, sound is shown but changes no suggestion.'}</span></p>
    <div class="facts" style="margin-top:10px">
      <div><span>Tracks by artists not in any genre playlist yet</span><b class="mono">${nf.scored.toLocaleString()}</b></div>
      <div><span>Scored tracks listened to</span><b class="mono">${w.heard.toLocaleString()} of ${v.mine.scored.toLocaleString()}</b></div>
      <div><span>…of them by never-filed artists</span><b class="mono">${w.heardNeverFiled.toLocaleString()}</b></div>
      <div><span>Top answers sound changed</span><b class="mono">${w.changed.toLocaleString()}</b></div>
    </div>
    <p class="why gateverdict" style="margin-top:12px"><span class="tag ${tone}">${g.pass === true ? 'passed' : g.pass === false ? 'not passed' : 'undecided'}</span>
      <b>${w.soundFirst
        ? (g.pass === true ? 'Helps.' : g.pass === false ? 'Not ahead of tags yet on your filing; sound still leads, by your call.' : 'Undecided; sound still leads, by your call.')
        : (g.pass === true ? 'Helps, so it now has a say.' : g.pass === false ? 'Not yet, so it only shows.' : 'Undecided, so it only shows.')}</b>
      ${esc(g.text ?? '')}</p>
    ${w.arms?.maest && maestScoreText ? `<p class="why" id="maestScore" style="margin-top:8px">${esc(maestScoreText(w))}</p>` : ''}
    ${identifyHTML(v.identify, p, esc)}
  </div>`;
}

/** How well it names genres by sound, on tracks you've already filed (core/audio/identify.mjs). */
function identifyHTML(a, p, esc) {
  if (!a?.scored) return '';
  return `<h3 style="margin:18px 0 6px; font-size:16px">Naming genres by sound</h3>
    <p class="why">Each heard track in a genre playlist whose name says a genre, named from its sound with itself
      left out: the sound model's styles, the filed tracks it sounds most like, its artist's tags, and its tempo.</p>
    <div class="pairs">
      ${pairBars(esc, 'Genre right (Drum & Bass, House…)', a.modelOnly.genre, a.genre, p, null, ['model alone', 'with your library'])}
      ${pairBars(esc, 'Sub-genre right too (Jungle, Donk…)', a.modelOnly.specific, a.specific, p, null, ['model alone', 'with your library'])}
    </div>
    <div class="facts" style="margin-top:10px">
      <div><span>Tracks scored</span><b class="mono">${a.scored.toLocaleString()}</b></div>
      ${a.tempo != null ? `<div><span>Tempo fits the playlist's genre</span><b class="mono">${p(a.tempo)} of ${a.tempoJudged.toLocaleString()}</b></div>` : ''}
      ${a.byGenre.map(g => `<div><span>${esc(g.name)}</span><b class="mono">${g.right} of ${g.n}</b></div>`).join('')}
    </div>`;
}

/** The playlists the engine understands least: offered in its top three least
 *  often for tracks that really are in them. Five or more tracks, so one odd
 *  record cannot put a playlist on the list by itself. */
export function weakBuckets(v, LIB, n = 5) {
  const names = new Map((LIB?.playlists ?? []).map(p => [p.id, p.name]));
  return (v?.mine?.playlists ?? [])
    .filter(b => b.n >= 5 && b.inTop3 != null)
    .slice(0, n)                       // already sorted weakest first
    .map(b => ({ ...b, name: names.get(b.id) ?? b.id }));
}

/**
 * The score as plain text, to paste into a message.
 *
 * Deliberately carries no track or artist names — only counts, rates and the
 * names of the user's own weakest playlists — so pasting it somewhere shares
 * how the engine did, not what the library holds beyond that.
 */
export function summary({ ENG, LIB, maestScoreText, measureLines, TUNE, tuneBlock }, log) {
  const v = ENG.val, r = ENG.rung;
  if (!v || v.error) return '';
  const pc = x => x == null ? '—' : Math.round(x * 100) + '%';
  const lines = [
    `Betterfy engine score — build __BUILD__`,
    `Library: ${LIB.playlists.length} playlists, ${(LIB.liked ?? []).length} liked songs`,
    r ? `Rung: ${r.name} — ${r.reason}` : null,
    r ? `Destinations ${r.destinations}, artists with neighbours ${r.artistsConnected}, in 2+ playlists ${pc(r.connectedShare)}` : null,
    `This engine: top-1 ${pc(v.mine.top1)}, top-3 ${pc(v.mine.top3)} (${v.mine.scored} tracks)`,
    ...weightsLines(v, pc),
    v.base ? `Today's engine: top-1 ${pc(v.base.top1)}, top-3 ${pc(v.base.top3)}${v.base.noAnswer ? `, no tags for ${v.base.noAnswer}` : ''}`
           : `Today's engine: not scored (no tag data loaded)`,
    v.mine.declined ? `Declined: ${v.mine.declined}, of which would have been right: ${v.mine.declinedWouldHaveBeenRight ?? 0}` : null,
    weakBuckets(v, LIB).length ? `Weakest: ${weakBuckets(v, LIB).map(b => `${b.name} ${pc(b.inTop3)} of ${b.n}`).join('; ')}` : null,
    ENG.pairs?.length ? `Can't tell apart: ${ENG.pairs.length} pair${ENG.pairs.length === 1 ? '' : 's'}` : null,
    v.mine.neverFiled ? `Never-filed artists: ${v.mine.neverFiled.scored} tracks, top-1 ${pc(v.mine.neverFiled.top1)}` : null,
    ...bridgeLines(v, pc),
    ...blendLines(v, pc),
    ...audioLines(v, pc, maestScoreText),
    calibLine('How sure', ENG.calib?.base, pc),
    calibLine('How sure, with similar artists', ENG.calib?.bridge, pc),
    calibLine('How sure, with sound', ENG.calib?.audio, pc),
    fillLine(v.fill, pc),
    teachLine(v.teach, pc),
    ...(log && measureLines ? measureLines(log) : []),
    `Took ${(v.ms / 1000).toFixed(1)}s ${v.where === 'worker' ? 'in the background' : 'on the page'}`,
  ];
  if (TUNE?.res && tuneBlock) lines.push('', tuneBlock(TUNE.res));
  return lines.filter(Boolean).join('\n');
}

/** Fill this playlist's gate (BUILD-6 F2, M4): hidden tracks found again in a playlist's top 10. Counts only. */
export function fillLine(f, pc) {
  if (!f || f.recall == null) return null;
  return `Fill this playlist: recall@10 ${pc(f.recall)} over ${f.playlists} playlists (random ${pc(f.random)}, bar ${pc(f.bar)}) — ${
    f.pass ? 'shown in Library' : 'off (behind a flag)'}`;
}
function fillRow(f, p) {
  if (!f || f.recall == null) return '';
  return `<div class="fillscore"><span><b>Fill this playlist</b> — hidden tracks back in the top 10 <span class="sub">· ${f.playlists} playlists, random ${p(f.random)}, needs ${p(f.bar)}${
    f.pass ? '' : ', so it stays off'}</span></span><b class="mono">${p(f.recall)}</b></div>`;
}

/** The teach questions' gate (BUILD-6 SG): 20 simulated answers on a hidden fold of your own filing. */
export function teachLine(t, pc) {
  if (!t) return null;
  if (t.before == null) return `Teach questions: off (${t.why})`;
  return `Teach questions: top-1 ${pc(t.before)} -> ${pc(t.after)} after ${t.asked} simulated answers, ${t.scored} hidden tracks — ${
    t.pass ? 'shown on File' : `off (${t.why})`}`;
}
function teachRow(t, p) {
  if (!t || t.before == null) return '';
  return `<div class="fillscore"><span><b>Teach questions</b> — right first time after 20 answers <span class="sub">· was ${p(t.before)}${
    t.pass ? ', so File asks them' : ', not enough better, so they stay off'}</span></span><b class="mono">${p(t.after)}</b></div>`;
}

/** "×4" for a multiplier, "off" for zero. */
const timesText = m => (m === 0 ? 'off' : `×${m}`);

/** The fitted weights as words: what each group was multiplied by. */
function multipliersText(m, withBridge) {
  if (!m) return '';
  const bits = [`artist graph ${timesText(m.graph)}`, `label ${timesText(m.registrant)}`, `record shape ${timesText(m.shape)}`];
  if (withBridge) bits.push(`similar artists ${timesText(m.bridge)}`);
  if (m.graphN) bits.push(`graph, wide playlists evened ${timesText(m.graphN)}`);
  return bits.join(', ');
}

/** The weight fit's part of the pasteable summary (core/validate/weights.mjs). */
function weightsLines(v, pc) {
  const f = v.weights;
  if (!f?.plain) return [];
  const line = (label, x, withBridge) => x ? `${label}: top-1 ${pc(x.fitted.top1)}, top-3 ${pc(x.fitted.top3)} `
    + `(default weights ${pc(x.default.top1)} / ${pc(x.default.top3)}); ${multipliersText(x.multipliers, withBridge)} — `
    + (x.use ? 'used' : 'not a point ahead, defaults kept') : null;
  return [
    line('This engine, weights fitted to your filing', f.plain, false),
    line('With similar artists, weights fitted', f.bridge, true),
  ].filter(Boolean);
}

/** The weight fit on the score card. Empty without one. */
function weightsCard(v, p, esc) {
  const f = v && !v.error ? v.weights : null;
  if (!f?.plain) return '';
  const names = ['default', 'fitted'];
  const one = (title, x, withBridge) => !x ? '' : `
    <div class="pairs">
      ${pairBars(esc, `${title} — right first time`, x.default.top1, x.fitted.top1, p, null, names)}
      ${pairBars(esc, `${title} — in the top three`, x.default.top3, x.fitted.top3, p, null, names)}
    </div>
    <p class="why" style="margin-top:6px"><span class="tag ${x.use ? 'ok' : 'idle'}">${x.use ? 'used' : 'not used'}</span>
      ${esc(multipliersText(x.multipliers, withBridge))}.</p>`;
  return `<h3 style="margin:18px 0 6px; font-size:16px">Weights fitted to your filing</h3>
    <p class="why">How much the artist graph, the label, the record's shape${f.bridge ? ' and similar artists' : ''} each
      count, chosen on four folds of your filed tracks and scored on the fifth, five times over — so "fitted" is on
      tracks the weights weren't tuned on. They're only used when that beats the defaults by a point.</p>
    ${one('This engine', f.plain, false)}
    ${one('With similar artists', f.bridge, true)}`;
}

/** The bridge's part of the pasteable summary. Counts and rates only. */
function bridgeLines(v, pc) {
  if (v.bridgeOff) return ['Similar artists: switched off'];
  if (v.bridgeErr && !v.mine.withBridge) return [`Similar artists: lookup failed (${v.bridgeErr})`];
  const w = v.mine.withBridge;
  if (!w) return [];
  const c = w.coverage ?? {}, st = v.bridgeStats ?? {}, verdict = bridgeVerdict(v);
  return [
    `With similar artists: top-1 ${pc(w.top1)}, top-3 ${pc(w.top3)} (weight ${w.weight})`,
    `Never-filed artists with similar artists: top-1 ${pc(w.neverFiled.top1)} (without ${pc(v.mine.neverFiled?.top1)})`,
    `Similar-artist coverage: ${c.asked ?? 0} artists looked up, Deezer ${c.deezer ?? 0}, ListenBrainz ${c.listenbrainz ?? 0}, `
      + `neighbours in library ${c.withNeighbours ?? 0}; had a say on ${w.judged} tracks`,
    st.failed || st.quota ? `Lookups that failed: ${st.failed ?? 0}${st.quota ? ', Deezer rate-limited the run' : ''}` : null,
    `Lookups took ${((v.bridgeMs ?? 0) / 1000).toFixed(1)}s${st.fromCache ? `, ${st.fromCache} remembered from before` : ''}`,
    verdict ? `Phase 0: ${verdict.pass === true ? 'PASS' : verdict.pass === false ? 'not yet' : 'undecided'} — ${verdict.text}` : null,
  ].filter(Boolean);
}

/** The blend's part of the pasteable summary (plan phase 1). Counts and rates only. */
function blendLines(v, pc) {
  const b = v.blend;
  if (!b) return v.base ? [] : ['Blended: not scored (no tag data loaded)'];
  const nf = b.neverFiled;
  const folds = Object.values(b.foldWeights ?? {}).join(', ');
  return [
    `Blended (tags ${b.weight} + this engine${b.withBridge ? ' with similar artists' : ''}${b.nativeFitted ? ', fitted weights' : ''}): top-1 ${pc(b.top1)}, top-3 ${pc(b.top3)}; `
      + `today's ${pc(b.tags.top1)} / ${pc(b.tags.top3)}, this engine ${pc(b.native.top1)} / ${pc(b.native.top3)} on the same ${b.scored} tracks`
      + (folds ? ` (weight per fold ${folds})` : ''),
    nf?.scored ? `Never-filed artists blended: top-1 ${pc(nf.top1)}, top-3 ${pc(nf.top3)} (today's ${pc(nf.tags.top1)}, `
      + `this engine ${pc(nf.native.top1)}; ${nf.scored} tracks)` : null,
    `Phase 1: ${blendVerdict(b).short}`,
  ].filter(Boolean);
}

/** What the blend's score means for the File screen. */
export function blendVerdict(b) {
  if (b.beatsTags && b.withBridge) return { on: true, short: 'blend beats tags — File uses it',
    text: 'The File screen now takes its picks from the blend. Tracks it has heard still lead with sound, and switching off similar artists below goes back to today’s picks.' };
  if (b.beatsTags) return { on: false, short: 'ahead without similar artists — File unchanged (needs them on)',
    text: 'Ahead, but this run had no similar artists, and the File screen only uses the blend with them. Switch them on and score again.' };
  return { on: false, short: 'blend not a point ahead of tags — File unchanged',
    text: 'Not at least a point ahead of today’s engine on tracks it wasn’t tuned on, so the File screen keeps today’s picks.' };
}

/** The blended line on the score card. Empty without one. */
function blendCard(v, p, esc) {
  const b = v && !v.error ? v.blend : null;
  if (!b) return '';
  const nf = b.neverFiled, verdict = blendVerdict(b), names = ['today’s', 'blended'];
  return `<h3 style="margin:18px 0 6px; font-size:16px">Today’s engine and this one, together</h3>
    <p class="why">Each playlist gets a score from both engines${b.withBridge ? ' (this one with similar artists)' : ''},
      each scaled so its best pick is 100%, then mixed: ${Math.round(b.weight * 100)}% tags. The mix is chosen on four
      folds and scored on the fifth, five times over, so these are tracks it wasn’t tuned on. A track with no tags
      is placed by this engine alone.</p>
    <div class="pairs">
      ${pairBars(esc, 'Right first time', b.tags.top1, b.top1, p, null, names)}
      ${pairBars(esc, 'In the top three', b.tags.top3, b.top3, p, null, names)}
      ${nf?.scored ? pairBars(esc, 'Right first time, artists not in any genre playlist yet', nf.tags.top1, nf.top1, p, null, names) : ''}
    </div>
    <p class="why gateverdict" style="margin-top:12px"><span class="tag ${verdict.on ? 'ok' : 'idle'}">${verdict.on ? 'used on File' : 'not used'}</span>
      ${esc(verdict.text)}</p>`;
}

/** Sound's part of the pasteable summary. Counts and rates only. */
function audioLines(v, pc, maestScoreText) {
  const w = v.mine?.withAudio;
  if (!w) return [];
  const g = w.gate ?? {};
  return [
    `With sound${w.soundFirst ? ' (sound-first, genre-only artist graph)' : ''}: top-1 ${pc(w.top1)}, top-3 ${pc(w.top3)} (weights audio ${w.weights?.audio}, learned ${w.learner ? w.weights?.learned : 'none'})`,
    `Never-filed artists with sound: top-1 ${pc(w.neverFiled.top1)} (without ${pc(v.mine.neverFiled?.top1)})`,
    `Sound coverage: ${w.heard} of ${v.mine.scored} scored tracks heard (${w.heardNeverFiled} never-filed), `
      + `${w.analysed} analysed in all; had a say on ${w.judged}, changed ${w.changed} top answers`,
    `Audio gate: ${g.pass === true ? 'PASS' : g.pass === false ? 'not yet' : 'undecided'} (${g.reason ?? '—'}) — ${g.text ?? ''}`,
    ...(w.arms?.maest && maestScoreText ? [maestScoreText(w, pc)] : []),
    ...(v.identify?.scored ? [
      `Naming genres by sound (${v.identify.scored} filed tracks): genre ${pc(v.identify.genre)}, sub-genre ${pc(v.identify.specific)}; `
        + `model alone ${pc(v.identify.modelOnly.genre)} / ${pc(v.identify.modelOnly.specific)}; `
        + `tempo fits ${pc(v.identify.tempo)} of ${v.identify.tempoJudged}`,
      `By genre: ${v.identify.byGenre.map(g => `${g.name} ${g.right}/${g.n}`).join(', ')}`,
    ] : []),
  ];
}

/** 0 nothing filed, 1 sparse, 2 working, 3 established. */
const RUNG_TONE = ['warn', 'warn', 'ok', 'ok'];

export function view(c) {
  const { ENG, LIB, esc, VALIDATE_N, idb, engineTargets, engineInBackground, bridgeOn, bridgeProgressText, maestScoreText } = c;
  const head = `<h1>Engine</h1>
    <p class="lede">What Betterfy has learnt from your own playlists, and how often it gets your filing right. Learning and scoring here change nothing in Spotify.${c.infoBtn?.('engine', 'Engine', `<p>No key, no other website, no genre list written by somebody else: just who you file together, on which label, in what shape
      of record, from when. Everything here is what it <i>would</i> do, until the score below shows it, blended with today's engine,
      beating today's engine on your own filing. Then the File screen's picks come from the blend.</p>`) ?? ''}</p>`;

  // Nothing to file into is a setting, not a result: say where it is fixed.
  if (!engineTargets().length) return `${head}
    <div class="card">
      <h2 style="margin:0 0 12px; font-size:19px">No genre playlists yet</h2>
      <p>Both engines only file into playlists that take suggestions, and none of yours do yet — none of
        their names say what genre they are. Mark the ones that are genre playlists in Library, then
        come back.</p>
      <div class="rowbtns" style="margin-top:18px"><button class="b go" data-act="lists">Open Library</button></div>
    </div>`;

  if (ENG.status === 'idle') return `${head}
    <div class="card">
      <h2 style="margin:0 0 12px; font-size:19px">Learn my library</h2>
      <p>Reads your ${LIB.playlists.length.toLocaleString()} playlists once and works out what each one means.
        Takes a few seconds, and is remembered afterwards so it is a one-off. It runs on this device —
        nothing is sent anywhere.</p>
      <div class="rowbtns" style="margin-top:18px">
        <button class="b big go" data-act="go">Learn my library</button>
      </div>
    </div>`;

  if (ENG.status === 'working') return `${head}
    <div class="card">
      <h2 style="margin:0 0 12px; font-size:19px">Working…</h2>
      <p>Working out what your playlists mean — the arithmetic for every pair of artists you file together.
        ${engineInBackground() ? 'It runs in the background' : 'On a big library this holds the page up for a moment'},
        and it only happens once.</p>
    </div>`;

  if (ENG.status === 'error') return `${head}
    <div class="card">
      <h2 style="margin:0 0 12px; font-size:19px">That didn't work</h2>
      <p class="why">${esc(ENG.err ?? 'Unknown error')}</p>
      <div class="rowbtns" style="margin-top:16px"><button class="b" data-act="go">Try again</button></div>
    </div>`;

  const r = ENG.rung, sh = ENG.shadow;

  const rungCard = `<div class="card">
    <h2 style="margin:0 0 4px; font-size:19px">How much it has to go on
      <span class="tag ${RUNG_TONE[r.rung] ?? 'warn'}" style="margin-left:6px; vertical-align:middle">${esc(r.name)}</span></h2>
    <p>${esc(r.reason)}.</p>
    <div class="facts" style="margin-top:16px">
      <div><span>Playlists it can file into</span><b class="mono">${r.destinations.toLocaleString()}</b></div>
      <div><span>Artists with neighbours</span><b class="mono">${r.artistsConnected.toLocaleString()}</b></div>
      <div><span>Artists in more than one playlist</span><b class="mono">${Math.round((r.connectedShare ?? 0) * 100)}%</b></div>
      ${r.rung <= 1 ? `<hr><p>Filing more of your library into more playlists is what raises this —
        not waiting, and not any setting.</p>` : ''}
    </div>
  </div>`;

  // Agreement is not accuracy, and dressing it as accuracy would be the whole
  // failure this screen exists to avoid: these tracks are unfiled, so there is
  // no right answer to measure against. It says how often the two engines would
  // hand you a different playlist. The score is the next card down.
  const pc = sh.judged ? Math.round((sh.agree / sh.judged) * 100) : null;
  const shadowCard = `<div class="card">
    <h2 style="margin:0 0 12px; font-size:19px">What it would do differently</h2>
    <p>The next ${sh.rows.length} ${sh.rows.length === 1 ? 'track' : 'tracks'} waiting to be filed, with today's
      suggestion beside this engine's. These are unfiled, so neither column is <i>known</i> to be right —
      this is only where the two disagree.</p>
    ${/* The shape-only count sits outside the `judged` branch deliberately. It used
          to be inside it, so on a backlog where today's engine has no suggestions
          at all — a listener with no tag coverage, which is the case this screen
          exists for — the whole summary vanished and took the one caveat that
          mattered with it. */''}
    ${sh.rows.length ? `<div class="facts" style="margin-top:16px">
      ${sh.judged ? `<div><span>Same playlist</span><b class="mono">${pc}% (${sh.agree} of ${sh.judged})</b></div>
      <div><span>Only this engine had an answer</span><b class="mono">${sh.onlyMine}</b></div>
      <div><span>Only today's engine did</span><b class="mono">${sh.onlyTheirs}</b></div>`
      : `<div><span>Nothing to compare against</span><b class="mono">today's engine suggested nothing for any of these</b></div>
      <div><span>This engine had an answer for</span><b class="mono">${sh.onlyMine} of ${sh.rows.length}</b></div>`}
      ${sh.shapeOnly ? `<div><span>Placed on shape alone, with nothing about the artist</span><b class="mono">${sh.shapeOnly}</b></div>` : ''}
      ${sh.decided ? `<hr><div><span>Confident · short list · not sure</span><b class="mono">${
        sh.decided.confident} · ${sh.decided.choose} · ${sh.decided.unsure}</b></div>` : ''}
    </div>` : ''}
    ${sh.rows.length ? `<div class="rows" style="margin-top:18px">
      ${sh.rows.map(row => {
        // Once calibrated, the checked answer is the answer: "not sure" is no
        // answer, and a short list that includes today's suggestion agrees with it.
        const answer = row.decision ? (row.decision.kind === 'unsure' ? null : row.decision.playlists)
                                    : row.mine ? [row.mine] : null;
        const same = !!(row.theirs && answer?.some(x => x.id === row.theirs.id));
        return `<div class="row"><details class="engrow">
          <summary>
            <div class="main">
              <div class="ttl">${esc(row.title)}
                <span class="tag ${same ? 'ok' : answer ? 'warn' : 'idle'}" style="margin-left:6px">${
                  same ? 'agree' : answer && row.theirs ? 'differ' : answer ? 'new answer' : 'no answer'}</span>${
                  row.shapeOnly ? '<span class="tag idle" style="margin-left:4px">shape only</span>' : ''}</div>
              <div class="sub">${esc(row.artist)}</div>
            </div>
            <div class="cmp">
              <div><em>today</em>${row.theirs ? `<b>${esc(row.theirs.name)}</b>` : '<i>no suggestion</i>'}</div>
              <div><em>this engine</em>${row.decision ? decisionHtml(row.decision, esc)
                : row.mine ? `<b>${esc(row.mine.name)}</b>` : '<i>won&rsquo;t guess</i>'}</div>
            </div>
          </summary>
          <div style="padding:2px 0 2px">
            ${row.mine ? `<p class="why">${Math.round(row.mine.score * 100)}% fit${
              row.band ? ` · ${esc(String(row.band).toLowerCase())} confidence` : ''}${
              row.declined ? ' · and it declined to commit to it' : ''}</p>` : ''}
            ${row.shapeOnly ? `<p class="whynone">Nothing below is about this record in particular — it has
              never seen you file this artist, and does not know the label. A seven-minute single from the
              2020s fits a playlist of seven-minute singles from the 2020s, which is true and is not much.
              Treat this one as a shrug, whatever the percentage says.</p>` : ''}
            ${/* Each clause is {mark, text}: ✓ carries the placement, · supports it,
                  ! argues against. The mark is the engine's own confidence in
                  that one piece of evidence, so it is shown rather than flattened
                  away. */''}
            ${row.why?.length ? `<ul class="whylist">${row.why.map(w =>
              `<li><span class="wmark">${esc(w.mark ?? '')}</span> ${esc(w.text ?? w)}</li>`).join('')}</ul>`
              : `<p class="whynone">${row.mine
                ? 'Nothing it could say about this would distinguish one of your playlists from another, so it says nothing rather than padding the answer out.'
                : 'It has no evidence for this track that separates your playlists at all — an artist it has never seen you file, on a label it does not know. It would rather say nothing than guess.'}</p>`}
          </div>
        </details></div>`;
      }).join('')}
    </div>` : ''}
  </div>`;

  const p = x => x == null ? '—' : Math.round(x * 100) + '%';
  const v = ENG.val;
  const verdict = v && !v.error && v.base
    ? (v.mine.top1 > v.base.top1 ? 'ahead' : v.mine.top1 < v.base.top1 ? 'behind' : 'level') : null;
  const valCard = `<div class="card">
    <h2 style="margin:0 0 12px; font-size:19px">Is it actually any better?</h2>
    <p>The honest test, and the one that decides whether this engine should ever take over. Your
      already-filed tracks are the answer key: hold one out, rebuild from a library that never saw it,
      and see whether each engine puts it back where you had it. Both are scored on the same
      ${VALIDATE_N.toLocaleString()} tracks, over the same folds.</p>
    <p class="why">It measures agreement with <b>your</b> habits, not musical truth. If your library is
      systematically misfiled it will reproduce that faithfully, and it cannot tell you so.</p>
    ${v?.error ? `<p class="why" style="margin-top:12px">That didn't work: ${esc(v.error)}</p>` : ''}
    ${v && !v.error ? `<div class="facts" style="margin-top:16px">
      <div><span><b>This engine</b> — right first time</span><b class="mono">${p(v.mine.top1)}</b></div>
      <div><span>…in its top three</span><b class="mono">${p(v.mine.top3)}</b></div>
      ${v.weights?.plain ? `<div><span>…with weights fitted to your filing${v.weights.plain.use ? '' : ' (not used)'}</span><b class="mono">${p(v.weights.plain.fitted.top1)} / ${p(v.weights.plain.fitted.top3)}</b></div>` : ''}
      ${v.base ? `<hr>
      <div><span><b>Today's engine</b> — right first time</span><b class="mono">${p(v.base.top1)}</b></div>
      <div><span>…in its top three</span><b class="mono">${p(v.base.top3)}</b></div>` : ''}
      <hr>
      <div><span>Tracks scored, each engine</span><b class="mono">${v.mine.scored.toLocaleString()}</b></div>
      ${fillRow(v.fill, p)}
      ${teachRow(v.teach, p)}
      ${v.base?.noAnswer ? `<p>Today's engine had no tags at all for ${v.base.noAnswer.toLocaleString()} of them.
        Counted as misses: a filing tool that returns nothing has not filed anything.</p>` : ''}
      ${!v.base ? `<p>No tag data is loaded, so there is nothing to compare against — the figure above
        stands on its own.</p>` : ''}
      <p>Took ${v.ms < 950 ? `${v.ms}ms` : `${(v.ms / 1000).toFixed(1)}s`}.</p>
    </div>
    ${verdict ? `<p class="why" style="margin-top:14px"><b>${
      verdict === 'ahead' ? 'Ahead.' : verdict === 'behind' ? 'Behind.' : 'Level.'}</b> ${
      verdict === 'ahead' ? 'On your library, reading nothing but your own filing beats reading the tag table.'
      : verdict === 'behind' ? 'On your library the tag table still wins, so this engine should not take over. That is what the test is for.'
      : 'There is nothing to choose between them on your library.'}</p>` : ''}
    ${weightsCard(v, p, esc)}
    ${bridgeCard(v, p, esc)}
    ${blendCard(v, p, esc)}
    ${audioCard(v, p, esc, maestScoreText)}
    ${v && !v.error ? calibCard(p, ENG.calib) : ''}
    ${weakBuckets(v, LIB).length ? `<h3 style="margin:18px 0 6px; font-size:16px">Playlists it understands least</h3>
      <p class="why">How often each one was even offered in the top three, for tracks that really are in it.
        Low here means the engine has no real idea what that playlist is for.</p>
      <div class="facts" style="margin-top:10px">${weakBuckets(v, LIB).map(b =>
        `<div><span>${esc(b.name)} <span class="sub">· ${b.n} tracks</span></span><b class="mono">${p(b.inTop3)}</b></div>`).join('')}
      </div>` : ''}` : ''}
    <label class="check-row" style="margin-top:14px"><input type="checkbox" data-act="bridgeToggle" id="bridgeToggle" ${bridgeOn() ? 'checked' : ''}
      ${ENG.valRunning ? 'disabled' : ''}> Also try similar artists (asks Deezer, ListenBrainz and Wikidata about the artists being scored)</label>
    <div class="rowbtns" style="margin-top:10px">
      <button class="b ${v ? '' : 'go'}" data-act="validate" ${ENG.valRunning ? 'disabled' : ''}>${
        ENG.valRunning ? 'Scoring…' : v ? 'Run it again' : 'Score both engines'}</button>
      <button class="b" data-act="scoreTune" ${ENG.valRunning || c.TUNE?.running ? 'disabled' : ''}>Score + Tune</button>
      ${v && !v.error && !ENG.valRunning ? `<button class="b" data-act="copy">Copy results</button>` : ''}
    </div>
    ${ENG.valRunning && ENG.valStage === 'bridge' ? `<p class="why" style="margin-top:12px" id="bridgeProgress" aria-live="polite">${esc(bridgeProgressText())}</p>
      <p class="why">The first run asks about each artist being scored — a few hundred, a minute or two. Every answer is
        remembered on this device for two months, so later runs only ask about what's new.</p>` : ''}
    ${ENG.valRunning && ENG.valStage !== 'bridge' ? `<p class="why" style="margin-top:12px">Learning your library from scratch ten times over —
      five folds, two engines. ${engineInBackground()
        ? 'It runs in the background, so the app stays usable — just leave this screen open until it finishes.'
        : 'On a big library that can take a while, and the page will freeze in bursts while it happens.'}
      Capping the tracks scored does not make it quicker: the rebuilds are the cost, and there are ten of
      them either way.</p>` : ''}
  </div>`;

  const tuneCard = tuneCardHtml(c, esc);

  const pairCard = ENG.pairs?.length ? `<div class="card">
    <h2 style="margin:0 0 12px; font-size:19px">Playlists it can't tell apart</h2>
    <p>Usually a fact about the library rather than a fault in the engine: two playlists holding the same
      kind of music, or one that is really a view of another. Worth knowing, because a track landing in
      either would be defensible.</p>
    <div class="rows" style="margin-top:16px">
      ${/* bucketPairs only ever returns pairs it could NOT separate, so there is
            no "distinct" case to render here. */ ''}
      ${ENG.pairs.map(pr => `<div class="row"><div class="main">
        <div class="ttl">${esc(pr.a?.name ?? '?')} &nbsp;·&nbsp; ${esc(pr.b?.name ?? '?')}</div>
        <div class="sub">${pr.verdict === 'view'
          ? `one looks like a view of the other — ${Math.round((pr.overlap ?? 0) * 100)}% of the smaller sits in the larger`
          : 'it cannot separate these two by the music in them'}</div>
      </div><span class="tag warn">${esc(pr.verdict)}</span></div>`).join('')}
    </div>
  </div>` : '';

  return `${head}
    <p class="mono" style="font-size:11.5px; color:var(--ink-3); margin:-10px 0 18px">${
      ENG.from === 'cache' ? 'revived from this device' : 'learned'} in ${ENG.ms.toLocaleString()}ms${
      idb.durable ? '' : ' · not remembered, because this browser is not letting the app store anything'}</p>
    ${rungCard}
    ${shadowCard}
    ${valCard}
    ${tuneCard}
    ${pairCard}
    <div class="rowbtns" style="margin:20px 0 0">
      <button class="b sm" data-act="reset">Forget and learn again</button>
    </div>`;
}

const TUNE_STAGE = { sound: 'filing by sound', ident: 'naming genres by sound', misfit: 'Tidy by sound' };

/**
 * The Tune card (BUILD-6 T1): per constant, the shipped value, the best of a small
 * grid on this account's own held-out tracks, and the measured change. Only rows
 * that clear the bar can be kept, and only on this device.
 */
export function tuneCardHtml(c, esc) {
  const T = c.TUNE;
  if (!T || (!T.res && !T.running && !T.err && !T.saved)) return '';
  const rows = T.res?.rows ?? [];
  const nPass = rows.filter(r => r.pass).length;
  const kept = Object.entries(T.over ?? {}).flatMap(([g, o]) => Object.entries(o).map(([k, v]) => `${g}.${k} ${v}`));
  const body = T.running
    ? `<p class="why" aria-live="polite">Trying each constant over a small range on your own held-out tracks, one group at a time${
        T.stage ? ` (now: ${esc(TUNE_STAGE[T.stage] ?? T.stage)})` : ''}. It runs ${c.engineInBackground() ? 'in the background' : 'on the page, which may stutter'}.</p>`
    : T.err ? `<p class="why">The sweep could not finish: ${esc(T.err)}</p>`
    : T.res ? `${rows.length ? `<div class="rows">${rows.map(r => `<div class="row"><div class="main">
        <div class="ttl">${esc(r.label)}</div>
        <div class="sub">${r.best === r.current ? `keep ${esc(r.current)}` : `now ${esc(r.current)}, best ${esc(r.best)}: ${esc(r.delta)}`}</div>
      </div><span class="tag ${r.pass ? 'ok' : 'warn'}">${r.pass ? 'clears the bar' : r.best === r.current ? 'keep' : 'not enough'}</span></div>`).join('')}</div>` : ''}
      ${(T.res.skipped ?? []).map(s => `<p class="why">${esc(s.title)}: not swept, ${esc(s.why)}.</p>`).join('')}
      <p class="why">A change only counts if it beats today's value on both halves of your held-out tracks by the bar for its group.
        Nothing here is shared, and nothing changes until you choose to keep it.</p>` : '';
  return `<div class="card" id="tuneCard">
    <h2 style="margin:0 0 12px; font-size:19px">Tune</h2>
    ${body}
    ${kept.length ? `<p class="why">In use on this device: ${esc(kept.join(', '))}.</p>` : ''}
    <div class="rowbtns" style="margin-top:10px">
      ${T.res && nPass && !T.running ? `<button class="b go" data-act="tuneApply">Use the ${nPass} that cleared the bar</button>` : ''}
      ${T.res && !T.running ? `<button class="b" data-act="tuneCopy">Copy tune results</button>` : ''}
      ${T.saved ? `<button class="b sm" data-act="tuneReset">Reset to default</button>` : ''}
    </div>
  </div>`;
}

/** `data-act` -> handler(ctx, el, ev). Click, except the checkbox, which is `change`. */
export const actions = {
  go: c => c.engineAnalyse(),
  validate: c => c.engineValidate(),
  scoreTune: c => c.engineScoreTune(),
  tuneApply: async c => { await c.tuneApply(); c.toast('Kept on this device. Reset to default undoes it.'); c.render(); },
  async tuneReset(c) { await c.tuneForget(); c.toast('Back to the defaults.'); c.render(); },
  /** Copy the sweep as one block, to paste next to the Score card. */
  async tuneCopy(c) {
    const text = c.tuneBlock(c.TUNE?.res);
    if (!text) return;
    try { await c.navigator.clipboard.writeText(text); return c.toast('Copied: paste it with the score.'); }
    catch { /* fall through to share */ }
    try { if (c.navigator.share) { await c.navigator.share({ text }); return; } } catch { return; }
    c.prompt('Copy this:', text);
  },
  lists: c => c.go('lists'),
  bridgeToggle: (c, el) => {
    if (el.checked) c.LS.removeItem('bf_bridge_off'); else c.LS.setItem('bf_bridge_off', '1');
    // File's blend reads the switch on every pick; this lets it re-check from the start.
    c.blendForget();
  },
  /** Copy the score as text; no clipboard permission offers the share sheet, then a manual copy. */
  async copy(c) {
    const text = summary(c, await c.getLog?.().catch(() => null));
    if (!text) return;
    try { await c.navigator.clipboard.writeText(text); return c.toast('Copied — paste it wherever you like.'); }
    catch { /* fall through to share */ }
    try { if (c.navigator.share) { await c.navigator.share({ text }); return; } } catch { return; }
    c.prompt('Copy this:', text);
  },
  /** Forget the learned space, so the next analysis rebuilds from the library. */
  async reset(c) {
    try { await c.idb.del(c.SPACE_KEY); } catch {}
    try { await c.idb.del(c.CAL_KEY); } catch {}
    // And the blend the File screen was using, and the fitted weights: both were fitted on what is being forgotten.
    try { await c.idb.del(c.BLEND_KEY); } catch {}
    c.blendForget();
    await c.weightsForget();
    await c.tuneForget?.();
    Object.assign(c.ENG, { status:'idle', space:null, rung:null, shadow:null,
                           pairs:null, val:null, calib:null, ms:0, from:null });
    c.toast('Cleared. The next analysis rebuilds from your library.');
    c.render();
  },
};
