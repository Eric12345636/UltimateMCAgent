# UltimateMCAgent

Minecraft Java 版智能体。Python 包是进服客户端；同一仓库里还有让它自己做决定的 CoE 工作区。

## 仓库里有什么

| 路径 | 作用 |
|---|---|
| `src/ultimatemcagent/` | HTTP 客户端与事件总线。登录后连到 `https://mc-api.windywindie.top/api/v1/`。 |
| `mc-agent-api/` | 进服用的 HTTP API，以及进程内的 CoE 控制器（上层规划技能，下层 20Hz 反射）。 |
| `p0/` | 上层用的观测压缩和动作指针。零依赖，离线可测。 |
| `p1/` | 下层反射模型的训练侧（L-obs 编码、轻量仿真、BC / RL、ONNX 导出）。 |
| `COE.md` | 上下层的设计契约。改观测或动作编码之前先读它。 |
| `AGENTS.md` | 工作区约定：命令、接口约束、容易改坏的行为。 |
| `RULES.md` | 挑战赛计分规则。 |
| `agent-api-spec-dist.md` | 已发布的对外 API 快照。 |

`mc-agent-api` 的对外 HTTP 接口与上游 [Zyzzyva0381/mc-agent-api](https://github.com/Zyzzyva0381/mc-agent-api) 保持一致。本地多出来的是 `POST /look` 和 `POST /controller/*`，以及 CoE 内部的挖掘、放置、熔炼实现。

## CoE 怎么分工

上层 LLM 一次排出最多 4 个技能（采集、合成、往下挖、放置、熔炼）。下层只看进程内的 bot，不调用 LLM，也不发 HTTP。两边的观测编码不同：上层用 `p0/`，下层用 `mc-agent-api/src/coe/local.js`，`p1/coe/tokens.py` 必须与它对得上，由 `p1/data/golden_local.json` 锁住。

这套链在真服上从木镐走到石镐，再挖到铁矿、放下熔炉，烧出了 1 个 `iron_ingot`。

## 跑起来

Python 客户端（需要 uv，Python ≥ 3.12）：

```bash
uv sync
uv run ultimatemcagent
```

登录资料放在本机的 `data/login.json`，不要提交。`src/ultimatemcagent/ext_file_ops.py` 从 `DATA_DIR` 读这个文件。

API 与 CoE 控制器（需要 Node.js ≥ 22）：

```bash
cd mc-agent-api
npm install
cp config.example.json config.json
npm start
```

`config.json` 含服务器地址和口令，已在 `.gitignore` 里。离线检查：

```bash
cd mc-agent-api
npm run check
npm test
cd ..
python p1/tests/test_golden.py
cd p0
node --test
```

`p1/runs/` 是训练权重，按 `p1/README.md` 不入库。需要模型时在 `p1/` 里重新训练。
