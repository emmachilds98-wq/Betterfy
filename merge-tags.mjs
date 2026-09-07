// Fold contributed Last.fm tags into docs/tags.json. Run: node merge-tags.mjs
//
// The shipped tag table covers one person's artists, and tag coverage is the
// ceiling on every suggestion the app makes. Everyone else's gaps get filled by
// their own Last.fm key into their own browser, where the answer helps nobody
// and dies with their site data — so each listener re-solves the same gaps.
//
// The browser build offers those answers to a Firestore collection; this folds
// them back into the file everyone downloads. Deliberately a build-time job
// rather than a runtime read: the page's read path does not change at all, so
// nobody pays a per-artist database read and no free tier is at risk. The
// shipped table simply gets better.
//
// Everything here is public. Contributions are only ever what a public API
// returned, they are published in this repo the moment they merge, and the
// Firebase web key identifies a project rather than authorising anything.
// Which means the validation below is the real security boundary: writes are
// unauthenticated, so nothing is trusted until it has been through it.
import { readFileSync, writeFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

/** Spotify IDs are 22 base62 characters. Anything else was not written by the app. */
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

const MAX_TAGS = 10;        // what the shipped table carries per artist
const MAX_NAME = 40;
const LASTFM_MAX = 100;     // Last.fm's gettoptags count scale

/**
 * One contribution's `tags` field → the shipped table's shape, or null.
 *
 * Two scales meet here. Last.fm counts run 0-100 and that is what the browser
 * contributes; docs/tags.json stores 0-10 and the page multiplies by ten on
 * load. Getting this backwards would not fail loudly — it would quietly make
 * every contributed artist ten times more or less confident than the shipped
 * ones, and skew every suggestion they take part in.
 *
 * @param {string} raw JSON text, as stored in the document's `tags` field.
 * @returns {[string, number][] | null} 0-10 scale, or null if not usable.
 */
export function normaliseContribution(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 20) return null;

  const seen = new Set();
  const out = [];
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [rawName, rawCount] = entry;
    if (typeof rawName !== 'string' || typeof rawCount !== 'number') return null;

    const name = rawName.trim().toLowerCase();
    // A tag has to be a word. Empty, oversized, or punctuation-only is either a
    // bug upstream or somebody trying it on.
    if (!name || name.length > MAX_NAME || !/[a-z0-9]/.test(name)) return null;
    if (!Number.isFinite(rawCount) || rawCount <= 0 || rawCount > LASTFM_MAX) return null;

    if (seen.has(name)) continue;
    seen.add(name);
    out.push([name, rawCount]);
  }
  if (!out.length) return null;
  // Rank on the true count and cut to ten before rounding. Rounding first
  // collapses 35 and 44 into the same bucket, and then "the strongest ten"
  // becomes "whichever ten happened to arrive first".
  return out.sort((a, b) => b[1] - a[1]).slice(0, MAX_TAGS)
    // Never below 1: the browser only sends counts of 10 and up, and a tag
    // rounded away to 0 is a tag silently lost.
    .map(([name, count]) => [name, Math.max(1, Math.min(10, Math.round(count / 10)))]);
}

/**
 * Fold valid contributions into the existing table.
 *
 * Gaps only — an artist already in tags.json is never overwritten. That is what
 * makes an unauthenticated write safe: the worst a bad contribution can do is
 * add an artist nobody had, which the next run of this script cannot be tricked
 * into using to replace one that was already right.
 *
 * @param {Record<string, [string, number][]>} existing docs/tags.json, as shipped.
 * @param {{id: string, tags: string}[]} contributions
 */
export function mergeContributions(existing, contributions) {
  const merged = { ...existing };
  const added = [], covered = [], rejected = [];

  for (const { id, tags } of contributions) {
    if (!SPOTIFY_ID.test(id ?? '')) { rejected.push({ id, why: 'not a Spotify artist id' }); continue; }
    if (merged[id]) { covered.push(id); continue; }
    const clean = normaliseContribution(tags ?? '');
    if (!clean) { rejected.push({ id, why: 'tags failed validation' }); continue; }
    merged[id] = clean;
    added.push(id);
  }
  return { merged, added, covered, rejected };
}

/* ---------- everything below only runs as a script ---------- */

/** Read a config value the published page already carries, so nothing is duplicated. */
function fromBuiltPage(re) {
  try { return readFileSync('docs/index.html', 'utf8').match(re)?.[1] ?? null; } catch { return null; }
}

/**
 * A signed JWT a Google service account can exchange for an OAuth2 access
 * token, scoped to Firestore only (`datastore`) — the narrowest scope that
 * still permits a delete, so a leaked token is not a leaked "do anything to
 * this Google Cloud project" credential.
 * @param {{client_email: string, private_key: string}} account
 */
export function serviceAccountAssertion(account, now = Date.now()) {
  const b64url = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const iat = Math.floor(now / 1000);
  const signingInput = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat, exp: iat + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(account.private_key, 'base64url');
  return `${signingInput}.${signature}`;
}

async function serviceAccountToken(account) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: serviceAccountAssertion(account),
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Google OAuth2 token exchange failed: ${res.status} ${JSON.stringify(body)}`);
  return body.access_token;
}

/**
 * Delete every contribution this run has already read and accounted for.
 * Nothing further is ever needed from any of them: one that merged now lives
 * in docs/tags.json, and one that was rejected cannot become valid without a
 * new document id — Firestore's create-only rules mean the same id can never
 * be corrected in place. Left in place, both kinds do nothing but grow the
 * collection and cost the next run a bigger read for no benefit.
 *
 * Best-effort per document: one failure does not stop the rest, and anything
 * left undeleted is picked up by the next run rather than lost.
 * @returns {Promise<{deleted: number, failed: string[]}>}
 */
export async function pruneContributions(project, account, ids) {
  if (!ids.length) return { deleted: 0, failed: [] };
  const token = await serviceAccountToken(account);
  const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/tagContributions`;
  let deleted = 0;
  const failed = [];
  for (const id of ids) {
    const res = await fetch(`${base}/${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (res?.ok) deleted++; else failed.push(id);
  }
  return { deleted, failed };
}

async function fetchContributions(project, key) {
  const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)`
    + `/documents/tagContributions`;
  const out = [];
  let pageToken = '';
  for (let page = 0; page < 200; page++) {   // a hard stop, so a paging bug cannot loop forever
    const url = `${base}?key=${key}&pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Firestore answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    for (const doc of body.documents ?? [])
      out.push({ id: doc.name.split('/').pop(), tags: doc.fields?.tags?.stringValue ?? '' });
    if (!body.nextPageToken) break;
    pageToken = body.nextPageToken;
  }
  return out;
}

async function main() {
  const project = process.argv[2] ?? process.env.TAGS_PROJECT
    ?? fromBuiltPage(/const TAGS_PROJECT = '([a-z][a-z0-9-]{3,39})'/);
  const key = process.argv[3] ?? process.env.TAGS_KEY
    ?? fromBuiltPage(/TAGS_KEY = '([A-Za-z0-9_-]{20,})'/);

  if (!project || !key) {
    // Not an error. A fork with no shared table is a supported way to run this.
    console.error('No shared tag project configured — nothing to merge.');
    return;
  }

  const existing = JSON.parse(readFileSync('docs/tags.json', 'utf8'));
  const before = Object.keys(existing).length;
  const contributions = await fetchContributions(project, key);
  console.error(`${contributions.length} contribution(s) for ${before} artists already covered`);

  const { merged, added, covered, rejected } = mergeContributions(existing, contributions);

  for (const r of rejected.slice(0, 20)) console.error(`  rejected ${r.id}: ${r.why}`);
  if (rejected.length > 20) console.error(`  …and ${rejected.length - 20} more`);

  if (!added.length) {
    console.error(`nothing new (${covered.length} already covered, ${rejected.length} rejected)`);
  } else {
    // Sorted, so the diff of a 400KB file is readable and two runs that add
    // the same artists produce the same bytes.
    const sorted = Object.fromEntries(Object.keys(merged).sort().map(k => [k, merged[k]]));
    writeFileSync('docs/tags.json', JSON.stringify(sorted));
    console.error(`docs/tags.json — ${before} → ${Object.keys(sorted).length} artists `
      + `(+${added.length}, ${covered.length} already covered, ${rejected.length} rejected)`);
  }

  // Optional, same as everything else here: with no service account this
  // collection just keeps every contribution forever, which is safe (nothing
  // reads it but this script) but grows unbounded for no benefit. Every
  // contribution fetched this run has now been accounted for — merged,
  // already-covered, or permanently rejected — so all of them are safe to
  // remove regardless of which.
  const serviceAccountJSON = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountJSON) {
    console.error('FIREBASE_SERVICE_ACCOUNT not set — leaving processed contributions in Firestore '
      + '(harmless, just an unbounded collection; see README for how to enable pruning)');
  } else if (contributions.length) {
    try {
      const account = JSON.parse(serviceAccountJSON);
      const { deleted, failed } = await pruneContributions(project, account, contributions.map(c => c.id));
      console.error(`pruned ${deleted}/${contributions.length} processed contribution(s) from Firestore`
        + (failed.length ? ` — ${failed.length} failed and are left for the next run` : ''));
    } catch (e) {
      // Never the reason the merge itself fails — tags.json is already
      // written by this point, and a stuck prune is a tidiness problem, not
      // a data problem.
      console.error(`skipping prune: ${e.message}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
