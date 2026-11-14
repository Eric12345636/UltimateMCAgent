'use strict'
// P0 状态层入口。
//
//   const { buildObservation, compress, encodeAction, decodeAction } = require('./p0')
//
// 典型用法（离线，给教师轨迹打标签）：
//   const obs = buildObservation(scenario)
//   const enc = encodeAction(call.verb, call.args, obs, { strict: true })
//   if (enc.ok) trainSample.push({ obs: compress(obs).tokens, act: enc.tokens })

const fs = require('fs')
const path = require('path')

const observe = require('./observe')
const compress = require('./compress')
const pointer = require('./pointer')
const verbs = require('./verbs')
const vocab = require('./vocab')
const format = require('./format')

const FIXTURE_FILE = path.resolve(__dirname, '../fixtures/scenarios.json')

function loadScenarios () {
  const raw = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'))
  return raw.scenarios.map(s => ({
    name: s.name,
    desc: s._desc,
    raw: {
      status: s.status,
      inventory: s.inventory,
      findBlocks: s.findBlocks,
      entities: s.entities,
      events: s.events
    },
    teacher_calls: s.teacher_calls || [],
    observation: observe.buildObservation({
      status: s.status,
      inventory: s.inventory,
      findBlocks: s.findBlocks,
      entities: s.entities,
      events: s.events
    })
  }))
}

function loadScenario (name) {
  const s = loadScenarios().find(x => x.name === name)
  if (!s) throw new Error(`没有这个场景：${name}（可用：${loadScenarios().map(x => x.name).join(', ')}）`)
  return s
}

module.exports = {
  // 观测
  buildObservation: observe.buildObservation,
  findBlockIndex: observe.findBlockIndex,
  findEntityIndex: observe.findEntityIndex,
  // 压缩
  compress: compress.compress,
  // 指针
  encodeAction: pointer.encodeAction,
  decodeAction: pointer.decodeAction,
  toRequest: pointer.toRequest,
  sameRequest: pointer.sameRequest,
  fidelity: pointer.fidelity,
  // 元信息
  VERBS: verbs.VERBS,
  VERB_NAMES: verbs.VERB_NAMES,
  vocab,
  format,
  // 夹具
  loadScenarios,
  loadScenario,
  FIXTURE_FILE
}
