/* ---------- boot ---------- */
$('#redirectShow').textContent = REDIRECT;
$('#redirectShow2').value = REDIRECT;
$('#ownId').value = LS.getItem('bf_client_id') || '';

/* Which app is actually in use, in words. Without this the panel looks the same
 * whether the switch took or not, and "I've set my own client ID" and "I am
 * still on the shared one" are indistinguishable from the outside — which is
 * the difference between fixed and still-throttled. */
function showWhichApp() {
  const own = LS.getItem('bf_client_id');
  const el = $('#whichApp'); if (!el) return;
  el.textContent = own
    ? `Using your own Spotify app (${own.slice(0, 8)}…) — its quota is yours alone.`
    : 'Using this page’s default Spotify app, whose quota is shared with everyone else who opens this link.';
}
showWhichApp();
/* beginAuth() is async, so `onclick = () => beginAuth()` turned every failure
 * inside it into an unhandled rejection: the button did nothing, said nothing,
 * and looked exactly like a broken app. Anything that stops a sign-in before it
 * leaves this page has to be on the screen. */
$('#connect').onclick = async () => {
  const btn = $('#connect');
  btn.disabled = true;
  try { await beginAuth(); }
  catch (e) { signInUnavailable(e.message); }
  finally { btn.disabled = false; }
};

/** A sign-in that cannot even start: say what is wrong, and offer the one thing
 *  that sometimes gets around it rather than a button that will fail again. */
function signInUnavailable(msg) {
  toast(msg);
  if ($('#landBlocked')) { $('#landBlocked').textContent = msg; return; }
  const p = document.createElement('p');
  p.id = 'landBlocked'; p.className = 'fineprint';
  p.textContent = msg;
  $('.cta')?.after(p);
}
$('#copyRedirect').onclick = async () => { try { await navigator.clipboard.writeText(REDIRECT); toast('Copied.'); } catch { $('#redirectShow2').select(); toast('Press Ctrl+C to copy.'); } };
$('#saveId').onclick = () => {
  const v = $('#ownId').value.trim();
  if (!v) return toast('Paste the client ID from your own Spotify app first.');
  // The whole point of this box is a different app with a quota of its own, and
  // the default one is printed in this page's source — so it is the easiest
  // wrong thing to paste in, and pasting it changes precisely nothing while
  // looking exactly like the fix.
  if (v === DEFAULT_CLIENT_ID)
    return toast('That is this page’s default app — the one already being shared. Create your own at developer.spotify.com/dashboard and paste that client ID instead.');
  // A Spotify client ID is 32 hex characters. The usual mistakes are pasting
  // the client secret, or half of something.
  if (!/^[0-9a-f]{32}$/i.test(v))
    return toast('That does not look like a Spotify client ID — they are 32 letters and numbers. Copy the Client ID, not the secret.');
  LS.setItem('bf_client_id', v);
  showWhichApp();
  toast('Saved — that is your app now. Tap Connect Spotify.');
};
$('#clearId').onclick = () => { LS.removeItem('bf_client_id'); $('#ownId').value=''; showWhichApp(); toast('Using the default app.'); };
/* Both of these are async with nothing catching them, which is the shape that
 * turns any throw inside into a button that does nothing and says nothing —
 * the same failure the delegated handlers all go through guard() to avoid. */
$('#disconnect').onclick = guard(async () => {
  LS.removeItem('bf_tok'); LS.removeItem('bf_autoconnect');
  await idb.clear(); location.href = REDIRECT;
});
$('#settingsResync').onclick = guard(async () => {
  const btn = $('#settingsResync');
  btn.disabled = true; btn.textContent = 'Re-reading your library…';
  try { openSettings(false); await start(true); }
  finally { btn.disabled = false; btn.textContent = 'Re-sync library from Spotify'; }
});

$('#syncSection').hidden = !syncAvailable();

let syncCodeTimer = null;
$('#syncShowCode').onclick = async () => {
  const btn = $('#syncShowCode'), box = $('#syncCodeBox');
  clearInterval(syncCodeTimer);
  btn.disabled = true;
  try {
    const { code, expiresAt } = await createLinkCode();
    box.hidden = false;
    const tick = () => {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      box.textContent = left > 0
        ? `${code} — enter this on the other device within ${Math.ceil(left / 60)} minute${left > 60 ? 's' : ''}.`
        : `${code} has expired — tap Link another device for a new one.`;
      if (left <= 0) clearInterval(syncCodeTimer);
    };
    tick();
    syncCodeTimer = setInterval(tick, 1000);
  } catch (e) { toast('Could not create a code: ' + e.message); }
  finally { btn.disabled = false; }
};

$('#syncRedeem').onclick = async () => {
  const input = $('#syncRedeemInput'), btn = $('#syncRedeem');
  const code = input.value.trim();
  if (!/^\d{6}$/.test(code)) return toast('That does not look like a 6-digit code.');
  btn.disabled = true;
  try {
    await redeemLinkCode(code);
    input.value = '';
    toast('Linked — pulling in what the other device knows…');
    const changed = await syncEverything();
    if (changed) refreshReports();
  } catch (e) { toast('Could not link: ' + e.message); }
  finally { btn.disabled = false; }
};

$('#syncForget').onclick = () => {
  LS.removeItem(SYNC_GROUP_KEY); LS.removeItem('bf_sync_auth'); SYNC_AUTH = null;
  $('#syncCodeBox').hidden = true; clearInterval(syncCodeTimer);
  toast('This device now syncs to nobody until you link it again.');
};
$('#btnUpdate').onclick = () => checkForUpdate(false);
$('#landUpdate').onclick = () => checkForUpdate(false);
$('#doUpdate').onclick = () => installUpdate();
$('#dismissUpdate').onclick = () => { $('#updateBar').hidden = true; };
window.bfReset = async () => {
  LS.removeItem('bf_tok'); LS.removeItem('bf_verifier'); LS.removeItem('bf_autoconnect');
  await idb.clear(); location.replace(REDIRECT);
};

const LOGO_HTML = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true">
  <rect width="32" height="32" rx="9" style="fill:var(--tilebg,var(--surface-2))"/>
  <rect x="7.75" y="4.9" width="7" height="3.4" rx="1.7" style="fill:var(--m0)"/>
  <rect x="7.75" y="9.6" width="12" height="3.4" rx="1.7" style="fill:var(--m1)"/>
  <rect x="7.75" y="14.3" width="16.5" height="3.4" rx="1.7" style="fill:var(--m2)"/>
  <rect x="7.75" y="19" width="12" height="3.4" rx="1.7" style="fill:var(--m3)"/>
  <rect x="7.75" y="23.7" width="7" height="3.4" rx="1.7" style="fill:var(--m4)"/>
</svg>Better<span>fy</span>`;

function stage(msg, pct, extra = '') {
  paintedView = null;
  $('#app').hidden = true; $('#land').hidden = false;
  $('#land').innerHTML = `<h1 class="logo">${LOGO_HTML}</h1>
    <p class="tagline">${esc(msg)}</p>
    <div class="prog" style="max-width:420px"><i style="width:${(pct*100).toFixed(1)}%"></i></div>${extra}
    <div style="max-width:420px;margin:24px auto 0">${typeof skeleton === 'function' ? skeleton('card', 1) : ''}</div>`;
}

// A single 429 is ordinary. Several in a row on this page's default client ID
// is a different problem: that ID's quota is shared with everyone else who
// has this page open, so waiting it out just means waiting on someone else's
// traffic, and a retry loop that keeps failing looks exactly like "never
// recovers" from the outside — because from inside a shared queue, it might
// genuinely not, for as long as that queue stays busy. The one thing that
// actually fixes that rather than just waiting longer is a personal Spotify
// app: same page, same everything, but a quota nobody else can spend.
// Reaching this screen at all means the silent budget (hold()'s own 60s of
// quietly-absorbed waits) is already spent — that is not "a busy few
// minutes" any more, it is the actual signal worth acting on. Waiting for a
// *second* one before saying so left people sitting through a whole extra
// failed cycle — each one its own round of escalating waits — before ever
// finding out there was a faster way through.
const RATE_LIMIT_STREAK_KEY = 'bf_ratelimit_streak', RATE_LIMIT_OWN_APP_AFTER = 1;
function noteRateLimited() {
  const n = (+LS.getItem(RATE_LIMIT_STREAK_KEY) || 0) + 1;
  LS.setItem(RATE_LIMIT_STREAK_KEY, String(n));
  return n;
}
const clearRateLimitStreak = () => LS.removeItem(RATE_LIMIT_STREAK_KEY);

/** A wall for a failure that is nobody's fault and will pass: no "start over"
 *  button, because signing in again is exactly what must not happen here. */
let blockedTimer = null, blockedCountdown = null;

/* The one thing that actually ends a shared-quota wait, rather than sitting it
 * out. Shown on the pause screen as well as the fallback one now: the pause
 * screen is where people were spending the wait, and it offered nothing to do
 * but watch a countdown re-arm. */
function ownAppNote() {
  return `<div class="note" style="max-width:420px; margin-top:14px; text-align:left">
      <b>Rather not wait it out?</b> This page's default Spotify app is shared by everyone who opens it,
      so a busy few minutes anywhere can hold up your library here too, for as long as that stays busy.
      Your own free Spotify app has a quota nobody else can spend: about a minute to set up, nothing to
      share with whoever sent you this link.
      <div class="rowbtns" style="margin-top:8px"><a class="b sm" href="${REDIRECT}?setup">Use your own Spotify app</a></div>
    </div>`;
}
/**
 * @param {number} [retryInMs] — when known, retry on its own once this has passed,
 * so getting past a rate limit never depends on someone remembering to come tap it.
 * A silent timer with a static "Try again" screen is what looked broken —
 * the button sat there with no sign anything was ever going to happen, so a
 * wait that was actually being handled read as the app having hung. Counting
 * down is the same fix hold() already applies to a Web API 429 mid-sync,
 * brought to the sign-in wall too.
 * @param {boolean} [ownAppHint] — several 429s in a row: say what actually helps.
 */
function blocked(msg, retry, retryInMs, ownAppHint) {
  clearTimeout(blockedTimer); blockedTimer = null;
  clearInterval(blockedCountdown); blockedCountdown = null;
  $('#app').hidden = true; $('#land').hidden = false;
  $('#land').innerHTML = `<h1 class="logo">${LOGO_HTML}</h1>
    <p class="tagline">${esc(msg)}</p>
    <button class="b p" id="landRetry">Try again</button>
    ${retryInMs != null ? `<p class="fineprint" id="landRetryCountdown"></p>` : ''}
    ${ownAppHint ? ownAppNote() : ''}`;
  // Whichever fires first — a tap or the timer — has to stop the other one,
  // or the countdown keeps ticking in the background forever after the retry
  // it was counting down to has already happened.
  const go = () => { clearTimeout(blockedTimer); clearInterval(blockedCountdown); retry(); };
  $('#landRetry').onclick = go;
  if (retryInMs != null) {
    blockedTimer = setTimeout(go, retryInMs);
    const until = Date.now() + retryInMs;
    const tick = () => {
      const el = $('#landRetryCountdown');
      if (!el) return;
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      el.textContent = left > 0 ? `Retrying by itself in ${left}s — no need to tap anything.` : 'Retrying…';
    };
    tick();
    blockedCountdown = setInterval(tick, 1000);
  }
}

/* ---------- the first paint, and the read that goes on behind it (BUILD-7 P1) ---------- */

/** While File is up on a partial read: `{ done, total }` liked songs read so far; null otherwise.
 *  The home header says so (screens/home.mjs), and nothing that waits for the whole library starts. */
let LIB_READ = null;
/** Was this load an account's first analysis (analyse.js analyseFirst), asked at the first paint. */
let FIRST_RUN = false;

/** The read went on a page: move the header's count without repainting the screen under a thumb. */
function libReadProgress(n) {
  if (!LIB_READ || !n) return;
  LIB_READ.done = n.done ?? LIB_READ.done;
  LIB_READ.total = n.total ?? LIB_READ.total;
  const el = document.querySelector('#fileStatus .st-reading');
  if (el) el.textContent = libReadText();
}
/** "reading liked songs 1,250/5,025": what the header says while the rest comes in. */
function libReadText() {
  const r = LIB_READ; if (!r) return '';
  return r.total ? `reading liked songs ${Math.min(r.done, r.total).toLocaleString()}/${r.total.toLocaleString()}`
    : 'reading the rest of your liked songs';
}

/**
 * syncLibrary, carried through a busy spell once File is up. Before the first paint a failure goes
 * to start()'s walls as it always did; after it, the page stays and the read resumes from its banked
 * pieces after the wait Spotify asked for, a few times, before giving up with a word on screen.
 */
async function readLibraryWhole(force, onProgress, onPartial, shown) {
  for (let tries = 0; ; tries++) {
    try { return await syncLibrary(force && !tries, onProgress, shown() ? null : onPartial); }
    catch (e) {
      if (!shown() || !retryable(e) || tries >= 3) throw e;
      await sleep(Math.max(1000, e.retryAfterMs ?? 15000));
    }
  }
}

/** Tags, feedback, classify and reports for `lib`, then File on screen. */
async function firstPaint(lib) {
  LIB = lib;
  performance.mark('bf:tags-start');
  stage('Loading genre tags…', 0.96);
  if (!TAGS) {
    // 435KB over whatever signal a phone has at the time. This used to be a
    // bare fetch: one blip threw a TypeError, which is not retryable, which
    // meant the only way off the screen was Start over — and Start over
    // cleared a perfectly good sign-in over a failed static file.
    const raw = await fetchTags();
    TAGS = {};
    // shipped as id -> [[tag, 0-10]] ; expand to the shape profile.mjs expects
    for (const [id, tags] of Object.entries(raw)) TAGS[id] = { tags: tags.map(([n,c]) => [n, c*10]) };
    // Kept aside so a hand-corrected artist can be put back the way Last.fm
    // shipped it, without losing every other correction made this session.
    RAW_TAGS = JSON.parse(JSON.stringify(TAGS));
    // anything this viewer has fetched for their own artists wins
    Object.assign(TAGS, (await idb.get('tags_extra')) ?? {});
  }
  // Skips and rejections must be in hand before reports are built, since
  // buildReports filters rejected playlists out of each track's suggestions.
  await loadFeedback();
  performance.mark('bf:feedback');
  stage('Working out where everything goes…', 0.99);
  CFG = classify(LIB, TAGS);
  performance.mark('bf:classified');
  // The first build stays on this thread: nothing else is waiting on the page yet, and a
  // worker would add its start-up and a copy of the library to the one wait that matters.
  // Every rebuild after this one (sync, tag fills, corrections) goes through refreshReports().
  R = buildReports(LIB, CFG, TAGS);
  performance.mark('bf:reports');
  $('#land').hidden = true; $('#app').hidden = false;
  clearRateLimitStreak();
  // The rail that used to carry this is a bar now; the account line lives in
  // the More sheet, which is where Disconnect sits too.
  const whoName = LIB.user?.name ?? LIB.user?.id ?? '';
  $('#who').textContent = whoName;
  $('#sheetWho').textContent = whoName;
  // A new account's first analysis starts by itself (analyse.js): asked before the
  // first paint so File opens on its progress strip, never on a button.
  FIRST_RUN = (() => { try { return analyseFirst(); } catch { return false; } })();
  view = ROUTER.start(); S.inboxAt = 0; render();
  // An old link such as #/sources opens the Settings sheet on that section.
  const landed = ROUTER.section; if (landed) openUnderHood(landed);
  window.scrollTo(0, 0);
  // Background, after the first paint — never delays it, and only redraws
  // again if another device actually had feedback this one did not, rather
  // than resetting the screen on every load for nothing.
  syncEverything().then(changed => { if (changed) refreshReports(); });
}

/**
 * The read finished after File went up on part of it: take the whole library, rebuild the
 * picks and counts, and repaint on the card that is showing (by id, never by position).
 */
async function takeFullLibrary(full) {
  LIB = full;
  CFG = classify(LIB, TAGS);
  const mine = ++REPORTS_APPLY;
  for (let tries = 0; tries < 2; tries++) {
    const sig = reportsSignature();
    const res = await buildReportsAsync(LIB, CFG, TAGS);
    if (mine !== REPORTS_APPLY || full !== LIB) return;   // a newer rebuild has it
    if (sig !== reportsSignature() && tries === 0) continue;
    const keep = R?.backlog?.[Math.min(S.inboxAt | 0, R.backlog.length - 1)]?.id;
    R = res;
    const at = keep ? R.backlog.findIndex(b => b.id === keep) : -1;
    S.inboxAt = at >= 0 ? at : Math.min(S.inboxAt | 0, Math.max(0, R.backlog.length - 1));
    LIB_READ = null;
    store.set('lib', LIB);
    store.set('reports', R);
    return;
  }
}

/** Everything that waits for the whole library: tag fills, the first analysis, the Engine's map,
 *  the radar and Tidy's checks, listening, Score + Tune. Never from a partial read. */
function afterFirstPaint() {
  // Keyless genres for artists nothing has tagged. Cached per artist, so after
  // the first load this asks only about artists that are new or stale.
  // Then Last.fm, with the built-in key, for every artist still thin (the owner's
  // call, 2026-11-16: every keyless source on by default). Chained after Wikidata
  // because both write the same tag cache. Asks only new or stale artists, so a
  // reload costs almost nothing. On an account's first load the same steps run as
  // its first analysis instead, with listening and progress on File (analyseAuto).
  (async () => {
    if (FIRST_RUN) await analyseAuto().catch(() => null);
    else {
      if (untaggedArtists().size) await fillFromWikidata({ quiet: true }).catch(() => {});
      // Every load, not only after the first analysis (owner, 2026-11-18: all the data up
      // front, never a button in Settings to press).
      if (lfmKey() && !(typeof ANALYSE !== 'undefined' && ANALYSE.running)) {
        await enrichMissing({ quiet: true }).catch(() => 0);   // rebuilds the reports itself when it asked anything
      }
    }
    // The Engine's map of the playlists, in the worker: from the cache after the first
    // time, so the Engine screen opens on results, not "Learn my library". Before the
    // similar artists, which place their picks in it.
    await engineAutoLearn().catch(() => false);
    // Release Radar starts by itself too, a little later (radar.js radarAuto), unless Stop was
    // pressed on this device. Not awaited: it reads Spotify, the similar artists below read others.
    // After its first read, Tidy › Hard to find checks a batch by itself (DESIGN-PLAN §7.7 A2).
    // So does Discover's once-a-day look for new music (§7.7 A1), radar or not.
    if (typeof radarAuto === 'function') radarAuto()
      .then(ran => ran && SCREEN_MODS.tidy?.background?.(screenCtx('tidy'))).catch(() => false)
      .then(() => typeof discAuto === 'function' && discAuto()).catch(() => false);
    // Then similar artists (Deezer, ListenBrainz), for every artist, so File uses
    // them without a Score run (docs/NEXT-WORKPLAN.md package 2). Last, so they
    // don't compete with the tag lookups; resumes where the last load stopped.
    if (typeof bridgeWarm === 'function') await bridgeWarm().catch(() => {});
  })();
  // Listening resumes by itself where it left off, if it was switched on — after the first
  // paint. (On a first run the analysis above starts it.)
  if (audioSettings().on && !FIRST_RUN) setTimeout(() => audioStart({ quiet: true }), 3000);
  // Score + Tune by itself: first look a minute in, then every five minutes while the tab is in front.
  try { autoScoreStart(); } catch { /* optional */ }
}

async function start(force) {
  let t;
  try { t = await token(); }
  catch (e) {
    const streak = e.status === 429 ? noteRateLimited() : 0;
    blocked(e.message, () => start(force), e.retryAfterMs, streak >= RATE_LIMIT_OWN_APP_AFTER);
    return;
  }
  clearRateLimitStreak();
  if (!t) {
    $('#land').hidden = false; $('#app').hidden = true;
    // Signed in in Safari and puzzled to be asked again here: say why, once,
    // where it is being asked rather than in a toast that disappears.
    if (standalone() && !$('#landWhy')) {
      const why = document.createElement('p');
      why.id = 'landWhy'; why.className = 'fineprint';
      why.textContent = 'iPhone keeps this app’s data separate from Safari’s, so it needs its own sign-in. It only asks once.';
      $('.cta')?.after(why);
    }
    return;
  }
  // A first paint from a partial read (docs/BUILD-7-PLAN.md P1): set once File is up on the
  // playlists and the first liked page, while syncLibrary goes on reading the rest.
  let early = null;
  LIB_READ = null;
  try {
    stage('Reading your library…', 0.02);
    LIB = force ? null : await idb.get('library');
    // A partial read is never the cache: something that saved LIB mid-read (Shuffle does) left
    // half the liked songs behind, so read again; the banked pieces make that a resume.
    if (LIB?.partial) LIB = null;
    performance.mark('bf:library');
    if (!LIB) {
      let at = 0.02;
      // A pause at the very start of a read is not a busy moment, it is a quota
      // that has already gone — so the way out rides along with the countdown
      // rather than waiting for the read to give up first.
      onHold = secs => stage(secs
        ? `Spotify asked for a pause — carrying on in ${secs}s. Leave this open.`
        : 'Carrying on…', at, secs ? ownAppNote() : '');
      const progress = (name, pct, n) => {
        // Once File is up the read carries on behind it: the status line counts, the page stays.
        if (early) { libReadProgress(n); return; }
        at = pct; stage(`Reading ${name}…`, pct);
      };
      const partial = lib => {
        LIB_READ = { done: lib.liked.length, total: lib.liked_total ?? null };
        // From here a pause shows as the small floating note (auth.js slowNote), not the landing page.
        onHold = null;
        early = firstPaint(lib).catch(e => { early = null; LIB_READ = null; throw e; });
        early.catch(() => {});
      };
      try { LIB = await readLibraryWhole(force, progress, partial, () => early); }
      finally { onHold = null; }
    }
    if (early) {
      // The first paint may still be on its way (the tag table is a download of its own).
      await early;
      await takeFullLibrary(LIB);
    } else await firstPaint(LIB);
    LIB_READ = null;
    afterFirstPaint();
  } catch (e) {
    LIB_READ = null;
    if (early) {
      // File is already up on the partial read: keep it, and say the rest did not come.
      toast('Could not read the rest of your liked songs: ' + e.message + ' Re-sync in Settings to try again.');
      store.touch('ui.inbox');
      return;
    }
    if (retryable(e)) {
      const streak = e.status === 429 ? noteRateLimited() : 0;
      blocked(e.message, () => start(force), e.retryAfterMs, streak >= RATE_LIMIT_OWN_APP_AFTER);
      return;
    }
    // Spotify lets a non-allowlisted account complete sign-in and only refuses
    // the API calls that follow, with a 403 — so this is discovered here, on
    // the very first read (/me, the playlist list, or liked songs; a 403 on an
    // individual playlist is already tolerated inside syncLibrary and never
    // reaches this catch). It is the exact same fix access_denied already
    // offers, just found one step later. Reload into it rather than rebuilding
    // the panel here: stage() above has already overwritten #land's pristine
    // markup, panel and wiring included, and only a fresh load has that back.
    if (e.status === 403) { location.href = REDIRECT + '?setup&reason=not_allowlisted'; return; }
    // Whatever went wrong here, signing out is almost never the fix — and it
    // used to be the only button on the screen. Clearing the token sent people
    // back to the accounts service, which is rate-limited per app, which
    // answered 429: "Spotify is handling too many requests." That is how one
    // unexplained error turned into a sign-in that would not complete. So Try
    // again keeps the sign-in and resumes from the banked pieces; starting over
    // is still there, for whoever actually wants it.
    $('#land').hidden = false; $('#app').hidden = true;
    $('#land').innerHTML = `<h1 class="logo">${LOGO_HTML}</h1>
      <p class="tagline">${esc(e.message)}</p>
      <button class="b p" id="landAgain">Try again</button>
      <p class="fineprint">Nothing already read is lost — this carries on from where it stopped.<br>
        Still stuck? <a href="#" id="landReset">Sign out and start over</a>.</p>`;
    $('#landAgain').onclick = () => start(force);
    $('#landReset').onclick = ev => {
      ev.preventDefault();
      LS.removeItem('bf_tok'); LS.removeItem('bf_autoconnect');
      location.href = REDIRECT;
    };
  }
}

// Spotify's raw error codes mean nothing to someone who just wanted to sort
// their playlists, so say what to actually do about each.
const FRIENDLY = {
  access_denied: 'Sign-in was cancelled, or this Spotify account hasn’t been approved for this app yet — see below for a way around that which needs nobody’s approval.',
  invalid_client: 'The app is not configured correctly yet. Let the person who sent you this link know.',
  invalid_scope: 'Spotify refused one of the permissions. Try again, and accept all of them.',
  server_error: 'Spotify had a problem. Try again in a moment.',
};

(async () => {
  if (T.rememberFilters) { if (T.crossMin) S.crossMin = T.crossMin; if (T.mfBand) S.mfBand = T.mfBand; if (T.discSide) S.discSide = T.discSide; }

  // Insert the "use your own app" hint shared by access_denied and a 403
  // discovered after sign-in (the reason=not_allowlisted branch below).
  // Idempotent: a page that already shows the hint does not get a second one.
  // CONTACT_EMAIL is blank unless whoever built this page opted in (see
  // build-web.mjs), so a fork of this repo never ships a stranger's inbox —
  // the extra sentence just does not exist for it.
  function offerOwnAppHint(html) {
    if ($('#landSetupHint')) return;
    const hint = document.createElement('p');
    hint.id = 'landSetupHint'; hint.className = 'fineprint';
    hint.innerHTML = html + (CONTACT_EMAIL ? ' Or, if you would rather not: '
      + `<a href="mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Betterfy access')}`
      + `&body=${encodeURIComponent('My Spotify account email is: ')}">ask to be added</a> instead — `
      + 'no setup on your end, just a wait for a reply.' : '');
    $('.cta')?.after(hint);
  }

  const q = new URLSearchParams(location.search);
  if (q.get('setup') !== null) { $('#setupPanel').hidden = false; LS.setItem('bf_setup','1'); }
  else if (LS.getItem('bf_setup')) $('#setupPanel').hidden = false;

  // A 403 discovered mid-sync (see start()'s catch) reloads to this exact URL
  // rather than rebuilding the setup panel in place: by the time that 403
  // happens, stage() has already overwritten #land's pristine markup — panel,
  // wiring and all — so only a fresh load has it to reveal. Stop here rather
  // than falling through to start() below: it would just hit the same 403 again.
  if (q.get('reason') === 'not_allowlisted') {
    history.replaceState({}, '', REDIRECT + '?setup');
    $('#ownAppDetails').open = true;
    offerOwnAppHint('Sign-in went through, but Spotify is still refusing requests for this account until '
      + 'it’s approved — you don’t need to ask to be added, though: '
      + '<a href="#ownAppDetails">use your own Spotify app</a> instead, set up in about a minute, '
      + 'sharing nothing with whoever sent you this link.');
    toast('This Spotify account isn’t on the approved list for this app yet.');
    return;
  }

  // Arrived here from "Update now": the cache-busting parameter has done its
  // job, so tidy it out of the address bar.
  if (q.has('v')) history.replaceState({}, '', REDIRECT);

  // Quiet check on every load, so a stale tab says so without being asked.
  // Deliberately not awaited — it must never delay the library from loading.
  setTimeout(() => checkForUpdate(true), 1500);

  if (q.get('error')) {
    const code = q.get('error');
    $('#land').hidden = false;
    toast(FRIENDLY[code] ?? `Sign-in failed (${code}). Try again.`);
    // access_denied covers both "you tapped cancel" and "this app has a
    // user cap and you're not on the list" — Spotify doesn't say which.
    // Rather than send everyone back to whoever runs this page to be added by
    // email, hand them the way to skip that approval entirely: their own free
    // Spotify app, registered under their own account, needing nobody's say-so.
    if (code === 'access_denied') {
      $('#setupPanel').hidden = false;
      $('#ownAppDetails').open = true;
      LS.setItem('bf_setup', '1');
      offerOwnAppHint('If this account isn’t on the approved list, you don’t need to ask to be added — '
        + '<a href="#ownAppDetails">use your own Spotify app</a> instead, set up in about a minute, sharing nothing with whoever sent you this link.');
    }
    history.replaceState({},'',REDIRECT);
    return;
  }
  const code = q.get('code');
  if (code) {
    // Take the code out of the address bar *before* posting it, and remember
    // that it has been posted. A home-screen app is reopened at the URL it was
    // last on, and iOS discards the page behind it freely — so a page still
    // carrying ?code= sent that same, already-spent code to Spotify again on
    // every reopen. Enough of those in a row is what earned the 429.
    history.replaceState({}, '', REDIRECT);
    if (LS.getItem('bf_code_used') !== code) {
      LS.setItem('bf_code_used', code);
      try { await exchange(code); }
      catch (e) {
        // The code is spent, so retrying means signing in from the top —
        // worth offering for a rate limit, which passes on its own. Carrying
        // the real wait through means this waits it out instead of inviting
        // an impatient tap that just asks the same rate-limited endpoint for
        // another code right away.
        if (retryable(e)) {
          const streak = e.status === 429 ? noteRateLimited() : 0;
          blocked(e.message, () => beginAuth(), e.retryAfterMs, streak >= RATE_LIMIT_OWN_APP_AFTER);
        } else { $('#land').hidden = false; signInUnavailable(e.message); }
        return;
      }
    }
  }
  // iOS gives a home-screen app its own storage, so it opens with no sign-in
  // even when Safari has one — there is no way to hand it across. What can be
  // done is not making a person do it: the first time this app is opened from
  // the Home Screen it goes to Spotify itself, and since Spotify already has
  // the grant it comes straight back. One attempt only, and the flag is set
  // before leaving, so a refusal lands on the landing page and stays there
  // rather than bouncing in a loop.
  // A browser that keeps nothing can still finish a sign-in — the verifier only
  // has to survive one redirect, and memory does that. What it cannot do is keep
  // you signed in: the token is gone on the next load, and every open looks like
  // a first open. Better said plainly on the way in than discovered repeatedly.
  if (!LS.durable && !$('#landNoStore')) {
    const p = document.createElement('p');
    p.id = 'landNoStore'; p.className = 'fineprint';
    p.textContent = 'This browser is not letting Betterfy store anything, so it will ask you to '
      + 'sign in every time and re-read your library each session. Turning off "Block All Cookies" '
      + 'for this site, or using a normal window rather than a private one, fixes that.';
    $('.cta')?.after(p);
  }

  if (autoConnectDue()) {
    LS.setItem('bf_autoconnect', '1');
    stage('Signing you in…', 0.01);
    // beginAuth() ends in a navigation, so this normally never resolves —
    // but if it throws first (no network, no secure context) that must not
    // leave "Signing you in…" on screen forever with no way off it.
    try { return await beginAuth(); }
    catch (e) {
      const streak = e.status === 429 ? noteRateLimited() : 0;
      blocked(e.message, () => beginAuth(), e.retryAfterMs, streak >= RATE_LIMIT_OWN_APP_AFTER);
      return;
    }
  }

  start(false);
})();
