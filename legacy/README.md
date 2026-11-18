# legacy/ (developer-only)

Nothing here is part of the hosted app, and no account needs it. These are the
Node CLIs and the older desktop-browser app from before the hosted page. They
work on a local `library.json` snapshot and stay only because something still
runs or tests them. New features don't go here.

| File | Still used by |
|---|---|
| `server.mjs` | `npm start`, `Betterfy.bat` (the older local app, with `../ui/`) |
| `dupes.mjs` | `npm run dupes` |
| `misfile.mjs` | `npm run misfile` |
| `analyse-v3.mjs` | `npm run analyse:v3`, `build-review-v3.mjs`, `test/fit.test.mjs` |
| `build-review.mjs` + `review.html` | `npm run build:review` |
| `build-review-v3.mjs` + `review-v3.html` | `npm run build:review:v3` |

Build 7 package H3 (2026-11-18) checked each file against `package.json`,
`test/` and every import, and found none unreferenced, so none were removed.
If a script above is dropped from `package.json`, its file can go with it.
See the main [README](../README.md) section "From a checkout (developers)".
