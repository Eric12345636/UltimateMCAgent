"""下层反射策略的网络结构。

设计约束：
  - **单次 forward < 1 ms**：20Hz 反思循环里每 tick 都要跑一次。
  - **能导出 ONNX**：运行侧（Node）用 onnxruntime-node 推理，不跑 Python。
  - **能处理部分可观测**：FPS 视角看不见背后，所以用 GRU 在观测窗口上做序列编码，
    并且支持堆叠最近 K 帧。

输入是 L-obs 的 token id 序列（定长 88 * K），不是原始 JSON：
  观测已经由 coe/tokens.py 压成定长 token，词表只有 153 项。

输出是四个头：
  move  : 9 类（局部坐标系 8 向 + 不动）
  yaw   : 9 类（视角增量分箱）
  pitch : 5 类
  bin   : 7 个独立 sigmoid（sprint/jump/sneak/shield/attack/use/dig）
"""

from __future__ import annotations

from typing import Dict, Tuple

import torch
import torch.nn as nn

MOVE_BINS = 9      # 0..7 是 8 个方向，8 是不动
YAW_BINS = 9       # -2.0 .. +2.0 rad，步长 0.5
PITCH_BINS = 5     # -1.0 .. +1.0 rad，步长 0.5
BIN_NAMES = ["sprint", "jump", "sneak", "shield", "attack", "use", "dig"]

# 视角反量化：把分箱还原成弧度
YAW_STEP = 0.5
PITCH_STEP = 0.5


def yaw_from_bin(b: int) -> float:
    return (b - (YAW_BINS - 1) / 2.0) * YAW_STEP


def pitch_from_bin(b: int) -> float:
    return (b - (PITCH_BINS - 1) / 2.0) * PITCH_STEP


class CoEPolicy(nn.Module):
    def __init__(self, vocab_size: int = 153, hidden: int = 192, emb: int = 64,
                 dropout: float = 0.0):
        super().__init__()
        self.vocab_size = vocab_size
        self.hidden = hidden
        self.emb = nn.Embedding(vocab_size, emb, padding_idx=0)
        self.gru = nn.GRU(emb, hidden, batch_first=True)
        self.norm = nn.LayerNorm(hidden)
        self.head_move = nn.Linear(hidden, MOVE_BINS)
        self.head_yaw = nn.Linear(hidden, YAW_BINS)
        self.head_pitch = nn.Linear(hidden, PITCH_BINS)
        self.head_bin = nn.Linear(hidden, len(BIN_NAMES))
        self.dropout = nn.Dropout(dropout) if dropout > 0 else nn.Identity()

    def forward(self, ids: torch.Tensor) -> Dict[str, torch.Tensor]:
        """ids: (B, T) 的 token id 序列。"""
        x = self.emb(ids)
        x = self.dropout(x)
        out, _ = self.gru(x)
        h = self.norm(out[:, -1, :])
        return {
            "move": self.head_move(h),
            "yaw": self.head_yaw(h),
            "pitch": self.head_pitch(h),
            "bin": self.head_bin(h),
        }

    @torch.no_grad()
    def act(self, ids: torch.Tensor, deterministic: bool = False):
        """采样一个动作。返回 (动作字典, logprob)。"""
        logits = self(ids)
        action = {}
        logprob = 0.0
        for key in ("move", "yaw", "pitch"):
            dist = torch.distributions.Categorical(logits=logits[key])
            a = torch.argmax(logits[key], dim=-1) if deterministic else dist.sample()
            action[key] = a
            logprob = logprob + dist.log_prob(a)
        bin_logits = logits["bin"]
        dist = torch.distributions.Bernoulli(logits=bin_logits)
        b = (bin_logits > 0).float() if deterministic else dist.sample()
        action["bin"] = b
        logprob = logprob + dist.log_prob(b).sum(dim=-1)
        return action, logprob

    def evaluate(self, ids: torch.Tensor, action: Dict[str, torch.Tensor]):
        """算 logprob 与熵（训练时用，需要梯度，所以这里不能加 no_grad）。"""
        logits = self(ids)
        logprob = 0.0
        entropy = 0.0
        for key in ("move", "yaw", "pitch"):
            dist = torch.distributions.Categorical(logits=logits[key])
            logprob = logprob + dist.log_prob(action[key])
            entropy = entropy + dist.entropy()
        dist = torch.distributions.Bernoulli(logits=logits["bin"])
        logprob = logprob + dist.log_prob(action["bin"].float()).sum(dim=-1)
        entropy = entropy + dist.entropy().sum(dim=-1)
        return logprob, entropy


class ValueHead(nn.Module):
    """价值函数：给 A2C 的 advantage 当基线。"""

    def __init__(self, vocab_size: int = 153, hidden: int = 192, emb: int = 64):
        super().__init__()
        self.emb = nn.Embedding(vocab_size, emb, padding_idx=0)
        self.gru = nn.GRU(emb, hidden, batch_first=True)
        self.norm = nn.LayerNorm(hidden)
        self.head = nn.Linear(hidden, 1)

    def forward(self, ids: torch.Tensor) -> torch.Tensor:
        out, _ = self.gru(self.emb(ids))
        return self.head(self.norm(out[:, -1, :])).squeeze(-1)
