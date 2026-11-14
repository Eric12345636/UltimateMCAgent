'use strict'
// L-obs：低层局部观测编码。
//
// 这是训练侧（p1/，Python）与运行侧（Node）之间的**编码契约**：
// 运行侧的实现是唯一真值，训练侧不允许另写一套，只能用 p1/data/golden_local.json 做回归校验。
// 改动本文件必须同步更新黄金向量，并让两端测试同时通过。
//
// 设计取舍：
//  - 低层只关心「几何 + 威胁 + 目标」，不关心方块名字、不关心背包。
//    信息少 → 学得快；也��� sim2real 的关键（仿真只需复刻 7 个地面类别，不必复刻 MC 方块注册表）。
//  - 观测是定长 token 序列（≈150 token），下层用 GRU 逐 token 递推。

// ---------- 方块 / 地面类别 ----------

// 表面类别（单个体素）
const SURF = { AIR: 'air', PASS: 'pass', SOLID: 'solid', LIQ: 'liq', HAZ: 'haz', CLIMB: 'climb' }

// 地面类别（一格径向：表面 + 正下方），反射策略真正关心的是「能不能走 / 会不会掉 / 会不会烧」
const T = {
  WALL: 'wall',    // 实体挡住
  FLAT: 'flat',    // 空且有地
  HOLE: 'hole',    // 空且没地（掉下去）
  LIQ: 'liq',      // 水
  HAZ: 'haz',      // 岩浆 / 火（表面就是危险）
  CLIMB: 'climb',  // 梯子 / 藤蔓
  MAGMA: 'magma'   // 空但脚下是岩浆
}
const TERRAINS = [T.WALL, T.FLAT, T.HOLE, T.LIQ, T.HAZ, T.CLIMB, T.MAGMA]

const HAZARD_NAMES = new Set([
  'lava', 'fire', 'magma_block', 'cactus', 'powder_snow', 'campfire',
  'soul_fire', 'soul_campfire', 'lava_cauldron'
])
const LIQUID_NAMES = new Set(['water', 'lava', 'bubble_column'])
const CLIMB_NAMES = new Set([
  'ladder', 'vine', 'twisting_vines', 'weaving_vines', 'scaffolding', 'cave_vines'
])

// goal 类型（与 skills.js 的 goal 编译结果一一对应）
const GOALS = ['goto', 'mine', 'attack', 'flee', 'eat', 'craft', 'idle']

// 局部坐标系：8 个方向，[右, 前] 分量。0=N 1=NE 2=E 3=SE 4=S 5=SW 6=W 7=NW，8=不动
const DIRS = [
  [0, 1], [1, 1], [1, 0], [1, -1],
  [0, -1], [-1, -1], [-1, 0], [-1, 1]
]
const MOVE_NONE = 8
const PROBE_DEPTH = 4
const PROBE_HEIGHT = 3

// mineflayer 朝向约定：yaw=0 朝 -Z，yaw 增大朝 -X。
//   前 = (-sin yaw, -cos yaw)，右 = (cos yaw, -sin yaw)
function frame (yaw) {
  const s = Math.sin(yaw)
  const c = Math.cos(yaw)
  // 用 0 - x 而不是 -x，避免 yaw=0 时产出 -0（下游 assert 与 JSON 序列化都不友好）
  return { fx: 0 - s, fz: 0 - c, rx: c, rz: 0 - s }
}

// 把世界方向向量投影到局部系，返回 0..7 的方向下标
function bearingIndex (vx, vz, f) {
  const side = vx * f.rx + vz * f.rz
  const front = vx * f.fx + vz * f.fz
  if (side === 0 && front === 0) return MOVE_NONE
  let idx = Math.round(Math.atan2(side, front) / (Math.PI / 4))
  idx = ((idx % 8) + 8) % 8
  return idx
}

function blockAt (bot, x, y, z) {
  const origin = bot.entity.position
  return bot.blockAt(origin.offset(x - origin.x, y - origin.y, z - origin.z), false) || null
}

// 体素 → 表面类别
function surfaceClass (b) {
  if (!b) return null
  const n = b.name || ''
  if (n === 'air' || n === 'cave_air' || n === 'void_air') return SURF.AIR
  if (HAZARD_NAMES.has(n)) return SURF.HAZ
  if (LIQUID_NAMES.has(n)) return SURF.LIQ
  if (CLIMB_NAMES.has(n)) return SURF.CLIMB
  if (b.boundingBox === 'empty' || b.type === 'plant') return SURF.PASS
  return SURF.SOLID
}

// 表面 + 正下方 → 地面类别
function terrainOf (surf, floor) {
  if (surf === null) return T.WALL        // 区块没加载：宁可当墙，不往未知里走
  if (surf === SURF.HAZ) return T.HAZ
  if (surf === SURF.LIQ) return T.LIQ
  if (surf === SURF.CLIMB) return T.CLIMB
  if (surf === SURF.SOLID) return T.WALL
  // surf 是 air / pass
  if (floor === null) return T.HOLE
  if (floor === SURF.HAZ) return T.MAGMA
  if (floor === SURF.LIQ) return T.LIQ
  if (floor === SURF.SOLID || floor === SURF.CLIMB) return T.FLAT
  return T.HOLE                            // 正下方是植物/空气 → 下面是空的
}

// 三维距离。不依赖 Vec3 的 distanceTo，方便用普通对象做测试替身。
function dist3 (a, b) {
  const dx = a.x - b.x
  const dy = (a.y || 0) - (b.y || 0)
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

// 某列的「站立面」高度（相对脚部的偏移）：站在 y 处的方块上时偏移为 0，
// 上台阶是 +1，悬空没有地面返回 null。
function groundOffset (bot, x, z, y0) {
  for (let y = y0 + 2; y >= y0 - PROBE_HEIGHT; y--) {
    const b = blockAt(bot, x, y, z)
    if (surfaceClass(b) !== SURF.SOLID) continue
    const above = blockAt(bot, x, y + 1, z)
    if (surfaceClass(above) !== SURF.SOLID) return (y + 1) - y0
  }
  return null
}

// 单个方向的探测：4 格的地面类别 + 地面高度偏移
function probeDir (bot, pos, f, dirIdx) {
  const d = DIRS[dirIdx]
  const terr = []
  let height = null
  const y0 = Math.floor(pos.y)
  for (let k = 1; k <= PROBE_DEPTH; k++) {
    const x = pos.x + (f.rx * d[0] + f.fx * d[1]) * k
    const z = pos.z + (f.rz * d[0] + f.fz * d[1]) * k
    const surf = surfaceClass(blockAt(bot, x, y0, z))
    const floor = surfaceClass(blockAt(bot, x, y0 - 1, z))
    terr.push(terrainOf(surf, floor))
    // 只在第一格可通过的方向上算地面高度（被墙挡住时高度无意义，也省一半体素查询）
    if (height === null && terr[k - 1] !== T.WALL && terr[k - 1] !== T.HAZ) {
      const h = groundOffset(bot, x, z, y0)
      if (h !== null) height = h
    }
  }
  return { terr, height }
}

// ---------- 分箱 ----------

function hpBucket (hp) {
  const h = Number(hp) || 0
  if (h <= 0) return 0
  if (h < 5) return 1
  if (h < 10) return 2
  if (h < 15) return 3
  if (h < 18) return 4
  if (h < 20) return 5
  return 6
}

function foodBucket (f) {
  const v = Number(f) || 0
  if (v <= 0) return 0
  if (v < 5) return 1
  if (v < 10) return 2
  if (v < 15) return 3
  if (v < 20) return 4
  return 5
}

function oxyBucket (o) {
  const v = Number(o)
  if (!Number.isFinite(v)) return 3
  if (v <= 0) return 0
  if (v <= 5) return 1
  if (v <= 10) return 2
  return 3
}

// 受伤/前摇时长（tick）
function tickBucket (ticks) {
  const t = Number(ticks)
  if (!Number.isFinite(t) || t < 0) return 4
  if (t < 1) return 0
  if (t < 3) return 1
  if (t < 6) return 2
  if (t < 16) return 3
  return 4
}

function distBucket (d) {
  const v = Number(d)
  if (!Number.isFinite(v)) return 5
  if (v < 1) return 0
  if (v < 2) return 1
  if (v < 4) return 2
  if (v < 8) return 3
  if (v < 16) return 4
  return 5
}

// 血量比例分箱
function fracBucket (frac) {
  const v = Number(frac)
  if (!Number.isFinite(v)) return 3
  if (v < 0.25) return 0
  if (v < 0.5) return 1
  if (v < 0.75) return 2
  return 3
}

// ---------- 采集 ----------

// 从 live bot 采一份结构化观测（还没编码成 token）
// opts: { goal, prev, hurtTicks }
function senseFromBot (bot, opts = {}) {
  if (!bot || !bot.entity) return null
  const ent = bot.entity
  const pos = ent.position
  const f = frame(ent.yaw || 0)

  // 几何
  const geom = []
  for (let i = 0; i < 8; i++) geom.push(probeDir(bot, pos, f, i))

  // 威胁：最近的敌对实体
  let threat = { present: false, bearing: null, dist: Infinity, hpFrac: null, hurtTicks: opts.hurtTicks || 0 }
  let best = Infinity
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === ent || e.type !== 'hostile' || !e.position) continue
    const d = dist3(e.position, pos)
    if (d > 16 || d >= best) continue
    best = d
    threat.present = true
    threat.dist = d
    threat.bearing = bearingIndex(e.position.x - pos.x, e.position.z - pos.z, f)
    threat.hpFrac = e.health !== undefined && e.maxHealth ? e.health / e.maxHealth : null
  }

  // 自身
  const self = {
    hp: bot.health,
    food: bot.food,
    oxy: bot.oxygenLevel,
    on_ground: !!ent.onGround,
    in_water: !!ent.isInWater,
    in_lava: !!ent.isInLava,
    on_fire: !!(ent.metadata?.[0] & 1),
    sneaking: typeof bot.getControlState === 'function' && bot.getControlState('sneak') === true,
    sprinting: typeof bot.getControlState === 'function' ? bot.getControlState('sprint') === true : false,
    blocking: !!(opts.prev && opts.prev.shield),
    hurt_ticks: opts.hurtTicks || 0
  }

  const goal = normalizeGoal(opts.goal, bot, f, threat)
  const prev = normalizePrev(opts.prev)

  return { self, geom, threat, goal, prev }
}

// goal 归一化 + 从 bot 现算距离/可见性/方位
function normalizeGoal (g, bot, f, threat) {
  const out = {
    type: GOALS.includes(g && g.type) ? g.type : 'idle',
    dist: null,
    visible: false,
    targetClass: null,
    bearing: null
  }
  if (!g || g.type === 'idle' || !bot || !bot.entity) return out
  const pos = bot.entity.position
  const target = g.target
  if (!target && g.type === 'flee' && threat?.present) {
    return { ...out, dist: threat.dist, visible: true, bearing: threat.bearing }
  }
  if (!target) return out
  if (target.entityId !== undefined && target.entityId !== null) {
    const e = (bot.entities || {})[target.entityId]
    if (!e || !e.position) return out
    out.dist = dist3(e.position, pos)
    out.visible = true
    out.bearing = bearingIndex(e.position.x - pos.x, e.position.z - pos.z, f)
  } else if (target.pos) {
    const p = target.pos
    out.dist = Math.hypot(p.x - pos.x, p.y - pos.y, p.z - pos.z)
    out.visible = true
    out.bearing = bearingIndex(p.x - pos.x, p.z - pos.z, f)
    const b = blockAt(bot, p.x, p.y, p.z)
    const surf = surfaceClass(b)
    out.targetClass = surf === null ? null : terrainOf(surf, surfaceClass(blockAt(bot, p.x, p.y - 1, p.z)))
  }
  return out
}

function normalizePrev (p) {
  const out = { move: MOVE_NONE, sprint: false, jump: false, sneak: false, shield: false, attack: false, dig: false }
  if (!p) return out
  if (typeof p.move === 'number') out.move = p.move
  for (const k of ['sprint', 'jump', 'sneak', 'shield', 'attack', 'dig']) out[k] = !!p[k]
  return out
}

// ---------- 编码成 token ----------

// 结构化观测 → token 数组
function encodeLocal (s) {
  const t = []
  if (!s) return t

  // 自身
  t.push('<self>')
  t.push('hp' + hpBucket(s.self.hp))
  t.push('fd' + foodBucket(s.self.food))
  t.push('ox' + oxyBucket(s.self.oxy))
  t.push('og' + (s.self.on_ground ? 1 : 0))
  t.push('iw' + (s.self.in_water ? 1 : 0))
  t.push('il' + (s.self.in_lava ? 1 : 0))
  t.push('of' + (s.self.on_fire ? 1 : 0))
  t.push('sk' + (s.self.sneaking ? 1 : 0))
  t.push('sp' + (s.self.sprinting ? 1 : 0))
  t.push('bl' + (s.self.blocking ? 1 : 0))
  t.push('hu' + tickBucket(s.self.hurt_ticks))

  // 几何
  t.push('<geom>')
  for (let i = 0; i < s.geom.length; i++) {
    const g = s.geom[i]
    t.push('g' + i)
    for (const tr of g.terr) t.push(tr)
    const h = g.height
    t.push('gh' + i)
    t.push(h === null || h === undefined ? 'open' : String(Math.max(-PROBE_HEIGHT, Math.min(PROBE_HEIGHT, h))))
  }

  // 威胁
  t.push('<threat>')
  if (s.threat.present) {
    t.push('tb' + (s.threat.bearing === null ? 8 : s.threat.bearing))
    t.push('td' + distBucket(s.threat.dist))
    t.push('th' + (s.threat.hpFrac === null ? 3 : fracBucket(s.threat.hpFrac)))
  } else {
    t.push('tbn')
    t.push('tdf')
    t.push('thf')
  }
  t.push('tt' + tickBucket(s.threat.hurtTicks))

  // 目标
  t.push('<goal>')
  t.push('gt' + s.goal.type)
  t.push('gd' + (s.goal.dist === null ? 'n' : distBucket(s.goal.dist)))
  t.push('gv' + (s.goal.visible ? 1 : 0))
  t.push('gc' + (s.goal.targetClass || 'na'))
  t.push('gb' + (s.goal.bearing === null ? 8 : s.goal.bearing))

  // 上一动作
  t.push('<prev>')
  t.push('pm' + s.prev.move)
  t.push('ps' + (s.prev.sprint ? 1 : 0))
  t.push('pj' + (s.prev.jump ? 1 : 0))
  t.push('pk' + (s.prev.sneak ? 1 : 0))
  t.push('ph' + (s.prev.shield ? 1 : 0))
  t.push('pa' + (s.prev.attack ? 1 : 0))
  t.push('pd' + (s.prev.dig ? 1 : 0))

  return t
}

// 一步到位：bot → token
function localTokens (bot, opts = {}) {
  return encodeLocal(senseFromBot(bot, opts))
}

// L-obs 的 token 词表（给 tokenizer / 嵌入表用）
function localVocab () {
  const v = new Set(['<self>', '<geom>', '<threat>', '<goal>', '<prev>'])
  for (let i = 0; i < 7; i++) v.add('hp' + i)
  for (let i = 0; i < 6; i++) v.add('fd' + i)
  for (let i = 0; i < 4; i++) v.add('ox' + i)
  for (const k of ['og', 'iw', 'il', 'of', 'sk', 'sp', 'bl']) { v.add(k + '0'); v.add(k + '1') }
  for (let i = 0; i < 5; i++) v.add('hu' + i)
  for (let i = 0; i < 8; i++) { v.add('g' + i); v.add('gh' + i) }
  for (const tr of TERRAINS) v.add(tr)
  v.add('open')
  // 站立面高度偏移：-3..3
  for (let i = -PROBE_HEIGHT; i <= PROBE_HEIGHT; i++) v.add(String(i))
  for (let i = 0; i < 9; i++) v.add('tb' + i)
  v.add('tbn')
  for (let i = 0; i < 6; i++) v.add('td' + i)
  v.add('tdf')
  for (let i = 0; i < 4; i++) v.add('th' + i)
  v.add('thf')
  for (let i = 0; i < 5; i++) v.add('tt' + i)
  for (const g of GOALS) v.add('gt' + g)
  for (let i = 0; i < 6; i++) v.add('gd' + i)
  v.add('gdn')
  v.add('gv0'); v.add('gv1')
  for (const tr of TERRAINS) v.add('gc' + tr)
  v.add('gcna')
  for (let i = 0; i < 9; i++) v.add('gb' + i)
  for (let i = 0; i <= 8; i++) v.add('pm' + i)
  for (const k of ['ps', 'pj', 'pk', 'ph', 'pa', 'pd']) { v.add(k + '0'); v.add(k + '1') }
  return [...v].sort()
}

module.exports = {
  SURF, T, TERRAINS, GOALS, DIRS, MOVE_NONE,
  frame, bearingIndex, surfaceClass, terrainOf, blockAt, dist3,
  hpBucket, foodBucket, oxyBucket, tickBucket, distBucket, fracBucket,
  senseFromBot, encodeLocal, localTokens, localVocab, normalizeGoal, normalizePrev
}
