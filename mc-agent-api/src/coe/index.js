'use strict'
// CoE（Chain of Experts）模块入口。
//
// 上层：LLM 下发 Skill（意图）
// 下层：训练出来的反射策略，20 Hz 逐 tick 输出控制向量
// 中间：SkillBus（队列）+ Controller（仲裁 + 执行）
//
// 详见工作区根目录的 COE.md。

const { Controller, TICK_MS } = require('./controller')
const { SkillBus } = require('./skillbus')
const { createPolicy } = require('./policy')
const { Recorder } = require('./record')
const { Planner, OllamaClient } = require('./llm')
const skills = require('./skills')
const local = require('./local')
const fs = require('fs')
const path = require('path')

let config = null
const attaching = new WeakMap()

function configure (opts) {
  config = opts.config
}

// 读 L-obs 词表：token -> id。训练侧（p1/）读的是同一个文件。
function loadVocab (file) {
  const p = file || path.resolve(__dirname, 'local-vocab.json')
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
  const list = Array.isArray(raw) ? raw : raw.tokens
  const map = new Map()
  list.forEach((t, i) => map.set(t, i))
  return map
}

// 给一个 session 装上下层控制器。
// 控制器是**进程内**的：它直接持有 bot，不经过 HTTP，因此不受动作锁的往返延迟约束。
async function attachController (session, opts = {}) {
  if (session.controller) return session.controller
  if (attaching.has(session)) return attaching.get(session).promise
  const pending = { cancelled: false }
  attaching.set(session, pending)
  pending.promise = createController(session, opts, pending)
  try {
    return await pending.promise
  } finally {
    if (attaching.get(session) === pending) attaching.delete(session)
  }
}

async function createController (session, opts, pending) {
  const coeCfg = (config && config.coe) || {}
  const kind = opts.kind || coeCfg.policy || 'rule'
  const modelPath = opts.path || coeCfg.modelPath || null
  let vocab = opts.vocab || null
  if (kind === 'onnx' && !vocab) {
    try {
      vocab = loadVocab(coeCfg.vocabPath || null)
    } catch (e) {
      console.log('[COE] 读词表失败：', e.message)
      vocab = null
    }
  }
  const policy = opts.policy || await createPolicy({ kind, path: modelPath, vocab })
  if (pending.cancelled || session.destroyed) {
    await policy.close?.()
    throw new Error('CoE attach cancelled')
  }
  const controller = new Controller(session, { policy, queueSize: opts.queueSize || coeCfg.queueSize || 4 })

  // 上层规划器（问本地 Ollama 要技能）
  const llmCfg = coeCfg.llm || {}
  if (llmCfg.enabled) {
    const client = new OllamaClient({
      endpoint: llmCfg.endpoint,
      model: llmCfg.model,
      keepAlive: llmCfg.keepAlive,
      timeoutMs: llmCfg.timeoutMs,
      temperature: llmCfg.temperature,
      maxTokens: llmCfg.maxTokens
    })
    controller.setPlanner(new Planner({ client, systemPrompt: llmCfg.systemPrompt, maxSkills: llmCfg.maxSkills }))
  }

  // 走 Session 的挂载口：它负责在 bot 已经连上时立刻接管
  session.attachController(controller)
  return controller
}

function detachController (session) {
  const pending = attaching.get(session)
  if (pending) {
    pending.cancelled = true
    attaching.delete(session)
  }
  const attached = !!session.controller
  session.detachController()
  return attached || !!pending
}

module.exports = {
  configure,
  attachController,
  detachController,
  loadVocab,
  Controller,
  SkillBus,
  Recorder,
  Planner,
  OllamaClient,
  createPolicy,
  skills,
  local,
  TICK_MS
}
