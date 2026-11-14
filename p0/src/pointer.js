'use strict'
// 指针层：把「一个 API 调用」和「一串紧凑 token」互相转换。
//
//   encodeAction(verb, args, obs)  →  tokens      （真实调用 → 训练标签）
//   decodeAction(tokens, obs)      →  {verb,args} （模型输出 → 真实调用）
//   toRequest(verb, args)          →  {method,path,body}
//
// 核心思想：坐标和实体 id 不让模型自由生成，而是指向观测里的候选表。
//   b<i>   第 i 个候选方块（位置从 obs.blocks[i].pos 取）
//   e<i>   第 i 个候选实体（id 从 obs.entities[i].id 取）
//   p x y z   字面坐标（严格模式外才用）
//   q <id>    字面实体 id（严格模式外才用）
//   px x z    只给水平坐标（move_to 省略 y 时用，语义和给 y 不同，必须区分）
//
// 两种模式：
//   strict = true（默认，给数据集打标签用）：目标必须在候选表里，否则编码失败。
//     这是"可达性"指标 —— 模型看不到的目标它学不会，也不该被当成可学的样本。
//   strict = false：允许字面回退，用来测"可表达性"。

const V = require('./vocab')
const { VERBS, EXTRA_TYPES } = require('./verbs')
const { ACT_START, ACT_END, BLOCK_PTR, ENTITY_PTR, UNKNOWN_NAME_PREFIX, textToken } = require('./format')
const { findBlockIndex, findEntityIndex, toPos } = require('./observe')

// ---------------- 编码 ----------------

function encodeTarget (spec, args, obs, strict) {
  // 返回 {tokens:[...]} 或 {error}
  const nested = spec.targetShape === 'nested'
  let entityId
  let pos
  let yOmitted = false

  if (nested) {
    const t = args.target
    if (!t) return { tokens: [] }
    if (t.entity_id !== undefined && t.entity_id !== null) entityId = t.entity_id
    else pos = toPos(t.pos || t)
  } else {
    if (args.entity_id !== undefined && args.entity_id !== null) entityId = args.entity_id
    else if (args.pos !== undefined || args.x !== undefined) {
      // move_to 省略 y 时语义是"只走 XZ"，和给 y 不同，不能用带 y 的候选去匹配
      yOmitted = spec.path === 'move_to' && args.y == null && args.pos === undefined
      // yOmitted 时 y 位置留 null，不参与数值校验
      pos = yOmitted
        ? [Number(args.x), null, Number(args.z)]
        : toPos(args.pos || args)
    }
  }

  // 实体优先（API 里 entity_id 和坐标互斥）
  if (entityId !== undefined) {
    if (spec.target === 'block' || !Number.isSafeInteger(Number(entityId))) return { error: '无效的实体目标' }
    const i = findEntityIndex(obs, entityId)
    if (i >= 0) return { tokens: ['t', 'e' + i] }
    if (strict) return { error: `entity ${entityId} 不在候选表里` }
    return { tokens: ['t', 'q', String(entityId)] }
  }

  if (pos) {
    if (spec.target === 'entity') return { error: '该动作需要实体目标' }
    if (yOmitted) {
      // 只给水平坐标：永远用 px 字面形式，语义和"给 y 的移动"不同
      if (!Number.isFinite(pos[0]) || !Number.isFinite(pos[2])) return { error: 'move_to 的 x/z 必须是数字' }
      return { tokens: ['t', 'px', V.num(pos[0]), V.num(pos[2])] }
    }
    if (!pos.every(Number.isFinite)) return { error: '坐标必须是有限数字' }
    const i = findBlockIndex(obs, pos)
    if (i >= 0) return { tokens: ['t', 'b' + i] }
    if (strict && !spec.literalOk) return { error: `坐标 ${pos.join(',')} 不在候选表里` }
    return { tokens: ['t', 'p', V.num(pos[0]), V.num(pos[1]), V.num(pos[2])] }
  }

  // 没有目标：place 不给坐标就是"自动找落点"，是合法的
  if (spec.targetRequired) return { error: `${spec.path} 需要目标` }
  return { tokens: [] }
}

function encodeAction (verb, args, obs, opts = {}) {
  const strict = opts.strict !== false
  const spec = Object.hasOwn(VERBS, verb) ? VERBS[verb] : null
  if (!spec) return { ok: false, error: `未知动作 ${verb}`, tokens: [] }

  const a = args || {}
  const tokens = [ACT_START, verb]

  if (spec.target !== 'none') {
    const t = encodeTarget(spec, a, obs, strict)
    if (t.error) return { ok: false, error: t.error, tokens: [] }
    tokens.push(...t.tokens)
  }

  if (spec.item === 'required') {
    if (!a.item) return { ok: false, error: `${verb} 需要 item`, tokens: [] }
    tokens.push('item', V.nameToken(a.item))
  } else if (spec.item === 'optional') {
    if (a.item) tokens.push('item', V.nameToken(a.item))
  }

  if (spec.text) {
    if (typeof a.message !== 'string') return { ok: false, error: 'chat 需要 message', tokens: [] }
    tokens.push('msg', textToken(a.message))
  }

  for (const key of spec.extras) {
    if (a[key] === undefined) continue
    const type = EXTRA_TYPES[key] || 'num'
    if (type === 'bool') {
      // posture 是"全量设置"语义：只写 true 的开关，缺省就等于 false
      if (verb === 'posture' && !a[key]) continue
      tokens.push(key, V.bool(a[key]))
    } else if (type === 'name') tokens.push(key, V.nameToken(a[key]))
    else tokens.push(key, V.num(a[key]))
  }

  tokens.push(ACT_END)
  return { ok: true, tokens, verb }
}

// ---------------- 解码 ----------------

function parseActionTokens (tokens) {
  if (!Array.isArray(tokens) || tokens.some(t => typeof t !== 'string')) return null
  const t = tokens
  const start = t.indexOf(ACT_START)
  const end = t.indexOf(ACT_END)
  const body = t.slice(start >= 0 ? start + 1 : 0, end >= 0 ? end : t.length)
  if (!body.length) return null
  const verb = body[0]
  const out = { verb, target: null, item: null, text: null, extras: {} }
  let i = 1
  while (i < body.length) {
    const k = body[i]
    if (i + 1 >= body.length) return null
    if (k === 't') {
      if (out.target) return null
      const kind = body[i + 1]
      if (kind === 'p') { out.target = { kind: 'pos', pos: [parseNumber(body[i + 2]), parseNumber(body[i + 3]), parseNumber(body[i + 4])] }; i += 5 }
      else if (kind === 'px') { out.target = { kind: 'posxz', x: parseNumber(body[i + 2]), z: parseNumber(body[i + 3]) }; i += 4 }
      else if (kind === 'q') { out.target = { kind: 'entityid', id: parseNumber(body[i + 2]) }; i += 3 }
      else if (BLOCK_PTR.test(kind)) { out.target = { kind: 'block', index: Number(kind.slice(1)) }; i += 2 }
      else if (ENTITY_PTR.test(kind)) { out.target = { kind: 'entity', index: Number(kind.slice(1)) }; i += 2 }
      else return null
    } else if (k === 'item') {
      if (out.item !== null) return null
      out.item = decodeName(body[i + 1])
      if (!out.item) return null
      i += 2
    } else if (k === 'msg') {
      if (out.text !== null) return null
      out.text = body[i + 1]
      i += 2
    } else {
      if (!Object.hasOwn(EXTRA_TYPES, k) || Object.hasOwn(out.extras, k)) return null
      out.extras[k] = body[i + 1]
      i += 2
    }
  }
  return out
}

function parseNumber (token) {
  return token?.trim() ? Number(token) : NaN
}

function decodeName (token) {
  if (/^N\d+$/.test(token)) return V.name(Number(token.slice(1)))
  if (token.startsWith(UNKNOWN_NAME_PREFIX)) return token.slice(UNKNOWN_NAME_PREFIX.length)
  return null
}

function decodeAction (tokens, obs) {
  const p = parseActionTokens(tokens)
  if (!p) return null
  const spec = Object.hasOwn(VERBS, p.verb) ? VERBS[p.verb] : null
  if (!spec) return null
  if ((spec.targetRequired && !p.target) || (spec.target === 'none' && p.target)) return null
  if ((!spec.item && p.item) || (!spec.text && p.text !== null)) return null
  if (Object.keys(p.extras).some(key => !spec.extras.includes(key))) return null
  const args = {}

  if (spec.target !== 'none' && p.target) {
    const t = p.target
    const entityTarget = t.kind === 'entity' || t.kind === 'entityid'
    if ((entityTarget && spec.target === 'block') || (!entityTarget && spec.target === 'entity')) return null
    if (t.kind === 'block') {
      const b = obs?.blocks?.[t.index]
      if (!b) return null
      if (spec.targetShape === 'nested') {
        args.target = { pos: b.pos.slice() }
      } else {
        args.x = b.pos[0]; args.y = b.pos[1]; args.z = b.pos[2]
      }
    } else if (t.kind === 'entity') {
      const e = obs?.entities?.[t.index]
      if (!e) return null
      if (spec.targetShape === 'nested') args.target = { entity_id: e.id }
      else args.entity_id = e.id
    } else if (t.kind === 'pos') {
      if (!t.pos.every(Number.isFinite)) return null
      if (spec.targetShape === 'nested') {
        args.target = { pos: t.pos.slice() }
      } else {
        args.x = t.pos[0]; args.y = t.pos[1]; args.z = t.pos[2]
      }
    } else if (t.kind === 'posxz') {
      if (spec.path !== 'move_to' || ![t.x, t.z].every(Number.isFinite)) return null
      args.x = t.x; args.z = t.z
    } else if (t.kind === 'entityid') {
      if (!Number.isSafeInteger(t.id)) return null
      if (spec.targetShape === 'nested') args.target = { entity_id: t.id }
      else args.entity_id = t.id
    } else {
      return null
    }
  }

  if (spec.item === 'required') {
    if (!p.item) return null
    args.item = p.item
  } else if (spec.item === 'optional') {
    if (p.item) args.item = p.item
  }
  if (spec.text) {
    if (p.text === null) return null
    args.message = String(p.text).replace(/_/g, ' ')
  }

  for (const key of spec.extras) {
    if (!(key in p.extras)) continue
    const type = EXTRA_TYPES[key] || 'num'
    const raw = p.extras[key]
    if (type === 'bool') {
      if (raw !== '0' && raw !== '1') return null
      args[key] = raw === '1'
    } else if (type === 'name') {
      args[key] = decodeName(raw)
      if (!args[key]) return null
    } else {
      args[key] = parseNumber(raw)
      if (!Number.isFinite(args[key])) return null
    }
  }

  return { verb: p.verb, args }
}

// ---------------- 请求组装 ----------------

function toRequest (verb, args) {
  const spec = Object.hasOwn(VERBS, verb) ? VERBS[verb] : null
  if (!spec) return null
  const body = {}
  for (const [k, v] of Object.entries(args || {})) {
    if (v === undefined) continue
    body[k] = v
  }
  return { method: spec.method, path: spec.path, body }
}

// 语义归一：posture 是"全量设置"，没写的字段就是 false，
// 所以 {sneak:true} 和 {sneak:true,shield:false,jump:false} 是同一个意思，比对前先归一。
function normalizeBody (verb, body) {
  if (verb === 'posture') {
    const out = {}
    for (const [k, v] of Object.entries(body)) if (v) out[k] = v
    return out
  }
  return body
}

// 语义比较：把 body 里的键排序后比 JSON，忽略 undefined
function sameRequest (a, b) {
  if (!a || !b) return false
  if (a.method !== b.method || a.path !== b.path) return false
  const norm = (verb, o) => {
    const src = normalizeBody(verb, o)
    return JSON.stringify(Object.keys(src).sort().reduce((acc, k) => { acc[k] = src[k]; return acc }, {}))
  }
  return norm(a.path, a.body) === norm(b.path, b.body)
}

// ---------------- 保真度 ----------------

// cases: [{verb, args}]  —— 一批真实调用
// 返回 reachable（严格，指针可达） 与 expressible（宽松，字面可表达）两个比率
function fidelity (cases, obs, opts = {}) {
  const failures = []
  let reachable = 0
  let expressible = 0
  for (const c of cases) {
    const strictEnc = encodeAction(c.verb, c.args, obs, { strict: true })
    const looseEnc = encodeAction(c.verb, c.args, obs, { strict: false })
    const original = toRequest(c.verb, c.args)

    let rOk = false
    if (strictEnc.ok) {
      const dec = decodeAction(strictEnc.tokens, obs)
      rOk = !!dec && sameRequest(toRequest(dec.verb, dec.args), original)
    }
    let eOk = false
    if (looseEnc.ok) {
      const dec = decodeAction(looseEnc.tokens, obs)
      eOk = !!dec && sameRequest(toRequest(dec.verb, dec.args), original)
    }
    if (rOk) reachable++
    if (eOk) expressible++
    if (!rOk) {
      failures.push({
        verb: c.verb,
        args: c.args,
        reason: strictEnc.error || (looseEnc.ok ? '还原后请求不一致' : looseEnc.error),
        looseOk: eOk
      })
    }
  }
  const total = cases.length
  return {
    total,
    reachable,
    expressible,
    reachableRate: total ? reachable / total : 0,
    expressibleRate: total ? expressible / total : 0,
    failures
  }
}

module.exports = {
  encodeAction, decodeAction, toRequest, sameRequest, normalizeBody, fidelity, parseActionTokens
}
