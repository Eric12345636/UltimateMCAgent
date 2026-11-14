'use strict'
// 生成 data/vocab.json —— 紧凑 token 用的名字词表。
//
//   node tools/build-vocab.js
//
// 词表来源：
//   - minecraft-data 1.21.11 的方块 / 物品 / 实体 / 效果 / 生物群系表
//   - 本仓库的错误码、事件类型、维度、游戏模式（手写清单，跟 docs/API.md 对齐）
//
// minecraft-data 的查找顺序：p0/node_modules → ../mc-agent-api/node_modules → $MC_DATA_PATH
// 生成结果已提交，日常开发不需要跑这个脚本。

const fs = require('fs')
const path = require('path')

const VERSION = '1.21.11'

function loadMcData () {
  const candidates = [
    'minecraft-data',
    path.resolve(__dirname, '../../mc-agent-api/node_modules/minecraft-data'),
    path.resolve(__dirname, '../node_modules/minecraft-data')
  ]
  if (process.env.MC_DATA_PATH) candidates.unshift(process.env.MC_DATA_PATH)
  const errors = []
  for (const c of candidates) {
    try {
      return require(c)
    } catch (e) {
      errors.push(`${c}: ${e.message.split('\n')[0]}`)
    }
  }
  throw new Error(
    '找不到 minecraft-data。装一个再跑：\n  npm i -D minecraft-data@3.117.0\n或设置 MC_DATA_PATH 指向已有安装。\n尝试过：\n  ' +
    errors.join('\n  ')
  )
}

// —— 手写清单：跟 mc-agent-api 的 docs/API.md 和 src/ 保持一致 ——
const ERROR_CODES = [
  'invalid_credentials', 'no_profile', 'rate_limited', 'unauthorized', 'invalid_token',
  'not_connected', 'wrong_server', 'not_ready', 'death_loop_cooldown', 'busy', 'dead',
  'interrupted', 'path_not_found', 'timeout', 'out_of_reach', 'out_of_range',
  'no_such_entity', 'missing_item', 'missing_ammo', 'missing_ingredients',
  'need_crafting_table', 'need_furnace', 'no_recipe',
  'no_support', 'occupied', 'place_failed', 'blocked_by_self', 'protected_region',
  'nothing_to_dig', 'undiggable', 'use_window_api', 'cannot_interact', 'cannot_use',
  'need_block_target', 'not_hungry', 'not_in_vehicle', 'dismount_failed', 'not_loaded',
  'stalled', 'bad_args', 'bad_json', 'unknown_api', 'internal', 'auth_error'
]

const EVENT_TYPES = [
  'chat', 'hurt', 'death', 'spawn', 'pickup', 'effect_start', 'effect_end',
  'sleep', 'wake', 'vehicle', 'kicked', 'disconnected', 'death_loop',
  'server_confirmed', 'reconnect', 'reconnect_failed'
]

const DIMENSIONS = ['overworld', 'the_nether', 'the_end']

const GAME_MODES = ['survival', 'creative', 'adventure', 'spectator']

// 方块属性名 / 常见属性值（minecraft-data 的 states 里名字不统一，手工补齐高频的）
const BLOCK_PROPERTIES = [
  'axis', 'facing', 'half', 'shape', 'waterlogged', 'lit', 'age', 'stage', 'level',
  'snowy', 'east', 'north', 'south', 'west', 'up', 'down', 'open', 'moisture',
  'variant', 'rotation', 'tilt', 'tilted', 'open_bit', 'has_bookshelf', 'powered',
  'triggered', 'attached', 'unstable', 'distance', 'east_west', 'north_south',
  'x', 'y', 'z', 'face', 'mode', 'reason', 'segments', 'part', 'orientation'
]

const PROPERTY_VALUES = [
  'y', 'x', 'z', 'north', 'south', 'east', 'west', 'up', 'down',
  'top', 'bottom', 'single', 'double', 'left', 'right', 'front', 'back',
  'straight', 'bent', 'unstraight', 'inscribed', 'outer', 'middle', 'none',
  'true', 'false', 'small', 'large', 'normal', 'thin', 'thick', 'idle',
  'has_grass', 'has_vines', 'has_rails', 'has_dirt', 'wet', 'dry'
]

// 动作原语名（模型要能选这些动词）
const VERBS = [
  'move_to', 'dig', 'place', 'interact', 'attack', 'shoot', 'use_item', 'craft',
  'equip', 'drop', 'chat', 'look', 'posture', 'control', 'dismount', 'stop',
  'window_view', 'window_act'
]

// 原版伤害类型（hurt 事件的 source 字段）
const DAMAGE_TYPES = [
  'fall', 'mob_attack', 'drown', 'in_fire', 'in_wall', 'starve', 'void',
  'lightning', 'out_of_world', 'magic', 'wither', 'cactus', 'lava', 'explosion',
  'suffocation', 'entity_attack', 'player_attack', 'indirect_magic', 'generic',
  'sonic_boom', 'bad_respawn_point', 'dry_out', 'sweet_berry_bush', 'falling_block'
]

// 装备槽位
const SLOTS = ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']

function collect (mcData) {
  const names = new Set()

  for (const k of Object.keys(mcData.blocksByName || {})) names.add(k)
  for (const k of Object.keys(mcData.itemsByName || {})) names.add(k)
  for (const k of Object.keys(mcData.biomesByName || {})) names.add(k)
  for (const k of Object.keys(mcData.effectsByName || {})) names.add(k.toLowerCase())
  for (const k of Object.keys(mcData.enchantmentsByName || {})) names.add(k.toLowerCase())
  for (const k of Object.keys(mcData.foodsByName || {})) names.add(k)

  // 实体：minecraft-data 按 id 索引，名字在 .name（形如 minecraft:zombie）
  for (const e of Object.values(mcData.entities || {})) {
    if (e && typeof e.name === 'string') names.add(e.name.replace(/^minecraft:/, ''))
  }

  for (const k of ERROR_CODES) names.add(k)
  for (const k of EVENT_TYPES) names.add(k)
  for (const k of DIMENSIONS) names.add(k)
  for (const k of GAME_MODES) names.add(k)
  for (const k of BLOCK_PROPERTIES) names.add(k)
  for (const k of PROPERTY_VALUES) names.add(k)
  for (const k of VERBS) names.add(k)
  for (const k of DAMAGE_TYPES) names.add(k)
  for (const k of SLOTS) names.add(k)

  return [...names].filter(Boolean).sort()
}

function main () {
  const mcData = loadMcData()
  const data = mcData(VERSION)
  const names = collect(data)
  const ids = {}
  names.forEach((n, i) => { ids[n] = i })

  const out = {
    version: VERSION,
    protocol: data.version && data.version.version,
    names: ids,
    ids: names,
    meta: {
      nameCount: names.length,
      blockCount: Object.keys(data.blocksByName || {}).length,
      itemCount: Object.keys(data.itemsByName || {}).length,
      entityCount: Object.keys(data.entities || {}).length,
      biomeCount: Object.keys(data.biomesByName || {}).length
    }
  }

  const file = path.resolve(__dirname, '../data/vocab.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(out))
  console.log('vocab written:', file)
  console.log('  names      =', out.meta.nameCount)
  console.log('  blocks     =', out.meta.blockCount)
  console.log('  items      =', out.meta.itemCount)
  console.log('  entities   =', out.meta.entityCount)
  console.log('  biomes     =', out.meta.biomeCount)
  console.log('  protocol   =', out.protocol)
}

main()
