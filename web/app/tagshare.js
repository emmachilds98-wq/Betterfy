/** Release styles for an artist Last.fm has nothing on at all — never called
 *  otherwise, since a real Last.fm tag always wins outright. */
/* ---------- giving a tag back ----------
 * The shipped tag table covers one person's artists. Everyone else's gaps get
 * filled by their own Last.fm key, into their own IndexedDB, where the answer
 * helps nobody else and dies when they clear site data — so every listener
 * re-solves the same gaps from scratch, forever.
 *
 * What is shared here is only what a public API returned for an artist, which
 * is the same answer for everyone and can be re-fetched by anyone. Corrections
 * made in the tag editor are opinionated and stay local; that split is what
 * keeps a shared table worth trusting.
 *
 * Entirely optional, per CLAUDE.md's rule for anything outside Spotify: with no
 * project configured this is a no-op, a failure is silent, and nothing waits on
 * it. A build with no sharing configured behaves exactly as it always did. */
const TAGS_PROJECT = '__TAGS_PROJECT__', TAGS_KEY = '__TAGS_KEY__';

/** Configured, and not just carrying an unreplaced build placeholder. */
const sharingTags = () => /^[a-z][a-z0-9-]{3,39}$/.test(TAGS_PROJECT) && TAGS_KEY.length >= 20;

/* App Check: the write above is unauthenticated by design (the Firestore rules
 * are a shape check, not a trust boundary — merge-tags.mjs is the real one),
 * which means anyone can script it into a spam flood or a plausible-looking
 * false tag. App Check closes the "script it at volume" half of that without
 * adding a sign-in: a reCAPTCHA v3 solve attests this request came from a real
 * browser on this real page, exchanged here for a token Firestore itself can
 * be told to require.
 *
 * Same optional pattern as everything else here: with no site key configured,
 * nothing loads, nothing is exchanged, and every contribution goes out exactly
 * as it did before this existed. APP_ID is the Firebase *web app* id (not a
 * secret — it names a thing), and already carries the project number App
 * Check's REST API wants as `projects/{project_number}/apps/{app_id}`. */
const APPCHECK_SITE_KEY = '__APPCHECK_SITE_KEY__', APPCHECK_APP_ID = '__APPCHECK_APP_ID__';
const appCheckConfigured = () => APPCHECK_SITE_KEY.length > 10 && /^\d+:\d+:web:/.test(APPCHECK_APP_ID);

let recaptchaReady = null;
/** Google's reCAPTCHA v3 script, loaded once and only ever when the first
 *  contribution actually needs it — not on every page load. */
function loadRecaptcha() {
  return recaptchaReady ??= new Promise((ok, bad) => {
    const s = document.createElement('script');
    s.src = `https://www.google.com/recaptcha/api.js?render=${APPCHECK_SITE_KEY}`;
    s.onload = ok; s.onerror = () => bad(new Error('reCAPTCHA script failed to load'));
    document.head.appendChild(s);
  });
}

let cachedAppCheckToken = null; // { token, exp }
/** A fresh App Check token, cached until shortly before its own expiry. */
async function appCheckToken() {
  if (cachedAppCheckToken && Date.now() < cachedAppCheckToken.exp - 30000) return cachedAppCheckToken.token;
  await loadRecaptcha();
  const recaptchaToken = await new Promise((ok, bad) => {
    grecaptcha.ready(() => grecaptcha.execute(APPCHECK_SITE_KEY, { action: 'contribute_tags' }).then(ok, bad));
  });
  const projectNumber = APPCHECK_APP_ID.split(':')[1];
  const res = await fetchDeadline(
    `https://firebaseappcheck.googleapis.com/v1/projects/${projectNumber}/apps/${APPCHECK_APP_ID}`
      + `:exchangeRecaptchaV3Token?key=${TAGS_KEY}`,
    { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recaptchaV3Token: recaptchaToken }) },
    8000);
  if (!res.ok) throw new Error(`App Check token exchange answered ${res.status}`);
  const data = await res.json();
  // ttl is a Google Duration string like "3600s"; parseInt reads the leading
  // digits and stops at the "s", which is all that is needed here.
  cachedAppCheckToken = { token: data.token, exp: Date.now() + (parseInt(data.ttl, 10) || 3600) * 1000 };
  return cachedAppCheckToken.token;
}

/**
 * Offer one artist's freshly-fetched tags to the shared table. Never awaited,
 * never retried: the tags are already saved locally, and this is a gift to
 * whoever hits the same gap next rather than something this listener is
 * waiting on.
 * @param tags [name, 0-100][] — Last.fm's own scale.
 */
function contributeTags(artistId, tags) {
  // Wrapped whole: this sits in the middle of fetching and saving a listener's
  // own tags, and nothing optional is allowed to interrupt that.
  try {
    if (!sharingTags() || !artistId || !tags?.length) return;
    // Already in the table everyone downloads, so there is nothing to give.
    if (RAW_TAGS?.[artistId]) return;
    const url = `https://firestore.googleapis.com/v1/projects/${TAGS_PROJECT}/databases/(default)`
      + `/documents/tagContributions?documentId=${encodeURIComponent(artistId)}&key=${TAGS_KEY}`;
    // documentId= on a create means the first contribution for an artist wins
    // and later ones are refused outright — no edits, no overwrites, nothing to
    // reconcile. The refusal is a 409 nobody reads.
    const body = JSON.stringify({ fields: {
      tags:   { stringValue: JSON.stringify(tags.slice(0, 10)) },
      source: { stringValue: 'lastfm' },
      at:     { integerValue: String(Date.now()) },
    } });
    const post = headers => fetchDeadline(url, { method: 'POST', headers, body }, 6000).catch(() => {});
    if (!appCheckConfigured()) { post({ 'content-type': 'application/json' }); return; }
    // Only when App Check is actually configured does fetching a token sit in
    // front of the write. Even then, a slow or failed token fetch must never
    // be the reason this listener's own tag fetch looks broken — so it still
    // posts without the header rather than not posting at all; Firestore's own
    // enforcement setting decides from there whether that write is accepted.
    appCheckToken().then(
      token => post({ 'content-type': 'application/json', 'X-Firebase-AppCheck': token }),
      () => post({ 'content-type': 'application/json' }),
    );
  } catch { /* never the reason a tag fetch failed */ }
}

