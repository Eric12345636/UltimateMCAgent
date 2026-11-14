"""在 mc_lite 仿真里用 A2C 训练**反射策略**。

反射策略只负责「这一 tick 怎么动」：躲岩浆、躲坠落、被怪贴脸时后撤举盾、
氧气不足时上浮。它不负责长程任务——那是上层 LLM 和技能执行器的活。

为什么不直接在真服上 RL：
  - 20Hz × 分钟级 episode，样本效率极低；
  - MC 没有回滚，重来成本高；
  - 1.21.11 的碰撞/伤害细节很难在短平快里复刻。
所以仿真只当**数据生成器**，评测仍然只在真服做（见 COE.md §7.2）。

仿真观测的编码与 Node 运行侧逐 token 一致（黄金向量守住），
所以在这里学到的反应能直接迁移。

跑法：
    python train_rl.py --episodes 2000 --out runs/rl
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
from typing import List

import torch
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from coe.model import CoEPolicy, ValueHead, pitch_from_bin, yaw_from_bin  # noqa: E402
from coe.tokens import load_vocab  # noqa: E402
from envs.mc_lite import MCEnv  # noqa: E402

BIN_NAMES = ["sprint", "jump", "sneak", "shield", "attack", "use", "dig"]


def action_to_env(action) -> dict:
    """把网络输出翻译成环境动作（单条样本，batch 维取 0）。"""
    b = action["bin"]
    if b.dim() > 1:
        b = b[0]
    return {
        "move": int(action["move"][0]) if action["move"].dim() > 0 else int(action["move"]),
        "sprint": bool(b[0]),
        "jump": bool(b[1]),
        "sneak": bool(b[2]),
        "shield": bool(b[3]),
        "attack": bool(b[4]),
        "use": bool(b[5]),
        "dig": bool(b[6]),
        "yaw_delta": yaw_from_bin(int(action["yaw"][0]) if action["yaw"].dim() > 0 else int(action["yaw"])),
        "pitch_delta": pitch_from_bin(int(action["pitch"][0]) if action["pitch"].dim() > 0 else int(action["pitch"])),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--episodes", type=int, default=2000)
    ap.add_argument("--out", default="runs/rl")
    ap.add_argument("--hidden", type=int, default=192)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--gamma", type=float, default=0.97)
    ap.add_argument("--entropy", type=float, default=0.01)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--goal", default="flee", choices=["flee", "goto"])
    ap.add_argument("--env-horizon", type=int, default=200)
    ap.add_argument("--minibatch", type=int, default=50)
    args = ap.parse_args()
    if args.episodes < 1 or args.env_horizon < 1 or args.minibatch < 1:
        ap.error("episodes、env-horizon 和 minibatch 必须为正整数")

    torch.manual_seed(args.seed)
    random.seed(args.seed)

    vocab = load_vocab()
    index = {t: i for i, t in enumerate(vocab)}
    n_vocab = len(vocab)

    policy = CoEPolicy(vocab_size=n_vocab, hidden=args.hidden)
    value = ValueHead(vocab_size=n_vocab, hidden=args.hidden)
    opt_p = torch.optim.Adam(policy.parameters(), lr=args.lr)
    opt_v = torch.optim.Adam(value.parameters(), lr=args.lr)

    best = float("-inf")
    stats = []

    for ep in range(args.episodes):
        env = MCEnv(seed=args.seed * 100000 + ep, goal=args.goal,
                    horizon=args.env_horizon)
        obs = env.observe()
        ids = torch.tensor([[index[t] for t in obs]], dtype=torch.long)

        values: List[torch.Tensor] = []
        rewards: List[float] = []
        masks: List[float] = []
        seqs: List[List[int]] = []
        acts = {"move": [], "yaw": [], "pitch": [], "bin": []}
        total_r = 0.0
        info = {}

        for _ in range(args.env_horizon):
            with torch.no_grad():
                action, _ = policy.act(ids)
                v = value(ids)
            env_action = action_to_env(action)
            obs, reward, done, info = env.step(env_action)
            total_r += reward
            values.append(v)
            rewards.append(reward)
            masks.append(0.0 if done and info.get("dead") else 1.0)
            seqs.append(ids.squeeze(0).tolist())
            for k in acts:
                acts[k].append(action[k].detach().squeeze(0))
            ids = torch.tensor([[index[t] for t in obs]], dtype=torch.long)
            if done:
                break

        # GAE(λ=0.95)
        with torch.no_grad():
            next_v = value(ids)
            returns: List[float] = []
            gae = 0.0
            for t in range(len(rewards) - 1, -1, -1):
                nv = next_v if t == len(rewards) - 1 else values[t + 1]
                delta = rewards[t] + args.gamma * float(nv) * masks[t] - float(values[t])
                gae = delta + args.gamma * 0.95 * masks[t] * gae
                returns.insert(0, gae + float(values[t]))
        targets = torch.tensor(returns, dtype=torch.float32)
        adv = targets - torch.cat(values)
        if adv.numel() > 1:
            adv = (adv - adv.mean()) / (adv.std(unbiased=False) + 1e-6)

        X = torch.tensor(seqs, dtype=torch.long)
        A = {k: torch.stack(v) for k, v in acts.items()}

        # 用采样到的动作重新算 logprob，每个样本使用自己的 advantage。
        # 一个 episode 切成多个 minibatch 做多次更新：
        # 1 次 episode 1 次更新的话，梯度步数太少（A2C 需要几千步）
        n_steps = len(seqs)
        mb = max(16, min(args.minibatch, n_steps))
        for s in range(0, n_steps, mb):
            sl = slice(s, min(s + mb, n_steps))
            lp_m, ent_m = policy.evaluate(X[sl], {k: v[sl] for k, v in A.items()})
            adv_m = adv[sl]
            loss_p = -(lp_m * adv_m).mean() - args.entropy * ent_m.mean()
            opt_p.zero_grad()
            loss_p.backward()
            torch.nn.utils.clip_grad_norm_(policy.parameters(), 1.0)
            opt_p.step()

            loss_v = F.mse_loss(value(X[sl]), targets[sl])
            opt_v.zero_grad()
            loss_v.backward()
            torch.nn.utils.clip_grad_norm_(value.parameters(), 1.0)
            opt_v.step()

        stats.append({"ep": ep, "reward": total_r, "hp": env.hp,
                      "death": bool(info.get("dead"))})
        if total_r > best:
            best = total_r
        if (ep + 1) % 50 == 0:
            recent = stats[-50:]
            avg_r = sum(s["reward"] for s in recent) / len(recent)
            deaths = sum(1 for s in recent if s["death"])
            avg_hp = sum(s["hp"] for s in recent) / len(recent)
            print("ep %5d  reward %8.2f  hp %5.2f  death %2d/%d  best %.2f" %
                  (ep + 1, avg_r, avg_hp, deaths, len(recent), best), flush=True)

    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, "reflex_policy.pt")
    torch.save({"state_dict": policy.state_dict(),
                "vocab_size": n_vocab,
                "tokens": vocab,
                "hidden": args.hidden}, path)
    with open(os.path.join(args.out, "train_log.json"), "w", encoding="utf-8") as fh:
        json.dump(stats, fh)
    print("保存", path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
