# Build 5 — progress log

Live status of `docs/BUILD-5-PLAN.md` §8's waves. Update this file with every
merge so a fresh session can pick up where the last one stopped.

## Done (on `main`)
- Wave 0: #97 (S1–S4, Spotify fixes, filing fixes, UI-A)
- Wave 1: A1 split (#102)
- Wave 2: A2 classifier (#107), A5 patcher + A8 goldens (#103), §5.1 feedback (#110), key step 1 (#106)

## In flight
- PR #112 merged: A6 router, A7 build conventions, A3 store ✅
- UI-B motion tokens + View Transitions ✅ (PR open)
- Default Last.fm key (`LASTFM_PUBLIC_KEY`, baked at build) + one-tap "Analyse my library" (agent running)

- A4 pilot ✅: history, sources, engine are ES modules (convention in web/README.md "Screen modules (A4)")

- PR #114 open: default Last.fm key + one-tap Analyse, A4 pilot (history/sources/engine), merged with main #105/#111/#116/#117
- #114 merged (Last.fm key, Analyse, A4 pilot). #118 merged (A4 home/inbox, shuffle/discover)
- #119 merged (§7 measurements). A4 complete: every screen is a module (PR open)
- #120 merged (A4 complete). #121 merged (UI-D 4-tab shell + Settings)
- UI-G merged on branch (entrances, FLIP helper, skeletons). Follow-ups: wire patch() into render so FLIP runs; use skeleton() in screens; add .lgtitle markup
- #122 merged (UI-C optimistic filing, UI-G motion). #123 merged (UI-E Library tab; patch() in render, FLIP rows, skeletons)
- #124 merged (UI-F copy pass). #125 merged (§5.2–§5.6 smarter functions). Build 5 plan complete up to owner-gated work
- Left: wave 5 — tune from the owner's Score run (HANDOFF §2); §6 key step 2 (S-KEY ONNX) and Beat This tempo need model export + measurement; owner to set LASTFM_PUBLIC_KEY

## Next
- Wave 3: remaining A4 screens, in groups:
  (home, inbox, inbox-actions) · (tidy, lists, new) · (shuffle, discover); UI-D 4-tab shell + Settings sheet
- Wave 4: UI-C, UI-E, UI-F, UI-G; §5.2–§5.6
- Deferred (need model export + measurement): Beat This tempo, S-KEY key step 2

## Notes for agents
- Worktrees can start from a stale base: first `git checkout -B <branch> <current tip>`.
- After merging branches, run `npm run build:web` once and commit the rebuilt `docs/` (build stamp must match across page and worker).
- `test/pageload.test.mjs` loads the built page in Chromium: run it after any web/app load-order change.

## Key + tempo model measurement (2026-11-16) — neither shipped
Beatport EDM Key set, half B (held out), middle 30 s as a Deezer preview. Reproduce: `scripts/audio-dsp/beatport-eval.mjs ... --half B --beats <onnx>`; S-KEY via `skey-predict.py` + `score-skey.mjs`.
- **S-KEY** (Deezer, code MIT, weights research/non-commercial; weights are `skey/models/skey.pt` in the deezer/s-key repo, 765 KB): n=635, exact **50.7%**, MIREX **61.1%** vs current DSP 55.3% / 64.6%. Below the bar (60/70) and below v3. Not exported to ONNX (its nnAudio VQT front end would also need a JS port). Rejected; key stays hidden.
- **Beat This small0** (MIT; ONNX from HF `jenila-ai/beat-this-small0-onnx`, 10 MB, dynamic time; the JKU cloud checkpoint host was rate-limited from here): tempo n=387, DSP 80.9% ±1 BPM / 50 octave errors; Beat This every record 81.1% / 49 (moved 55: fixed 28, broke 27); flagged-only 82.7% / 43 (fixed 21, broke 14). Gain is inside the ±3.9 CI; not shipped. The #115 JS front end (beat-mel/beats.mjs) is kept as measurement tooling.

## Key + tempo, second try (2026-11-16) — gated tempo octave fold shipped, key still below the bar
Beatport EDM Key set (Zenodo 1101082, md5 checked), split by `beatport-eval.mjs` `halfOf`: every rule and weight fitted or picked on half A only (model selection by 2-fold CV inside A), reported once on half B. CIs are 95% (normal for a rate, paired bootstrap for a difference vs the shipped DSP on the same tracks). Reproduce: `scripts/audio-dsp/keytempo-features.mjs <dataset> <cache> <features.jsonl> [--shard i/n]`, then `scripts/audio-dsp/keytempo-lab.mjs <features.jsonl> key|tempo`; end to end with `beatport-eval.mjs --half B`.

**Tempo, first cut (ungated; superseded by the gated fold below).** Of the 50 half-B octave errors most are a 124–145 track heard at half time (house/techno/trance 64, dubstep 70); DnB/hip-hop double-time errors are fewer and Beatport's own DnB labels are split between 87 and 174. Rule: a combined tempo under `SLOW_FOLD` = 74 BPM is read at double time (`core/audio/dsp/combine.mjs` combineTempo; `COMBINE_VERSION` 1.1.0, so records re-measure lazily). 74 is the best of a 66–106 sweep on half A (88.8%). Half B, end to end through `measureWindows`: **88.9% ±3.1 within ±1 BPM** vs 80.9% ±3.9, octave errors 50 → 19; paired gain **+8.0 [5.4, 10.9]**, fixed 32, broke 1. On Beatport alone it cleared "beats the current DSP by more than its CI", but see the GTZAN check. Half A end to end: 88.8% (81.9% before). By confidence on B: high 95.5% of 155, mid 91.5% of 153, low 70.9% of 79. It moves only slow readings: a 174 stays 174, so it does not impose Beatport's half-time DnB labels.
- Also measured, not shipped: a fitted octave chooser over {T, 2T, T/2} (softmax on log-tempo prior, ± band-ACF at P, 2P, P/2, ± Beatport genre × prior): 90.2–91.7% on B (+9 to +11), but its extra gain over the one-sided fold comes from halving 160–180 readings, i.e. learning Beatport's 87-for-DnB convention, and the ACF/genre terms add < 0.5 point. Genre-aware ranges would need the account's playlist genres passed into the worker (web/ wiring, not done here). Oracle octave choice: 93.8%.

**Tempo — non-EDM check (GTZAN) and the gate, shipped.** Beatport is all EDM, so the fold was re-measured on GTZAN (1,000 30 s clips, 10 genres; 998 with beat annotations from the Beat This! release, Zenodo 13922116; reference = 60 / median inter-beat interval; windows 0–10 s and 10–20 s). Reproduce: `scripts/audio-dsp/gtzan-tempo-eval.mjs <genres> <beats> --out gz.jsonl`, `... --beatport <cache> <features.jsonl> --out bp.jsonl`, then `--report gz.jsonl` (no fold / ungated / gated, ±1 BPM with octave errors ×2 / ÷2, fixed/broke vs no fold).

| GTZAN genre (n≈100) | no fold | ungated fold | gated fold (shipped) |
|---|---|---|---|
| blues | 59.0% ±9.6 (8/8) | 55.0% (13/7), broke 4 | 59.0% (8/8) |
| classical | 25.0% ±8.5 (5/4) | 23.0% (8/2), broke 2 | 25.0% (5/4) |
| country | 56.0% ±9.7 (14/17) | 49.0% (23/17), broke 7 | 56.0% (14/17) |
| disco | 89.0% ±6.1 (2/2) | 89.0% | 89.0% |
| hiphop | 80.0% ±7.8 (16/0) | 80.0% | 80.0% |
| jazz | 47.5% ±9.8 (4/18) | 40.4% (12/17), fixed 1 broke 8 | 47.5% (4/18) |
| metal | 52.0% ±9.8 (8/18) | 49.0% (11/18), broke 3 | 52.0% (8/18) |
| pop | 70.0% ±9.0 (20/1) | 65.0% (25/1), broke 5 | 70.0% (20/1) |
| reggae | 74.7% ±8.6 (5/10) | 74.7% | 74.7% |
| rock | 62.0% ±9.5 (14/4) | 65.0% (14/1), fixed 3 | 63.0% (14/3), fixed 1 |
| **all 998** | **61.5% ±3.0 (96/82)** | 59.0% ±3.1 (129/75), fixed 4 broke 29 | **61.6% ±3.0 (96/81), fixed 1 broke 0** |

(x/y = octave errors reading double / half the annotated tempo.) The ungated fold hurt overall (4 fixed vs 29 broken; every per-genre drop is inside that genre's ±9–10 CI, but the total isn't neutral), so it is now gated: it applies only when the windows that heard the slow tempo show a steady dance pulse, `tempo.mjs` `pulse` ≥ `PULSE_FOLD` = 0.38 (mean of the kick/body/snare/hat onset autocorrelations at the beat period and snare/hat at half of it; ~0.5 for house at half time, ~0.25 for ballads and swung jazz). Computed from the same window audio in the worker, no web wiring. `TEMPO_VERSION` 1.1.0 (adds `pulse`), `COMBINE_VERSION` 1.1.0. The threshold (and the choice of this feature over bpmConf, the octave flag, the 2T partner score or any single band) was picked on Beatport half A + GTZAN even-numbered clips, with the constraint that the GTZAN tuning half loses nothing.
- Held out: **Beatport half B (beatport-eval.mjs, n=387): 84.0% ±3.7** vs 80.9% ±3.9, octave errors 50 → 38; on the cached windows (n=394) 79.4% → 82.5%, **fixed 12, broke 0** (the ungated fold: fixed 32, broke 1). **GTZAN odd-numbered clips (n=500): 60.8% → 61.0%, fixed 1, broke 0** (ungated: 58.2%, fixed 4, broke 17). Beatport half A: 81.1% → 84.5% (fixed 13, broke 0).
- Against the original ship rule: the gated gain on Beatport B (+3.1) is **inside** the ±3.9 CI of the rate, though the paired result (12 fixed, 0 broken; sign test p ≈ 0.0005) is not chance. It is shipped because it is a strict improvement on both sets with no genre harmed (coordinator's rule (b)); revert by setting `SLOW_FOLD` to 0. Recovering the rest of the ungated gain needs a better dance-vs-slow-music signal (e.g. the account's playlist genres in the worker).

**Key — not shipped; still below 60/70.** Shipped v3 on B: 55.3% ±3.9 exact, MIREX 64.6% ±3.2 (A: 59.5 / 68.0 — B is the harder half, so +5 on A ≠ +5 on B). Tonic is right on 67.7% of B, mode right on 81.6% of those. Tried, each fitted on A, B exact / MIREX with paired Δ vs shipped:
- Refit of v3's 25-weight softmax on A only: 54.6 / 64.0 (Δ −0.6). The shipped `LEARNED` weights were fitted on a set that mostly overlaps half A (A 59.5 vs B 55.3).
- Separate major/minor decision (tonic from the 24-way model, mode from a logistic classifier at that tonic on chroma, ± 4 band chromas 30–2500 Hz, ± bass-note histogram): mode accuracy given the right tonic 78.8–80.9% vs v3's 81.6%; exact 53.4–54.8. **No gain**: the mode information isn't in these features beyond what v3 already uses (EDM minor/major without a sounding third).
- More features in the rotation-shared softmax: band chromas (30/120/350/1000/2500/5000 Hz), bass-note histogram, log chroma, 30–5000 Hz chroma, pairwise chroma products: 51.3–54.6 exact, every Δ ≤ 0 (several significantly negative). A-CV never beat the plain chroma by more than 1 point either.
- Chroma front-end variants (refit each): peak weight linear 49.3 / sqrt 53.4 / count 53.4 / log-SNR 52.8; per-frame normalised 54.2; harmonic (time-median, ±2 / ±4 frames) 54.6 / 53.7; F_MAX 1000 53.1 / 2500 55.3; F_MIN 60 54.6; TONAL_SNR 3 49.9 / 1.5 53.4. Stacking variants: best 55.9 / 65.3 (Δ +0.6 [−1.1, 2.4]).
- Confidence gating (shipped v3, B): keyConf ≥ 0.5 covers 67.7% at 60.2% ±4.6 exact; ≥ 0.7 covers 51.2% at 63.4% ±5.2; ≥ 0.8 covers 41.7% at 64.5% ±5.8. Never reaches the 70% wanted for a Camelot tiebreak.
Conclusion: hand-built chroma + a linear key model is saturated around 55% on this half; the 60/70 bar needs a different signal (a learned front end that is licensable, or more audio than two 10 s windows). Key stays hidden; `mixesWith`/order untouched.
