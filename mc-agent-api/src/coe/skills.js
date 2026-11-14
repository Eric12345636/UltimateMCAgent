'use strict'
const { isExposed } = require('../blocks')
// Skill：上层专家（LLM）能表达的全部意图。
//
// 设计约束：LLM **不得**直接调用 move_to / dig / attack 这些原子端点——
// 它们会占住动作锁几秒到几十秒，把下层反射专家彻底挤出回路。
// LLM 只能下发 Skill，由控制器编译成 goal 条件，再由下层模型逐 tick 执行。

// skill 表：required 是必填参数，goal 是编译出的 goal 类型
const SKILLS = {
  goto: { required: ['x', 'y', 'z'], goal: 'goto', desc: '走到某个坐标' },
  gather: { required: ['target'], goal: 'mine', desc: '采集某类方块' },
  mine: { required: ['target'], goal: 'mine', desc: '挖掉某类方块（别名）' },
  // attack 的目标可以是实体名（LLM 只看得见名字）或 entity_id，
  // 所以不用通用的 required 检查，交给下面那段专门的校验。
  attack: { required: [], goal: 'attack', desc: '攻击某个实体（按实体名或 entity_id）' },
  flee: { required: [], goal: 'flee', desc: '逃离威胁' },
  eat: { required: [], goal: 'eat', desc: '进食' },
  craft: { required: ['item'], goal: 'craft', desc: '合成物品' },
  // 背包里的工作台/熔炉不是已放置的方块。place 把物品放到脚下附近。
  place: { required: ['item'], goal: 'idle', desc: '把背包里的方块放到地上' },
  smelt: { required: ['item'], goal: 'idle', desc: '用附近熔炉熔炼' },
  equip: { required: ['item'], goal: 'idle', desc: '切换手持物品' },
  wait: { required: [], goal: 'idle', desc: '原地等待' },
  chat: { required: ['message'], goal: 'idle', desc: '发言' }
}

const SKILL_NAMES = Object.keys(SKILLS)

// LLM 一次能用的技能数上限，防止它一次吐一大堆
const MAX_SKILLS = 8

// 参数校验：返回 { ok: true, args } 或 { ok: false, error }
function validateSkill (skill, args) {
  const spec = Object.hasOwn(SKILLS, skill) ? SKILLS[skill] : null
  if (!spec) return { ok: false, error: `未知技能 ${skill}（可用：${SKILL_NAMES.join(' / ')}）` }
  if (args != null && (typeof args !== 'object' || Array.isArray(args))) return { ok: false, error: 'args 必须是对象' }
  const a = args || {}
  for (const k of spec.required) {
    if (a[k] === undefined || a[k] === null || a[k] === '') {
      return { ok: false, error: `技能 ${skill} 缺少参数 ${k}` }
    }
  }
  if (skill === 'goto') {
    const nums = ['x', 'y', 'z'].map(k => Number(a[k]))
    if (!nums.every(Number.isFinite)) return { ok: false, error: '技能 goto 的 x/y/z 必须是数字' }
  }
  if (skill === 'attack') {
    // 按**名字**引用（LLM 只看得见名字），代码再解析成 entity_id；
    // 也接受直接的 entity_id（调试用）。
    if (a.entity !== undefined && a.entity !== null && a.entity !== '') {
      if (typeof a.entity !== 'string') return { ok: false, error: '技能 attack 的 entity 必须是实体名（字符串）' }
    } else {
      const id = Number(a.entity_id)
      if (a.entity_id == null || a.entity_id === '' || !Number.isSafeInteger(id)) return { ok: false, error: '技能 attack 需要 entity（实体名）或 entity_id' }
    }
    if (a.max_hits !== undefined && (!Number.isSafeInteger(Number(a.max_hits)) || Number(a.max_hits) < 1)) return { ok: false, error: 'max_hits 必须是正整数' }
  }
  if (['gather', 'mine', 'craft', 'smelt'].includes(skill) && a.count !== undefined) {
    if (!Number.isSafeInteger(Number(a.count)) || Number(a.count) < 1 || Number(a.count) > 64) return { ok: false, error: 'count 必须在 1..64' }
  }
  if (['gather', 'mine'].includes(skill) && a.radius !== undefined) {
    if (!Number.isFinite(Number(a.radius)) || Number(a.radius) < 1 || Number(a.radius) > 64) return { ok: false, error: 'radius 必须在 1..64' }
  }
  if (['gather', 'mine'].includes(skill) && a.down !== undefined && typeof a.down !== 'boolean') {
    return { ok: false, error: 'down 必须是布尔值' }
  }
  if (['gather', 'mine'].includes(skill) && a.ahead !== undefined && typeof a.ahead !== 'boolean') {
    return { ok: false, error: 'ahead 必须是布尔值' }
  }
  if (skill === 'wait') {
    const ms = Number(a.ms === undefined ? 1000 : a.ms)
    // 上限 2 秒：实测 7B 模型会把 wait 当成"拖延"的口子（wait 5000 出现过），
    // 上层应该频繁重决策，而不是长时间空转。
    if (!Number.isFinite(ms) || ms < 0 || ms > 2000) return { ok: false, error: '技能 wait 的 ms 必须在 0..2000' }
  }
  if (skill === 'chat') {
    if (typeof a.message !== 'string' || !a.message.trim() || /[\r\n\u2028\u2029]/u.test(a.message)) return { ok: false, error: '技能 chat 需要一行非空 message' }
    if (a.message.length > 100) return { ok: false, error: '技能 chat 的 message 不能超过 100 字符' }
    if (a.message.trimStart().startsWith('/')) return { ok: false, error: '技能 chat 的 message 不能以 / 开头' }
  }
  return { ok: true, args: a }
}

// 从 LLM 的一段文本里抽出技能列表。
// 接受两种形态：纯 JSON 数组，或 {"skills":[...]}，或单个 skill 对象。
// LLM 本地部署时输出 JSON 不太稳定，这里做一次容错解析。
function parseSkills (text) {
  let raw = text
  if (typeof raw !== 'string') return []
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) raw = fence[1]
  raw = raw.trim()
  if (!raw) return []
  // 截取第一个 [ ... ] 或 { ... } 片段
  const start = raw.search(/[\[{]/)
  if (start < 0) return []
  const end = raw.lastIndexOf(raw[start] === '[' ? ']' : '}')
  let parsed
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch (e) {
    return []
  }
  let list = parsed
  if (parsed && !Array.isArray(parsed)) {
    if (Array.isArray(parsed.skills)) list = parsed.skills
    else if (parsed.skill) list = [parsed]
  }
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list.slice(0, MAX_SKILLS)) {
    if (!item || typeof item !== 'object') continue
    // 两种形态都认：{skill, args:{...}}（LLM 按 schema 生成的形态）
    // 和 {skill, target:..., count:...}（扁平形态）
    const args = item.args && typeof item.args === 'object' ? item.args : item
    const v = validateSkill(item.skill, args)
    if (v.ok) out.push({ skill: item.skill, args: v.args, reason: item.reason || '' })
  }
  return out
}

// 找到最近的一个目标方块（mineflayer 的 findBlocks 走区块缓存，不算慢，但只在技能切换时调一次）
// opts.exposed === false 时连埋着的方块也算。调用方要自己挖开一条路。
async function findNearestBlock (bot, name, maxDistance = 32, opts = {}) {
  if (!bot || !bot.entity) return null
  const block = bot.registry?.blocksByName?.[name]
  if (!block) return null
  const positions = bot.findBlocks({
    matching: block.id,
    maxDistance,
    count: 64,
    useExtraInfo: opts.exposed === false ? undefined : (b => isExposed(bot, b))
  })
  if (!positions || !positions.length) return null
  let best = null
  const me = bot.entity.position
  for (const pos of positions) {
    const dist = pos.distanceTo(me)
    if (!best || dist < best.dist) best = { pos, dist }
  }
  return best
}

// 把「实体引用」解析成 entity id。
// LLM 会照抄观测里的字样，所以这些形态都得认：
//   "zombie"  "zombie#812"  "812"  812
// 名字按不区分大小写匹配，匹配不到就退化成类型名（creeper / zombie）。
function resolveEntity (bot, ref) {
  if (ref === undefined || ref === null || ref === '') return null
  const raw = String(ref).trim()
  const me = bot.entity.position

  // "zombie#812" → 名字 zombie，id 812
  let name = raw
  let wantId = null
  const hash = raw.indexOf('#')
  if (hash >= 0) {
    name = raw.slice(0, hash).trim()
    const n = Number(raw.slice(hash + 1))
    if (Number.isFinite(n)) wantId = n
  }
  if (wantId !== null && bot.entities[wantId]) return wantId
  if (/^\d+$/.test(raw) && bot.entities[Number(raw)]) return Number(raw)

  const lower = name.toLowerCase()
  let best = null
  for (const e of Object.values(bot.entities || {})) {
    if (!e || !e.position) continue
    const label = String(e.name || e.username || '').toLowerCase()
    const type = String(e.type || '').toLowerCase()
    if (label !== lower && type !== lower) continue
    const d = e.position.distanceTo(me)
    if (!best || d < best.d) best = { id: e.id, d }
  }
  return best ? best.id : null
}

// 把 Skill 编译成 goal。
// ctx: { bot, session }
// 返回 { ok, goal } 或 { ok:false, error }
//
// goal = { type, target: { pos } | { entityId }, args }
async function compileGoal (skill, args, ctx = {}) {
  const v = validateSkill(skill, args)
  if (!v.ok) return { ok: false, error: v.error }
  const bot = ctx.bot
  const spec = SKILLS[skill]
  const a = v.args

  switch (skill) {
    case 'goto': {
      const pos = { x: Number(a.x), y: Number(a.y), z: Number(a.z) }
      return { ok: true, goal: { type: spec.goal, target: { pos }, args: a } }
    }
    case 'gather':
    case 'mine': {
      if (!bot) return { ok: false, error: 'bot 未连接' }
      const down = a.down === true
      const ahead = a.ahead === true
      // 往下挖或向前挖不依赖目标方块已经露出来：脚下可能还是泥土。
      if (down || ahead) {
        const p = bot.entity && bot.entity.position
        const pos = p ? { x: Math.floor(Number(p.x)), y: Math.floor(Number(p.y)) - 1, z: Math.floor(Number(p.z)) } : null
        if (!pos) return { ok: false, error: 'bot 未连接' }
        const dir = Array.isArray(a.dir) && a.dir.length >= 2 ? [Number(a.dir[0]) || 0, Number(a.dir[1]) || 0] : [1, 0]
        return {
          ok: true,
          goal: {
            type: spec.goal,
            target: { pos, blockName: String(a.target) },
            args: {
              count: Number(a.count) || 1,
              blockName: String(a.target),
              radius: Number(a.radius) || 32,
              down,
              ahead,
              dir
            }
          }
        }
      }
      const radius = Number(a.radius) || 32
      let hit = await findNearestBlock(bot, String(a.target), radius)
      if (!hit) hit = await findNearestBlock(bot, String(a.target), radius, { exposed: false })
      if (!hit) return { ok: false, error: `附近没有 ${a.target}` }
      return {
        ok: true,
        goal: {
          type: spec.goal,
          target: { pos: hit.pos, blockName: String(a.target) },
          args: { count: Number(a.count) || 1, blockName: String(a.target), radius }
        }
      }
    }
    case 'attack': {
      if (!bot) return { ok: false, error: 'bot 未连接' }
      const ref = a.entity || a.entity_id
      const eid = resolveEntity(bot, ref)
      if (eid === null) return { ok: false, error: `附近没有 ${a.entity}` }
      const e = (bot.entities || {})[eid]
      if (!e) return { ok: false, error: `实体 ${eid} 不在视野里` }
      return { ok: true, goal: { type: spec.goal, target: { entityId: eid }, args: { maxHits: a.max_hits === undefined ? undefined : Number(a.max_hits) } } }
    }
    case 'flee':
      return { ok: true, goal: { type: spec.goal, target: null, args: a } }
    case 'eat':
      return { ok: true, goal: { type: spec.goal, target: null, args: a } }
    case 'craft':
      return { ok: true, goal: { type: spec.goal, target: null, args: { item: String(a.item), count: Number(a.count) || 1 } } }
    case 'place':
      return { ok: true, goal: { type: spec.goal, target: null, args: { item: String(a.item) } } }
    case 'smelt':
      return { ok: true, goal: { type: spec.goal, target: null, args: { item: String(a.item), count: Number(a.count) || 1 } } }
    case 'equip':
      return { ok: true, goal: { type: spec.goal, target: null, args: { item: String(a.item) } } }
    case 'wait':
      return { ok: true, goal: { type: spec.goal, target: null, args: { ms: Number(a.ms === undefined ? 1000 : a.ms) } } }
    case 'chat':
      return { ok: true, goal: { type: spec.goal, target: null, args: { message: String(a.message) } } }
    default:
      return { ok: false, error: `技能 ${skill} 还没有实现` }
  }
}

module.exports = { SKILLS, SKILL_NAMES, MAX_SKILLS, validateSkill, parseSkills, compileGoal, findNearestBlock, resolveEntity }
