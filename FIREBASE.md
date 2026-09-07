# Firebase — Cloud Storage for cross-device library sync

Status as of 2026-09-07, verified against the live project rather than assumed.
Read the "Blocker" section first: the bucket does not exist yet and cannot be
created from here.

---

## What Betterfy wants Cloud Storage for

`V2-PLAN.md` §2.3 — *"It only works where you're sitting."* Everything the
browser build knows lives in one origin's IndexedDB (`betterfy`/`kv`) and
`localStorage`: the library snapshot, artist tags, the skip/reject feedback map,
axis overrides. Clear site data and it is gone; open the page on a phone and it
starts from an empty library and a multi-minute sync.

Cloud Storage holds **one private blob per account** — a gzipped copy of that kv
store — so a filing backlog started at a desk can be finished on a sofa.

This is a bonus feature under `CLAUDE.md`'s rule, not infrastructure: with no
Firebase config baked into the build the page must make no requests, show no
sign-in, and behave exactly as it does today. Nothing in the filing, tagging or
misfile model may lean on it.

### Why Cloud Storage and not Firestore

The blob is ~11 MB raw and under 3 MB gzipped — past Firestore's 1 MB document
limit, so Firestore would mean chunking it across documents and paying a read
per chunk. One object per account is the cheaper and duller shape. The cost is
the blocker below: Firestore runs on the free Spark plan, Cloud Storage does not.

---

## Blocker: Cloud Storage requires the Blaze plan

`betterfy-1a983` is on **Spark (billing not enabled)**. Since September 2024,
provisioning a default Cloud Storage bucket requires the pay-as-you-go **Blaze**
plan — on Spark the console redirects to an upgrade page and the API returns
402/403. Verified two ways:

- `firebase_get_environment` reports `Billing Enabled: No`.
- `GET https://firebasestorage.googleapis.com/v0/b/betterfy-1a983.firebasestorage.app/o`
  → **404 Not Found**. The bucket named in the SDK config does not exist. (The
  `storageBucket` field is populated from the project's intended default name
  whether or not the bucket has been created — it is not evidence of a bucket.)

Blaze needs a card on file. It still includes the no-cost tier, and this
workload sits far inside it: 5 GB stored, 1 GB/day egress, 5,000 uploads and
50,000 downloads per month, against one ~3 MB blob written a few times a day.
Set a budget alert anyway.

**Emma has to do this step** — nobody else should be putting a payment method on
her account.

---

## Verified state of `betterfy-1a983`

| | |
|---|---|
| Project | `betterfy-1a983` (number `940770314231`), created 2026-09-07, ACTIVE |
| Web app | registered, display name `https://emmachilds98-wq.github.io/Betterfy/` |
| App ID | `1:940770314231:web:f3579103449980316b90f2` |
| Billing | **Spark — not enabled** |
| Cloud Storage | **bucket does not exist** (404) |
| Firebase Auth | **not enabled** — `identitytoolkit` returns `CONFIGURATION_NOT_FOUND` |
| Firestore | exists, rules are the default deny-all |
| Repo | no Firebase reference anywhere on `main` |

So the project has been *created* correctly — right name, right web app, app
named after the actual Pages URL — and then nothing after that step has been
done yet. Three of the four things this feature needs are missing.

### Firestore, separately

The shared tag table — a public `tagContributions` collection that lets one
listener's freshly-fetched Last.fm tags fill the gap for the next one — is a
different feature from Cloud Storage sync, and it has since shipped (#28):
`firestore.rules` in the repo root is deployed, `TAGS_PROJECT` and `TAGS_KEY`
are baked into `docs/index.html`, and `GET .../documents/tagContributions`
now returns `200 {}` rather than the `403 PERMISSION_DENIED` this section used
to describe. Contribution is live. See `README.md`'s "The shared tag table"
for how it works and `merge-tags.mjs` for the job that folds contributions
back into `docs/tags.json`.

---

## Console steps (in order)

1. **Upgrade to Blaze.** Firebase console → ⚙ → Usage and billing → Modify plan.
   Set a budget alert while you are there.
2. **Create the default Storage bucket.** Build → Storage → Get started. Take
   the default name `betterfy-1a983.firebasestorage.app`. Choose a
   **`us-central1`, `us-east1` or `us-west1`** location — the always-free egress
   quota only applies in those three, and the location cannot be changed later.
   Start in locked mode; the rules below replace whatever it creates.
3. **Enable Authentication** with the **Google** provider. Storage rules cannot
   scope anything to an account without it, and a bucket behind a public web API
   key with no auth is an open bucket.
4. **Add the authorized domain.** Authentication → Settings → Authorized
   domains → add `emmachilds98-wq.github.io`. Without it sign-in fails on the
   live site with `auth/unauthorized-domain` while working fine on localhost.
5. **Deploy the rules** (from the repo root, after step 2 — this needs the
   bucket to exist):

   ```
   npx firebase-tools deploy --only storage
   ```

Steps 2–5 are all reversible. Step 1 is the one with a card attached.

---

## Config, corrected

`.firebaserc`, `firebase.json` and `storage.rules` are now in the repo and point
at `betterfy-1a983`. The rules give each account its own prefix and nothing
else; the reasoning is in the comments in `storage.rules`, including why
`create, update` and `delete` are spelled out separately rather than folded into
`write`.

The web SDK config for the registered app, read from the project rather than
retyped:

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

All of it is public — a Firebase web key names a project, it does not authorise
anything; `storage.rules` does the real work. Same posture the shared-tag branch
already documents for `TAGS_KEY`.

Bake it at build time the way `build-web.mjs` already handles `SPOTIFY_CLIENT_ID`
— argv, then `.env`, then whatever the last build left in `docs/index.html`.
That last fallback exists because `.env` is gitignored, and without it a rebuild
in a fresh clone silently ships a page with the feature switched off. Add
`FIREBASE_CONFIG` (the JSON above, one line) to `.env.example` with a note that
it is public and optional.

---

## App wiring — the shape to build

Not yet written. The constraints that should drive it:

- **Optional, per `CLAUDE.md`.** No config baked in → no SDK loaded, no sign-in
  UI, no request. A fork with no Firebase behaves exactly as Betterfy does now.
- **Load the SDK in a separate `<script type="module">`** that resolves a ready
  promise on `window`. `app.template.html` is one concatenated classic script
  and the Firebase v12 SDK is ESM-only; module scripts are deferred, so the
  classic script has to await that promise rather than assume it.
- **`signInWithPopup`, not `signInWithRedirect`.** The site is on
  `github.io` while the auth handler is on `firebaseapp.com`, and redirect
  sign-in is the flow that browsers' third-party-cookie blocking breaks. Handle
  a blocked popup with a real message, not a silent failure.
- **Two identities is a real cost.** Signing into Google *as well as* Spotify is
  friction on a page whose whole sign-in story is currently one Spotify button.
  Anonymous auth avoids it but gives a different uid per device, which is
  exactly the thing cross-device sync needs to not happen — it would need an
  explicit device-linking step. A Cloud Function minting a custom token from the
  Spotify token would give one sign-in and `uid = Spotify user id`, at the cost
  of a function to maintain. Worth deciding deliberately rather than defaulting.
- **Set `contentType` explicitly on upload** (`application/gzip`). The rules
  match on it, and an upload with no content type is denied.
- **Gzip with `CompressionStream('gzip')`** — no library needed.
- **Guard the overwrite.** Store the device id and a timestamp in the object's
  custom metadata and check them before writing, so a stale phone cannot
  silently flatten a desktop's afternoon of filing. The existing action log is
  the thing that makes a bad merge recoverable; it should go up with the blob.
- **Failure is never fatal.** Same rule the tag contribution follows: the local
  IndexedDB copy is the source of truth, and a sync that fails is a toast, not a
  broken session.

Tests belong in `test/webcloud.test.mjs`, following the pattern in
`test/webstorage.test.mjs` — slice the function out of the built
`docs/index.html` and run it in a `vm` sandbox against a hostile stub, so the
"it must degrade silently" claims above are pinned rather than asserted.
