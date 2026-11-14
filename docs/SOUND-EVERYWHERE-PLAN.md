# Sound everywhere — making the app use what it hears (2026-11-14)

Plan B is merged and #88 put sound in front of filing: heard tracks are filed
by sound and the File card names genre › sub-genre › BPM. Every other screen
still ignores it. This plan spreads the same signal (records, `identify`,
`placements(…, { soundFirst })`, `tempoRelation`/`mixesWith`) across Tidy,
Playlists, Shuffle and Discover, and improves the one feature that is
measurably weak (key, 30% exact). It follows `docs/HANDOFF.md` §6.

Rules (HANDOFF §4) bind every piece: works from the Spotify library alone; no
Spotify content into an ML model and nothing pooled across accounts (lookups
and counts on your own library only); byte-identical when there is no sound
data; generated files are rebuilt, never hand-merged; `mel.mjs`/`record.mjs`
frozen.

## Pieces (one PR each, run in parallel)

| # | Piece | Owns (new files unless noted) | Template slice |
|---|---|---|---|
| S1 | **Tidy by sound** + plumbing: a sound tier on Tidy ("sounds like jungle, sits in House") with move/undo, measured on held-out tracks; share `SOUND.space` with `ENG.space`; refresh `AUDIO.records` mid-run | `core/audio/misfit.mjs`, `test/soundtidy.test.mjs`, `web/styles/69-tidysound.css` | `vTidy`, the `SOUND` engine section |
| S2 | **Playlist sound profiles**: each playlist's genre mix, BPM range and energy from its heard members; flag playlists that are two genres by sound and offer the split | `core/audio/plprofile.mjs`, `test/plprofile.test.mjs`, `web/styles/63-listsound.css` | `vLists` |
| S3 | **Mix order**: BPM- and sound-aware ordering for Shuffle ("DJ order"): each next track beatmatchable and close in sound, with an energy arc option | `core/audio/order.mjs`, `test/mixorder.test.mjs`, `web/styles/72-mixorder.css` | `vShuffle`, `shuffleStats` |
| S4 | **Discover by sound**: listen to candidates' previews (ISRC → Deezer, existing queue) and re-rank by fit to the seed playlist's sound; add a keyless candidate path (sound-alikes of your top artists' tracks) so Discover works without a Last.fm key | `core/audio/discover.mjs`, `test/sounddiscover.test.mjs`, `web/styles/73-discsound.css` | `vDiscover` |
| S5 | **Key accuracy**: improve `core/audio/dsp/key.mjs` (profiles, tuning offset, per-window voting), re-measure; if it clears the bar, use key (Camelot) in `mixesWith` and S3 | `core/audio/dsp/key.mjs` (existing), `test/audiokey.test.mjs` | none unless shown |

Pieces touch different functions of `docs/app.template.html`; on conflict,
keep both slices and rebuild.

## Waiting on the owner

- The **Score run** (HANDOFF §2): Listen to my music, then Engine → Learn my
  library → Score both engines → Copy results. It is the only way to tune
  `SOUND_FIRST_WEIGHTS`, identify's thresholds and the tempo ranges on real
  data, and to check each piece above on a real library.
- Key re-measurement on the Beatport set needs the dataset on a machine that
  can download it (`scripts/audio-dsp/beatport-eval.mjs`).

## Later

- WP-C2 part 2 (CLAP audio encoder in the page) and the MAEST model file
  (#90): both need model downloads the cloud sessions cannot reach.
