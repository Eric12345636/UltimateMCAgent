# CoE 架构：链式专家（LLM 上层 + 训练出来的下层反射模型）

> 本文是跨 `mc-agent-api/`（运行侧）、`p1/`（训练侧）的工作区级设计契约。
> 任何一端改动观测编码或动作编码，另一端必须同步，并更新黄金向量测试。

## 0. 决策记录（已确认）

| 项 | 结论 |
|---|---|
| 架构形态 | **Chain of Experts**：不同时间尺度的专家串成一条链，下层把结果回传上层 |
| 低层训练 | **混合**：技能执行用行为克隆（BC，教师=pathfinder），反射/生存用仿真 RL |
| 主仓库 | **允许改动** `mc-agent-api/`，接口/错误码/文档由实现方同步 |
| 上层 LLM | **本地部署**（vLLM / Ollama），决策周期按 0.5–2 s 预算 |

---

## 1. 为什么要分层

现有 `mc-agent-api` 的接口形态是「一个动作 = 一次 HTTP 请求 = 一次动作锁占用」：

- `move_to` 最长占锁 60 s（`session.js:1611`）
- 动作之间**无法交错**：锁在 `http.js:156-165`
- 没有任何流式通道，全部靠轮询

这意味着「受到攻击时立刻后退 0.5 s」这件事，**用现有接口无论多快都做不到**：最快的一次往返也���百毫秒级，而且请求会被动作锁挡成 `busy`。

CoE 的分工就是绕开这个约束：

- **上层专家（LLM）**：慢。负责「做什么」（目标、技能、优先级）。延迟 0.5–2 s 完全可接受。
- **下层专家（训练出来的小模型）**：快。负责「怎么在这一刻动」（每一 tick 按哪个键、往哪看、要不要出手）。**必须**在 100 ms 量级内反应。

下层专家跑在 `mc-agent-api` 进程内（`session.bot` 直接可用），不走 HTTP，因此不受动作锁的往返约束。

---

## 2. 总体架构

```
┌─ 专家 A：LLM（慢，0.5–2 s）─────────────────────────────────┐
│  输入：高层观测 H-obs（p0 压缩态，≈140 token）                │
│        + 事件摘要 + 当前技能状态                              │
│  输出：Skill（技能意图，不是原子 API 调用）                    │
│        { skill: 'gather', target: 'oak_log', count: 8 }        │
└────────────────────────────┬─────────────────────────────────┘
                             │  SkillBus（进程内队列 + 仲裁）
┌────────────────────────────▼─────────────────────────────────┐
│  专家 B：下层反射模型（快，20 Hz，GRU）                        │
│  输入：低层观测 L-obs（≈100 token）+ goal 条件 + 上一动作       │
│  输出：控制向量（移动 9 向 / sprint / jump / sneak / shield /   │
│        attack / use / Δyaw / Δpitch / dig）                    │
│  旁路：规则反射层 v0（Phase 1 基线，后续可替换）                 │
└────────────────────────────┬─────────────────────────────────┘
                             │  bot.setControlState / activateItem / dig
                        mineflayer bot
```

**「链」的闭合靠三件事**：

1. **Skill → goal 编译**：LLM 输出的技能被编译成 goal 条件喂给下层模型，下层模型是 goal-conditioned policy π(a | s, g)。
2. **仲裁**：下层有**否决权**（保命优先），上层有**目标定义权**。下层覆盖时上报 `override` 事件。
3. **反馈**：下层把「受击 / 卡住 / 到达 / 完成 / 失败」写进 `session.events`，上层通过 `/events` 读到并重新规划。

### 2.1 两个子循环

下层不是一个循环，是两个：

| 循环 | 频率 | 负责 | 训练来源 |
|---|---|---|---|
| **task loop**（技能执行） | 事件驱动 | 离散技能步骤：走近 → 对准 → 挖 / 打 / 吃 / 合成 | **行为克隆**（pathfinder 教师） |
| **reflex loop**（反射） | **20 Hz** | 连续控制：往哪走、跳不跳、举不举盾、现在要不要出手 | **仿真 RL** |

两个循环共用同一份 L-obs 编码。reflex loop **随时可以打断** task loop（例如正在挖矿时看见苦力怕贴脸 → 立刻停手后撤）。

---

## 3. 观测契约

**两层必须用两套编码。** 混用会造成 observation aliasing（下层学到了只有上层才有的信息），训推不一致必崩。

### 3.1 H-obs（高层）= 现有 p0 压缩态

`p0/src/compress.js` 的输出（≈138–144 token），**不改动**。上层还需要额外拿到：

- 当前技能状态（`running` / `goal` / `progress`）
- 下层上报的 `override` 原因

### 3.2 L-obs（低层）= 本文件定义的编码契约

**设计原则**：低层只关心几何与威胁，不关心方块名字、不关心背包。
这既是「反应快」的需要（信息少 → 学得快），也是 sim2real 的关键（仿真只需模拟 6 个方块类别，不必复刻 MC 方块注册表）。

#### 方块类别（6 类）

| token | 含义 | 归类规则 |
|---|---|---|
| `air` | 空气 | `name === 'air'` |
| `solid` | 实体 | 默认；含 `dirt/stone/log/ore/glass/...` |
| `pass` | 可穿过 | `type === 'plant'`（草、花、火把、甘蔗） |
| `liq` | 液体 | `water` / `lava` 及其带水/带岩浆变体 |
| `haz` | 危险 | `lava` / `fire` / `magma_block` / `cactus` / `powder_snow` / `campfire` / `soul_fire` |
| `climb` | 可攀爬 | `ladder` / `vine` / `twisting_vines` / `scaffolding` |

> 岩浆同时是 `liq` 和 `haz`：**几何上按 `liq` 处理（要走进去才要游），危险上按 `haz` 处理（要走开）**。实现取 `haz` 优先。

#### 几何探测（8 方向 × 4 格）

方向按 **bot 当前朝向的局部坐标系**：`N, NE, E, SE, S, SW, W, NW`。
每个方向沿水平射线探 4 格，落在**脚部所在 y 层**的方块，得到「地面类别」。

**地面类别（7 类）**——把「表面」和「正下方」合起来，这才是反射策略真正需要的：

| token | 含义 |
|---|---|
| `wall` | 表面是实体，挡路 |
| `flat` | 空且脚下有地 |
| `hole` | 空且脚下没地（会掉下去） |
| `liq` | 水 |
| `haz` | 表面就是危险（岩浆/火） |
| `climb` | 梯子/藤蔓 |
| `magma` | 空但脚下是岩浆 |

另外每个方向再给一个「站立面高度偏移」token（`-3..+3` / `open`），用来判断台阶。

每个方向 7 个 token（`g<i>` + 4 个类别 + `gh<i>` + 高度），8 方向 **56 token**。

#### 自身状态

| 字段 | 分箱 | token 数 |
|---|---|---|
| 血量 | `0 / 1-4 / 5-9 / 10-14 / 15-17 / 18-19 / 20` | 7 |
| 饱食 | `0 / 1-4 / 5-9 / 10-14 / 15-19 / 20` | 7 |
| 氧气 | `0 / 1-5 / 6-10 / 11-20` | 4 |
| 布尔标志 | `on_ground / in_water / in_lava / on_fire / sneaking / sprinting / blocking` | 7 |
| 受伤时长（tick） | `0 / 1-2 / 3-5 / 6-15 / 16+` | 5 |

共 **30 token**。

#### 威胁

最近的敌对实体（16 格内）：

| 字段 | 分箱 | token 数 |
|---|---|---|
| 相对方位（局部系） | 8 向 + `none` | 9 |
| 距离 | `0-2 / 2-4 / 4-8 / 8-16` | 4 |
| 血量比例 | `0-25% / 25-50% / 50-75% / 75-100%` | 4 |
| 前摇（自上次受伤 tick） | 同「受伤时长」 | 5 |

共 **22 token**。没有敌对实体时用 `none` + 距离 `far` 占位。

#### 目标（goal 条件）

| 字段 | 取值 | token 数 |
|---|---|---|
| goal 类型 | `goto / mine / attack / flee / eat / craft / idle` | 7 |
| 目标距离 | `0-1 / 1-2 / 2-4 / 4-8 / 8-16 / 16+ / none` | 7 |
| 目标可见 | 0/1 | 1 |
| 目标类别（挖矿目标） | 6 类 | 6 |
| 目标方位（局部系） | 8 向 + `none` | 9 |

共 **30 token**。

#### 上一动作

| 字段 | 取值 | token 数 |
|---|---|---|
| 移动方向 | 9 向（含 none） | 9 |
| 布尔 | `sprint / jump / sneak / shield / attack / dig` | 6 |

共 **15 token**。

**L-obs 总量 = 88 token**（`self 11 + geom 56 + threat 5 + goal 5 + prev 7` + 4 个段落标记）。

> 下层用 **GRU**（不是 Transformer）：GRU 天然带记忆（FPS 视角看不见背后），逐 token 递推的代价可接受
> （88 步 × GRU(192) ≈ 0.5 ms）。网络结构见 `p1/coe/model.py`。

#### 编码契约的实现位置

| 端 | 文件 | 角色 |
|---|---|---|
| 运行侧（真值） | `mc-agent-api/src/coe/local.js` | 实现编码，产出 token 数组 |
| 词表 | `mc-agent-api/src/coe/local-vocab.json` | 153 个 token，训练侧读同一份 |
| 训练侧 | `p1/coe/tokens.py` | **必须**与 Node 侧逐 token 一致 |
| 黄金向量 | `p1/data/golden_local.json` | 14 个场景，由 Node 侧生成 |

**黄金向量是硬约束**：Node 侧是唯一真值，改了它就重新生成黄金向量；
Python 侧的 `p1/tests/test_golden.py` 会逐 token 比对，不一致就红。

---

## 4. 动作契约

### 4.1 上层输出：Skill

Skill 是**意图**，不是原子调用。LLM 只输出 JSON：

```json
{ "skill": "gather", "target": "oak_log", "count": 8, "reason": "开局缺木头" }
```

**上层观测的呈现形式**（实测见 §5.0）：不要把原始 JSON 丢给 LLM，也不要用 p0 的 `N<id>` 压缩态
（那是给"从零预训的小模型"用的，对通用 LLM 是乱码）。上层要的是**代码算好分类的结构化文本**：

```
状态: 生命 14/20 饱食 13/20 位置[100,12,-50] 夜晚 洞穴 手持stone_pickaxe
威胁等级: 危险（最近敌对实体 zombie 2.5格，正在逼近）      <- 代码算的，不是 LLM 算的
资源: cobblestone 3.6格 / coal_ore 4.6格 / iron_ore 6.2格
背包: cobblestone x34 coal x9 raw_iron x3 torch x32
最近事件: 受到攻击 掉血2
```

Skill 表：

| skill | 参数 | 语义 | 编译出的 goal |
|---|---|---|---|
| `goto` | `x,y,z` | 走到某坐标 | `goto` |
| `gather` | `target`(方块名), `count` | 采集 N 个某类方块 | `mine`（先 goto 再 mine） |
| `mine` | `target`, `count` | 同上，别名 | `mine` |
| `attack` | `entity_id` | 攻击某实体 | `attack` |
| `flee` | `from`(可选) | 逃离威胁 | `flee` |
| `eat` | — | 进食 | `eat` |
| `craft` | `item`, `count` | 合成 | `craft` |
| `equip` | `item` | 换装备 | `idle`（瞬时） |
| `wait` | `ms` | 等待 | `idle` |
| `chat` | `message` | 说话 | `idle`（瞬时） |

**LLM 不得直接调用 `move_to` / `dig` / `attack` 这些原子端点**——它们会产生秒级到分钟级的锁占用，把下层专家彻底挤出回路。原子端点保留给「纯 HTTP 客户端」模式和调试。

### 4.2 下层输出：控制向量

离散化动作（20 Hz 一次）：

| 字段 | 取值 |
|---|---|
| `move` | 9 向（局部系：N/NE/E/SE/S/SW/W/NW/none） |
| `sprint` | 0/1 |
| `jump` | 0/1 |
| `sneak` | 0/1 |
| `shield` | 0/1（`activateItem`） |
| `attack` | 0/1（冷却允许时触发） |
| `use` | 0/1 |
| `yaw_delta` | 9 箱，−2.0 … +2.0 rad，步长 0.5 |
| `pitch_delta` | 5 箱，−1.0 … +1.0 rad，步长 0.5 |
| `dig` | 0/1（边沿触发：0→1 开始挖，1→0 停止） |

多头分类实现（`move` / `yaw` / `pitch` 各一个头，其余是独立 sigmoid 头）。

### 4.3 连续量与离散的分工

**对准目标（look-at）由控制器做，不交给模型。** 原因：正对着方块挖是确定性任务，让模型学只会浪费容量并引入抖动。模型负责「什么时候转、转多少去躲/去看别处」。

同理，`move` 输出在**局部系**（相对当前 yaw），控制器负责换算成 WASD 组合。

---

## 5. 仲裁与抢占

### 5.0 上层 LLM 的选型与实测（重要）

**选型**：基座 `qwen2.5:7b`，决策名字 `qwen2.5-mc:7b`（`src/coe/Modelfile`，Ollama 0.40.16，RTX 5060 Laptop 8GB）。下面的延迟数字是在基座上测的。
8GB 显存决定了上限：7B 的 Q4 是 4.8GB，留约 3GB 给 KV cache；14B（Q4 约 9GB）放不下。
实测用 `src/coe/llm-probe.js` / `src/coe/llm-e2e.js` 跑，结论如下。

| 结论 | 证据 |
|---|---|
| **结构化输出完全可用** | Ollama 的 `format` 传 JSON Schema（支持 `oneOf`），输出**恒为合法技能数组**。用 `oneOf` 逐技能精确约束后，模型不再产出 `flee 带 distance` 这类垃圾。 |
| **热延迟够用** | 0.6–1.4 s / 次（26–53 token，≈40 tok/s）。符合 0.5–2 s 的决策预算。 |
| **冷启动很贵** | 首次 52 s（模型加载进显存）。必须 `keep_alive: '30m'` 常驻。 |
| **并发是串行的** | `num_parallel=1` 时 N 个请求就是 N 倍时间。`num_parallel=2` 后 2 个并发 ≈ 单次延迟。 |
| **7B 不会稳定执行数值阈值** | 提示词里写"距离小于 4 格就 flee"，模型时而无视、时而过度反应。 |
| **7B 会把 `wait`/`flee` 当拖延口** | 第一版提示词下输出了 `flee` + `wait 5000ms`。已在 `validateSkill` 里把 `wait` 封顶到 2 s。 |
| **7B 会照抄观测里的字样** | 观测写 `zombie#812`，它就输出 `entity: "zombie#812"`。解析器必须容错多种写法。 |

**由此得出的设计约束（比"选哪个模型"重要得多）**：

1. **算术留在代码里**。上层观测里不写"距离 4.6 格"，写**代码算好的分类标签**：
   `威胁等级: 安全 / 警戒 / 危险`。LLM 只做「标签 → 技能」的语义映射，不做阈值判断。
2. **安全不交给 LLM**。实测它会无视"危险 → flee"而选择 `attack`。
   所以：**威胁等级只是给 LLM 的建议，权威判定在代码**——
   `Planner.arrange()` 会把 `flee` 强制排到第一位（危险时模型没提就补一个），
   下层的 reflex loop + `override` 是第二道防线。LLM 提了个危险技能被下层否决，
   这是设计内的正常路径，不是异常。
3. **技能按名字引用，不按 id**。LLM 的观测里只有名字，给它 id 它就会瞎编。
   `attack` 用 `entity: "zombie"`，代码再解析成 `entity_id`（解析器认
   `"zombie"` / `"zombie#812"` / `"812"` 三种写法）。
4. **观测渲染是上层的核心资产**。同一个模型、同一套技能，换一种观测呈现，
   决策质量差别很大。观测渲染器（原始 JSON → 结构化分类文本）比提示词更值得投入。

### 5.0.1 本机 Ollama 配置（已配好）

KV cache 预算 ≈ `n_ctx × num_parallel`，**16k 是这台 8GB 机器能保住 100% GPU 的上限**：

| 配置 | 结果 |
|---|---|
| `32768 × 1` | 9% 掉 CPU ❌ |
| `16384 × 1` | 100% GPU，但请求串行 |
| `16384 × 2` | 29% 掉 CPU ❌ |
| **`8192 × 2`** | **100% GPU，2 个并发 ≈ 单次延迟** ✅ |

最终落地：

| 环境变量 | 值 |
|---|---|
| `OLLAMA_CONTEXT_LENGTH` | `8192` |
| `OLLAMA_NUM_PARALLEL` | `2` |
| `OLLAMA_MAX_LOADED_MODELS` | `1` |
| `OLLAMA_KEEP_ALIVE` | `30m` |
| `OLLAMA_HOST` | `127.0.0.1:11434` |

外加：计划任务 `Ollama`（登录时启动 `ollama app.exe`，开机自启）、
agent 侧的 `src/coe/llm.js`（raw http，不引入 npm 包）。

> 环境变量是**用户级**持久化的，但 `Start-Process` 继承的是**当前进程**的环境，
> 不是刚写进注册表的——改了之后必须重启 Ollama 进程才生效（tray app 也要重启，
> 因为 `ollama serve` 是它的子进程）。

### 5.1 动作锁的重新定义

现状：`session.busy` = 「谁在驱动 bot」。CoE 下必须区分驱动者：

```js
session.busy = { name, t, owner }   // owner: 'http' | 'controller'
```

- HTTP 接管时释放反射层拥有的按键。HTTP 持锁期间，反射循环让位，教师录制可以读取实际按键。
- 下层 task loop 执行技能时 → `owner: 'controller'`，外部 HTTP 动作拿到 `busy`。
- 下层 reflex loop **不持锁**（它每 tick 都在动），它只通过「抢占」影响 task loop。

### 5.2 抢占规则

| 触发 | 动作 |
|---|---|
| `hurt` 事件 | 现有 `session.interrupt('hurt')` 会打断持锁动作（`session.js:93-102`）——**下层复用它**，不需要新机制 |
| reflex 判定「保命优先」（岩浆/坠落/贴身敌对） | 停掉当前 task step（`stopDigging`、取消 pathfinder goal），切 goal 到 `flee`，上报 `override` |
| 上层下发紧急 Skill | task loop 取消当前 step，清理后执行紧急技能 |
| `death` | 一切停摆，等 respawn |

**reflex 的否决权是硬性的**：一旦判定保命，上层后续 2 s 内的普通技能不生效，直到危险解除。

### 5.3 事件契约

下层向上层上报的事件（走现有 `session.pushEvent` → `/events` 通道）：

| 事件 | 字段 | 含义 |
|---|---|---|
| `skill_start` | `skill`, `args` | 开始执行技能 |
| `skill_done` | `skill`, `ms` | 技能完成 |
| `skill_failed` | `skill`, `reason` | 技能失败 |
| `override` | `reason`, `from_skill` | reflex 覆盖了上层意图（`reason` ∈ `lava/falling/threat/low_air/low_hp`） |
| `stuck` | `ms`, `pos` | 连续 N tick 位移不足 |
| `threat` | `name`, `dist`, `hp` | 检测到敌对实体（供上层决策是否交战） |

事件字段表 `p0/src/format.js` 的 `EVENT_FIELDS` **必须同步新增这 6 类**，否则高层压缩观测里会丢字段。

---

## 6. 代码结构

```
D:\MC agent\
├── COE.md                      # 本文件
├── mc-agent-api/               # 运行侧（git repo）
│   ├── src/coe/
│   │   ├── local.js            # L-obs 编码（训练/运行契约的真值）
│   │   ├── local-vocab.json    # 153 个 token 的词表
│   │   ├── skills.js           # Skill 表 + goal 编译器
│   │   ├── policy.js           # 反射策略：规则 v0 + ONNX 推理
│   │   ├── controller.js       # 20 Hz 循环 + task loop + 仲裁 + telemetry
│   │   ├── skillbus.js         # 技能队列（替换/截止/优先级）
│   │   ├── record.js           # BC 数据录制器（JSONL）
│   │   ├── build-vocab.js      # 重新生成 local-vocab.json
│   │   ├── build-golden.js     # 生成 p1/data/golden_local.json
│   │   └── index.js            # 对外入口 + configure
│   ├── src/session.js          # + controller 挂载点、owner 锁、事件类型
│   ├── src/http.js             # + controller_* 端点、owner 标记
│   ├── test/coe.test.js        # 单元测试（node --test，全离线）
│   └── docs/API.md             # 同步接口文档 / 错误码表 / 版本历史
├── p0/                         # 已有的高层表示层（token 压缩 + 指针）
└── p1/                         # 训练侧（Python，与 p0 平级）
    ├── coe/
    │   ├── tokens.py            # L-obs 编码（必须与 Node 侧一致）
    │   ├── model.py             # GRU 策略网络 + 价值头
    │   └── export_onnx.py       # 导出 ONNX + 词表
    ├── envs/mc_lite.py          # 极简体素仿真（只仿 8 个机制）
    ├── data/golden_local.json   # 黄金向量（Node 侧生成，Python 侧回归）
    ├── data/episodes/           # BC 录制数据（JSONL）
    ├── tests/test_golden.py     # 编码一致性回归
    ├── train_bc.py              # 行为克隆（技能执行器）
    └── train_rl.py              # A2C（反射策略）
```

### 6.1 新增 HTTP 端点

| 端点 | 锁 | 说明 |
|---|---|---|
| `POST /api/v1/controller/attach` | 只读 | 装上下层控制器 |
| `POST /api/v1/controller/detach` | 只读 | 卸下控制器 |
| `POST /api/v1/controller/submit` | 只读（自己查 `busy`） | 提交 Skill |
| `GET /api/v1/controller/state` | 只读 | 当前技能 / goal / reflex 状态 |
| `GET /api/v1/controller/telemetry` | 只读 | 决策频率、平均决策耗时、override 次数 |

> `controller/*` 都不进 HTTP 动作锁：锁的占有由 controller 自己管理（`owner='controller'`），
> 外部动作在 controller 跑技能时照常拿到 `busy`。

### 6.2 常用命令

```bash
# 运行侧
cd mc-agent-api
npm run check          # 语法检查（唯一原有的自动检查）
npm test               # 单元测试（node --test，全离线）
node src/coe/build-vocab.js    # 重新生成 L-obs 词表
node src/coe/build-golden.js   # 重新生成黄金向量

# 训练侧
cd p1
python tests/test_golden.py    # 编码一致性回归（必须先过）
python train_rl.py --episodes 4000 --goal flee --out runs/rl
python coe/export_onnx.py --ckpt runs/rl/reflex_policy.pt --out runs/rl/model.onnx
```

---

## 7. 训练方案

### 7.1 技能执行器（BC）

- **教师**：pathfinder。`canDig=false`，跑 `move_to` 时 pathfinder 每 tick 都在算方向与视角 → **标签天然免费**。
- **采样**：`mc-agent-api/src/coe/record.js` 挂在 `physicsTick` 上，记录 (L-obs, 动作)。
  HTTP `move_to` 提供教师目标。录制器把 `action_t` 配给 `obs_{t-1}`，动作切换时清空待配对帧。
  配错一步模型就学歪，这是 BC 最容易踩的坑。
- **补齐非移动技能**：`dig` / `attack` / `eat` 用脚本化教师补录（对准→开始→保持→停止），标签同样确定。
- **数据量**：单次 `move_to` 数百 tick，一个 episode 数千样本，几百 episode → 百万级。
- **训法**：`p1/train_bc.py`，GRU + 多头 CE/BCE。目标是复现 pathfinder 的行为，不是超越它。
- **学的头**：`move`（9 分类）、`jump`、`sprint`。其余头留给反射策略和后续的技能专用数据。

### 7.2 反射策略（仿真 RL）

**为什么不直接真服 RL**：20 Hz × 分钟级 episode，样本效率极低；MC 无回滚，重来成本高；且真服 1.21.11 的伤害/碰撞细节难复刻。

**仿真只仿 8 个机制**：重力与落地、方块碰撞（7 类地面）、岩浆/火伤害、坠落伤害、攻击冷却与伤害、实体追击、氧气/溺水、液体减速。

**关键约束**：仿真的 L-obs 编码必须与 `local.js` **逐 token 一致** → 用黄金向量做回归测试（`p1/tests/test_golden.py`）。

**reward**（只做反射，不做任务）：

```
r = -0.05（每 tick）
  - 1.0 × 掉血量
  - 0.5（受伤额外惩罚）
  + 5.0 × 进展（逃跑用敌我距离增加量，寻路用目标距离缩短量）
  - 10（死亡）
```

**算法**：A2C（策略梯度 + 价值基线 + 熵正则），GAE(λ=0.95)，见 `p1/train_rl.py`。
CPU 吞吐约 1.5 s/episode（200 tick）。

**真服阶段**：用同一套 reward 在真服上做少量 PPO 微调 + **作为唯一评测场**（仿真只当数据生成器）。

### 7.3 部署

训练在 Python，导出 **ONNX**，运行侧用 `onnxruntime-node` 推理：

- 模型接口：`ids` int64 `(1, 88*K)` → `move`/`yaw`/`pitch`/`bin` logits
- 目标单次 forward **< 1 ms**（GRU(192)，88 token）
- 进程内推理，无跨进程往返
- `onnxruntime-node` 是 mc-agent-api 的 **optionalDependency**（装不上也不影响 `policy: "rule"`）

---

## 8. 指标

| 指标 | 定义 | 目标 |
|---|---|---|
| **反应延迟** | 危险信号出现 → reflex loop 产出第一个规避动作的 tick 数 | **≤ 2 tick（100 ms）** |
| 技能完成率 | task loop 完成 / 发起 | vs pathfinder 基线 |
| 技能耗时 | goto/mine 的完成时间 | vs pathfinder 基线 |
| override 率 | 触发否决的次数 / 技能次数 | 越低越好（说明上层计划更准） |
| 上层重规划次数 | LLM 重新下发 Skill 的次数 | 下降 |

**反应延迟是整个 CoE 的核心卖点**：LLM 路线做不到 100 ms 级，这是分层的收益本身。

---

## 9. 阶段路线

| Phase | 内容 | 状态 |
|---|---|---|
| **0** | `src/coe/` 骨架：L-obs 编码、Skill 编译、规则 reflex v0、controller 循环、SkillBus、`controller_*` 端点、事件类型、黄金向量 | ✅ 已完成 |
| **1** | 规则反射层标定 + telemetry 跑真服 | ⏳ 需要真服（测反应延迟基线） |
| **2** | BC 训技能执行器 → ONNX → Node 部署 | ⏳ 需要真服录制数据 |
| **3** | 仿真 RL 训反射 → sim2real | ⏳ 训练脚本就绪，需真服复测 |
| **4** | LLM（本地 vLLM/Ollama）接 SkillBus | ⏳ 接口就绪 |

**Phase 1 必须先做**：没有规则基线，训练完的模型无法判断好坏。

> **环境限制**：当前机器的 npm registry 不可达，`npm install` 装不上 mineflayer，
> 所以 Phase 1/2 的真机验证还没做（代码按 mineflayer 4.39 的 API 写，`npm run check` 与单测都过）。

---

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 动作锁语义没理清 → 高低层打架 | Phase 0 就把 `owner` 和让位规则定死并写测试 |
| 高层观测混入低层 → observation aliasing | 两套编码；L-obs 不含名字与背包；黄金向量回归 |
| sim2real gap | 仿真只当数据生成器；评测只在真服做；观测编码对齐 |
| 事件字段表是手写的，漏加类型 → 信息丢失 | 加事件必须同步 `p0/src/format.js` 的 `EVENT_FIELDS` |
| LLM 被塞进反射回路 | Skill 表里没有任何「即时反应」类技能；reflex 永不查 LLM |
| 规则层和训练模型同时输出 → 打架 | Phase 3 用模型**替换**规则，不是叠加；模型不可用时回落到规则 |

---

## 11. 相关文档

- 接口规范（仓库内真值）：`mc-agent-api/docs/API.md`
- 对外发布副本：`agent-api-spec-dist.md`（**改动前需与使用者确认**）
- 高层表示层：`p0/README.md`
- 工作区约定：`AGENTS.md`
