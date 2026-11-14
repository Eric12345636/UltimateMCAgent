"""把训练好的策略导出成 ONNX，供 Node 运行侧用 onnxruntime-node 推理。

导出的是**单步**模型：
  输入  ids : int64 (1, T)   T = 88 * 帧数
  输出  move : (1, 9)   logits
        yaw  : (1, 9)   logits
        pitch: (1, 5)   logits
        bin  : (1, 7)   logits（sigmoid 前）

词表会一起导出（vocab.json），Node 侧靠它把 token 字符串映射成 id。
两边必须用同一份词表——Node 侧的是 mc-agent-api/src/coe/local-vocab.json。

跑法：
    python export_onnx.py --ckpt runs/rl/reflex_policy.pt --out runs/rl/model.onnx
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from coe.model import CoEPolicy  # noqa: E402
from coe.tokens import load_vocab  # noqa: E402

SEQ_LEN = 88


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", default="runs/rl/reflex_policy.pt")
    ap.add_argument("--out", default="runs/rl/model.onnx")
    ap.add_argument("--frames", type=int, default=1)
    ap.add_argument("--opset", type=int, default=17)
    args = ap.parse_args()

    ckpt = torch.load(args.ckpt, map_location="cpu", weights_only=True)
    vocab = ckpt["tokens"] if "tokens" in ckpt else load_vocab()
    policy = CoEPolicy(vocab_size=ckpt.get("vocab_size", len(vocab)),
                       hidden=ckpt.get("hidden", 192))
    policy.load_state_dict(ckpt["state_dict"])
    policy.eval()

    seq = SEQ_LEN * args.frames
    dummy = torch.zeros(1, seq, dtype=torch.long)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    torch.onnx.export(
        policy, dummy, args.out,
        input_names=["ids"], output_names=["move", "yaw", "pitch", "bin"],
        dynamic_axes={"ids": {0: "batch"}, "move": {0: "batch"},
                      "yaw": {0: "batch"}, "pitch": {0: "batch"}, "bin": {0: "batch"}},
        opset_version=args.opset, do_constant_folding=True)

    vocab_out = os.path.join(os.path.dirname(os.path.abspath(args.out)), "vocab.json")
    with open(vocab_out, "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "tokens": vocab}, fh, ensure_ascii=False)

    print("导出", args.out, "（序列长度 %d）" % seq)
    print("词表", vocab_out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
