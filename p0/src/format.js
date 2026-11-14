'use strict'
// 紧凑 token 的格式常量。
//
// 设计原则：所有 token 都来自一个有界词表（见 data/vocab.json），
// 数字单独成 token，名字统一用 N<id> 编码。这样后续无论用 BPE 还是直接 softmax
// 都不会遇到无界词表。

const OBS_START = '<s>'
const OBS_END = '</s>'
const ACT_START = '<a>'
const ACT_END = '</a>'

// 未知名字（自定义物品等）走 X<原文>，保证不丢信息
const UNKNOWN_NAME_PREFIX = 'X'

// 指针：b<idx> 指向候选方块，e<idx> 指向候选实体
const BLOCK_PTR = /^b(\d+)$/
const ENTITY_PTR = /^e(\d+)$/

// 自状态字段名（顺序固定，压缩时按此顺序输出）
const SELF_FIELDS = [
  'pos', 'yaw', 'dim', 'gm', 'hp', 'food', 'sat', 'xp', 'arm', 'oxy',
  'held', 'off', 'snk', 'shd', 'jmp', 'fire', 'wat', 'sub', 'lava', 'ride',
  'time', 'day', 'rain', 'biome', 'alive', 'ready', 'busy', 'near'
]

// 事件类型的定长参数表：type -> [[字段名, 取值类型], ...]
// 取值类型：num（数字）| name（游戏里的名字，走词表）| text（自由文本）
const EVENT_FIELDS = {
  hurt: [['health', 'num'], ['damage', 'num'], ['source', 'name']],
  death: [],
  spawn: [],
  pickup: [['item', 'name'], ['count', 'num']],
  effect_start: [['name', 'name'], ['level', 'num'], ['duration_s', 'num']],
  effect_end: [['name', 'name']],
  sleep: [],
  wake: [],
  vehicle: [['action', 'text'], ['name', 'name']],
  kicked: [['reason', 'text']],
  disconnected: [['reason', 'text']],
  death_loop: [['deaths', 'num']],
  server_confirmed: [['via', 'text']],
  chat: [['text', 'text']],
  // CoE 下层控制器上报的事件（见 mc-agent-api/src/coe/ 与工作区 COE.md）
  // skill / reason 是封闭的标识符集合，不是 MC 里的方块名，所以走 text 而不是 name：
  // 这样不用把词表和技能表耦合起来，也不会丢信息。
  skill_start: [['skill', 'text']],
  skill_done: [['skill', 'text'], ['ms', 'num']],
  skill_failed: [['skill', 'text'], ['reason', 'text']],
  override: [['reason', 'text'], ['from_skill', 'text']],
  controller_ready: [['policy', 'text']]
}

// 文本类字段压缩成单 token：去空白 + 下划线连接 + 截断
function textToken (text, max = 48) {
  if (text === undefined || text === null) return '-'
  const s = String(text).replace(/\s+/g, '_').slice(0, max)
  return s || '-'
}

module.exports = {
  OBS_START, OBS_END, ACT_START, ACT_END,
  UNKNOWN_NAME_PREFIX, BLOCK_PTR, ENTITY_PTR,
  SELF_FIELDS, EVENT_FIELDS, textToken
}
