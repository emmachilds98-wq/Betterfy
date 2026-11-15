# CLAP text table (WP-C2)

Builds `docs/models/clap-text-table.json`, the prompts that WP-C3's naming and
"sounds like" search match CLAP audio embeddings against. The page never runs
CLAP's text model. It runs once, here.

```bash
node scripts/audio-clap/prompts.mjs            # prompts.json: every ontology genre + reviewed descriptions
python scripts/audio-clap/text-table.py        # text-embeddings.json (needs torch + transformers)
node scripts/audio-clap/pack-table.mjs         # docs/models/clap-text-table.json (int8, record.mjs packing)
node --test test/clap-table.test.mjs
```

The Python step needs a CPU build of PyTorch and `transformers` (tested on
4.46.3 and 5.23.0). It downloads the pinned checkpoint, about 780 MB, on the
first run.

**Model:** `laion/larger_clap_music_and_speech`, pinned in `text-table.py`. It
must match the audio encoder the page runs (`record.mjs` `CLAP_MODEL`).
`laion/larger_clap_music` is *not* usable here: its text tower is collapsed
(see `docs/AUDIO-BUILD-PLAN.md` §7), and `test/clap-table.test.mjs` fails on a
table built from it.

Regenerate after adding genres to the ontology or editing `DESCRIPTIONS` in
`prompts.mjs`. The intermediates (`prompts.json`, `text-embeddings.json`) are
not committed.
