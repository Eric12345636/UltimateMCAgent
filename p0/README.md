# p0 — 状态层（压缩器 + 指针层）

把 `mc-agent-api` 的原始响应压成**紧凑 token**，把动作参数编成**候选指针**，
让"从零预训练一个小模型来做 Minecraft 决策"这件事在数据上成立。

P0 是整个训练方案的地基：表示设计错了，后面（合成数据、RL、技能库）全部白做。
本阶段**完全离线**，不需要 Minecraft 服务端。

---

## 它解决什么问题

| | 原始 API 响应 | P0 压缩后 |
|---|---|---|
| 一个观测步 | ~1500–2500 token（原始 JSON） | **138–144 token** |
| 坐标 | 由模型自由生成 → 幻觉 | 指向观测里的候选（`b3`） |
| 动作参数 | 散落在 JSON 里 | 紧凑定长布局 |

两个可验证的指标：

- **token 预算**：单步 ≤ 320（实测 138–144）
- **指针保真度**：教师真实调用 → 指针 → 还原后的 HTTP 请求，**100% 一致**（夹具上已验证）

---

## 目录

```
p0/
├── data/vocab.json          名字词表（2090 条，由 minecraft-data 1.21.11 生成）
├── src/
│   ├── index.js             对外入口
│   ├── observe.js           原始响应 → 规范化观测（候选表按距离排序，下标稳定）
│   ├── compress.js          观测 → 紧凑 token
│   ├── pointer.js           动作参数 ⇄ 指针（双向）
│   ├── verbs.js             动作原语表（每个动词对应一个 API 端点）
│   ├── vocab.js             名字 ⇄ N<id>
│   └── format.js            token 格式常量
├── fixtures/scenarios.json  夹具（形状对齐 docs/API.md 的响应示例）
├── test/                    node:test，19 个用例
└── tools/
    ├── build-vocab.js       重新生成词表
    └── demo.js              打印压缩结果 + 往返对照
```

## 跑

```bash
node --test          # 19 个用例，全离线
node tools/demo.js          # 看压缩结果和指针往返
node tools/demo.js forest   # 只看某个场景
```

---

## token 格式

```
<s>
pos x y z | yaw | dim | gm | hp | food | sat | xp lv pr | arm | oxy
held | off | snk shd jmp | fire wat sub lava | ride
time | day | rain | biome | alive ready busy | near
eff ...             药水效果
inv name cnt ...    背包
blk i name x y z dist [prop k v ...]
ent i name id x y z dist [hp n]
ev type v...        最近事件
</s>
```

规则：

- **名字**统一是 `N<id>`（`N1192` = `oak_log`），词表里没有的走 `X<原文>`，不丢信息
- **数字**单独成 token；小数保留 3 位（yaw/pitch 是 2 位精度，压到 1 位会丢信息）
- **候选下标**从 0 连续编号，按距离升序 → 指针和下标永远对得上
- 段落可单独关（`includeEntities` / `includeInventory` / …），方便做消融

## 指针语法

```
<a> dig t b1 </a>                       挖第 1 个候选方块
<a> move_to t px 10 17 </a>             只走水平坐标（语义 ≠ 带 y 的移动）
<a> attack t e1 max_hits 1 </a>         打第 1 个候选实体
<a> place t b0 item N403 </a>           在第 0 个候选方块处放 crafting_table
<a> use_item t b4 item N1192 </a>       对着第 4 个候选方块使用 oak_log
<a> craft item N403 count 1 </a>        合成 crafting_table
<a> chat msg Hello_world! </a>
```

| 记号 | 含义 |
|---|---|
| `b<i>` | 第 i 个候选方块 → 位置从 `obs.blocks[i].pos` 取 |
| `e<i>` | 第 i 个候选实体 → id 从 `obs.entities[i].id` 取 |
| `p x y z` | 字面坐标 |
| `px x z` | 字面水平坐标（`move_to` 省略 y 时**必须**用这个，和给 y 语义不同） |
| `q <id>` | 字面实体 id |

---

## 三个关键设计决策

### 1. 「操作对象」必须用指针，「目的地」可以写字面坐标

- `dig` / `place` / `interact` 作用于某个方块 → 目标必须在候选表里，否则编码失败。
  模型看不见的目标它学不会，也不该被当成可学的样本。
- `move_to` / `look` / `shoot` / `use_item` 的落点是"目的地" → 允许字面坐标。
  它是从观测里抄来的，不是凭空编的。

这条分界由 `verbs.js` 里的 `literalOk` 控制。

### 2. 严格 / 宽松双模式，两个不同的指标

| 模式 | 用途 | 指标含义 |
|---|---|---|
| `strict: true`（默认，给数据集打标签） | 目标必须在候选表里 | **可达率** —— 模型学不学得会 |
| `strict: false` | 允许字面回退 | **可表达率** —— 语法上说不说得了 |

`fidelity(cases, obs)` 同时返回两个比率和失败清单。

### 3. 语义归一后再比较请求

`posture` 是"全量设置"语义（没写的字段就是 false），所以 `{sneak:true}` 和
`{sneak:true,shield:false,jump:false}` 是同一个意思。编码时只写 `true` 的开关，
比对前先 `normalizeBody` 归一。

---

## 接下来怎么接真服

P0 的输入目前是夹具。接上真实服务端后，流程是：

```js
// 1) 采一组感知
const obs = buildObservation({
  status:    (await call('status')).result,
  inventory: (await call('inventory')).result,
  findBlocks:(await call('find_blocks', { types: BLOCK_TYPES, radius: 32, limit: 20 })).result,
  entities:  (await call('get_entities', { radius: 32 })).result,
  events:    (await call('events', { since: lastSeq, limit: 50 })).result
})

// 2) 教师调用 → 指针标签
const enc = encodeAction(call.verb, call.args, obs, { strict: true })
if (enc.ok) samples.push({ obs: compress(obs).tokens, act: enc.tokens })

// 3) 推理时反向
const dec = decodeAction(modelOutput, obs)
await call(dec.verb, dec.args)
```

**关键未知量**：`find_blocks` 要查哪些 `types`。查少了 → 教师挖的方块不在候选表 → 指针编不出来 → 可达率掉。
这就是"观测策略"需要和任务课程一起设计的原因。生存采集链第一版建议：
`['oak_log','oak_planks','crafting_table','stone','cobblestone','coal_ore','iron_ore','dirt']`。

---

## 已知限制 / 待办

- **动作集是 P0 的最小集**：`window_view` / `window_act` / `shoot` 的细节、`stop` / `connect` 之类
  属于 harness 权限，都没进模型的动作空间
- **`chat` 文本**走 `msg <下划线连接的文本>`，只保 48 字符；真要训 chat 行为得单独设计
- **词表是 1.21.11 快照**，换版本要重新生成；且 `minecraft-data` 的 `recipes` 是新格式，
  配方表不能用它直接导出，得从服务器的 `recipe_book_add` 拿（见 P1）
- **事件字段表是手写的**，服务器加了新事件类型要同步 `format.js`
- 还没做：**跨步上下文**（历史观测怎么拼）、**tokenizer**（现在是裸 token 数组，
  后面要决定是直接 softmax 还是训 BPE）、**数据集导出格式**
