# Firebase — cross-device sync

Status as of 2026-09-07, verified against the live project rather than assumed
where noted below.

---

## What this is for

`V2-PLAN.md` §2.3 — *"It only works where you're sitting."* Everything the
browser build knows lives in one origin's IndexedDB (`betterfy`/`kv`) and
`localStorage`: the library snapshot, artist tags, the skip/reject feedback
map, tag corrections, axis overrides. Clear site data and it is gone; sign in
on a phone and it starts from an empty library and a multi-minute sync — with
no memory of anything decided on the desktop.

This is a bonus feature under `CLAUDE.md`'s rule, not infrastructure: with no
Firebase config baked into the build the page must make no requests, show no
sign-in, and behave exactly as it does today. Nothing in the filing, tagging
or misfile model may lean on it.

## The recommended design: sync the small state through Firestore

**Not** the ~11 MB library snapshot — that's re-derivable from Spotify on any
device, so losing it costs a re-sync, not data. What's worth syncing is the
small, non-re-derivable state: skip/reject feedback, tag corrections, axis
overrides, the action log. That's kilobytes, fits Firestore's free Spark plan
comfortably, and gets per-field merge instead of last-writer-wins on a blob —
which also sidesteps the "a stale phone flattens a desktop's afternoon of
filing" problem a whole-blob sync has to solve with custom metadata guards.
The first read on a new device stays slow either way, because that's
Spotify's rate limit, not storage.

(An earlier version of this file proposed Cloud Storage for a full library
blob instead. See "Considered and rejected" below for why — kept for the
record, not as a live option.)

### The identity problem, and why it doesn't need a server

Firebase Auth and Spotify's OAuth are two unrelated systems. There's no way
for a Firestore security rule to check "this write is really from whoever
owns Spotify account X" without something server-side vouching for that link
— normally a Cloud Function that mints a Firebase custom token from a
verified Spotify token, giving one sign-in and `uid = Spotify user id`. That's
the *right* design, but it needs Blaze (Functions isn't on Spark) and a
function to maintain, in a project whose whole identity is "no server." Not
worth it for kilobytes of feedback data.

The alternative that needs neither a server nor a second real sign-in:
**Firebase Anonymous Auth, plus an explicit device-link step.**

1. Each device signs in to Firebase anonymously (free, no UI, no password) —
   this is what gives it write access under the rules below at all. It has
   nothing to do with *which* Spotify account is signed in; two anonymous
   devices are unrelated until linked.
2. The *first* device to ever sync generates a random sync-group id (a UUID,
   generated locally, no server round trip) and creates
   `syncGroups/{groupId}` with itself as the sole member. All the small state
   lives under `syncGroups/{groupId}/state/*` from then on.
3. **Linking a second device**: the first device shows a short code (six
   digits, expires in ~10 minutes) and writes it to `linkCodes/{code} = {
   groupId, createdAt }`. The second device's owner types that code in; the
   second device reads that one document (the code is the secret — anyone
   who doesn't have it can't guess it in the window it's valid), learns the
   group id, adds its own anonymous uid to that group's `members`, and
   deletes the code so it can't be reused.
4. From then on, every device with its own uid in `syncGroups/{groupId}.members`
   can read and write `syncGroups/{groupId}/state/*` — enforced entirely by
   Firestore rules checking `request.auth.uid in
   get(/databases/$(database)/documents/syncGroups/$(groupId)).data.members`,
   no server involved.

Draft rules for this shape (write these into `firestore.rules` as a new
`match` block alongside the existing `tagContributions` one — they're
independent collections and can coexist):

```
match /syncGroups/{groupId} {
  allow get: if request.auth != null && request.auth.uid in resource.data.members;
  allow create: if request.auth != null
                && request.resource.data.members == [request.auth.uid];
  // Joining (via a redeemed link code) may only ever add the caller's own
  // uid, never remove or replace anyone else's.
  allow update: if request.auth != null
                && request.auth.uid in resource.data.members.concat([request.auth.uid])
                && request.resource.data.members ==
                   resource.data.members.concat([request.auth.uid]);

  match /state/{doc} {
    allow read, write: if request.auth != null && request.auth.uid in
      get(/databases/$(database)/documents/syncGroups/$(groupId)).data.members;
  }
}

match /linkCodes/{code} {
  // The code itself is short-lived and single-use; anyone holding it can
  // redeem it, same trust model as a "forgot password" email link.
  allow create: if request.auth != null && request.resource.data.groupId is string;
  allow get, delete: if request.auth != null;
}
```

### What's needed before this can be built

**Firebase Auth must be enabled with the Anonymous provider** — currently
`identitytoolkit` on `betterfy-1a983` returns `CONFIGURATION_NOT_FOUND` (see
the verified state below), meaning no Auth provider is on at all yet. This is
a console step, not something a build or a script can do:

1. Firebase console → Build → Authentication → Get started.
2. Sign-in method → Anonymous → Enable.
3. Authentication → Settings → Authorized domains → confirm
   `emmachilds98-wq.github.io` is listed (it should be added automatically,
   but double-check — a missing entry fails sign-in on the live site with
   `auth/unauthorized-domain` while working fine on localhost).

Nothing else about the project needs to change — this stays on Spark, no
Blaze, no card on file.

### Client wiring — the shape to build once Auth is on

- **Load the Auth SDK in a separate `<script type="module">`** that resolves
  a ready promise on `window`, the same reason `TAGS_PROJECT`/App Check avoid
  it: `app.template.html` is one concatenated classic script, and the
  Firebase v12 SDK is ESM-only.
- **Sign in anonymously on first load, silently** — no button, no visible
  step. `onAuthStateChanged` gives the uid once it resolves.
- **The device-link UI** lives in the More sheet, near Disconnect: "Link
  another device" shows a code and starts polling `linkCodes/{code}` for
  deletion (meaning it was redeemed); "I have a code" is the input on the
  joining device.
- **Sync is additive/merge, never a snapshot overwrite.** Feedback and
  overrides are keyed by track/artist id already — writing `state/feedback`
  as a map keyed the same way means two devices editing different tracks
  never conflict, and the same track edited on both takes whichever write
  landed last (acceptable for this data; unlike a library blob, there's no
  large piece to lose).
- **Optional, per `CLAUDE.md`, same as everything else here.** No
  `APPCHECK`-style build-time flag exists for this yet because it needs a
  second SDK either way — the natural gate is simply whether the Auth SDK
  resolved a uid. No uid, no sync, page behaves exactly as it does today.
- **Failure is never fatal.** Same rule tag contribution follows: local
  IndexedDB/localStorage stays the source of truth, and a sync that fails is
  a toast, not a broken session.

Tests belong in `test/websync-firestore.test.mjs`, following the pattern in
`test/webtagshare.test.mjs` and `test/websignin-denied.test.mjs` — slice the
function out of the built `docs/index.html` and run it in a `vm` sandbox
against a scripted Firestore/Auth stub, so "degrades silently with no uid" and
"the rules enforce membership" are pinned rather than asserted. The rules
themselves are worth a `firebase-tools` emulator test if that becomes
practical in CI; short of that, the membership logic above should at least be
read by a second pair of eyes before it goes live, since a rules bug here is a
privacy bug (someone else's feedback data), not just a broken feature.

---

## Verified state of `betterfy-1a983`

| | |
|---|---|
| Project | `betterfy-1a983` (number `940770314231`), created 2026-09-07, ACTIVE |
| Web app | registered, display name `https://emmachilds98-wq.github.io/Betterfy/` |
| App ID | `1:940770314231:web:f3579103449980316b90f2` |
| Billing | **Spark — not enabled** (and this plan doesn't need it to change) |
| Cloud Storage | **bucket does not exist** (404) — irrelevant to this plan |
| Firebase Auth | **not enabled** — `identitytoolkit` returns `CONFIGURATION_NOT_FOUND`. **This is the one blocker** — see "What's needed before this can be built" above. |
| Firestore | exists, rules deployed. `tagContributions` (shared tags, #28) is live; `syncGroups`/`linkCodes` for this feature don't exist yet |
| Repo | `firestore.rules`, `.firebaserc`, `firebase.json` are in the repo root and point at this project |

### Firestore, separately: the shared tag table

A different feature from this one, already shipped (#28, #31) — a public
`tagContributions` collection that lets one listener's freshly-fetched Last.fm
tags fill the gap for the next one. See `README.md`'s "The shared tag table"
for how it works, `merge-tags.mjs` for the job that folds contributions back
into `docs/tags.json`, and `.github/workflows/tags.yml` for the review gate
and optional pruning around it. Nothing about it changes with the sync
feature above — different collections, different trust models (that one is
intentionally public and unauthenticated; this one is intentionally private
and auth-gated).

---

## Considered and rejected: Cloud Storage for a full library blob

An earlier pass proposed one private ~11 MB gzipped blob per account in Cloud
Storage, mirroring the whole IndexedDB `kv` store rather than just the small
state. Rejected because:

- **It needs Blaze.** Since September 2024, provisioning a default Cloud
  Storage bucket requires the pay-as-you-go plan — on Spark the console
  redirects to an upgrade page and the API returns 402/403. Confirmed live:
  `GET https://firebasestorage.googleapis.com/v0/b/betterfy-1a983.firebasestorage.app/o`
  → `404 Not Found` (the bucket named in the SDK config doesn't exist yet;
  the `storageBucket` field is populated from the project's intended default
  name regardless of whether the bucket has been created, so it's not
  evidence of one). Blaze needs a card on file, and while the free tier
  covers this workload comfortably (5 GB stored, 1 GB/day egress, 5,000
  uploads/50,000 downloads a month against one ~3 MB blob written a few times
  a day), that's still a step **only Emma should take** — nobody else should
  be putting a payment method on her account.
- **It solves the wrong problem.** The library itself is fully re-derivable
  from Spotify on any device; syncing it is convenience, not data recovery.
  What actually can't be recovered — feedback, corrections, overrides — is
  exactly the small state the Firestore design above targets directly,
  without needing Blaze at all.
- **A blob needs a stale-write guard the small state doesn't.** Overwriting
  a whole snapshot risks a stale phone flattening a desktop's afternoon of
  filing; that needs device-id-and-timestamp metadata checks before every
  write. Per-field merge on small, id-keyed state sidesteps the problem
  rather than solving it.

If a genuinely large, non-derivable blob shows up later (there isn't one
today), this is the place to revisit Cloud Storage — the SDK config below is
still accurate if that day comes:

```js
{
  apiKey:            "AIzaSyBEom-MoIBCnC9g48dIeQ0MIRPeVptrBLQ",
  authDomain:        "betterfy-1a983.firebaseapp.com",
  projectId:         "betterfy-1a983",
  storageBucket:     "betterfy-1a983.firebasestorage.app",
  messagingSenderId: "940770314231",
  appId:             "1:940770314231:web:f3579103449980316b90f2",
  measurementId:     "G-XJY8YFWRZM"
}
```

All of it is public — a Firebase web key names a project, it does not
authorise anything; the rules do the real work, same posture already
documented for `TAGS_KEY`. `storage.rules` in the repo root still gives each
account its own prefix, for whenever (if ever) this gets revisited.
