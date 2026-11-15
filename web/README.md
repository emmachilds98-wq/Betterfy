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
- `bundles.mjs`: which modules go into the lazy `docs/engine.js` and
  `docs/audio.js` (below).

## The lazy bundles: `// @bundle` lines

Since `docs/BUILD-5-PLAN.md` A7 there is no list of engine modules in
`build-web.mjs`. A module joins a bundle by saying so in its first line:

```js
// @bundle engine order=110 global=BetterfyCalibrate
```

- `engine` or `audio`; a module may carry one line per bundle
  (`core/sources/deezer.mjs` is in both).
- `global=` is the name the page uses (`BetterfyCalibrate.…`). Optional.
- `order=` only fixes where the module's code sits in the built file (it was
  how the convention replaced the old lists without changing a byte). **Leave
  it off a new module**; unnumbered ones go after the numbered ones, by path.
- The line is stripped from the bundle, like an import.

`docs/audio.js` is also a folder sweep, as before: all of `core/audio/` and
`core/audio/dsp/`, plus `core/intrinsic/audio*.mjs` named automatically
(`audio-learn.mjs` → `BetterfyAudioLearnIntrinsic`). A `core/audio/` module that
says `// @bundle engine` (sound ID, sound-alikes, mixes, DJ order…) ships in
`engine.js` instead and the sweep skips it; that is what `ENGINE_SIDE` used to
say by hand. The page's inline core (`norm`, `credits`, `profile`,
`core/playlists/axes.mjs`, `ui/sound.mjs`) and the audio worker's ear modules
stay explicit lists in `build-web.mjs`: the first costs every load, the second
is edited together with the worker's ops.

`test/bundles.test.mjs` fails if the committed `docs/engine.js`/`docs/audio.js`
carry different modules or globals from what the lines declare (a line went
missing, or you added one and need to rebuild), or if the page uses a
`Betterfy*` name no line declares.

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
| `app/reports.js` | `buildReports()`, mirrors `legacy/dupes.mjs` / `legacy/misfile.mjs` |
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
  (A7 kept this list explicit: load order matters here, and a filename-prefix
  convention would rename every file.)
- New module for the Engine screen or listening: a `// @bundle` line in the
  module, not an edit to `build-web.mjs`.
