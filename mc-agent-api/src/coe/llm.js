'use strict'
// Ollama 客户端 + 上层决策器。
//
// 刻意**不引入 npm 包**：仓库的依赖能少就少（onnxruntime-node 也是 optional），
// 而且本机 HTTP API 就一个 POST，raw http 完全够用。
//
// 关键行为：
//   - 结构化输出：format 传 JSON Schema，模型输出**恒为合法技能数组**
//   - keep_alive：默认 30m，避免 52s 的冷启动重载
//   - 超时/失败**不抛给上层**：LLM 挂了就不下发技能，下层继续跑当前技能
//     （安全判定本来就在下层，上层挂掉不会让 bot 乱跑）
//
// 依据：COE.md §5.0 的实测结论。

const http = require('http')
const https = require('https')
const { URL } = require('url')
const { renderObservation, classifyThreat } = require('./render')
const { parseSkills } = require('./skills')

// 技能 JSON Schema：交给 Ollama 的 format 做约束解码。
//
// 用 oneOf 逐技能精确约束（实测 Ollama 0.40 支持），这样模型不会产出
// 「attack 带个 distance」「flee 带个奇怪的字段」这种垃圾。
//
// 关键设计：attack 按**实体名**引用（entity），不按 id ——
// LLM 的观测里只有名字，给它 id 它就会瞎编。名字 → id 的解析在代码里做。
function buildSkillSchema () {
  const obj = (props, required) => ({
    type: 'object',
    properties: props,
    required: required || [],
    additionalProperties: false
  })
  const skill = (name, argsProps, argsRequired) => ({
    type: 'object',
    properties: {
      skill: { const: name },
      args: obj(argsProps || {}, argsRequired || []),
      reason: { type: 'string' }
    },
    required: ['skill', 'args'],
    additionalProperties: false
  })
  const num = { type: 'number' }
  const int = { type: 'integer' }
  const str = { type: 'string' }
  return {
    type: 'array',
    items: {
      oneOf: [
        skill('goto', { x: num, y: num, z: num }, ['x', 'y', 'z']),
        skill('gather', { target: str, count: int, down: { type: 'boolean' }, ahead: { type: 'boolean' } }, ['target']),
        skill('mine', { target: str, count: int, down: { type: 'boolean' }, ahead: { type: 'boolean' } }, ['target']),
        skill('attack', { entity: str }, ['entity']),
        skill('flee', {}),
        skill('eat', {}),
        skill('craft', { item: str, count: int }, ['item']),
        skill('place', { item: str }, ['item']),
        skill('smelt', { item: str, count: int }, ['item']),
        skill('equip', { item: str }, ['item']),
        skill('chat', { message: str }, ['message'])
      ]
    }
  }
}

// 上层**故意不给** wait 技能：
// "现在没事做"的正确表达是**不下发任何技能**（下层继续跑当前技能），
// 而不是让上层空转一秒。实测模型会拿 wait 当填充物（评测里 no_stall 是最高频的失败规则）。
// wait 技能本身还在，留给手动 POST /controller/submit 用。

const DEFAULT_SYSTEM_PROMPT = [
  '你是 Minecraft Java 版生存 agent 的上层决策器。最终目标：获得至少 1 个 iron_ingot。不要做与这个目标无关的事。',
  '只输出 JSON 数组，不要解释。',
  '可用技能：',
  '  goto(x,y,z) 走到坐标；gather(target,count) 采集方块；mine(target,count) 挖方块，down 为 true 时往脚下挖，ahead 为 true 时向前挖；',
  '  attack(entity) 攻击实体（用实体名）；flee 逃离威胁；eat 进食；',
  '  craft(item,count) 合成；place(item) 把背包里的方块放到地上；smelt(item,count) 用附近熔炉熔炼；',
  '  equip(item) 换手持；chat(message) 说话。',
  '决策规则：',
  '1. 威胁等级是"危险"时，第一个技能必须是 flee。',
  '2. 威胁等级是"安全"或"无"时，不要 flee，也不要 attack。',
  '3. 威胁等级是"警戒"时，不要 flee，可以先 attack 击退它。',
  '4. 背包里的 crafting_table 或 furnace 只是物品，不等于已经放在地上。需要工作台或熔炉时先 place，再 craft 或 smelt。',
  '5. gather/mine 的 target 必须是"资源"那一行列出的方块名。往下挖可以 mine stone 且 down 为 true，向前探可以 ahead 为 true。',
  '6. 「建议下一步」若已经排了好几步，按这个顺序原样输出，不要收成一步。没有镐、身边也没有已放置的工作台、但背包有原木时，先 craft 对应的木板。',
  '7. 不要输出空数组。资源那一行为空、又没有建议步骤时，输出一个 goto，x 用当前位置加 8，y 和 z 保持不变。',
  '8. 一次最多输出 4 个技能，按执行顺序排列。',
  '9. target 用方块名，entity 用实体名，不要编造 id。'
].join('\n')

// 能吃的物品（与 session.js 的 FOOD_ITEMS 保持一致；这里只用来过滤"背包没食物还 eat"）
const FOOD_NAMES = new Set([
  'bread', 'apple', 'baked_potato', 'potato', 'carrot', 'golden_carrot', 'golden_apple',
  'beef', 'cooked_beef', 'porkchop', 'cooked_porkchop', 'chicken', 'cooked_chicken',
  'mutton', 'cooked_mutton', 'rabbit', 'cooked_rabbit', 'cod', 'cooked_cod',
  'salmon', 'cooked_salmon', 'melon_slice', 'sweet_berries', 'glow_berries',
  'cookie', 'pumpkin_pie', 'beetroot', 'beetroot_soup', 'mushroom_stew', 'honey_bottle', 'rotten_flesh'
])

const PICKAXES = new Set([
  'wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe',
  'netherite_pickaxe', 'golden_pickaxe', 'copper_pickaxe'
])
const LOG_NAMES = [
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
  'mangrove_log', 'cherry_log'
]
// 采集优先级：矿比木头值钱，木头比铺地的石头值钱。草方块只在没有别的可见方块时才用。
const GATHER_PRIORITY = [
  'coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore',
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
  'mangrove_log', 'cherry_log',
  'stone', 'cobblestone', 'sand', 'dirt', 'gravel'
]

function itemCounts (raw) {
  const have = {}
  for (const it of ((raw && raw.inventory && raw.inventory.items) || [])) {
    if (!it || !it.name) continue
    have[it.name] = (have[it.name] || 0) + (it.count || 1)
  }
  const held = raw && raw.status && raw.status.held && raw.status.held.name
  if (held && !have[held]) have[held] = 1
  return have
}

function visibleBlockSet (raw) {
  const blocks = raw && raw.findBlocks && raw.findBlocks.blocks
  if (!Array.isArray(blocks)) return null
  const set = new Set()
  for (const b of blocks) if (b && b.name) set.add(b.name)
  return set
}

function visibleEntitySet (raw) {
  const ents = (raw && raw.entities && raw.entities.entities) || []
  const set = new Set()
  for (const e of ents) {
    if (!e) continue
    for (const key of ['name', 'type']) {
      if (!e[key]) continue
      set.add(String(e[key]).split('#')[0].trim().toLowerCase())
    }
  }
  return set
}

function finiteCoord (n) {
  return typeof n === 'number' && Number.isFinite(n)
}

// 丢掉模型编出来的技能。findBlocks 缺席时不校验方块名（观测不完整，没法证伪）。
function sanitizeSkills (skills, raw, threat) {
  const have = itemCounts(raw)
  const hasFood = Object.keys(have).some(n => FOOD_NAMES.has(n))
  const food = raw && raw.status && raw.status.food
  const foodFull = typeof food === 'number' && food >= 20
  const blocks = visibleBlockSet(raw)
  const ents = visibleEntitySet(raw)
  const level = threat && threat.level
  const out = []
  for (const s of skills || []) {
    if (!s || typeof s.skill !== 'string') continue
    const args = s.args || {}
    if (s.skill === 'flee') {
      if (level !== 'danger') continue
    } else if (s.skill === 'eat') {
      if (!hasFood || foodFull) continue
    } else if (s.skill === 'attack') {
      if (level === 'safe' || level === 'none') continue
      const ent = args.entity
      if (ent === undefined || ent === null) continue
      if (!ents.has(String(ent).split('#')[0].trim().toLowerCase())) continue
    } else if (s.skill === 'gather' || s.skill === 'mine') {
      if (!args.target || typeof args.target !== 'string') continue
      // 向下/向前挖时，目标方块可以还没露在资源列表里（脚下是泥土）。
      if (args.down !== true && args.ahead !== true && blocks && !blocks.has(args.target)) continue
    } else if (s.skill === 'goto') {
      if (!finiteCoord(args.x) || !finiteCoord(args.y) || !finiteCoord(args.z)) continue
    } else if (s.skill === 'craft' || s.skill === 'equip' || s.skill === 'place' || s.skill === 'smelt') {
      if (!args.item || typeof args.item !== 'string') continue
    } else if (s.skill === 'chat') {
      if (!args.message || typeof args.message !== 'string') continue
    } else {
      continue
    }
    out.push(s)
  }
  return out
}

// 不依赖模型的下一步。必须能单独通过 scenarios.json 的评分，
// 这样 LLM 给空数组或给了会被丢掉的技能时，上层仍然有一个可执行计划。
function proposeSkills (raw) {
  const threat = classifyThreat(raw && raw.entities)
  const have = itemCounts(raw)
  const status = (raw && raw.status) || {}
  const food = typeof status.food === 'number' ? status.food : 20
  const blocks = (raw && raw.findBlocks && raw.findBlocks.blocks) || []
  const blockNames = new Set(blocks.map(b => b && b.name).filter(Boolean))
  const out = []
  const add = (skill, args) => {
    if (out.length >= 2) return
    if (out.some(s => s.skill === skill)) return
    out.push({ skill, args: args || {} })
  }

  if (threat.level === 'danger') add('flee', {})
  if (food <= 14 && food < 20 && Object.keys(have).some(n => FOOD_NAMES.has(n))) add('eat', {})

  const hasPick = Object.keys(have).some(n => PICKAXES.has(n))
  const hasTable = (have.crafting_table || 0) > 0 || blockNames.has('crafting_table')
  if (!hasPick && !hasTable) {
    let planks = 0
    for (const n of Object.keys(have)) if (n.endsWith('_planks')) planks += have[n]
    const sticks = have.stick || 0
    const logName = LOG_NAMES.find(n => have[n])
    if (planks >= 4) add('craft', { item: 'crafting_table' })
    else if (logName) add('craft', { item: logName.replace(/_log$/, '_planks') })
    else if (planks >= 2 && sticks < 2) add('craft', { item: 'stick', count: 4 })
  }

  const target = GATHER_PRIORITY.find(n => blockNames.has(n)) || (blockNames.has('grass_block') ? 'grass_block' : null)
  if (target) add('gather', { target })

  if (!out.length) {
    const pos = Array.isArray(status.pos) ? status.pos : [0, 64, 0]
    const x = finiteCoord(pos[0]) ? pos[0] : 0
    const y = finiteCoord(pos[1]) ? pos[1] : 64
    const z = finiteCoord(pos[2]) ? pos[2] : 0
    add('goto', { x: x + 8, y, z })
  }
  return out
}

function digSkill (name) {
  return name === 'gather' || name === 'mine'
}

// 建议下一步已经写明目标时，模型常在后面再补 goto / 另一项合成。
// 那些技能和目标争执行顺序。模型已经选中同一目标时，只留下这一条。
function sameTarget (got, want) {
  if (!got || !want || !got.skill || !want.skill) return false
  const gotDig = digSkill(got.skill)
  const wantDig = digSkill(want.skill)
  if (gotDig !== wantDig && got.skill !== want.skill) return false
  if (!gotDig && got.skill !== want.skill) return false
  const a = got.args || {}
  const b = want.args || {}
  if (b.item && a.item !== b.item) return false
  if (b.target && a.target !== b.target) return false
  if (b.x !== undefined && Number(a.x) !== Number(b.x)) return false
  if (b.z !== undefined && Number(a.z) !== Number(b.z)) return false
  return true
}

function focusDetermined (skills, raw, threat) {
  const want = raw && raw.suggestion && raw.suggestion.skill
  if (!want || !want.skill) return skills
  const hit = (skills || []).find(s => sameTarget(s, want))
  if (!hit) return skills
  if (threat && threat.level === 'danger' && hit.skill !== 'flee') {
    const flee = skills.find(s => s.skill === 'flee') || { skill: 'flee', args: {}, reason: '威胁等级危险（代码补）' }
    return [flee, hit]
  }
  return [hit]
}

class OllamaClient {
  constructor (opts = {}) {
    this.endpoint = opts.endpoint || 'http://127.0.0.1:11434'
    this.model = opts.model || 'qwen2.5-mc:7b'
    this.keepAlive = opts.keepAlive || '30m'
    this.timeoutMs = opts.timeoutMs || 20000
    this.temperature = opts.temperature === undefined ? 0.1 : opts.temperature
    this.maxTokens = opts.maxTokens || 400
    this.lastError = null
    this.lastLatencyMs = 0
    this.calls = 0
    this.failures = 0
  }

  url (path) {
    return new URL(path, this.endpoint).toString()
  }

  // 一次 POST，返回解析后的 JSON
  post (path, body, timeoutMs) {
    const target = this.url(path)
    const mod = target.startsWith('https:') ? https : http
    const data = JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const req = mod.request(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
      }, res => {
        let buf = ''
        res.on('data', c => { buf += c })
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 200)}`))
            return
          }
          try { resolve(JSON.parse(buf)) } catch (e) { reject(new Error('返回不是合法 JSON')) }
        })
      })
      req.setTimeout(timeoutMs || this.timeoutMs, () => {
        req.destroy(new Error(`超时 ${timeoutMs || this.timeoutMs}ms`))
      })
      req.on('error', reject)
      req.end(data)
    })
  }

  // 一次 GET（/api/version 这类只接受 GET 的端点）
  get (path, timeoutMs) {
    const target = this.url(path)
    const mod = target.startsWith('https:') ? https : http
    return new Promise((resolve, reject) => {
      const req = mod.request(target, { method: 'GET' }, res => {
        let buf = ''
        res.on('data', c => { buf += c })
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 200)}`))
            return
          }
          try { resolve(JSON.parse(buf)) } catch (e) { reject(new Error('返回不是合法 JSON')) }
        })
      })
      req.setTimeout(timeoutMs || this.timeoutMs, () => {
        req.destroy(new Error(`超时 ${timeoutMs || this.timeoutMs}ms`))
      })
      req.on('error', reject)
      req.end()
    })
  }

  // 服务是否可用
  async health () {
    try {
      const r = await this.get('/api/version', 3000)
      return { ok: true, version: r.version }
    } catch (e) {
      this.lastError = e.message
      return { ok: false, error: e.message }
    }
  }

  // 预热：把模型加载进显存，避免第一次决策等 52s
  async warmup () {
    const t0 = Date.now()
    try {
      await this.post('/api/generate', {
        model: this.model,
        prompt: 'ok',
        stream: false,
        keep_alive: this.keepAlive,
        options: { num_predict: 1 }
      }, 180000)
      this.lastLatencyMs = Date.now() - t0
      return { ok: true, ms: this.lastLatencyMs }
    } catch (e) {
      this.lastError = e.message
      return { ok: false, error: e.message, ms: Date.now() - t0 }
    }
  }

  // 结构化对话：返回 { ok, content, ms }
  async chat (messages, opts = {}) {
    const t0 = Date.now()
    this.calls++
    try {
      const r = await this.post('/api/chat', {
        model: this.model,
        stream: false,
        keep_alive: this.keepAlive,
        format: opts.schema || buildSkillSchema(),
        options: {
          temperature: opts.temperature === undefined ? this.temperature : opts.temperature,
          num_predict: opts.maxTokens || this.maxTokens
        },
        messages
      }, opts.timeoutMs || this.timeoutMs)
      this.lastLatencyMs = Date.now() - t0
      const content = r.message && r.message.content
      if (!content) throw new Error('返回里没有 message.content')
      return { ok: true, content, ms: this.lastLatencyMs }
    } catch (e) {
      this.failures++
      this.lastError = e.message
      return { ok: false, error: e.message, ms: Date.now() - t0 }
    }
  }

  stats () {
    return {
      endpoint: this.endpoint,
      model: this.model,
      calls: this.calls,
      failures: this.failures,
      last_latency_ms: this.lastLatencyMs,
      last_error: this.lastError
    }
  }
}

// 上层决策器：渲染观测 → 问 LLM → 解析技能
class Planner {
  constructor (opts = {}) {
    this.client = opts.client || new OllamaClient(opts)
    this.systemPrompt = opts.systemPrompt || DEFAULT_SYSTEM_PROMPT
    this.maxSkills = opts.maxSkills || 4
  }

  // raw = { status, inventory, findBlocks, entities, events }
  async plan (raw, opts = {}) {
    const text = renderObservation(raw)
    const threat = classifyThreat(raw.entities)
    const messages = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: text }
    ]
    const res = await this.client.chat(messages, opts)
    if (!res.ok) return { ok: false, error: res.error, observation: text, ms: res.ms }
    let skills = sanitizeSkills(parseSkills(res.content), raw, threat)
    // 安全或无威胁时，代码已经排好的铁锭链直接执行。
    // 7B 会把多步收成一步（例如工作台还在背包里就去合成木镐）。
    // 警戒和危险不用这条链，避免把逃跑盖掉。
    const calm = !threat || threat.level === 'safe' || threat.level === 'none'
    const chain = calm && raw && raw.suggestion && Array.isArray(raw.suggestion.steps) ? raw.suggestion.steps : null
    const chained = chain && chain.length ? sanitizeSkills(chain, raw, threat) : []
    if (chained.length) {
      skills = chained
    } else {
      // 没有镐、也没有工作台时，只挖木头不会推进工具链。无威胁时改成先合成。
      // 警戒和危险不动：那里模型给出的 attack 仍然有用。
      const proposed = proposeSkills(raw)
      const onlyDigging = skills.length > 0 && skills.every(s => s.skill === 'gather' || s.skill === 'mine')
      if (onlyDigging && threat.level !== 'danger' && threat.level !== 'warn' && proposed.some(s => s.skill === 'craft')) {
        skills = proposed
      }
      // LLM 给空、或给的技能全被丢掉时：先用观测里的「建议下一步」，再落到确定性提案。
      // 模型不可达时走不到这里，仍然返回 ok:false，由调用方报 llm_error。
      if (!skills.length && raw && raw.suggestion && raw.suggestion.skill) {
        skills = sanitizeSkills([raw.suggestion.skill], raw, threat)
      }
      if (!skills.length) skills = proposed
      // 采样参数（temperature 0.1、repeat_penalty 1.1）改不动已经选中的目标，
      // 模型仍会在目标后面再采样几条无关技能。目标一致时把后面的权重丢掉。
      skills = focusDetermined(skills, raw, threat)
    }
    // 先整理（arrange 可能补一个 flee），再截断——反过来的话补完会超上限
    skills = this.arrange(skills, threat, { food: raw.status && raw.status.food }).slice(0, this.maxSkills)
    return { ok: true, skills, threat: threat.level, raw_content: res.content, observation: text, ms: res.ms }
  }

  // 确定性整理：威胁等级是代码算的，所以**技能顺序也由代码定**。
  //
  // 实测 7B 模型不保证把 flee 排在第一位（贴脸时它会给 attack + flee，
  // 而 attack 会先执行 = 送死）。与其指望模型听话，不如让代码来排：
  //   危险 → flee 必须第一个
  //   安全 → 去掉 flee（远处没必要逃）
  // LLM 负责的是"计划"，不是"安全反射"——安全反射归下层。
  arrange (skills, threat, ctx = {}) {
    const out = skills.slice()
    if (threat.level !== 'danger') return out.filter(s => s.skill !== 'flee' && !(s.skill === 'eat' && ctx.food >= 20))
    const flee = out.find(s => s.skill === 'flee') || { skill: 'flee', args: {}, reason: '威胁等级危险（代码补）' }
    return [flee, ...out.filter(s => s.skill !== 'flee' && s.skill !== 'attack' && !(s.skill === 'eat' && ctx.food >= 20))]
  }
}

module.exports = {
  OllamaClient, Planner, buildSkillSchema, DEFAULT_SYSTEM_PROMPT, renderObservation,
  sanitizeSkills, proposeSkills, FOOD_NAMES
}
