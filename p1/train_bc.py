"""行为克隆：训练技能执行器。

教师 = pathfinder。数据由 mc-agent-api/src/coe/record.js 在真服上录，
每行一条 {"obs": [...token...], "act": {...}}，见 p1/data/episodes/。

学的不是「寻路」，而是**微操**：
  - move   9 分类（朝哪边走）
  - jump   二分类（什么时候起跳）
  - sprint 二分类（什么时候疾跑）
其余头（sneak/shield/attack/use/dig、视角增量）在 BC 阶段不训，
留给反射策略（仿真 RL）和后续的技能专用数据。

跑法：
    python train_bc.py --data data/episodes --out runs/bc --epochs 20
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys

import torch
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from coe.model import CoEPolicy  # noqa: E402
from coe.tokens import load_vocab, token_ids  # noqa: E402


def load_samples(paths, vocab):
    """读 JSONL，返回 (ids, move, jump, sprint)。"""
    ids_all, move_all, jump_all, sprint_all = [], [], [], []
    index = {t: i for i, t in enumerate(vocab)}
    skipped = 0
    for p in paths:
        with open(p, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    skipped += 1
                    continue
                obs = row.get("obs")
                act = row.get("act")
                if not obs or not act:
                    skipped += 1
                    continue
                try:
                    ids = [index[t] for t in obs]
                except KeyError:
                    skipped += 1
                    continue
                ids_all.append(ids)
                move_all.append(int(act.get("move", 8)))
                jump_all.append(1 if act.get("jump") else 0)
                sprint_all.append(1 if act.get("sprint") else 0)
    return ids_all, move_all, jump_all, sprint_all, skipped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/episodes")
    ap.add_argument("--out", default="runs/bc")
    ap.add_argument("--epochs", type=int, default=20)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--hidden", type=int, default=192)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    torch.manual_seed(args.seed)

    paths = sorted(glob.glob(os.path.join(args.data, "*.jsonl")))
    if not paths:
        print("没有找到数据。先用 mc-agent-api 的 Recorder 在真服上录一段：")
        print("  const rec = new Recorder({ path: 'p1/data/episodes/goto.jsonl' })")
        print("  controller.setRecorder(rec)")
        return 1

    vocab = load_vocab()
    ids, move, jump, sprint, skipped = load_samples(paths, vocab)
    if not ids:
        print("数据为空")
        return 1
    print("样本 %d 条（跳过 %d 条），词表 %d" % (len(ids), skipped, len(vocab)))

    X = torch.tensor(ids, dtype=torch.long)
    Y_move = torch.tensor(move, dtype=torch.long)
    Y_jump = torch.tensor(jump, dtype=torch.float32)
    Y_sprint = torch.tensor(sprint, dtype=torch.float32)

    policy = CoEPolicy(vocab_size=len(vocab), hidden=args.hidden)
    opt = torch.optim.Adam(policy.parameters(), lr=args.lr)
    n = len(X)

    for ep in range(args.epochs):
        perm = torch.randperm(n)
        total = 0.0
        correct = 0
        for s in range(0, n, args.batch):
            idx = perm[s:s + args.batch]
            logits = policy(X[idx])
            loss_move = F.cross_entropy(logits["move"], Y_move[idx])
            bin_logits = logits["bin"][:, 0]      # 0 = sprint
            bin_logits_jump = logits["bin"][:, 1]  # 1 = jump
            loss_bin = (F.binary_cross_entropy_with_logits(bin_logits, Y_sprint[idx])
                        + F.binary_cross_entropy_with_logits(bin_logits_jump, Y_jump[idx]))
            loss = loss_move + 0.5 * loss_bin
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(policy.parameters(), 1.0)
            opt.step()
            total += float(loss) * len(idx)
            correct += int((logits["move"].argmax(-1) == Y_move[idx]).sum())
        print("epoch %2d  loss %.4f  move_acc %.3f" %
              (ep + 1, total / n, correct / n))

    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, "bc_policy.pt")
    torch.save({"state_dict": policy.state_dict(),
                "vocab_size": len(vocab),
                "tokens": vocab,
                "hidden": args.hidden}, path)
    print("保存", path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
