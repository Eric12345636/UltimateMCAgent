'use strict'
// 规范化观测：把 API 的原始响应整理成压缩层和指针层共用的统一结构。
//
// 输入是 mc-agent-api 的四个响应（result 部分）：
//   status    GET  /status
//   inventory GET  /inventory
//   findBlocks POST /find_blocks   ← 必须是"指定类型"模式，摘要模式没有坐标，无法当指针目标
//   entities  POST /get_entities
//   events    GET  /events
//
// 输出的 observation 里有两份候选表：
//   blocks   候选方块，每条带稳定的下标（指针 b<i> 指它）
//   entities 候选实体，每条带稳定的下标（指针 e<i> 指它）
// 下标由"距离升序"决定，所以同样的观测永远得到同样的下标。

const DEFAULTS = {
  maxBlocks: 12,      // 候选方块上限（最近的优先）
  maxEntities: 8,     // 候选实体上限
  maxEvents: 6,       // 事件条数上限
  maxInventory: 24    // 背包条目上限
}

function toPos (p) {
  if (!p) return null
  if (Array.isArray(p) && p.length >= 3) return [Number(p[0]), Number(p[1]), Number(p[2])]
  if (typeof p === 'object' && p.x !== undefined) return [Number(p.x), Number(p.y), Number(p.z)]
  return null
}

function samePos (a, b) {
  return !!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

function buildObservation (raw, opts = {}) {
  const o = { ...DEFAULTS, ...opts }
  const status = raw.status || {}
  const inventory = raw.inventory || {}
  const fb = raw.findBlocks || {}

  // ---- 候选方块 ----
  // 摘要模式（blocks 是 {name:{count,nearest,dist}}）没有逐块坐标，不能当指针目标，
  // 这里只保留种类统计，块候选留空。
  let blockCandidates = []
  let blockSummary = {}
  if (Array.isArray(fb.blocks)) {
    blockCandidates = fb.blocks
      .filter(b => b && b.name && toPos(b.pos))
      .map(b => ({
        name: b.name,
        pos: toPos(b.pos),
        dist: Number(b.dist || 0),
        properties: b.properties || {},
        mature: b.mature,
        growth: b.growth
      }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, o.maxBlocks)
  } else if (fb.blocks && typeof fb.blocks === 'object') {
    blockSummary = fb.blocks
  }

  // ---- 候选实体 ----
  const entityCandidates = ((raw.entities && raw.entities.entities) || [])
    .filter(e => e && e.name !== undefined)
    .map(e => ({
      id: e.id,
      name: e.name,
      type: e.type,
      pos: toPos(e.pos),
      dist: Number(e.dist || 0),
      health: e.health,
      item: e.item
    }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, o.maxEntities)

  // ---- 背包 ----
  const items = ((inventory.items) || [])
    .filter(i => i && i.name)
    .map(i => ({ name: i.name, count: i.count, slot: i.slot }))
    .slice(0, o.maxInventory)

  // ---- 事件 ----
  const events = ((raw.events && raw.events.events) || []).slice(-o.maxEvents)

  return {
    status,
    inventory: {
      items,
      armor: inventory.armor || {},
      offhand: inventory.offhand || null,
      held: inventory.held || null,
      empty_slots: inventory.empty_slots
    },
    blocks: blockCandidates,
    blockSummary,
    entities: entityCandidates,
    events,
    meta: {
      findBlocksTotal: fb.total,
      findBlocksRadius: fb.radius,
      findBlocksScanned: fb.scanned,
      summaryMode: !Array.isArray(fb.blocks)
    }
  }
}

// 在观测里找与给定坐标完全一致的候选方块下标，找不到返回 -1
function findBlockIndex (obs, pos) {
  if (!pos) return -1
  for (let i = 0; i < obs.blocks.length; i++) if (samePos(obs.blocks[i].pos, pos)) return i
  return -1
}

// 在观测里找给定实体 id 的候选下标，找不到返回 -1
function findEntityIndex (obs, entityId) {
  if (entityId === undefined || entityId === null) return -1
  for (let i = 0; i < obs.entities.length; i++) if (obs.entities[i].id === entityId) return i
  return -1
}

module.exports = { buildObservation, findBlockIndex, findEntityIndex, toPos, samePos, DEFAULTS }
