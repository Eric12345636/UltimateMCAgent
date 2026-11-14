'use strict'
// 动作原语表：模型能选的动词，每个动词对应一个 mc-agent-api 端点。
//
// 这张表就是「L2 落地层」的动作空间。刻意只收核心动词：
// window_act 这类复杂指令不进第一版；connect/disconnect/stop 属于 harness 权限，不给模型。
//
// 字段含义：
//   method/path        对应的 HTTP 端点
//   target             目标绑定方式：block | entity | blockOrEntity | none
//   targetRequired     目标缺失时该动作无法表达（编码直接失败，计入保真度损失）
//   targetShape        flat = {x,y,z} / {entity_id}；nested = {pos:{...}} / {entity_id:{...}}
//   literalOk          允许用字面坐标表达目标。
//                      「操作对象」（挖/放/交互的方块）必须指向看得见的候选，
//                      「目的地 / 朝向」（移动、转向、远程射击、使用物品的落点）
//                      可以用字面坐标 —— 它是从观测里抄来的，不是凭空编的。
//   item               'required' | 'optional' | false
//   extras             需要原样透传的额外参数（按 EXTRA_TYPES 解码）

// 额外参数的类型：num | bool | name
const EXTRA_TYPES = {
  range: 'num',
  collect: 'bool',
  max_hits: 'num',
  interval_ms: 'num',
  timeout: 'num',
  ms: 'num',
  count: 'num',
  charge_ms: 'num',
  yaw: 'num',
  pitch: 'num',
  slot: 'name',
  source: 'name',
  weapon: 'name',
  forward: 'bool',
  back: 'bool',
  left: 'bool',
  right: 'bool',
  jump: 'bool',
  sneak: 'bool',
  sprint: 'bool'
}

const VERBS = {
  move_to: {
    method: 'POST', path: 'move_to',
    target: 'blockOrEntity', targetRequired: true, targetShape: 'flat', literalOk: true,
    item: false, extras: ['range', 'timeout']
  },
  dig: {
    method: 'POST', path: 'dig',
    target: 'block', targetRequired: true, targetShape: 'flat', literalOk: false,
    item: false, extras: ['collect']
  },
  place: {
    method: 'POST', path: 'place',
    target: 'block', targetRequired: false, targetShape: 'flat', literalOk: false,
    item: 'required', extras: []
  },
  interact: {
    method: 'POST', path: 'interact',
    target: 'blockOrEntity', targetRequired: true, targetShape: 'flat', literalOk: false,
    item: 'optional', extras: []
  },
  attack: {
    method: 'POST', path: 'attack',
    target: 'entity', targetRequired: true, targetShape: 'flat', literalOk: false,
    item: false, extras: ['max_hits', 'interval_ms', 'timeout']
  },
  shoot: {
    method: 'POST', path: 'shoot',
    target: 'blockOrEntity', targetRequired: true, targetShape: 'flat', literalOk: true,
    item: false, extras: ['weapon', 'charge_ms']
  },
  use_item: {
    method: 'POST', path: 'use_item',
    target: 'blockOrEntity', targetRequired: false, targetShape: 'nested', literalOk: true,
    item: 'required', extras: ['ms', 'timeout', 'source']
  },
  craft: {
    method: 'POST', path: 'craft',
    target: 'none', targetRequired: false, targetShape: 'flat', literalOk: false,
    item: 'required', extras: ['count']
  },
  equip: {
    method: 'POST', path: 'equip',
    target: 'none', targetRequired: false, targetShape: 'flat', literalOk: false,
    item: 'required', extras: ['slot']
  },
  drop: {
    method: 'POST', path: 'drop',
    target: 'none', targetRequired: false, targetShape: 'flat', literalOk: false,
    item: 'required', extras: ['count']
  },
  chat: {
    method: 'POST', path: 'chat',
    target: 'none', targetRequired: false, targetShape: 'flat',
    item: false, extras: [], text: true
  },
  look: {
    method: 'POST', path: 'look',
    target: 'blockOrEntity', targetRequired: false, targetShape: 'flat', literalOk: true,
    item: false, extras: ['yaw', 'pitch']
  },
  posture: {
    method: 'POST', path: 'posture',
    target: 'none', targetRequired: false, targetShape: 'flat', literalOk: false,
    item: false, extras: ['sneak', 'shield', 'jump']
  },
  control: {
    method: 'POST', path: 'control',
    target: 'none', targetRequired: false, targetShape: 'flat', literalOk: false,
    item: false, extras: ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint', 'ms', 'yaw', 'pitch']
  },
  dismount: {
    method: 'POST', path: 'dismount',
    target: 'none', targetRequired: false, targetShape: 'flat', literalOk: false,
    item: false, extras: []
  }
}

// shield 是 posture 专用的布尔参数，EXTRA_TYPES 里没列，补上
EXTRA_TYPES.shield = 'bool'

const VERB_NAMES = Object.keys(VERBS)

module.exports = { VERBS, VERB_NAMES, EXTRA_TYPES }
