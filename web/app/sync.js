/* ---------- cross-device sync (Firestore) ----------
 * Skip/reject feedback is the one thing that did not survive a fresh sign-in
 * on a different device — the library itself re-syncs from Spotify either
 * way, but a decision already made stayed device-local otherwise. Firebase
 * Anonymous Auth plus an explicit device-link code lets two devices share it
 * without a second real sign-in, a server, or Firebase Auth ever needing to
 * know which Spotify account is involved. Full design in FIREBASE.md.
 *
 * Reuses TAGS_PROJECT/TAGS_KEY: same Firebase project as the shared tag
 * table, same public API key. With neither configured, sync is unavailable —
 * same as sharing itself, and for the same reason: nothing here is a secret,
 * but there is nothing to point it at either. */
const syncAvailable = () => sharingTags();

let SYNC_AUTH = null; // { uid, idToken, refreshToken, exp }

/** Sign in anonymously (or refresh an existing session), memoised across
 *  calls within the page and persisted so a reload does not mint a new,
 *  unrelated identity every time. */
async function syncSignIn() {
  if (SYNC_AUTH && Date.now() < SYNC_AUTH.exp - 60000) return SYNC_AUTH;
  const saved = JSON.parse(LS.getItem('bf_sync_auth') || 'null');
  if (saved && Date.now() < saved.exp - 60000) return (SYNC_AUTH = saved);

  if (saved?.refreshToken) {
    try {
      const r = await fetchDeadline(`https://securetoken.googleapis.com/v1/token?key=${TAGS_KEY}`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: saved.refreshToken }),
      }, 8000);
      if (r.ok) {
        const b = await r.json();
        SYNC_AUTH = { uid: b.user_id, idToken: b.id_token, refreshToken: b.refresh_token,
          exp: Date.now() + (+b.expires_in) * 1000 };
        LS.setItem('bf_sync_auth', JSON.stringify(SYNC_AUTH));
        return SYNC_AUTH;
      }
    } catch { /* fall through to a fresh identity */ }
  }

  // A brand new anonymous identity — no password, no email, invisible to
  // whoever is using the page. This has nothing to do with *which* Spotify
  // account is signed in; it only lets Firestore's rules tell "a device this
  // app trusts" from "anyone on the internet".
  const r = await fetchDeadline(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${TAGS_KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  }, 8000);
  if (!r.ok) throw new Error(`Sync sign-in failed: ${r.status}`);
  const b = await r.json();
  SYNC_AUTH = { uid: b.localId, idToken: b.idToken, refreshToken: b.refreshToken,
    exp: Date.now() + (+b.expiresIn) * 1000 };
  LS.setItem('bf_sync_auth', JSON.stringify(SYNC_AUTH));
  return SYNC_AUTH;
}

/** One authenticated Firestore REST call. `path` is relative to the default
 *  database's documents root, e.g. `syncGroups/{id}/state/feedback`. */
async function syncDoc(method, path, body) {
  const auth = await syncSignIn();
  const url = `https://firestore.googleapis.com/v1/projects/${TAGS_PROJECT}/databases/(default)/documents/${path}`;
  const res = await fetchDeadline(url, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.idToken}` },
    body: body ? JSON.stringify(body) : undefined,
  }, 8000);
  if (!res.ok) throw new Error(`Sync request failed: ${res.status}`);
  return res.status === 204 ? null : res.json();
}

const SYNC_GROUP_KEY = 'bf_sync_group';

/** This device's sync group — generated once, locally, and never displayed.
 *  The group id itself is the real secret (see firestore.rules); a link code
 *  is only how a second device learns it. */
function syncGroupId() {
  let id = LS.getItem(SYNC_GROUP_KEY);
  if (!id) { id = crypto.randomUUID(); LS.setItem(SYNC_GROUP_KEY, id); }
  return id;
}

/** Makes this device a member of its own (or an adopted) sync group. A
 *  no-op after the first successful call: the rules allow *create* on a
 *  member doc but not update, so this checks first rather than presenting an
 *  identical write a second time and having it bounce. */
async function ensureSyncMembership() {
  const auth = await syncSignIn();
  const groupId = syncGroupId();
  try { await syncDoc('GET', `syncGroups/${groupId}/members/${auth.uid}`); }
  catch {
    // The GET can fail because the doc is missing (the common case, fixed by
    // creating it) or transiently for some other reason while it already
    // exists — in which case the create below 409s, which is a harmless
    // no-op here, not a real failure.
    await syncDoc('POST', `syncGroups/${groupId}/members?documentId=${auth.uid}`, { fields: {} })
      .catch(e => { if (!e.message.includes('409')) throw e; });
  }
  return groupId;
}

const LINK_CODE_TTL = 10 * 60 * 1000;
const randomLinkCode = () => String(Math.floor(100000 + Math.random() * 900000));

/** Show this on the device that already has a sync group; the other device
 *  redeems it with redeemLinkCode() below. */
async function createLinkCode() {
  await ensureSyncMembership();
  const code = randomLinkCode();
  await syncDoc('POST', `linkCodes?documentId=${code}`, { fields: {
    groupId: { stringValue: syncGroupId() },
    createdAt: { integerValue: String(Date.now()) },
  } });
  return { code, expiresAt: Date.now() + LINK_CODE_TTL };
}

/** Redeem a code shown on another device: adopt its sync group, join it, and
 *  delete the code so it cannot be redeemed twice. */
async function redeemLinkCode(code) {
  const doc = await syncDoc('GET', `linkCodes/${code}`).catch(() => null);
  const groupId = doc?.fields?.groupId?.stringValue;
  if (!groupId) throw new Error('That code was not found — check it and try again.');
  const createdAt = +(doc.fields.createdAt?.integerValue ?? 0);
  if (Date.now() - createdAt > LINK_CODE_TTL)
    throw new Error('That code has expired — get a new one from the other device.');
  LS.setItem(SYNC_GROUP_KEY, groupId);
  await ensureSyncMembership();
  await syncDoc('DELETE', `linkCodes/${code}`).catch(() => {});
  return groupId;
}

/**
 * Combine this device's feedback with another device's. Rejections are a
 * fact once recorded on either device — a track rejected for a playlist on
 * the phone should stay rejected for it on the laptop too, so those union
 * rather than picking a side. Skip counts take whichever is higher (it only
 * ever increases) and the later of the two lastSkip timestamps. No entry is
 * ever dropped, so merging twice in either order lands on the same result.
 */
function mergeFeedback(local, remote) {
  const merged = { ...local };
  for (const [id, r] of Object.entries(remote ?? {})) {
    const l = merged[id];
    // Accepts and keeps union the same way; each only appears once either side has one.
    const union = k => [...new Set([...(l[k] ?? []), ...(r[k] ?? [])])];
    merged[id] = !l ? r : {
      skips: Math.max(l.skips ?? 0, r.skips ?? 0),
      lastSkip: [l.lastSkip, r.lastSkip].filter(Boolean).sort().at(-1) ?? null,
      rejected: union('rejected'),
      ...(l.accepted || r.accepted ? { accepted: union('accepted') } : {}),
      ...(l.kept || r.kept ? { kept: union('kept') } : {}),
    };
  }
  return merged;
}

/**
 * Pull the group's feedback, merge it into FB, save the merge locally, and
 * push it back up if the merge changed anything the remote side did not
 * already have — so both devices converge after one sync rather than only
 * after each has independently synced at least once. Fire-and-forget, same
 * as contributeTags: this must never delay or break the screen it was called
 * from, and a failure here is invisible rather than a broken session.
 */
async function syncFeedback() {
  // syncAvailable() only says the *build* has a Firebase project to point
  // at — the same one shared-tags already uses. That must not be read as
  // this *listener* having opted in: nobody should get an anonymous Firebase
  // identity and a Firestore write just from opening the page. Only a device
  // that has actually been linked (SYNC_GROUP_KEY set, via "Link another
  // device" or redeeming a code) has opted in, and only then does this do
  // anything at all.
  if (!syncAvailable() || !LS.getItem(SYNC_GROUP_KEY)) return false;
  try {
    const groupId = await ensureSyncMembership();
    const doc = await syncDoc('GET', `syncGroups/${groupId}/state/feedback`).catch(() => null);
    const remote = doc?.fields?.data?.stringValue ? JSON.parse(doc.fields.data.stringValue) : {};
    const before = JSON.stringify(FB);
    const merged = mergeFeedback(FB, remote);
    const mergedStr = JSON.stringify(merged);
    if (mergedStr === before && mergedStr === JSON.stringify(remote)) return false;
    FB = merged;
    await saveFeedback();
    // Only push back up what the remote side does not already have — a
    // no-op write here still costs a call for nothing.
    if (mergedStr !== JSON.stringify(remote)) {
      await syncDoc('PATCH', `syncGroups/${groupId}/state/feedback`,
        { fields: { data: { stringValue: mergedStr } } });
    }
    return mergedStr !== before;
  } catch { return false; /* next sync tries again; nothing here is load-bearing */ }
}

