"""WP-C2, step 2: embed prompts.json with CLAP's text encoder, at build time.

    python scripts/audio-clap/text-table.py      (needs torch + transformers)

Writes text-embeddings.json beside this file: the 512-d projected text
embedding of every prompt, L2-normalised, as plain floats. pack-table.mjs then
packs it into docs/models/clap-text-table.json with record.mjs's own
packEmbedding, so the page never needs CLAP's text model (~500 MB) at all.

The model is pinned to one revision of laion/larger_clap_music_and_speech
(Apache-2.0), the same model whose audio tower the page runs (record.mjs
CLAP_MODEL). Text and audio have to come from one checkpoint or they are not
in the same space.

Not laion/larger_clap_music: measured 2026-11-14, its text tower is collapsed.
All 154 prompts land within cosine 0.999 of each other (mean vector norm
0.9996), and even after centring the nearest neighbours are noise (jungle ->
jazz, donk -> k-pop). The music-and-speech checkpoint gives a mean pairwise
cosine of 0.44 and sensible neighbours (bassline -> garage house, bass house;
techno -> trance, electro). Same architecture and size, and it has a ready
ONNX export of its audio tower (Xenova/larger_clap_music_and_speech).
"""
import json, pathlib, sys
import torch
from transformers import ClapModel, ClapProcessor

MODEL = "laion/larger_clap_music_and_speech"
REVISION = "195c3a3e68faebb3e2088b9a79e79b43ddbda76b"  # pin; bump with the audio export

here = pathlib.Path(__file__).parent
spec = json.loads((here / "prompts.json").read_text())
texts = [p["text"] for p in spec["prompts"]]

model = ClapModel.from_pretrained(MODEL, revision=REVISION).eval()
proc = ClapProcessor.from_pretrained(MODEL, revision=REVISION)
out = []
with torch.no_grad():
    for i in range(0, len(texts), 32):
        batch = proc(text=texts[i:i + 32], return_tensors="pt", padding=True)
        # The text tower's pooled output through CLAP's text projection: the
        # 512-d space the audio projection also lands in. Spelled out rather
        # than get_text_features(), whose return type changed in transformers 5.
        pooled = model.text_model(**batch).pooler_output
        emb = torch.nn.functional.normalize(model.text_projection(pooled), dim=-1)
        out.extend(emb.tolist())
        print(f"{min(i + 32, len(texts))}/{len(texts)}", file=sys.stderr)

full_rev = getattr(model.config, "_commit_hash", None) or REVISION
(here / "text-embeddings.json").write_text(json.dumps({
    "model": MODEL, "revision": full_rev, "dim": len(out[0]), "template": spec["template"],
    "prompts": [{**p, "emb": e} for p, e in zip(spec["prompts"], out)],
}))
print(f"{len(out)} prompts embedded, dim {len(out[0])}, revision {full_rev}")
