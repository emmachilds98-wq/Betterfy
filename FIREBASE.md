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

## Status: feedback sync is live; corrections and overrides are not yet

Shipped: skip/reject feedback (the `FB` map — how many times a track has been
skipped, and which playlists it's been rejected for) syncs across devices
that have been linked to each other, through Firestore, on the free Spark
plan. Not yet: tag corrections (`tags_extra`) and axis overrides (`bf_axes`)
still only live on the device that set them — same reasoning, same design,
just not built yet. Whoever picks that up next should follow the pattern
`syncFeedback()` already sets in `docs/app.template.html`, most of which
generalises directly (`syncSignIn`/`syncDoc`/`ensureSyncMembership`/link codes
are all already state-agnostic; only a per-state merge function and a pull/push
wrapper like `syncFeedback()` itself need writing per piece of state).

**Not** the ~11 MB library snapshot — that's re-derivable from Spotify on any
device, so losing it costs a re-sync, not data. What's worth syncing is the
small, non-re-derivable state above. That's kilobytes, fits Firestore's free
Spark plan comfortably, and gets a real merge instead of last-writer-wins on a
blob — which also sidesteps the "a stale phone flattens a desktop's afternoon
of filing" problem a whole-blob sync has to solve with custom metadata guards.
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

The alternative that needs neither a server nor a second real sign-in, and
what's actually built: **Firebase Anonymous Auth, plus an explicit
device-link step, entirely over Firestore's and Identity Toolkit's REST
APIs** — no Firebase SDK at all, the same "raw `fetch`, no dependency" choice
already made for the shared tag table and App Check. `app.template.html`
stays one concatenated classic script; nothing here needed the ESM-only SDK
an earlier draft of this doc assumed it would.

1. Each device signs in anonymously (`syncSignIn()`, a plain POST to
   `identitytoolkit.googleapis.com/v1/accounts:signUp`) — free, no UI, no
   password. This is what gives it write access under the rules below at
   all; it has nothing to do with *which* Spotify account is signed in, and
   two anonymous devices are unrelated until linked. The resulting ID token
   and refresh token are cached in `localStorage` (`bf_sync_auth`) and
   refreshed (`securetoken.googleapis.com/v1/token`) rather than re-minted
   on every load.
2. **This device does nothing with any of the above until it opts in** —
   Settings → "Sync across devices" is hidden entirely unless
   `TAGS_PROJECT`/`TAGS_KEY` are configured (same Firebase project the shared
   tag table uses), and even then `syncFeedback()` refuses to run — no
   identity created, no request made — until `localStorage.bf_sync_group` is
   set, which only happens by tapping **Link another device** or actually
   redeeming a code. Opening the page must never silently enrol a listener in
   anything; see `docs/app.template.html`'s `syncFeedback()` for the exact
   gate.
3. The *first* device to sync generates a random group id locally
   (`crypto.randomUUID()`, no server round trip) and adds itself to
   `syncGroups/{groupId}/members/{uid}`.
4. **Linking a second device** (Settings → Sync across devices → *Link
   another device*): the first device shows a six-digit code, valid for 10
   minutes, and writes `linkCodes/{code} = { groupId, createdAt }`. The
   second device's owner types the code into *Link this device*; it reads
   that one document (the code is the secret — knowing it is what grants
   access, the same trust model as a password-reset link), refuses it
   client-side if `createdAt` is past the 10-minute window, adopts the
   group id, adds its own uid to `members`, and deletes the code so it can't
   be redeemed twice.
5. From then on, either device can read and write
   `syncGroups/{groupId}/state/*` — enforced by Firestore rules checking
   membership via `exists()` on the `members` subcollection, not an array
   field (an array would need a read-modify-write on every join, which is
   exactly the kind of race the per-uid-document shape avoids). No server
   involved anywhere in this.

The actual rules, live in `firestore.rules` today:

```
match /syncGroups/{groupId} {

  match /members/{uid} {
    // Any signed-in device can check membership; only its own uid can be
    // added, and only ever added, never edited or removed.
    allow get: if request.auth != null;
    allow create: if request.auth != null && request.auth.uid == uid;
    allow update, delete: if false;
  }

  match /state/{doc} {
    allow read, write: if request.auth != null && exists(
      /databases/$(database)/documents/syncGroups/$(groupId)/members/$(request.auth.uid));
  }
}

match /linkCodes/{code} {
  allow create: if request.auth != null
                && request.resource.data.keys().hasOnly(['groupId', 'createdAt'])
                && request.resource.data.groupId is string
                && request.resource.data.createdAt is int;
  allow get: if request.auth != null;
  allow delete: if request.auth != null;
  allow update: if false;
}
```

A groupId is never displayed anywhere — it's the real secret (128 bits of
randomness), the same trust model as an unguessable "anyone with the link"
share. The six-digit code is only how a *second* device learns it, which is
why it's short-lived and single-use rather than the actual security boundary.

### Merging: feedback specifically, and why it's a union, not last-write-wins

`mergeFeedback()` in `docs/app.template.html` treats a rejection as a fact
once recorded on either device — a track rejected for a playlist on the
phone stays rejected for it everywhere, so rejections union rather than one
side overwriting the other. Skip counts take whichever is higher (a count
only ever increases) and `lastSkip` takes the later timestamp. No entry is
ever dropped, and merging is order-independent — two devices converge to the
same state regardless of which one happened to sync first. This works
because feedback's shape (a count, a timestamp, a set) has an obvious
"combine, don't replace" rule; tag corrections and axis overrides are plain
values with no natural union, so whoever builds those should expect a
simpler "prefer local, fill gaps from remote" merge instead (never silently
reverting a fresh local edit, but also not attempting to combine two
different values for the same key).

### What was needed, and is now done

**Firebase Auth needed the Anonymous provider enabled** — this was the one
blocker (`identitytoolkit` returned `CONFIGURATION_NOT_FOUND` on
`betterfy-1a983`) and is a console-only step nothing here could do remotely.
It's done. Nothing else about the project changed — this stays on Spark, no
Blaze, no card on file.

### Verifying it actually works

This was built and tested entirely against a scripted Identity
Toolkit/Firestore (`test/websync-firestore.test.mjs`) — there is no way to
exercise the real `identitytoolkit.googleapis.com` and
`firestore.googleapis.com` round trip, or the rules' actual enforcement,
without a live domain and a live project. Worth a real smoke test before
trusting it fully: open the hosted page on two devices (or two browser
profiles) signed into the same Spotify account, use *Link another
device*/*Link this device* to connect them, skip or reject a track on one,
and confirm it shows up on the other within a page reload. If a rules bug
slipped through, this is also where it would surface — the failure mode is
either "wrongly refused" (annoying, safe) or "unexpectedly allowed"
(a privacy bug, worth reporting immediately). A `firebase-tools` emulator
test would catch this in CI instead of by hand; not yet set up here.

---

## Verified state of `betterfy-1a983`

| | |
|---|---|
| Project | `betterfy-1a983` (number `940770314231`), created 2026-09-07, ACTIVE |
| Web app | registered, display name `https://emmachilds98-wq.github.io/Betterfy/` |
| App ID | `1:940770314231:web:f3579103449980316b90f2` |
| Billing | **Spark — not enabled** (and this plan doesn't need it to change) |
| Cloud Storage | **bucket does not exist** (404) — irrelevant to this plan |
| Firebase Auth | Reported enabled (Anonymous provider) as of this pass — not independently re-verified against the live project from here, since nothing in this environment can reach it. The "verifying it actually works" smoke test above is the real check. |
| Firestore | exists, rules deployed (including `syncGroups`/`linkCodes` as of this pass). `tagContributions` (shared tags, #28) is live and unaffected |
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
