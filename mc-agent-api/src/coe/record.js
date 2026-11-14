'use strict'
// BC 数据录制器：把 (L-obs, 动作) 对写成 JSONL，供 p1/ 训练技能执行器。
//
// 教师 = pathfinder。跑一次 move_to，pathfinder 每个 tick 都在算方向键与视角，
// **标签是白送的**：本 tick 结束时读 bot 当前的按键状态，就是 pathfinder 刚刚施加的动作。
//
// 关键细节（配对错一步，模型就学歪了）：
//   pathfinder 在物理 tick 里先算动作、再移动。我们挂在 physicsTick 上采样时，
//   位置已经是「本 tick 移动之后」的了，而动作是「本 tick 施加的」。
//   所以正确配对是 action_t ↔ obs_{t-1}，这里用一个 tick 的延迟来对齐。
//
// 用法：
//   const rec = new Recorder({ path: 'D:/MC agent/p1/data/episodes/goto.jsonl' })
//   controller.setRecorder(rec)

const fs = require('fs')
const path = require('path')
const { MOVE_NONE } = require('./local')

// WASD 组合 → 9 向下标（与 policy.moveKeys 互逆）
function wasdToMove (f, b, l, r) {
  if (f && r) return 1
  if (r && b) return 3
  if (b && l) return 5
  if (f && l) return 7
  if (f) return 0
  if (r) return 2
  if (b) return 4
  if (l) return 6
  return MOVE_NONE
}

class Recorder {
  constructor (opts = {}) {
    this.path = opts.path || null
    this.labelSource = opts.labelSource || 'bot'   // 'bot' = 读 bot 实际按键；'policy' = 用策略输出
    this.maxSamples = opts.maxSamples || 200000
    this.stream = null
    this.count = 0
    this.pending = null          // 上一 tick 的观测（延迟一格配对）
    this.dropped = 0
  }

  start () {
    if (!this.path) throw new Error('Recorder 需要输出路径')
    fs.mkdirSync(path.dirname(this.path), { recursive: true })
    this.stream = fs.createWriteStream(this.path, { flags: 'a' })
    return this
  }

  reset () {
    this.pending = null
  }

  stop () {
    if (this.stream) {
      this.stream.end()
      this.stream = null
    }
    this.reset()
  }

  // 从 bot 读当前实际生效的按键
  readBotAction (bot) {
    const g = k => {
      try { return bot.getControlState(k) === true } catch (e) { return false }
    }
    const f = g('forward')
    const b = g('back')
    const l = g('left')
    const r = g('right')
    return {
      move: wasdToMove(f, b, l, r),
      sprint: g('sprint'),
      jump: g('jump'),
      sneak: g('sneak'),
      shield: false,
      attack: false,
      use: false,
      yaw_delta: 0,
      pitch_delta: 0,
      dig: false,
      // 原始按键，训练时可以自己决定怎么用（比如只看 move 和 jump）
      raw: { forward: f, back: b, left: l, right: r }
    }
  }

  // 每个 tick 调一次。obs 是本 tick 的观测，action 是本 tick 施加的动作。
  sample (bot, obs, policyAction) {
    if (!this.stream) return
    const action = this.labelSource === 'policy' ? policyAction : this.readBotAction(bot)
    // 策略输入与输出同时产生。读教师键位时，用上一帧观测配当前帧标签。
    if (this.labelSource === 'policy') this.write(obs, action)
    else if (this.pending) this.write(this.pending, action)
    this.pending = obs
  }

  write (obs, action) {
    if (!this.stream) return
    if (this.count >= this.maxSamples) {
      this.dropped++
      return
    }
    this.stream.write(JSON.stringify({ obs, act: action, t: Date.now() }) + '\n')
    this.count++
  }

  stats () {
    return { path: this.path, samples: this.count, dropped: this.dropped }
  }
}

module.exports = { Recorder, wasdToMove }
