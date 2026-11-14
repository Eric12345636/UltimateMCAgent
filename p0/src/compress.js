'use strict'
// 压缩层：把规范化观测压成一串紧凑 token。
//
// 布局（字段顺序固定，模型好学）：
//   <s>
//   pos x y z | yaw | dim | gm | hp | food | sat | xp lv pr | arm | oxy
//   held | off | snk shd jmp | fire wat sub lava | ride
//   time | day | rain | biome | alive ready busy | near
//   eff ...          （药水效果，可关）
//   inv name cnt ... （背包）
//   blk i name x y z dist [prop k v ...]
//   ent i name id x y z dist [hp n]
//   ev type v...     （最近事件）
//   </s>
//
// 名字统一走 N<id>（见 vocab.js），数字单独成 token。

const V = require('./vocab')
const { OBS_START, OBS_END, EVENT_FIELDS, textToken } = require('./format')

const DEFAULTS = {
  includeEffects: true,
  includeEvents: true,
  includeInventory: true,
  includeBlocks: true,
  includeEntities: true,
  includeProperties: true,
  includeArmor: false      // 护甲四件比较占位置，第一版先关
}

function push (t, ...xs) { for (const x of xs) t.push(x) }

function compress (obs, opts = {}) {
  const o = { ...DEFAULTS, ...opts }
  const s = obs.status || {}
  const t = [OBS_START]
  const sections = {}

  // ---- 自身状态 ----
  const st = []
  const pos = s.pos || []
  push(st, 'pos', V.num(pos[0]), V.num(pos[1]), V.num(pos[2]))
  push(st, 'yaw', V.num(s.yaw))
  push(st, 'dim', V.nameToken(s.dimension))
  push(st, 'gm', V.nameToken(s.gamemode))
  push(st, 'hp', V.num(s.health))
  push(st, 'food', V.num(s.food))
  push(st, 'sat', V.num(s.saturation))
  push(st, 'xp', V.num(s.xp_level), V.num(s.xp_progress))
  push(st, 'arm', V.num(s.armor_points))
  push(st, 'oxy', V.num(s.oxygen))
  push(st, 'held', V.nameToken(s.held && s.held.name))
  push(st, 'off', V.nameToken(s.offhand && s.offhand.name))
  push(st, 'snk', V.bool(s.sneaking))
  push(st, 'shd', V.bool(s.blocking))
  push(st, 'jmp', V.bool(s.jumping))
  push(st, 'fire', V.bool(s.on_fire))
  push(st, 'wat', V.bool(s.in_water))
  push(st, 'sub', V.bool(s.submerged))
  push(st, 'lava', V.bool(s.in_lava))
  push(st, 'ride', V.nameToken(s.in_vehicle && s.in_vehicle.name))
  push(st, 'time', V.num(s.time_of_day))
  push(st, 'day', V.bool(s.is_day))
  push(st, 'rain', V.bool(s.raining))
  push(st, 'biome', V.nameToken(s.biome))
  push(st, 'alive', V.bool(s.alive))
  push(st, 'ready', V.bool(s.ready))
  push(st, 'busy', V.nameToken(s.busy))
  if (s.nearest_hostile) push(st, 'near', V.nameToken(s.nearest_hostile.name), V.num(s.nearest_hostile.dist))
  t.push(...st)
  sections.self = st.length

  // ---- 药水效果 ----
  if (o.includeEffects && Array.isArray(s.effects) && s.effects.length) {
    const ef = []
    for (const e of s.effects) {
      push(ef, 'eff', V.nameToken(e.name), V.num(e.level), V.num(e.duration_s))
    }
    t.push(...ef)
    sections.effects = ef.length
  }

  // ---- 背包 ----
  if (o.includeInventory && obs.inventory && obs.inventory.items.length) {
    const iv = ['inv']
    for (const it of obs.inventory.items) {
      push(iv, V.nameToken(it.name), V.num(it.count))
    }
    t.push(...iv)
    sections.inventory = iv.length
  }

  // ---- 候选方块 ----
  if (o.includeBlocks && obs.blocks.length) {
    const bl = []
    obs.blocks.forEach((b, i) => {
      push(bl, 'blk', String(i), V.nameToken(b.name), V.num(b.pos[0]), V.num(b.pos[1]), V.num(b.pos[2]), V.num(b.dist))
      if (o.includeProperties && b.properties) {
        for (const [k, val] of Object.entries(b.properties)) {
          push(bl, 'prop', V.nameToken(k), V.nameToken(String(val)))
        }
      }
    })
    t.push(...bl)
    sections.blocks = bl.length
  }

  // ---- 候选实体 ----
  if (o.includeEntities && obs.entities.length) {
    const en = []
    obs.entities.forEach((e, i) => {
      push(en, 'ent', String(i), V.nameToken(e.name), String(e.id),
        V.num(e.pos[0]), V.num(e.pos[1]), V.num(e.pos[2]), V.num(e.dist))
      if (e.health !== undefined) push(en, 'hp', V.num(e.health))
    })
    t.push(...en)
    sections.entities = en.length
  }

  // ---- 最近事件 ----
  if (o.includeEvents && obs.events.length) {
    const ev = []
    for (const e of obs.events) {
      const fields = EVENT_FIELDS[e.type] || []
      push(ev, 'ev', V.nameToken(e.type))
      for (const [f, kind] of fields) {
        const val = e[f]
        if (val === undefined || val === null) { push(ev, '-'); continue }
        if (kind === 'num') push(ev, V.num(val))
        else if (kind === 'name') push(ev, V.nameToken(val))
        else if (typeof val === 'object') push(ev, textToken(JSON.stringify(val)))
        else push(ev, textToken(val))
      }
    }
    t.push(...ev)
    sections.events = ev.length
  }

  t.push(OBS_END)
  return {
    tokens: t,
    text: t.join(' '),
    stats: {
      total: t.length,
      sections,
      blockCount: obs.blocks.length,
      entityCount: obs.entities.length,
      inventoryCount: obs.inventory.items.length
    }
  }
}

module.exports = { compress, DEFAULTS }
