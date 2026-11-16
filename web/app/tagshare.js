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

/* Who is voting (BUILD-6 H1). merge-tags.mjs publishes a tag only when two
 * independent contributor ids name it for the same artist, so each document
 * carries one, as `<artist id>_<contributor id>`.
 *
 * The id is not a stable install id. It is the first 16 hex characters of
 * SHA-256(secret + ':' + artist id), where the secret is 128 random bits made
 * on this device the first time it contributes and never sent anywhere. So the
 * same install always casts the same one vote for an artist (Firestore refuses
 * a second create of one document id), while the collection, which anyone can
 * read, cannot group one install's contributions together: a stable id there
 * would have published which artists one listener had in their library. */
const TAGSHARE_SECRET_KEY = 'bf_tagshare_secret';
let tagshareSecretMem = null;   // when storage is blocked: one secret for this visit
function tagshareSecret() {
  try {
    const kept = LS.getItem(TAGSHARE_SECRET_KEY);
    if (/^[0-9a-f]{32}$/.test(kept ?? '')) return kept;
  } catch { /* storage blocked: fall through to a per-visit secret */ }
  const fresh = tagshareSecretMem ?? [...crypto.getRandomValues(new Uint8Array(16))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  tagshareSecretMem = fresh;
  try { LS.setItem(TAGSHARE_SECRET_KEY, fresh); } catch { /* kept in memory instead */ }
  return fresh;
}
/** This install's contributor id for one artist: 16 hex characters, unlinkable across artists. */
async function contributorId(artistId) {
  const bytes = new TextEncoder().encode(`${tagshareSecret()}:${artistId}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
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
    // No Web Crypto (an insecure context): no contributor id, so no vote to cast.
    if (!globalThis.crypto?.subtle) return;
    const body = JSON.stringify({ fields: {
      tags:   { stringValue: JSON.stringify(tags.slice(0, 10)) },
      source: { stringValue: 'lastfm' },
      at:     { integerValue: String(Date.now()) },
    } });
    // documentId= on a create means this install's vote for an artist is cast
    // once and a repeat is refused outright: no edits, no overwrites, nothing
    // to reconcile. The refusal is a 409 nobody reads.
    const post = (docId, headers) => fetchDeadline(
      `https://firestore.googleapis.com/v1/projects/${TAGS_PROJECT}/databases/(default)`
        + `/documents/tagContributions?documentId=${encodeURIComponent(docId)}&key=${TAGS_KEY}`,
      { method: 'POST', headers, body }, 6000).catch(() => {});
    contributorId(artistId).then(cid => {
      const docId = `${artistId}_${cid}`;
      if (!appCheckConfigured()) return post(docId, { 'content-type': 'application/json' });
      // Only when App Check is actually configured does fetching a token sit in
      // front of the write. Even then, a slow or failed token fetch must never
      // be the reason this listener's own tag fetch looks broken — so it still
      // posts without the header rather than not posting at all; Firestore's own
      // enforcement setting decides from there whether that write is accepted.
      return appCheckToken().then(
        token => post(docId, { 'content-type': 'application/json', 'X-Firebase-AppCheck': token }),
        () => post(docId, { 'content-type': 'application/json' }),
      );
    }).catch(() => { /* never the reason a tag fetch failed */ });
  } catch { /* never the reason a tag fetch failed */ }
}


/* ---------- what each source knows about this account (BUILD-6 H1) ----------
 * The Sources coverage card's data: this account's artist ids and, for each,
 * what tags_extra and bridge-raw already say. Read from this device's own
 * IndexedDB; nothing is fetched or sent. web/screens/sources.mjs turns it into
 * percentages (artistCoverage). Re-read at most every 30 seconds while the card
 * is showing, since the bridge lookups fill in behind it. */
const SRC_COV = { data: null, at: 0, pending: null };
function sourceCoverage() {
  if (!SRC_COV.pending && Date.now() - SRC_COV.at > 30000) {
    SRC_COV.pending = loadSourceCoverage()
      .then(changed => { if (changed && typeof underHoodRefresh === 'function') underHoodRefresh(); })
      .catch(() => {})
      .finally(() => { SRC_COV.pending = null; });
  }
  return SRC_COV.data;
}
async function loadSourceCoverage() {
  SRC_COV.at = Date.now();
  if (!LIB) return false;
  const ids = new Set();
  for (const p of LIB.playlists ?? []) for (const t of p.tracks ?? []) for (const a of t.artists ?? []) if (a?.id) ids.add(a.id);
  for (const t of LIB.liked ?? []) for (const a of t.artists ?? []) if (a?.id) ids.add(a.id);
  let extraAll = {}, bridgeAll = {};
  try { extraAll = (await idb.get('tags_extra')) ?? {}; } catch { /* none kept */ }
  try { bridgeAll = (await idb.get(BRIDGE_KEY))?.raw ?? {}; } catch { /* none kept */ }
  // Only what the card reads, so the whole bridge cache is not held twice.
  const extra = {}, bridge = {}, shipped = {};
  for (const id of ids) {
    const x = extraAll[id], b = bridgeAll[id];
    if (x) extra[id] = { source: x.source ?? null, tags: x.tags?.length ? [0] : [] };
    if (b) bridge[id] = { deezerId: b.deezerId ?? null, deezerAt: b.deezerAt, mbid: b.mbid ?? null, mbidAt: b.mbidAt };
    if (RAW_TAGS?.[id]?.tags?.length) shipped[id] = [0];
  }
  const data = { ids: [...ids], shipped, extra, bridge };
  const changed = JSON.stringify(data) !== JSON.stringify(SRC_COV.data);
  SRC_COV.data = data;
  return changed;
}
