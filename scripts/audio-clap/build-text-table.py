#!/usr/bin/env python3
"""Build docs/models/clap-text-table.json from scripts/audio-clap/prompts.json (WP-C2).

CLAP's text encoder (RoBERTa-base, 125 M parameters, so well over 100 MB even
quantised) runs here, at build time, and never in the page. The page only
ships the audio encoder and this table: one L2-normalised 512-d text
embedding per reviewed prompt, int8-packed exactly as core/audio/record.mjs
packEmbedding() packs audio embeddings, so the page compares the two with a
plain dot product.

Reproducible: the model is pinned to a Hugging Face revision, inference is on
CPU in float32 with deterministic algorithms, and the table records the
SHA-256 of the prompt list it was built from (test/audioclap.test.mjs checks
the committed table against the committed prompts).

The model is LAION's original music checkpoint, converted strictly by
clap_model.py, because the Hugging Face upload of it is broken (read there).

    python3 -m venv .venv
    .venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch
    .venv/bin/pip install transformers==4.46.3 numpy
    curl -LO https://huggingface.co/lukewys/laion_clap/resolve/main/music_audioset_epoch_15_esc_90.14.pt
    export CLAP_CHECKPOINT=$PWD/music_audioset_epoch_15_esc_90.14.pt
    .venv/bin/python scripts/audio-clap/build-text-table.py          # write
    .venv/bin/python scripts/audio-clap/build-text-table.py --check  # rebuild and compare
"""
import base64, hashlib, json, os, sys

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import clap_model  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
PROMPTS = os.path.join(HERE, "prompts.json")
OUT = os.path.join(ROOT, "docs", "models", "clap-text-table.json")
TABLE_VERSION = 1
BATCH = 32


def prompts_list(spec):
    out = []
    for concept, name in spec["genres"].items():
        out.append({"text": spec["template"].replace("{name}", name), "kind": "genre", "concept": concept})
    for d in spec["descriptions"]:
        out.append({"text": d, "kind": "description"})
    texts = [p["text"] for p in out]
    dupes = {t for t in texts if texts.count(t) > 1}
    if dupes:
        sys.exit(f"duplicate prompts: {sorted(dupes)}")
    return out


def build():
    raw = open(PROMPTS, "rb").read()
    spec = json.loads(raw)
    prompts = prompts_list(spec)
    torch.manual_seed(0)
    torch.use_deterministic_algorithms(True)
    torch.set_num_threads(1)
    model, proc = clap_model.load(clap_model.checkpoint_path(arg_value("--checkpoint")))
    for i in range(0, len(prompts), BATCH):
        chunk = prompts[i:i + BATCH]
        enc = proc(text=[p["text"] for p in chunk], return_tensors="pt", padding=True)
        with torch.no_grad():
            out = model.get_text_features(**enc)
        emb = getattr(out, "pooler_output", out)
        emb = torch.nn.functional.normalize(emb, dim=-1).numpy()
        for p, e in zip(chunk, emb):
            p["emb"] = clap_model.pack(e)
    return {
        "v": TABLE_VERSION,
        "model": "laion/larger_clap_music",
        "checkpoint": f"{clap_model.ORIGINAL_REPO}/{clap_model.ORIGINAL_FILE}",
        "checkpointSha256": clap_model.ORIGINAL_SHA256,
        "config": f"{clap_model.HF_CONFIG}@{clap_model.HF_REVISION}",
        "dim": int(model.config.projection_dim),
        "template": spec["template"],
        "promptsSha256": hashlib.sha256(raw).hexdigest(),
        "licence": "LAION CLAP music checkpoint, CC0-1.0 (laion/larger_clap_music: Apache-2.0); see docs/models/LICENSE-CLAP",
        "prompts": prompts,
    }


def arg_value(flag):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv[:-1] else None


def dump(table):
    # One prompt per line: small diffs when the list is edited.
    head = {k: v for k, v in table.items() if k != "prompts"}
    lines = ",\n".join("    " + json.dumps(p, ensure_ascii=False, separators=(",", ":")) for p in table["prompts"])
    body = json.dumps(head, ensure_ascii=False, indent=2)[:-2]
    return body + ',\n  "prompts": [\n' + lines + "\n  ]\n}\n"


if __name__ == "__main__":
    text = dump(build())
    if "--check" in sys.argv:
        old = open(OUT, encoding="utf-8").read() if os.path.exists(OUT) else ""
        if old != text:
            # int8 codes may differ by one on a different CPU/BLAS; report how far.
            a, b = json.loads(old)["prompts"], json.loads(text)["prompts"]
            worst = 0
            for x, y in zip(a, b):
                qa = np.frombuffer(base64.b64decode(x["emb"]["q"]), np.int8)
                qb = np.frombuffer(base64.b64decode(y["emb"]["q"]), np.int8)
                worst = max(worst, int(np.max(np.abs(qa.astype(int) - qb.astype(int)))))
            sys.exit(f"table differs from a fresh build (worst int8 step difference {worst})")
        print(f"{OUT}: matches a fresh build")
    else:
        open(OUT, "w", encoding="utf-8").write(text)
        print(f"wrote {OUT}: {text.count(chr(10))} lines, {len(text) // 1024} KB")
