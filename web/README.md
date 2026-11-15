# web/: the page's source

`node build-web.mjs` turns this folder and `docs/app.template.html` into
`docs/index.html` (plus the lazy `engine.js` and `audio.js` bundles).

- `docs/app.template.html`: the markup only. Its one `<script>` holds the
  bundled scoring core (`__CORE__`) and then `__APP__`, where the build puts the
  files below back in.
- `manifest.mjs`: `APP_FILES`, the load order of `app/` and `screens/`. The
  build concatenates them verbatim in that order; `assembledTemplate()` gives
  the template with the script back in, which tests that slice the source use.
- `styles/`: the stylesheet, as partials inlined in file-name order
  (`docs/UI-BUILD-PLAN.md` §3). CSS goes here, never into the template.
- `ui/sound.mjs`: the sound layer's renderers, bundled as globals.
- `audio/`: "Listen to my music", bundled into the lazy `docs/audio.js`.

## app/ and screens/

These are **classic scripts sharing one top-level scope**, cut verbatim from
what was a single inline script (`docs/BUILD-5-PLAN.md` A1). A file may use
anything declared in a file above it in `APP_FILES`, and functions are hoisted
across all of them, so moving code between files is safe only if it keeps
top-level statements running in the same order. They become ES modules screen
by screen in A4.

| File | Owns |
|---|---|
| `app/storage.js` | `$`, `esc`, `LS` and the small formatters |
| `app/theme.js` | colour, density, remembered filters, the Theme sheet |
| `app/version.js` | spotting and installing a newer build |
| `app/auth.js` | PKCE sign-in, tokens, and `sp()` (every Spotify call) |
| `app/cache.js` | the IndexedDB library cache (`idb`) |
| `app/feedback.js` | skips and rejects (`FB`) |
| `app/classify.js` | `classify()`: the page's wrapper over `core/playlists/axes.mjs`, which `axes.mjs` runs too |
| `app/reports.js` | `buildReports()`, mirrors `dupes.mjs` / `misfile.mjs` |
| `app/ui.js` | page state (`LIB`, `S`, `view`), screen order and names, `toast()` |
| `app/actionlog.js` | the History log, undo, playlist and library writes |
| `app/player.js` | Spotify Connect playback bar |
| `screens/home.js` | `vHome` and its action icons |
| `app/listening.js` | the listening indicator (`setListen`), cover thumbnails |
| `app/soundslots.js` | sound chips/strips on the File and Discover cards, sound-first picks |
| `screens/inbox.js` | `vInbox` (File) and artist roll-forward |
| `screens/tidy.js` | `vTidy`, Tidy by sound |
| `screens/new.js` | gaps, `vNew` |
| `screens/shuffle.js` | spacing shuffle, DJ order, `vShuffle` |
| `screens/discover.js` | discovery, keyless and by-sound Discover, `vDiscover` |
| `screens/history.js` | `vHistory` |
| `screens/lists.js` | playlist mixes and sound profiles, "two genres?", `vLists` |
| `screens/sources.js` | `vSources`, `tagCoverage()` |
| `app/tagshare.js` | giving tags back to the shared table |
| `app/sync.js` | cross-device sync (Firestore) |
| `app/sync-tags.js` | tag corrections and playlist types, synced |
| `app/keyless.js` | genres for artists with no key at all |
| `app/tagfix.js` | correcting one artist's tags |
| `app/render.js` | `VIEWS`, `render()`, `go()` |
| `app/gestures.js` | touch gestures |
| `app/more.js` | the More sheet |
| `app/errors.js` | `guard()`, `fire()`: nothing fails in silence |
| `app/engine.js` | engine glue: lazy `engine.js`, the worker, calibration, the neighbour bridge |
| `app/audio.js` | listening glue: lazy `audio.js`, settings, mood/voice/energy |
| `app/soundfirst.js` | sound-first filing, sound ID and matches |
| `app/clap.js` | CLAP cluster names and "sounds like" search |
| `app/audio-panel.js` | the Listening and Deep listen panels |
| `screens/engine.js` | `vEngine` and its score/bridge/calibration cards |
| `app/events.js` | the document-wide click and change handlers |
| `screens/inbox-actions.js` | filing the current track (`fileCurrent`, `inboxAct`) |
| `app/boot.js` | settings wiring, the loading stage, `start()` and the boot IIFE |

## Rules

- A change to these files needs `node build-web.mjs` before `npm test`: most
  web tests read the built `docs/index.html`.
- New file: add it to `APP_FILES` at the point its top-level code must run.
