'use strict'
// 上层观测渲染器：把 API 的原始 JSON 压成给 LLM 看的结构化文本。
//
// 为什么不用 p0 的压缩态：p0 把名字压成 N<id>，那是给"从零预训的小模型"用的，
// 通用 LLM 看着是乱码（见 COE.md §4.1）。
//
// 为什么不让 LLM 自己算距离：实测 7B 模型执行不了"距离小于 4 格就 flee"这类阈值判断，
// 时而无视、时而过度反应。所以**算术留在代码里**，LLM 只做「分类标签 → 技能」的语义映射。
//
// 输出形如：
//   状态: 生命 20/20 饱食 20/20 位置[10,64,10] 白天 森林 手持iron_sword
//   威胁等级: 安全（最近敌对实体 zombie 12.6格）
//   资源: crafting_table 2.8格 / oak_log 4.5格 / stone 4.6格
//   背包: oak_log x12 stick x4 crafting_table x1 iron_sword x1
//   最近事件: 受到攻击 掉血3

// 威胁等级的分档（代码算，不让模型算）
const THREAT_DANGER = 4    // 小于这个距离算危险
const THREAT_WARN = 8      // 小于这个距离算警戒

const DAY_NAMES = { day: '白天', night: '夜晚' }

function fmtDist (d) {
  if (d === undefined || d === null || !Number.isFinite(Number(d))) return '?'
  return (Math.round(Number(d) * 10) / 10).toString()
}

function posStr (pos) {
  if (!pos) return '?'
  const p = Array.isArray(pos) ? pos : [pos.x, pos.y, pos.z]
  return '[' + p.map(v => Math.round(Number(v) * 10) / 10).join(',') + ']'
}

// 威胁等级：只看最近敌对实体的距离。返回 { level, label, detail }
function classifyThreat (entities) {
  const list = (entities && entities.entities) || []
  let best = null
  for (const e of list) {
    if (!e || e.type !== 'hostile') continue
    const d = Number(e.dist)
    if (!Number.isFinite(d)) continue
    if (!best || d < best.dist) best = { name: e.name || e.type, dist: d, health: e.health }
  }
  if (!best) return { level: 'none', label: '无', detail: '附近没有敌对实体' }
  if (best.dist < THREAT_DANGER) {
    return { level: 'danger', label: '危险', detail: `最近敌对实体 ${best.name} ${fmtDist(best.dist)}格，正在逼近` }
  }
  if (best.dist < THREAT_WARN) {
    return { level: 'warn', label: '警戒', detail: `最近敌对实体 ${best.name} ${fmtDist(best.dist)}格` }
  }
  return { level: 'safe', label: '安全', detail: `最近敌对实体 ${best.name} ${fmtDist(best.dist)}格` }
}

// 资源候选：find_blocks 找到的方块，按距离排；同类只留最近的一个（避免 "dirt 1.6 / dirt 1.9" 占满列表）
function renderResources (findBlocks, limit = 5) {
  const blocks = (findBlocks && findBlocks.blocks) || []
  if (!Array.isArray(blocks) || !blocks.length) return '资源: 附近没有找到目标方块'
  const seen = new Set()
  const picked = []
  for (const b of blocks.slice().sort((a, b) => (a.dist || 0) - (b.dist || 0))) {
    if (!b || !b.name || seen.has(b.name)) continue
    seen.add(b.name)
    picked.push(b)
    if (picked.length >= limit) break
  }
  return '资源: ' + picked.map(b => `${b.name} ${fmtDist(b.dist)}格`).join(' / ')
}

function renderInventory (inventory, limit = 8) {
  const items = (inventory && inventory.items) || []
  if (!items.length) return '背包: 空'
  const parts = items.slice(0, limit).map(i => `${i.name} x${i.count}`)
  return '背包: ' + parts.join(' ')
}

function renderEvents (events, limit = 3) {
  const list = (events && events.events) || []
  if (!list.length) return '最近事件: 无'
  const parts = []
  for (const e of list.slice(-limit)) {
    if (e.type === 'hurt') parts.push(`受到攻击 掉血${fmtDist(e.damage)}`)
    else if (e.type === 'pickup') parts.push(`捡到 ${e.item} x${e.count}`)
    else if (e.type === 'death') parts.push('死亡')
    else if (e.type === 'effect_start') parts.push(`获得效果 ${e.name}`)
    else if (e.type === 'chat') parts.push(`聊天 ${String(e.text || '').slice(0, 20)}`)
    else if (e.type === 'skill_done') parts.push(`完成 ${e.skill}`)
    else if (e.type === 'skill_failed') parts.push(`失败 ${e.skill}${e.code ? '（' + e.code + '）' : ''}`)
    else if (e.type === 'override') parts.push(`下层否决了 ${e.from_skill || '上层'}（${e.reason}）`)
    else parts.push(e.type)
  }
  return '最近事件: ' + parts.join('；')
}

// 比赛进度：计分条目的完成情况 + 下一步建议目标（由 RULES.md 计分表算出来，不让 LLM 猜）
function renderProgress (progress) {
  const p = progress || {}
  if (!p.known) return '比赛进度: 未知（没有找到 RULES.md 计分表）'
  const inProg = Array.isArray(p.inProgress) && p.inProgress.length
    ? `；进行中 ${p.inProgress.length} 条（${p.inProgress.slice(0, 3).join('、')}）`
    : ''
  const lines = [`比赛进度: 计分条目已完成 ${p.completed}/${p.total} 条（合计 ${p.points} 分）${inProg}`]
  if (Array.isArray(p.targets) && p.targets.length) {
    lines.push('下一步目标: ' + p.targets.map(t => `${t.id}(${t.points}分)`).join(' / '))
  }
  return lines.join('\n')
}

// 合成建议：代码按背包算好"现在能做什么、只差什么"，避免 7B 模型自己记配方/数材料
function renderCraft (craft) {
  const c = craft || {}
  const parts = []
  if (Array.isArray(c.craftable) && c.craftable.length) parts.push('可立刻合成 ' + c.craftable.join(' / '))
  if (Array.isArray(c.near) && c.near.length) parts.push('只差材料 ' + c.near.join(' / '))
  if (!parts.length) return '合成: 材料不足（先采集资源）'
  return '合成: ' + parts.join('；')
}

// 建议下一步：代码状态机给出的唯一一条最优动作（LLM 只需照着执行或判断是否危险）
function renderSuggestion (suggestion) {
  const text = typeof suggestion === 'string' ? suggestion : (suggestion && suggestion.text)
  if (!text) return '建议下一步: 按"下一步目标"自主决定（无固定建议）'
  return '建议下一步: ' + text
}

// 可猎动物：低血量/饥饿时 LLM 需要知道附近能打什么来获取食物
function renderAnimals (entities) {
  const list = ((entities && entities.entities) || []).filter(e => e && e.type === 'animal')
  if (!list.length) return '可猎动物: 无'
  const parts = list.slice(0, 4).map(e => `${e.name || 'animal'} ${fmtDist(e.dist)}格`)
  return '可猎动物: ' + parts.join(' / ')
}

// 主入口：raw（status/inventory/findBlocks/entities/events/progress/craft）→ 结构化文本
function renderObservation (raw = {}) {
  const s = raw.status || {}
  const hp = s.health !== undefined ? Math.round(s.health * 10) / 10 : 20
  const food = s.food !== undefined ? Math.round(s.food * 10) / 10 : 20
  const lines = []
  lines.push(`状态: 生命 ${hp}/20 饱食 ${food}/20 位置${posStr(s.pos)} ` +
    `${DAY_NAMES[s.is_day ? 'day' : 'night'] || ''} ${s.biome || ''} 手持${(s.held && s.held.name) || '空手'}`.trim())
  const th = classifyThreat(raw.entities)
  lines.push(`威胁等级: ${th.label}（${th.detail}）`)
  lines.push(renderHostiles(raw.entities))
  lines.push(renderAnimals(raw.entities))
  lines.push(renderResources(raw.findBlocks))
  lines.push(renderInventory(raw.inventory))
  lines.push(renderCraft(raw.craft))
  lines.push(renderSuggestion(raw.suggestion))
  lines.push(renderProgress(raw.progress))
  lines.push(renderEvents(raw.events))
  return lines.join('\n')
}

// 敌对实体清单（带 id，方便调试和精确指认；技能按名字引用）
function renderHostiles (entities) {
  const list = ((entities && entities.entities) || []).filter(e => e && e.type === 'hostile')
  if (!list.length) return '敌人: 无'
  const parts = list.slice(0, 5).map(e => {
    const hp = e.health !== undefined ? ` 血量${Math.round(e.health)}` : ''
    const id = e.id !== undefined && e.id !== null ? `#${e.id}` : ''
    return `${e.name || e.type}${id} ${fmtDist(e.dist)}格${hp}`
  })
  return '敌人: ' + parts.join(' / ')
}

module.exports = {
  renderObservation, renderProgress, renderCraft, renderSuggestion, renderAnimals, classifyThreat, renderResources, renderInventory, renderEvents, renderHostiles,
  THREAT_DANGER, THREAT_WARN
}
