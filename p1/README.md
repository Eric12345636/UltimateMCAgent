# p1 — CoE 下层模型的训练侧

训练 **CoE 的下层反射模型**（20Hz 逐 tick 输出控制向量）。
上层 LLM 不在这里——它只下发「技能」，见工作区根目录的 `COE.md`。

与 `p0/` 的分工：

| | `p0/` | `p1/` |
|---|---|---|
| 面向 | 上层 LLM | 下层反射模型 |
| 表示 | 高层观测压缩（≈140 token）+ 动作指针 | 低层局部观测（88 token）+ 控制向量 |
| 产物 | 给 LLM 看的 prompt | ONNX 模型 + 词表 |

---

## 1. 目录

```
p1/
├── coe/
│   ├── tokens.py          # L-obs 编码（与 Node 侧逐 token 一致）
│   ├── model.py           # GRU 策略网络（torch）+ 价值头
│   └── export_onnx.py     # 导出 ONNX + 词表
├── envs/
│   └── mc_lite.py         # 极简体素仿真（只仿 8 个机制）
├── data/
│   ├── golden_local.json  # 黄金向量（Node 侧生成，Python 侧回归）
│   └── episodes/          # BC 录制数据（JSONL，由 Recorder 在真服上录）
├── tests/
│   └── test_golden.py     # 编码一致性回归
├── train_bc.py            # 行为克隆（技能执行器）
├── train_rl.py            # A2C（反射策略）
└── runs/                  # 训练产物（不入库）
```

---

## 2. 编码契约（最重要的一件事）

`mc-agent-api/src/coe/local.js`（Node，运行侧）是 **L-obs 编码的真值**。
Python 侧 `coe/tokens.py` 必须产出**逐 token 一致**的结果。

保证手段是**黄金向量**：

```bash
# Node 侧生成（改了编码就重新生成）
cd mc-agent-api && node src/coe/build-golden.js

# Python 侧回归
cd p1 && python tests/test_golden.py
```

黄金向量覆盖 14 个场景，包括地形、岩浆、水下低氧、敌对实体、残血和逃跑目标，每个场景逐 token 比对。

**改了 Node 侧的编码而不重新生成黄金向量，Python 侧测试就会失败**——
这是故意的。

---

## 3. 装依赖

```bash
python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
python -m pip install numpy onnx onnxruntime onnxscript
```

`torch` 用 CPU 版就够（模型很小，GRU(192)，88 token）。

---

## 4. 训练反射策略（仿真 RL）

反射策略只管「这一 tick 怎么动」：躲岩浆、躲坠落、被怪贴脸时后撤举盾、氧气不足时上浮。

```bash
python train_rl.py --episodes 4000 --goal flee --out runs/rl
```

- 算法：A2C（策略梯度 + 价值基线 + 熵正则），GAE(λ=0.95)
- 逃跑奖励随敌我距离增加而增加，寻路奖励随目标距离缩短而增加。使用修正后的训练脚本重新生成策略权重。
- 环境：`envs/mc_lite.py`，只仿重力/碰撞/液体/岩浆/坠落/实体/氧气 8 个机制
- 观测：与 Node 运行侧逐 token 一致（黄金向量守住），所以这里学到的反应能直接迁移
- 吞吐：CPU 上约 1.5 s/episode（200 tick），4000 episode ≈ 1.7 小时

**仿真只当数据生成器**。评测只在真服做（见 `COE.md` §8）。

导出 ONNX：

```bash
python coe/export_onnx.py --ckpt runs/rl/reflex_policy.pt --out runs/rl/model.onnx
```

产物为 `model.onnx`（int64 输入 `ids`，输出 `move`/`yaw`/`pitch`/`bin`）和 `vocab.json`。导出器生成 `model.onnx.data` 时，把它和模型放在同一目录。Node 侧配置示例：

```json
{ "coe": { "enabled": true, "policy": "onnx",
           "modelPath": "D:/.../model.onnx",
           "vocabPath": "D:/.../vocab.json" } }
```

> Node 侧默认用 `mc-agent-api/src/coe/local-vocab.json`。它和 `vocab.json` 内容必须一致
> （都是 `localVocab()` 的输出）。

---

## 5. 录制 BC 数据 + 训练技能执行器

教师 = pathfinder。跑 `move_to` 时 pathfinder 每 tick 都在算方向键，**标签是白送的**。

### 录制（Node 侧，在真服上）

```js
const { Recorder } = require('mc-agent-api/src/coe')
const rec = new Recorder({ path: 'D:/MC agent/p1/data/episodes/goto.jsonl' })
rec.start()
controller.setRecorder(rec)
// ... 让上层下 goto 技能，或者手动 controller.submit('goto', {x,y,z})
// 录完：rec.stop()
```

每行一条：

```json
{"obs": ["<self>", "hp6", ...], "act": {"move": 0, "sprint": true, "jump": false, ..., "raw": {...}}, "t": 1750000000000}
```

> 教师录制默认跟随 HTTP `move_to`，把当前帧读到的按键配给上一帧观测。切换动作或断线时会清空待配对帧。指定 `labelSource: 'policy'` 时记录同一帧的推理输入和输出。

### 训练

```bash
python train_bc.py --data data/episodes --out runs/bc --epochs 20
```

学的头：`move`（9 分类）、`jump`、`sprint`。
其余头留给反射策略和后续的技能专用数据。

---

## 6. 网络结构

```
ids (1, 88*K) ──► Embedding(153, 64) ──► GRU(64→192) ──► LayerNorm ──► MLP
                                                                 ├─► move  (9)
                                                                 ├─► yaw   (9)
                                                                 ├─► pitch (5)
                                                                 └─► bin   (7, sigmoid)
```

- `K` = 堆叠帧数，默认 1（一个 tick 一帧）。需要更长的记忆时把 `K` 调大。
- 规模约 60 万参数，单次 forward 在 CPU 上 < 1 ms。
- 视角增量（yaw/pitch）交给控制器做对准，模型只学「什么时候转、转多少去躲」。

---

## 7. 已知限制

- `mc_lite` 不模拟配方、掉落、经验、方块放置——它只够训反射。
- 仿真里的碰撞/伤害规则与 1.21.11 必然有出入，**策略必须在真服上复测**。
- 黄金向量只覆盖 14 个手写场景。编码改动如果涉及这些场景之外的分支，
  测试不会报错——所以改编码时宁可多加几个场景。
