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
| `screens/history.mjs` | History: screen module (see below) |
| `screens/lists.js` | playlist mixes and sound profiles, "two genres?", `vLists` |
| `screens/sources.mjs` | Sources: screen module (`tagCoverage()` lives in `lists.js`) |
| `app/tagshare.js` | giving tags back to the shared table |
| `app/sync.js` | cross-device sync (Firestore) |
| `app/sync-tags.js` | tag corrections and playlist types, synced |
| `app/keyless.js` | genres for artists with no key at all |
| `app/tagfix.js` | correcting one artist's tags |
| `app/store.js` | `store.get/set/touch/on`: background jobs write a slice, the mounted screen that watches it repaints (A3) |
| `app/render.js` | `VIEWS`, `render()`, `go()` |
| `app/gestures.js` | touch gestures |
| `app/more.js` | the More sheet |
| `app/errors.js` | `guard()`, `fire()`: nothing fails in silence |
| `app/engine.js` | engine glue: lazy `engine.js`, the worker, calibration, the neighbour bridge |
| `app/audio.js` | listening glue: lazy `audio.js`, settings, mood/voice/energy |
| `app/soundfirst.js` | sound-first filing, sound ID and matches |
| `app/blend.js` | File's picks from tags blended with the engine and similar artists, once the Score run says so; the engine's per-account fitted weights (`engine-weights`, `withFittedWeights`) |
| `app/clap.js` | CLAP cluster names and "sounds like" search |
| `app/audio-panel.js` | the Listening and Deep listen panels |
| `screens/engine.mjs` | Engine: screen module, its score/bridge/calibration cards and summary (its jobs are in `app/engine.js`) |
| `app/screens.js` | glue for screen modules: `SCREEN_CTX`, `screenCtx()`, `screenView()`, `dispatchAct()` |
| `app/events.js` | the document-wide click and change handlers |
| `screens/inbox-actions.js` | filing the current track (`fileCurrent`, `inboxAct`) |
| `app/boot.js` | settings wiring, the loading stage, `start()` and the boot IIFE |

## Screen modules (A4)

A screen moves from classic script to ES module one at a time (History,
Sources and Engine are done; copy them). The convention:

- **File**: `web/screens/<name>.mjs`, first line `// @bundle screens <name> <order>`.
  That header is the whole registration: `build-web.mjs` finds it
  (`discoverBundles('web/screens', 'screens')`), bundles it with the rest and
  exposes it as `BetterfyScreens.<name>`. It is not in `manifest.mjs`.
- **Exports**: `view(ctx)` (pure, returns the HTML string), `actions` (a map
  `data-act` name to `(ctx, el, ev) => ...`, async is fine) and optionally
  `mount(ctx)`, which `render()` calls after the screen is painted. Extra
  `export`s (helpers) are fine and are what tests import.
- **No outside scope**: a module imports nothing and names no page global.
  It destructures what it needs from `ctx`: `view({ S, esc })`.
- **ctx**: add `<name>: () => ({ ... })` to `SCREEN_CTX` in `app/screens.js`,
  listing exactly what the module uses (state objects, helpers, `toast`,
  `render`, `go`, the long jobs that stay in `app/*.js`). It is rebuilt on every
  call, so it never goes stale. Long-running jobs and anything other files call
  stay classic in `app/`; the module reaches them through ctx.
- **VIEWS**: in `app/render.js` use `screenView('<name>')`.
- **Markup**: buttons carry `data-act="<name>"` (plus ids and `data-*` values
  as before). `events.js` calls `dispatchAct()` first in its click and change
  handlers, which runs `actions[act]` of the screen being shown and falls
  through to the old branches when there is none. Checkboxes, radios and
  selects fire on `change`, everything else on `click`. Delete the screen's old
  branches from `events.js` when you move them.
- **Store**: unchanged. `STORE_WATCH` in `app/store.js` names screens, not
  files, so `store.touch('eng')` still repaints Engine.
- **Tests**: `import * as X from '../web/screens/<name>.mjs'` and call
  `X.view(fixtureCtx)` and `X.actions.foo(fixtureCtx, el)`. Where the test
  also needs the page code, take ctx from the page itself
  (`vm.runInContext("screenCtx('<name>')", sandbox)`). Delete the screen's old
  vm-slice tests in the same change. Slice end markers that named the old
  screen (`function vHistory()`) now end at the next classic function.

## Rules

- A change to these files needs `node build-web.mjs` before `npm test`: most
  web tests read the built `docs/index.html`.
- New file: add it to `APP_FILES` at the point its top-level code must run.
