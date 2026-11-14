# mc-agent-api

让 AI agent 通过 HTTP 玩 Minecraft Java 版。每次登录在服务端起一个独立的 [mineflayer](https://github.com/PrismarineJS/mineflayer) bot，agent 用一组 JSON 接口观察世界（状态、背包、方块、实体、事件流、advancement）并执行动作（寻路、挖掘、放置、合成、攻击、射击、使用物品、骑乘掌舵、GUI 操作……）。

- 接口规范：[docs/API.md](docs/API.md)
- 对接自己的服务器（认证 / 代理网络）：[docs/ADAPTERS.md](docs/ADAPTERS.md)
- 真机验收脚本：[test/live_test.py](test/live_test.py)
- Minecraft Agent 挑战赛初赛规则（草案）：[docs/RULES.md](docs/RULES.md)

> 目前只在 **Minecraft Java 1.21.11**（Leaves 服务端，Velocity 代理）上完整验证过：`yggdrasil` 认证 + `proxy` 就绪判定的组合跑通了全部 31 项真机验收。`offline` + `direct` 的组合还没有在真机上单独跑过完整回归，遇到问题欢迎提 issue。代码里有若干针对 1.21.x 协议的修补，其它版本可以在 `minecraft.version` 里改，但不保证可用。

## 快速开始

需要 Node.js ≥ 22，以及一台你有权限的 Minecraft 服务器。

```bash
git clone https://github.com/Zyzzyva0381/mc-agent-api.git
cd mc-agent-api
npm install
cp config.example.json config.json   # 按需修改
npm start
```

默认配置连接本机 `127.0.0.1:25565` 的**离线模式**服务器（`server.properties` 里 `online-mode=false`），API 监听 `127.0.0.1:18900`。

```bash
# 登录：offline 模式下 username 就是 bot 的角色名，password 是 config.json 里的共享口令
TOKEN=$(curl -s -X POST http://127.0.0.1:18900/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"Agent_1","password":"change-me"}' | jq -r .token)

# 等 ready=true 后就可以调动作接口
curl -s http://127.0.0.1:18900/api/v1/status -H "Authorization: Bearer $TOKEN"
curl -s -X POST http://127.0.0.1:18900/api/v1/move_to \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"x": 10, "y": 64, "z": 10}'
```

## 配置

`config.json`（路径也可以用命令行第一个参数或环境变量 `MC_AGENT_CONFIG` 指定）：

| 键 | 默认 | 说明 |
|---|---|---|
| `http.host` / `http.port` | `127.0.0.1` / `18900` | API 监听地址。环境变量 `MC_AGENT_PORT` 可覆盖端口 |
| `http.trustProxyHeaders` | `false` | 部署在反向代理 / Cloudflare Tunnel 后面时打开，登录限流按 `CF-Connecting-IP` / `X-Forwarded-For` 识别客户端 |
| `http.loginRateLimit` | 10 次失败 / 60 s 锁定 / 全局 60 次每分钟 | `maxFailsPerIp`、`blockSeconds`、`maxGlobalPerMinute` |
| `minecraft.host` / `port` / `version` | `127.0.0.1` / `25565` / `1.21.11` | bot 连接的服务器 |
| `session.tokenTtlHours` | `24` | token 有效期 |
| `auth` | `{"type": "offline"}` | 认证适配器，见下 |
| `readiness` | `{"type": "direct"}` | 就绪判定适配器，见下 |
| `coe` | `{"enabled": false}` | CoE 下层控制器，见下 |

### 认证（`auth`）

| `type` | 适用 | 参数 |
|---|---|---|
| `offline` | 离线模式服务器 | `password`：所有账号共用的 API 口令（**强烈建议设置**，否则任何能访问 API 的人都能刷 bot）；`allowedUsernames`：可选白名单 |
| `yggdrasil` | authlib-injector 外置登录（Blessing Skin 等皮肤站） | `authServer`、`sessionServer`；`hosts`：可选的静态解析（皮肤站在内网时） |

正版（Microsoft）登录需要交互式设备码流程，不适合"HTTP 账号密码换 token"的模型，目前没有内置；可以按 [docs/ADAPTERS.md](docs/ADAPTERS.md) 自己写一个认证适配器。

### 就绪判定（`readiness`）

`status.ready` 为 `true` 之前，动作接口一律返回 `wrong_server`。

| `type` | 适用 | 参数 |
|---|---|---|
| `direct` | 直连单个服务器 | 无。出生即就绪 |
| `proxy` | Velocity / BungeeCord 代理网络 | `server`（必填，`/server` 后面的后端名）、`minAdvancements`（默认 20）、`rcon`（可选：后端 RCON，用玩家列表做权威的在场确认） |

完整示例见 [examples/config.yggdrasil-proxy.json](examples/config.yggdrasil-proxy.json)。

### CoE（链式专家）

把决策拆成两层：**上层 LLM 下发技能（意图），下层反射策略在 20Hz 逐 tick 输出控制向量**。
下层控制器跑在本进程内，直接持有 bot，**不走 HTTP**，所以能在 100ms 量级做出反应——
这是纯 HTTP 方案做不到的（动作锁 + 往返延迟）。设计与接口见工作区的 `COE.md` 与 [docs/API.md §4.18](docs/API.md)。

| 键 | 默认 | 说明 |
|---|---|---|
| `coe.enabled` | `false` | 登录后自动装上下层控制器 |
| `coe.policy` | `rule` | `rule` = 规则基线；`onnx` = 加载训练好的模型 |
| `coe.modelPath` | `null` | ONNX 模型路径（`policy: "onnx"` 时必填） |
| `coe.vocabPath` | `null` | L-obs 词表路径，默认用内置的 `src/coe/local-vocab.json` |
| `coe.queueSize` | `4` | 待执行技能队列长度 |
| `coe.llm.enabled` | `false` | 启用上层 LLM（本地 Ollama） |
| `coe.llm.endpoint` | `http://127.0.0.1:11434` | Ollama 地址 |
| `coe.llm.model` | `qwen2.5-mc:7b` | 决策模型名。基座是 `qwen2.5:7b`，用 `src/coe/Modelfile` 另注册，不覆盖基座 |
| `coe.llm.keepAlive` | `30m` | 模型在显存里待多久（避免 50s 的冷启动重载） |
| `coe.llm.timeoutMs` | `8000` | 单次调用超时 |
| `coe.llm.maxSkills` | `2` | 一次最多接受几个技能 |

手动装载用 `POST /api/v1/controller/attach`，下发技能用 `POST /api/v1/controller/submit`，
让 LLM 规划一次用 `POST /api/v1/controller/plan`，
读运行指标用 `GET /api/v1/controller/telemetry`。

#### 上层 LLM（本地 Ollama）

需要本机跑着 Ollama。**不要用 `ollama run` 交互式命令**，用 HTTP API（`/api/chat`）——
只有它支持传 JSON Schema 做结构化约束解码，模型输出恒为合法技能数组。

```bash
ollama pull qwen2.5:7b
ollama create qwen2.5-mc:7b -f src/coe/Modelfile
ollama ps          # 确认 CONTEXT / PROCESSOR
```

这台机器（RTX 5060 Laptop 8GB）实测下来的配置：

| 环境变量 | 值 | 为什么 |
|---|---|---|
| `OLLAMA_CONTEXT_LENGTH` | `8192` | KV cache 预算 ≈ `n_ctx × num_parallel`，16k 才能保住 100% GPU |
| `OLLAMA_NUM_PARALLEL` | `2` | 2 个并发决策几乎不增加单次延迟 |
| `OLLAMA_MAX_LOADED_MODELS` | `1` | 8GB 装不下两个 4.8GB 的模型 |
| `OLLAMA_KEEP_ALIVE` | `30m` | 否则 5 分钟后卸载，再决策要等 50s 冷启动 |

> `n_ctx=32768` 能加载，但会有 29% 的层掉到 CPU，推理会明显变慢。
> `n_ctx=16384` + `num_parallel=2` 同样会掉 CPU。**8192×2 是这台机器的甜点**。

多 bot 共用同一个模型时请求会串行排队（`num_parallel=2` 就是 2 个槽位）。

## 安全提示

- API 本身是明文 HTTP。对公网开放时请放在 HTTPS 反向代理后面，并打开 `http.trustProxyHeaders`。
- 每个 token 对应一个真实进服的 bot；离线模式下务必设置 `auth.password`。
- bot 能做的事情和普通玩家一样，服务器的反作弊 / 权限设置照常生效。

## 参赛入口

`npm run compete -- examples/competition.config.json` 通过公布的赛事 API 跑初赛路线。配置和计分说明见 [初赛 Agent](docs/COMPETITION.md)。

## 测试

单元测试（离线，不需要 Minecraft 服务器）：

```bash
npm test        # CoE 和初赛 Agent 的离线回归
npm run check   # 语法检查
```

真机验收（31 项）：[test/live_test.py](test/live_test.py) 是一套真机验收：用 RCON 在测试服上布置场景，再通过 HTTP 驱动 bot 逐项断言。**只能对专门的测试服跑**——它会 fill 方块、清实体、改难度和时间。

```bash
export MC_AGENT_API=http://127.0.0.1:18900/api/v1 MC_AGENT_USER=Agent_1 MC_AGENT_PASSWORD=change-me
export RCON_HOST=127.0.0.1 RCON_PORT=25575 RCON_PASSWORD=...
python3 test/live_test.py all
```

## 协议

[MIT](LICENSE)
