"""The CLAP model every script in this folder uses (WP-C2), loaded one way.

Why not `ClapModel.from_pretrained("laion/larger_clap_music")`: that Hugging
Face upload is broken. Its text branch was never filled in by the conversion
(word embeddings at their N(0, 0.02) initialisation, every bias zero, both
logit scales ~0), so every prompt embeds to the same vector, and its audio
embeddings are ~0.95 alike for a sine, a kick drum and noise (checked
2026-11-14 at revision a0b4534a). The checkpoint it was converted from is
LAION's own `music_audioset_epoch_15_esc_90.14.pt` (lukewys/laion_clap,
CC0-1.0), and that one works. So this file converts the original into
transformers' ClapModel with transformers' own key mapping
(convert_clap_original_pytorch_to_hf.py), but loads strictly: a key that
doesn't land is an error here, where the upstream script used strict=False,
which is how an untrained branch got published.

The architecture config (HTSAT-base audio, RoBERTa-base text, 512-d
projection) and the preprocessor config are still taken from
laion/larger_clap_music, pinned to its revision: those are right; only its
weights are not.
"""
import base64, hashlib, os, re

import numpy as np

import torch
from transformers import ClapConfig, ClapModel, ClapProcessor

HF_CONFIG = "laion/larger_clap_music"
HF_REVISION = "a0b4534a14f58e20944452dff00a22a06ce629d1"
ORIGINAL_REPO = "lukewys/laion_clap"
ORIGINAL_FILE = "music_audioset_epoch_15_esc_90.14.pt"
ORIGINAL_SHA256 = "fae3e9c087f2909c28a09dc31c8dfcdacbc42ba44c70e972b58c1bd1caf6dedd"
ORIGINAL_URL = f"https://huggingface.co/{ORIGINAL_REPO}/resolve/main/{ORIGINAL_FILE}"

# transformers/models/clap/convert_clap_original_pytorch_to_hf.py, verbatim.
KEYS_TO_MODIFY_MAPPING = {
    "text_branch": "text_model",
    "audio_branch": "audio_model.audio_encoder",
    "attn": "attention.self",
    "self.proj": "output.dense",
    "attention.self_mask": "attn_mask",
    "mlp.fc1": "intermediate.dense",
    "mlp.fc2": "output.dense",
    "norm1": "layernorm_before",
    "norm2": "layernorm_after",
    "bn0": "batch_norm",
}
# The original model computes its own spectrogram inside the audio branch;
# transformers does that in the feature extractor instead, so these have no home.
# Nor do the AudioSet classification heads (head, tscam_conv), the training
# loss's extra MLPs (audio_transform, text_transform: laion_clap's
# get_audio_embedding/get_text_embedding never use them), and the Swin
# blocks' precomputed attention masks (rebuilt by the model).
DROPPED = ("audio_model.audio_encoder.spectrogram_extractor.", "audio_model.audio_encoder.logmel_extractor.",
           "audio_model.audio_encoder.head.", "audio_model.audio_encoder.tscam_conv.",
           "audio_transform.", "text_transform.")
dropped = lambda k: k.startswith(DROPPED) or k.endswith(".attn_mask")


def rename_state_dict(state_dict):
    out = {}
    for key, value in state_dict.items():
        if key.startswith("module."):
            key = key[len("module."):]
        for old, new in KEYS_TO_MODIFY_MAPPING.items():
            if old in key:
                key = key.replace(old, new)
        m = re.match(r".*sequential.(\d+).*", key)
        p = re.match(r".*_projection.(\d+).*", key)
        if m:
            n = m.group(1)
            key = key.replace(f"sequential.{n}.", f"layers.{int(n) // 3}.linear.")
        elif p:
            n = int(p.group(1))
            key = key.replace(f"_projection.{n}.", f"_projection.linear{1 if n == 0 else 2}.")
        if "qkv" in key:
            d = value.size(0) // 3
            out[key.replace("qkv", "query")] = value[:d]
            out[key.replace("qkv", "key")] = value[d:2 * d]
            out[key.replace("qkv", "value")] = value[2 * d:]
        else:
            out[key] = value
    return out


def pack(v):
    """record.mjs packEmbedding(), bit for bit: one scale, int8, base64.
    JS Math.round rounds .5 up, so floor(x + 0.5), not Python's round()."""
    v = np.asarray(v, dtype=np.float32)
    mx = float(np.max(np.abs(v)))
    s = mx / 127 if mx > 0 else 1.0
    q = np.floor(v.astype(np.float64) / s + 0.5).astype(np.int64)
    return {"s": s, "q": base64.b64encode(((q + 256) & 0xFF).astype(np.uint8).tobytes()).decode("ascii")}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def load(checkpoint):
    """The working model, eval mode, plus the processor. `checkpoint` is a
    local copy of ORIGINAL_FILE (download ORIGINAL_URL; ~2.4 GB)."""
    got = sha256(checkpoint)
    if got != ORIGINAL_SHA256:
        raise SystemExit(f"{checkpoint}: sha256 {got}, expected {ORIGINAL_SHA256}")
    # weights_only: tensors and plain containers, no arbitrary pickle code. The
    # file also holds a few numpy scalars (training metadata), allowed by name.
    from numpy._core.multiarray import scalar
    allowed = [(scalar, "numpy.core.multiarray.scalar"), np.dtype] + [type(np.dtype(t)) for t in ("float64", "float32", "int64", "int32", "bool")]
    with torch.serialization.safe_globals(allowed):
        ckpt = torch.load(checkpoint, map_location="cpu", weights_only=True)
    sd = ckpt.get("state_dict", ckpt)
    sd = {k: v for k, v in rename_state_dict(sd).items() if not dropped(k)}
    config = ClapConfig.from_pretrained(HF_CONFIG, revision=HF_REVISION)
    model = ClapModel(config).eval()
    own = model.state_dict()
    # position_ids/token_type_ids are constant buffers the model builds itself.
    unexpected = sorted(k for k in sd if k not in own)
    missing = sorted(k for k in own if k not in sd and not k.endswith(("position_ids", "token_type_ids")))
    if unexpected or missing:
        raise SystemExit(f"checkpoint does not map onto ClapModel: missing {missing[:8]}, unexpected {unexpected[:8]}")
    for k, v in sd.items():
        if own[k].shape != v.shape:
            raise SystemExit(f"{k}: checkpoint {tuple(v.shape)} vs model {tuple(own[k].shape)}")
    model.load_state_dict(sd, strict=False)  # only those buffers are left as built
    processor = ClapProcessor.from_pretrained(HF_CONFIG, revision=HF_REVISION)
    return model, processor


def checkpoint_path(arg=None):
    p = arg or os.environ.get("CLAP_CHECKPOINT")
    if not p or not os.path.exists(p):
        raise SystemExit(f"pass --checkpoint or set CLAP_CHECKPOINT to a local {ORIGINAL_FILE} ({ORIGINAL_URL})")
    return p
