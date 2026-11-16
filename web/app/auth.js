/* ---------- PKCE ---------- */
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

/* PKCE needs SHA-256, and crypto.subtle only exists in a secure context. Over
 * plain http, or inside an in-app web view that withholds it, this used to be a
 * bare TypeError thrown out of a click handler nobody was catching — a Connect
 * button that did nothing at all, with no way to tell that apart from the app
 * being broken. Spotify requires S256, so there is no weaker fallback to take;
 * what there is, is saying so. */
const AUTH_UNAVAILABLE = 'This browser will not let Betterfy sign in securely — '
  + 'it is blocking the cryptography the Spotify sign-in needs. Open the page over '
  + 'https, in Safari or Chrome rather than inside another app.';

async function beginAuth() {
  if (!globalThis.crypto?.subtle || !crypto.getRandomValues) throw new Error(AUTH_UNAVAILABLE);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  // Both stores, not one. localStorage because sessionStorage is per-tab and
  // Spotify's redirect can land in a different tab (or a restored one), which
  // is what used to make this work only in a private window. sessionStorage as
  // well because localStorage is the half a locked-down browser takes away, and
  // a sign-in that cannot remember one random string for ten seconds is not
  // worth failing over — the verifier is short-lived and single-use either way.
  LS.setItem('bf_verifier', verifier);
  try { sessionStorage.setItem('bf_verifier', verifier); } catch {}
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  // Nothing below can recover a verifier that was never kept, and finding that
  // out after the round trip to Spotify means failing on the way back in with
  // an error about a "lost security code". Check it here, where it is still
  // one clear sentence about this browser.
  if (readVerifier() !== verifier) throw new Error('This browser is not letting Betterfy store anything, '
    + 'so it cannot complete a Spotify sign-in. Turn off "Block All Cookies" for this site, or open it in a normal window.');
  location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    response_type:'code', client_id:clientId(), scope:SCOPES, redirect_uri:REDIRECT,
    code_challenge_method:'S256', code_challenge:challenge,
  });
}

/* Spotify rate-limits accounts.spotify.com per app rather than per listener, so
 * a busy few minutes can hand any one of us a 429 on sign-in. Two things make
 * that survivable: never treat "too many requests" as "you are signed out",
 * and never answer a 429 with more requests. Note also that the accounts
 * service replies to a 429 in plain text, not the JSON error object the docs
 * describe, so the body has to be parsed defensively. */
const RATE_LIMITED = 'Spotify is handling too many requests right now. Wait a minute, then try again.';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The PKCE verifier, from whichever store still has it. Written to both on the
 *  way out, because a locked-down browser takes localStorage away and not always
 *  sessionStorage with it. */
function readVerifier() {
  let v = null;
  try { v = sessionStorage.getItem('bf_verifier'); } catch {}
  return v || LS.getItem('bf_verifier');
}

/* Every request this page makes gets a deadline. fetch() has none of its own,
 * and a phone hands you a request that never settles often enough to matter:
 * a hung sign-in POST and a sign-in that is never going to finish look exactly
 * the same from the outside, and the second one is what people were reporting. */
const CALL_TIMEOUT = 20000;

/** fetch with a deadline. AbortController is everywhere that matters; where it
 *  is not, the call is still made, just without the deadline. */
async function fetchDeadline(url, opts = {}, ms = CALL_TIMEOUT) {
  if (typeof AbortController !== 'function') return fetch(url, opts);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

/** A 429/5xx/offline failure; the sign-in itself is still good. */
const retryable = e => !!e?.retryable;
/** @param {number} [retryAfterMs] — when known, how long Spotify actually asked for. */
const authError = (msg, status, retryAfterMs) => Object.assign(new Error(msg), {
  status, retryable: status === 429 || status >= 500 || status === 0, retryAfterMs,
});

async function tokenRequest(params) {
  let wait = 1000;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      // Deadline, not just a catch: a sign-in POST that hangs is indistinguishable
      // from a sign-in that is simply never going to finish, and the second one is
      // what people were looking at.
      res = await fetchDeadline('https://accounts.spotify.com/api/token', {
        method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({ ...params, client_id:clientId() }),
      });
    } catch {
      if (attempt >= 2) throw authError('Could not reach Spotify. Check your connection and try again.', 0);
      await sleep(wait); wait *= 2; continue;
    }
    const body = await res.json().catch(() => null);
    if (res.ok) return body;
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      // Retry-After is in seconds and Spotify can ask for minutes or hours.
      // Wait out a short one; anything longer is reported, never slept through.
      const after = (+res.headers.get('retry-after') || 0) * 1000;
      if (after <= 10000) { await sleep(Math.max(wait, after)); wait *= 2; continue; }
    }
    throw authError(res.status === 429 ? RATE_LIMITED
      : (body?.error_description || body?.error?.message || body?.error || `Spotify answered ${res.status}.`),
      res.status, res.status === 429 ? (+res.headers.get('retry-after') || 0) * 1000 || undefined : undefined);
  }
}

async function exchange(code) {
  const verifier = readVerifier();
  if (!verifier) throw new Error('Sign-in could not be completed — the browser lost the security code. Tap Connect Spotify again.');
  try {
    const t = await tokenRequest({ grant_type:'authorization_code', code, redirect_uri:REDIRECT,
                                   code_verifier:verifier });
    t.expires_at = Date.now() + t.expires_in * 1000;
    LS.setItem('bf_tok', JSON.stringify(t));
    return t;
  } finally {
    // The code is spent either way, so the verifier that goes with it is too.
    LS.removeItem('bf_verifier');
    try { sessionStorage.removeItem('bf_verifier'); } catch {}
  }
}

// One refresh at a time. Every stale-token caller used to post its own, so a
// screenful of parallel requests asked the rate-limited endpoint for the same
// token several times over.
let refreshing = null;

async function token() {
  const t = JSON.parse(LS.getItem('bf_tok') || 'null');
  if (!t) return null;
  if (Date.now() < t.expires_at - 60000) return t.access_token;
  if (!refreshing) refreshing = refresh(t).finally(() => { refreshing = null; });
  return refreshing;
}

async function refresh(t) {
  let f;
  try {
    f = await tokenRequest({ grant_type:'refresh_token', refresh_token:t.refresh_token });
  } catch (e) {
    // A rate limit or a dropped connection means "later", not "sign in again".
    // Throwing away the saved token here is what sent people back to the
    // sign-in screen — where signing in asked the same rate-limited endpoint
    // for another token, and got the same 429 back.
    if (retryable(e)) throw e;
    LS.removeItem('bf_tok');
    // A token Spotify has actually rejected, not just rate-limited, is a real
    // sign-out — so the home-screen app's one shot at signing itself back in
    // is worth spending again, rather than leaving it stuck on a landing page
    // with a button to tap forever because that shot was already used at
    // install time.
    LS.removeItem('bf_autoconnect');
    return null;
  }
  // Spotify only sometimes issues a new refresh token; keep the old one otherwise.
  const merged = { ...t, ...f, expires_at: Date.now() + f.expires_in*1000 };
  LS.setItem('bf_tok', JSON.stringify(merged));
  return merged.access_token;
}

/* ---------- Spotify ----------
 * Reading a large library cold is hundreds of calls, and Spotify's limit is a
 * rolling window rather than a per-call one — fire them off as fast as the
 * network allows and you will find it. So every call is paced, the pace slackens
 * as soon as Spotify pushes back, and it tightens again once it stops. */
/* The floor used to be 70ms — fourteen calls a second, several times what a
 * Spotify app that has not been granted extended quota is allowed, so a cold
 * read did not risk a 429 so much as guarantee one. It is worse than that when
 * the page's default client ID is shared: the quota is the app's, not the
 * listener's, so two friends reading their libraries at once are spending the
 * same budget. Pace for the shared case, because that is the case this page is
 * for. The ceiling is high enough to actually be a pause rather than a slightly
 * slower version of the same mistake. */
const MIN_GAP = 250, MAX_GAP = 4000;
/* Multiplicative increase on a 429, additive decrease on success — the pace
 * backs off fast and recovers slowly. It used to recover by a tenth per call,
 * which walked all the way back down to the floor in under thirty calls and
 * straight into the next 429; that oscillation is what turned one busy minute
 * into a read that never finished. */
const GAP_RECOVER = 25;
const GAP_KEY = 'bf_gap';

/* iOS discards the page behind you freely, and every reopen used to start again
 * at full speed — including the reopen right after Spotify asked for a pause.
 * So the pace Spotify last agreed to is remembered, and only half-forgotten on
 * the way back in: quick enough to speed up again once the queue clears, slow
 * enough not to walk into the same wall on the first call. */
const rememberedGap = () => {
  try { return Math.min(MAX_GAP, Math.max(MIN_GAP, (+LS.getItem(GAP_KEY) || 0) / 2)); }
  catch { return MIN_GAP; }
};
let gap = rememberedGap();   // ms between calls
const setGap = ms => {
  gap = Math.min(MAX_GAP, Math.max(MIN_GAP, ms));
  try { LS.setItem(GAP_KEY, String(Math.round(gap))); } catch {}
};
let nextAt = 0;      // earliest moment the next call may leave

/** Set while a sync is on screen, so a pause can say so instead of looking hung. */
let onHold = null;

/* Spotify's limit is a rolling window, so a quiet stretch drains it. Without
 * this, a back-off earned during a cold sync outlives the window it was earned
 * in — and every tap for the rest of the session waits on a queue that emptied
 * minutes ago. */
const GAP_IDLE_RESET = 30000;

async function pace() {
  const now = Date.now();
  if (nextAt && now - nextAt > GAP_IDLE_RESET) setGap(MIN_GAP);
  const at = Math.max(now, nextAt);
  nextAt = at + gap;
  if (at > now) await sleep(at - now);
}

/** Sit out a rate limit, counting down rather than going quiet. */
async function hold(ms) {
  const until = Date.now() + ms;
  try {
    for (let left = ms; left > 0; left = until - Date.now()) {
      onHold?.(Math.ceil(left / 1000));
      if (!onHold) slowNote(Math.ceil(left / 1000));
      await sleep(Math.min(1000, left));
    }
  } finally { onHold?.(0); slowNote(0); }
}

/** E1: a pause outside the first sync is a visible state, not a silent wait. */
function slowNote(secs) {
  if (typeof document === 'undefined') return;
  let el = document.getElementById('slowdown');
  if (!secs) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'slowdown'; el.setAttribute('role', 'status');
    el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:76px;z-index:60;padding:10px 14px;border-radius:12px;'
      + 'background:var(--surface,#222);color:var(--ink,#fff);border:1px solid var(--line,#888);font-size:13px;text-align:center';
    document.body.appendChild(el);
  }
  el.textContent = `Spotify asked us to slow down \u2014 retrying in ${secs}s`;
}

// A 429 is worth sitting through quietly only while the wait is short — that
// covers ordinary throttling. Retry-After is not a suggestion, and Spotify can
// legitimately ask for minutes at a time, especially on a client ID shared by
// everyone using the hosted page; holding through one of those with nothing
// on screen but a re-arming countdown, up to eight times in a row, is what
// "stuck on Spotify asked for a pause" actually was — the same silent wait
// restarting for over an hour with no way to back out of it. Past this budget
// the pause is surfaced instead: a real screen with a Try again button and an
// honest wait time, which is what "stuck" needs to stop meaning "frozen".
const AUTO_HOLD_MAX = 20000;    // sit out any single wait this short or less
const AUTO_HOLD_BUDGET = 60000; // …but never more than this in total per call

/* And a budget for the read as a whole, because the per-call one never trips in
 * the case that matters. A quota that is simply gone answers the very first
 * call of a read with a 429, then the next, then the next — each pause short
 * enough to absorb, each one starting its countdown over, none of them ever
 * reaching a per-call limit. From the outside that is a progress bar stuck at
 * 2% and "Spotify asked for a pause" re-arming forever, which is exactly the
 * report. No amount of waiting fixes it either: the quota belongs to the app,
 * not to the listener, so it is being spent by everyone else with this page
 * open. Past this, stop absorbing and show the screen that names the real fix. */
const HOLD_BUDGET_RUN = 15000;
let heldRun = 0;   // reset at the top of every read

/* A phone's network is not a desktop's. It changes cell mid-request, hands over
 * to Wi-Fi, and every so often leaves a request hanging with nobody ever coming
 * back to it — and fetch() has no deadline of its own, so the read simply sat on
 * "Reading <playlist>…" for as long as anyone was willing to watch it.
 *
 * The dropped ones were worse than the hung ones. A dropped fetch throws a
 * TypeError ("Load failed", in Safari), and a TypeError carries no `retryable`
 * flag — so one blip in the middle of a several-hundred-call read was read as a
 * permanent answer, and there were only two permanent answers available: bank
 * that playlist as empty, or decide the sign-in is dead and offer Start over.
 * Start over cleared the token, so the next thing anyone did was sign in again
 * — at the accounts service, which is rate-limited per app, which answered 429,
 * which is the "too many requests" screen. The whole loop started with one
 * dropped request that should have simply been asked again. */
const NET_TRIES = 3;         // a dropped, hung or 5xx call is just asked again

/* The shipped tag table is 435KB, fetched over whatever signal a phone has at
 * the time. It used to be a bare fetch().then(r => r.json()): one blip threw a
 * TypeError, TypeErrors are not retryable, and the only button on the screen
 * that answered was Start over — which cleared a perfectly good sign-in over a
 * failed static file. */
async function fetchTags() {
  for (let i = 0; ; i++) {
    try {
      const r = await fetchDeadline('tags.json?v=__BUILD__', {}, 45000);
      if (!r.ok) throw new Error(String(r.status));
      return await r.json();
    } catch {
      if (i >= 2) throw authError('Could not load the genre tags. Your library is already read — this only needs the connection back.', 0);
      await sleep(1000 * 2 ** i);
    }
  }
}

/** Make the next token() go back to Spotify even though the cached one still
 *  looks fresh — for a 401, which means it stopped being fresh early. */
function expireToken() {
  try {
    const t = JSON.parse(LS.getItem('bf_tok') || 'null');
    if (t) LS.setItem('bf_tok', JSON.stringify({ ...t, expires_at: 0 }));
  } catch {}
}

const NET_LOST = 'Lost the connection to Spotify. Nothing read so far is lost — this picks up where it stopped.';

async function sp(path, opts = {}) {
  const url = path.startsWith('http') ? path : 'https://api.spotify.com/v1' + path;
  let held = 0;      // ms of 429 already sat through quietly, this call
  let soft = 0;      // dropped / hung / 5xx attempts, this call
  let back = 1000;   // and how long to wait before the next of those
  let reauthed = false;
  for (let i = 0; ; i++) {
    await pace();
    let res;
    try {
      res = await fetchDeadline(url, { ...opts, headers:{ authorization:'Bearer ' + await token(),
        'content-type':'application/json', ...opts.headers } });
    } catch (e) {
      // Offline, dropped, or hung past the deadline. Ask again — and if it keeps
      // failing, say so as something retryable, because it is the network, not
      // an empty playlist and not a dead sign-in.
      // A POST that dropped may still have landed: never blindly resend it. The
      // caller re-reads what is there and sends only what is missing.
      if (opts.method === 'POST') throw Object.assign(authError(NET_LOST, 0), { ambiguous: true });
      if (++soft >= NET_TRIES) throw authError(NET_LOST, 0);
      setGap(gap * 2); await sleep(back); back *= 2; continue;
    }
    if (res.status === 429) {
      const after = (+res.headers.get('retry-after') || 0) * 1000;
      // A quota-exceeded 429 carries a reason Spotify only added recently: the
      // app's whole request budget for the period is gone, not a busy moment,
      // so neither a quiet hold nor a counted-down retry is ever going to
      // change the answer — saying otherwise, with a countdown promising it
      // will "carry on by itself", would be worse than saying nothing.
      const body = await res.json().catch(() => null);
      const quotaExceeded = body?.error?.reason === 'QUOTA_EXCEEDED';
      const wait = after || Math.min(2000 * 2 ** i, 60000);
      setGap(gap * 2);
      if (!quotaExceeded && wait <= AUTO_HOLD_MAX && held + wait <= AUTO_HOLD_BUDGET
          && heldRun + wait <= HOLD_BUDGET_RUN) {
        held += wait; heldRun += wait; await hold(wait); continue;
      }
      if (quotaExceeded) throw authError('This app’s Spotify request quota is used up for now — '
        + 'waiting will not change that, however long. Your own Spotify app has a quota nobody else can spend; see below.', 429);
      // wait, not after: after is only ever this one response's own Retry-After
      // (or 0), and what the fallback screen needs to wait out is whatever this
      // attempt actually asked for — the backoff estimate when Spotify sent none.
      throw authError(after >= 60000
        ? `Spotify has asked for a pause — about ${Math.round(after / 60000)} minute${after >= 90000 ? 's' : ''}. It will carry on by itself once that has passed.`
        : RATE_LIMITED, 429, wait);
    }
    // Spotify's own bad day. Same treatment as a dropped connection: ask again,
    // and if it will not settle, report it as something to come back to rather
    // than as the sign-in having failed.
    if (res.status >= 500) {
      if (opts.method === 'POST') throw Object.assign(authError(`Spotify answered ${res.status}. It may or may not have saved that.`, res.status), { ambiguous: true });
      if (++soft >= NET_TRIES) throw authError(`Spotify answered ${res.status}. It will pick up where it stopped.`, res.status);
      setGap(gap * 2); await sleep(back); back *= 2; continue;
    }
    // A token that has stopped working early — revoked, or the grant changed.
    // Worth exactly one forced refresh before believing it; token() will clear
    // the sign-in itself if Spotify refuses that too.
    if (res.status === 401 && !reauthed) { reauthed = true; expireToken(); continue; }
    setGap(gap - GAP_RECOVER);
    if (res.status === 204) return null;
    const body = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(`${res.status} ${body?.error?.message ?? ''}`), { status: res.status });
    return body;
  }
}
async function paged(path, key) {
  const out = []; let page = await sp(path);
  while (page) { const box = key ? page[key] : page; out.push(...(box.items ?? [])); if (!box.next) break; page = await sp(box.next); }
  return out;
}

