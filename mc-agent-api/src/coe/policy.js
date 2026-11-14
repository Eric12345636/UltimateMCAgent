'use strict'
// 下层反射策略。
//
// v0 = 规则实现。它不是「凑合的模型」，而是**基线**：Phase 1 要用它拿到反应延迟的基线数字，
//      没有基线，Phase 2/3 训出来的模型就没法判断好坏。
// v1 = 训练好的 ONNX 模型（GRU），训练在 p1/，导出后由 onnxruntime-node 推理。
//
// 策略的输出是**控制向量**，不是 API 调用：
//   move        9 向（局部坐标系：0=N 1=NE 2=E 3=SE 4=S 5=SW 6=W 7=NW 8=不动）
//   sprint/jump/sneak/shield/attack/use/dig  布尔
//   yaw_delta/pitch_delta  弧度增量（分箱后反量化）
//
// 原则：**不把「对准目标」交给模型**。正对着方块挖是确定性任务，交给控制器做，
// 模型只负责「什么时候转、转多少去躲」。

const { MOVE_NONE } = require('./local')
const ESCAPE_TERRAIN = new Set(['flat', 'climb', 'liq'])

// 地面类别的「好不好走」评分，用于挑逃跑方向
const TERRAIN_SCORE = {
  flat: 4,
  climb: 3,
  liq: 1,
  wall: -1,
  hole: -3,
  magma: -8,
  haz: -10
}

function emptyAction () {
  return {
    move: MOVE_NONE,
    sprint: false,
    jump: false,
    sneak: false,
    shield: false,
    attack: false,
    use: false,
    yaw_delta: 0,
    pitch_delta: 0,
    dig: false
  }
}

// 方向下标 → WASD 组合
function moveKeys (move) {
  const k = { forward: false, back: false, left: false, right: false }
  switch (move) {
    case 0: k.forward = true; break
    case 1: k.forward = true; k.right = true; break
    case 2: k.right = true; break
    case 3: k.back = true; k.right = true; break
    case 4: k.back = true; break
    case 5: k.back = true; k.left = true; break
    case 6: k.left = true; break
    case 7: k.forward = true; k.left = true; break
    default: break
  }
  return k
}

// 反方向
const opposite = i => (i === null || i === undefined || i === MOVE_NONE) ? null : (i + 4) % 8

// 挑一个「最值得走」的方向：地形分高、且尽量远离 avoid 方向
function dangerAhead (geom, dir) {
  const g = geom[dir]
  if (!g) return true
  for (let k = 0; k < Math.min(2, g.terr.length); k++) {
    const t = g.terr[k]
    if (t === 'hole' || t === 'haz' || t === 'magma') return true
  }
  return false
}

function bestDir (geom, avoid, requireFooting = false, opts = {}) {
  const forbid = opts.forbid || null
  let best = MOVE_NONE
  let bestScore = -Infinity
  for (let i = 0; i < 8; i++) {
    const g = geom[i]
    if (!g) continue
    if (forbid && forbid.has(g.terr[0])) continue
    if (requireFooting && !ESCAPE_TERRAIN.has(g.terr[0])) continue
    let score = 0
    for (let k = 0; k < g.terr.length; k++) {
      score += (TERRAIN_SCORE[g.terr[k]] !== undefined ? TERRAIN_SCORE[g.terr[k]] : 0) * (1 - k * 0.18)
    }
    if (avoid !== null && avoid !== undefined && avoid !== MOVE_NONE) {
      const d = Math.min((i - avoid + 8) % 8, (avoid - i + 8) % 8)
      if (d === 4) score += 6      // 正对面
      else if (d === 3 || d === 5) score += 2
    }
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  }
  // 四周都被禁止时退回普通选向，总比停在岩浆或水里强
  if (best === MOVE_NONE && forbid) return bestDir(geom, avoid, requireFooting)
  return best
}

// 正前方是否通畅（用来决定要不要冲刺）
function clearAhead (geom, dir) {
  const g = geom[dir]
  if (!g) return false
  for (let k = 0; k < Math.min(2, g.terr.length); k++) {
    const t = g.terr[k]
    if (t === 'wall' || t === 'hole' || t === 'magma' || t === 'haz') return false
  }
  return true
}

// 前方是墙或洞时挑一个能绕的侧向。洞不能当绕路，否则会从坑边走进坑。
function pickSide (geom, dir) {
  const right = (dir + 1) % 8
  const left = (dir + 7) % 8
  const ok = d => {
    const g = geom[d]
    return g && g.terr[0] !== 'wall' && !dangerAhead(geom, d)
  }
  if (ok(right)) return right
  if (ok(left)) return left
  return MOVE_NONE
}

// 站在实地上、下一步会踩空或踩岩浆时潜行。水里潜行是下沉，不能用。
function maybeSneak (a, s, geom) {
  if (!s.on_ground || s.in_water || s.in_lava || s.on_fire) return a
  const dir = (a.move === MOVE_NONE || a.move === null || a.move === undefined) ? 0 : a.move
  const g = geom[dir]
  if (g && (g.terr[0] === 'hole' || g.terr[0] === 'magma')) a.sneak = true
  return a
}

// 规则反射策略（纯函数，方便单测）
function ruleAct (sense, goal, emergency) {
  const a = emptyAction()
  if (!sense) return a
  const s = sense.self || {}
  const th = sense.threat || { present: false }
  const g = sense.goal || { type: 'idle' }
  const geom = sense.geom || []

  // 1) 致命危险：岩浆 / 着火 —— 立刻离开，优先级最高
  if (s.in_lava || s.on_fire) {
    a.move = bestDir(geom, th.present ? th.bearing : null, true)
    if (a.move === MOVE_NONE && s.in_lava) a.move = bestDir(geom, null)
    a.sprint = true
    a.jump = true
    return a
  }

  // mineflayer：pitch 为正是低头。缺氧时要抬头，否则一直往下看，游不出去。
  if (s.in_water && s.oxy <= 10) {
    // 水格本身也算能走，但缺氧时要挑陆地，否则会沿着水塘一直游
    a.move = bestDir(geom, null, true, { forbid: new Set(['liq', 'haz', 'magma', 'hole']) })
    a.pitch_delta = -0.5
    a.jump = true
    return a
  }

  if (emergency === 'low_hp' && th.present) {
    a.move = bestDir(geom, th.bearing, true)
    a.sprint = true
    a.shield = true
    return maybeSneak(a, s, geom)
  }

  // 贴身敌对实体
  const close = th.present && th.dist < 3.4
  if (close && g.type !== 'attack') {
    a.move = bestDir(geom, th.bearing, true)
    a.sprint = true
    a.shield = true
    return maybeSneak(a, s, geom)
  }
  if (close && g.type === 'attack') {
    a.move = th.bearing
    a.attack = true
    a.shield = th.dist < 2.0
    return maybeSneak(a, s, geom)
  }

  // 低血量 + 有威胁 —— 撤退（除非上层明确要求交战）
  if (th.present && s.hp <= 7 && g.type !== 'attack' && g.type !== 'flee') {
    a.move = bestDir(geom, th.bearing, true)
    a.sprint = true
    a.shield = true
    return maybeSneak(a, s, geom)
  }

  // 目标导向
  if (g.type === 'flee') {
    if (th.present) {
      a.move = bestDir(geom, th.bearing, true)
      a.sprint = true
      a.shield = true
    }
    return maybeSneak(a, s, geom)
  }

  if (g.type === 'attack' && th.present) {
    if (th.dist > 3.6) a.move = th.bearing
    else if (th.dist < 2.4) a.move = opposite(th.bearing)
    a.attack = true
    a.shield = th.dist < 2.2
    return maybeSneak(a, s, geom)
  }

  if (g.type === 'goto' || g.type === 'mine') {
    const b = g.bearing
    if (b !== null && b !== undefined && b !== MOVE_NONE) {
      a.move = b
      const front = geom[b]
      const foot = front && front.terr[0]
      // 脚下一格是平地、再往前一格是岩浆或洞时，这一步走下去就会掉进去
      const blocked = foot === 'wall' || dangerAhead(geom, b)
      if (blocked) {
        const side = pickSide(geom, b)
        if (side !== MOVE_NONE) a.move = side
        else if (foot === 'wall') a.jump = true
        else a.move = MOVE_NONE
      }
      const near = g.dist !== null && g.dist !== undefined && g.dist < 4
      a.sprint = a.move !== MOVE_NONE && !near && clearAhead(geom, a.move)
    }
    return maybeSneak(a, s, geom)
  }

  return maybeSneak(a, s, geom)
}

// 规则策略：包装成和 ONNX 策略一样的接口
class RulePolicy {
  constructor () {
    this.name = 'rule'
  }

  async load () { return this }

  act (sense, goal) {
    return ruleAct(sense, goal)
  }
}

// ONNX 策略：加载 p1/ 导出的 GRU 模型（见 p1/coe/export_onnx.py）。
// 模型接口（导出时固定）：
//   输入  ids : int64 (1, T)
//   输出  move (1,9) / yaw (1,9) / pitch (1,5) / bin (1,7)，都是 logits
// 词表用同一个 local-vocab.json，token 字符串 → id 的下标。
class OnnxPolicy {
  constructor (opts = {}) {
    this.name = 'onnx'
    this.path = opts.path || null
    this.vocab = opts.vocab || null       // token -> id 的 Map
    this.session = null
    this.inputName = opts.inputName || 'ids'
    this.outputNames = opts.outputNames || ['move', 'yaw', 'pitch', 'bin']
    this.yawBins = opts.yawBins || 9
    this.pitchBins = opts.pitchBins || 5
    this.yawStep = opts.yawStep || 0.5
    this.pitchStep = opts.pitchStep || 0.5
  }

  async load (path) {
    if (path) this.path = path
    if (!this.path) throw new Error('OnnxPolicy 需要模型路径')
    if (!this.vocab) throw new Error('OnnxPolicy 需要 token 词表')
    let ort
    try {
      ort = require('onnxruntime-node')
    } catch (e) {
      throw new Error('onnxruntime-node 未安装：' + e.message)
    }
    this.ort = ort
    this.session = await ort.InferenceSession.create(this.path)
    return this
  }

  async close () {
    const session = this.session
    this.session = null
    await session?.release()
  }

  // sense -> token id 序列
  tokenize (sense) {
    const { encodeLocal } = require('./local')
    const tokens = encodeLocal(sense)
    const ids = new Array(tokens.length)
    for (let i = 0; i < tokens.length; i++) {
      const id = this.vocab.get(tokens[i])
      if (id === undefined) throw new Error('未知 token：' + tokens[i])
      ids[i] = id
    }
    return ids
  }

  // 跑一次推理，返回控制向量
  async act (sense, goal) {
    if (!this.session) throw new Error('OnnxPolicy 未加载模型')
    const ids = this.tokenize(sense)
    const ort = this.ort || require('onnxruntime-node')
    const tensor = new ort.Tensor('int64', BigInt64Array.from(ids.map(v => BigInt(v))), [1, ids.length])
    const out = await this.session.run({ [this.inputName]: tensor })
    const pick = (name) => {
      const t = out[name] || out[this.outputNames[this.outputNames.indexOf(name)]]
      const d = t.data
      let bi = 0
      for (let i = 1; i < d.length; i++) if (d[i] > d[bi]) bi = i
      return bi
    }
    const a = emptyAction()
    a.move = pick('move')
    a.yaw_delta = (pick('yaw') - (this.yawBins - 1) / 2) * this.yawStep
    a.pitch_delta = (pick('pitch') - (this.pitchBins - 1) / 2) * this.pitchStep
    // bin：7 个 logit，sigmoid 后 > 0.5 视为真。顺序：sprint jump sneak shield attack use dig
    const bins = ['sprint', 'jump', 'sneak', 'shield', 'attack', 'use', 'dig']
    const bd = out.bin.data
    for (let i = 0; i < bins.length && i < bd.length; i++) {
      a[bins[i]] = bd[i] > 0
    }
    return a
  }
}

// 按配置选策略：优先用模型，模型不可用时回落到规则（绝不因为模型挂了就不动）
async function createPolicy (opts = {}) {
  if (opts.kind === 'onnx' || opts.path) {
    try {
      const p = new OnnxPolicy(opts)
      await p.load()
      return p
    } catch (e) {
      console.log('[COE] ONNX 策略加载失败，回落到规则策略：', e.message)
    }
  }
  return new RulePolicy()
}

module.exports = {
  emptyAction, moveKeys, opposite, bestDir, clearAhead, pickSide,
  ruleAct, RulePolicy, OnnxPolicy, createPolicy, TERRAIN_SCORE
}
