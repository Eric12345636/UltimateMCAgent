'use strict'
// CoE 控制器：下层专家的运行时。
//
// 两个循环：
//   reflex loop  每 tick（20Hz）：策略输出控制向量 → bot.setControlState
//   task loop    事件驱动：执行上层下发的 Skill（走过去 / 挖 / 打 / 吃 / 合成）
//
// 仲裁规则（见 COE.md §5）：
//   1. HTTP 动作在跑时 reflex loop 让位——否则两个驱动者同时按键会互相打架
//   2. reflex 判定「保命优先」时否决当前 task step，切到 flee，并上报 override
//   3. 上层下发紧急 Skill 时打断当前 task step
//
// 关键约束：reflex loop **绝不**等待 LLM，也**绝不**发 HTTP 请求。
// 它的全部输入都来自进程内的 bot 对象。

const { senseFromBot, encodeLocal } = require('./local')
const { moveKeys, emptyAction, ruleAct } = require('./policy')
const { SkillBus } = require('./skillbus')
const { compileGoal, findNearestBlock } = require('./skills')
const { isExposed } = require('../blocks')

const TICK_MS = 50          // 20 Hz
const OVERRIDE_HOLD_MS = 2000  // 否决之后，普通技能要等这么久才恢复
const IDLE = { type: 'idle', target: null, args: {} }
const FLEE = { type: 'flee', target: null, args: {} }

class Controller {
  constructor (session, opts = {}) {
    this.session = session
    this.policy = opts.policy || null
    this.actions = opts.actions
    // 上层规划器（问 LLM 要技能）。没有它，控制器就只跑下层反射 + 手动提交的技能。
    this.planner = opts.planner || null
    this.bus = new SkillBus({ max: opts.queueSize || 4 })
    this.goal = IDLE
    // 谁在控制移动键：'pathfinder'（寻路中）/ 'policy'（反射层）/ 'none'
    this.moveOwner = 'none'
    this.override = null
    this.runId = 0
    this.taskRunning = false
    this.bot = null
    this.prev = null
    this.shieldHeld = false
    this.lastHurtAt = 0
    this.lastTickAt = 0
      this.pending = false
    this.generation = 0
    this.stopped = false
    this.telemetry = {
      startedAt: Date.now(),
      ticks: 0,
      decisionMsSum: 0,
      decisionMsMax: 0,
      decisionMsAvg: 0,
      overrides: 0,
      preemptions: 0,
      skillsStarted: 0,
      skillsDone: 0,
      skillsFailed: 0,
      yielded: 0
    }
  }

  log (...a) {
    console.log(new Date().toISOString().slice(11, 19), '[COE]', ...a)
  }

  // ---------- 生命周期 ----------

  attach () {
    this.stopped = false
    const bot = this.session.bot
    if (bot) this.onBotReady(bot)
  }

  detach () {
    this.stopped = true
    this.stop('detached')
    this.unbindBot()
    if (!this.pending) this.disposePolicy()
  }

  disposePolicy () {
    if (this.policy?.close) Promise.resolve(this.policy.close()).catch(e => this.log('释放策略失败:', e.message))
  }

  onBotReady (bot) {
    if (this.stopped || this.bot === bot) return
    if (this.bot) this.onBotGone()
    this.bot = bot
    this.lastHurtAt = 0
    this.session.pushEvent('controller_ready', { policy: this.policy ? this.policy.name : 'none' })
    this.physicsTick = () => {
      if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null }
      this.tickSource = 'physicsTick'
      this.onTick()
    }
    // 物理已推进这一帧，先读取实际按键，再由 pathfinder 写入下一帧按键。
    bot.prependListener('physicsTick', this.physicsTick)
    this.tickTimer = setInterval(() => {
      if (bot.physicsEnabled === false) return
      this.tickSource = 'timer'
      this.onTick()
    }, TICK_MS)
    if (this.tickTimer.unref) this.tickTimer.unref()
  }

  onBotGone () {
    this.stop('disconnected')
    this.unbindBot()
  }

  unbindBot () {
    if (this.bot) this.bot.removeListener('physicsTick', this.physicsTick)
    this.bot = null
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null }
    this.tickSource = null
  }

  canDrive (bot = this.bot) {
    return !this.stopped && !this.session.destroyed && bot === this.bot && bot === this.session.bot &&
      !!bot?.entity && this.session.alive && this.session.isReady()
  }

  onHurt () {
    this.lastHurtAt = Date.now()
    if (this.session.busy === this.taskLock && this.taskLock) this.cancelTask('hurt')
  }

  stop (reason) {
    this.bus.queue.length = 0
    this.generation++
    this.goal = IDLE
    this.override = null
    this.prev = null
    this.resetRecording()
    this.cancelTask(reason)
    if (this.session.busy?.owner !== 'http') {
      this.releaseAll()
      this.session.applyPosture()
    }
  }

  hurtTicks () {
    if (!this.lastHurtAt) return 99
    return Math.round((Date.now() - this.lastHurtAt) / TICK_MS)
  }

  // ---------- reflex loop ----------

  onTick () {
    const bot = this.bot
    if (!this.canDrive(bot)) {
      if (this.taskRunning) this.cancelTask('not_ready')
      if (this.controlsOwned && this.session.busy?.owner !== 'http') this.releaseAll()
      this.resetRecording()
      return
    }
    const t0 = Date.now()
    this.doTick(bot)
      .catch(e => this.log('tick error:', e && e.message))
      .finally(() => {
        const ms = Date.now() - t0
        const tel = this.telemetry
        tel.ticks++
        tel.decisionMsSum += ms
        if (ms > tel.decisionMsMax) tel.decisionMsMax = ms
        tel.decisionMsAvg = +(tel.decisionMsSum / tel.ticks).toFixed(2)
        this.lastTickAt = Date.now()
      })
  }

  async doTick (bot) {
    if (!this.canDrive(bot)) return
    const busy = this.session.busy
    if (busy && busy.owner !== 'controller') {
      this.telemetry.yielded++
      this.recordTeacher(bot, busy)
      return
    }
    this.resetRecording()

    let sense = senseFromBot(bot, { goal: this.goal, prev: this.prev, hurtTicks: this.hurtTicks() })
    if (!sense) return
    const reason = this.dangerReason(sense)
    if (reason) this.applyOverride(reason)
    else if (this.override && Date.now() >= this.override.until) {
      this.override = null
      if (!this.taskRunning || this.taskCancelled) this.goal = IDLE
    }
    if (sense.goal.type !== this.goal.type) {
      sense = senseFromBot(bot, { goal: this.goal, prev: this.prev, hurtTicks: this.hurtTicks() })
    }
    if (this.moveOwner === 'pathfinder') return
    const epoch = this.session.actionEpoch
    const generation = this.generation
    const runId = this.runId
    const goal = this.goal
    let action = emptyAction()
    if (this.override || goal.type === 'idle') {
      // 危险与闲置由确定性规则处理，模型只在有任务且拥有键位时输出。
      action = ruleAct(sense, goal, this.override?.reason)
    } else {
      if (this.pending) return
      this.pending = true
      try {
        action = await this.policy?.act(sense, goal)
      } catch (e) {
        this.log('策略异常，回落到规则动作:', e && e.message)
        action = ruleAct(sense, goal)
      } finally {
        this.pending = false
        if (this.stopped) this.disposePolicy()
      }
    }
    if (!this.canDrive(bot) || generation !== this.generation || runId !== this.runId ||
        epoch !== this.session.actionEpoch || goal !== this.goal || this.session.busy?.owner === 'http') return
    if (!action) action = emptyAction()
    if (this.session.interruptedBy && !this.override) return
    this.applyAction(action)
    this.prev = action
    if (this.recorder?.labelSource === 'policy') this.recorder.sample(bot, encodeLocal(sense), action)
    if (!this.override && !this.taskRunning && this.bus.queue.length) this.pumpTask()
  }

  recordTeacher (bot, lock) {
    if (!this.recorder || this.recorder.labelSource === 'policy') return
    if (!lock.teacherGoal || this.session.interruptedBy || this.tickSource === 'timer') {
      this.resetRecording()
      return
    }
    if (this.recordingLock !== lock) this.resetRecording()
    this.recordingLock = lock
    const action = this.recorder.readBotAction(bot)
    const sense = senseFromBot(bot, { goal: lock.teacherGoal, prev: action, hurtTicks: this.hurtTicks() })
    this.recorder.sample(bot, encodeLocal(sense), action)
  }

  resetRecording () {
    if (this.recordingLock) this.recorder?.reset()
    this.recordingLock = null
  }

  // 挂 / 卸 BC 录制器
  setRecorder (rec) {
    this.resetRecording()
    this.recorder = rec || null
    return this.recorder
  }

  // 挂 / 卸上层规划器
  setPlanner (planner) {
    this.planner = planner || null
    return this.planner
  }

  // 判定「保命优先」的条件
  dangerReason (sense) {
    const s = sense.self || {}
    const th = sense.threat || {}
    if (s.in_lava || s.on_fire) return 'lava'
    if (s.in_water && s.oxy <= 5) return 'low_air'
    if (th.present && s.hp <= 4) return 'low_hp'
    if (th.present && th.dist < 2.5 && this.goal.type !== 'attack') return 'threat'
    return null
  }

  applyOverride (reason) {
    const now = Date.now()
    if (this.override?.reason === reason) {
      this.override.until = now + OVERRIDE_HOLD_MS
      return
    }
    const from = this.bus.current ? this.bus.current.skill : null
    this.generation++
    this.override = { reason, at: now, until: now + OVERRIDE_HOLD_MS, from_skill: from }
    this.telemetry.overrides++
    // 打断正在执行的技能
    if (this.taskRunning && this.goal.type !== 'flee' && this.cancelTask('override:' + reason)) {
      this.telemetry.preemptions++
    }
    this.goal = FLEE
    this.session.pushEvent('override', { reason, from_skill: from })
    this.log('override:', reason, 'from', from)
  }

  // 把控制向量落到 bot 上
  applyAction (action) {
    const bot = this.bot
    if (!bot || !bot.entity) return
    const posture = this.session.posture || {}
    const set = (k, v) => { try { bot.setControlState(k, !!v) } catch (e) {} }
    const keys = moveKeys(action.move)

    // 寻路、对准、挖掘和攻击由技能拥有。否决后才交还给反射策略。
    if (this.moveOwner === 'pathfinder') return
    this.controlsOwned = true
    set('forward', keys.forward)
    set('back', keys.back)
    set('left', keys.left)
    set('right', keys.right)
    set('jump', !!action.jump || !!posture.jump)
    set('sprint', !!action.sprint)
    set('sneak', !!action.sneak || !!posture.sneak)

    // 举盾（副手盾牌 = activateItem）
    const wantShield = !!action.shield && !posture.shield && !this.session.usingItem &&
      bot.inventory?.slots[45]?.name === 'shield'
    if (wantShield && !this.shieldHeld) {
      try {
        bot.activateItem(true)
        this.shieldHeld = true
      } catch (e) {}
    } else if (!wantShield && this.shieldHeld) {
      if (!posture.shield && !this.session.usingItem) { try { bot.deactivateItem() } catch (e) {} }
      this.shieldHeld = false
    }

    // 视角增量
    if (action.yaw_delta || action.pitch_delta) {
      const e = bot.entity
      const pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, (e.pitch || 0) + (action.pitch_delta || 0)))
      Promise.resolve(bot.look((e.yaw || 0) + (action.yaw_delta || 0), pitch, true)).catch(() => {})
    }

    // 攻击、用物品和挖掘由技能执行器发出。
  }

  releaseMovement () {
    const bot = this.bot
    if (!bot || !this.controlsOwned) return
    this.controlsOwned = false
    for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
      try { bot.setControlState(k, false) } catch (e) {}
    }
  }

  releaseAll () {
    this.releaseMovement()
    if (this.shieldHeld && this.bot) {
      if (!this.session.posture?.shield && !this.session.usingItem) { try { this.bot.deactivateItem() } catch (e) {} }
      this.shieldHeld = false
    }
  }

  yieldToHttp () {
    this.generation++
    this.releaseAll()
    this.session.applyPosture()
    this.prev = null
  }

  // ---------- task loop ----------

  // 从队列里取下一个技能并执行
  async pumpTask () {
    if (this.taskRunning || this.override || this.session.busy || !this.canDrive()) return
    const item = this.bus.next()
    if (!item) return
    const lock = this.session.claimLock('skill:' + item.skill, 'controller')
    this.taskRunning = true
    const myRun = ++this.runId
    this.taskLock = lock
    this.taskCancelled = null
    try {
      const compiled = await compileGoal(item.skill, item.args, { bot: this.bot, session: this.session })
      if (this.aborted(myRun)) throw new Error('aborted')
      if (!compiled.ok) throw new Error(compiled.error)

      this.goal = compiled.goal
      this.telemetry.skillsStarted++
      this.session.pushEvent('skill_start', { skill: item.skill, args: item.args })

      const ok = await this.runSkill(item, compiled.goal, myRun)
      if (!ok || this.aborted(myRun)) throw new Error('技能未完成')
      this.telemetry.skillsDone++
      this.session.pushEvent('skill_done', { skill: item.skill, ms: Date.now() - item.at })
    } catch (e) {
      this.telemetry.skillsFailed++
      const reason = this.taskCancelled || this.session.interruptedBy || e.message
      this.session.pushEvent('skill_failed', { skill: item.skill, reason, ...(e.code ? { code: e.code } : {}) })
    } finally {
      this.taskRunning = false
      this.taskLock = null
      this.bus.done()
      this.moveOwner = 'none'
      if (!this.override) {
        this.goal = IDLE
        this.releaseAll()
      }
      this.session.releaseLock(lock)
      setImmediate(() => this.pumpTask())
    }
  }

  // 任务是否被打断：上层换了技能，或者 hurt/death 触发了 stop_on
  aborted (myRun) {
    return myRun !== this.runId || !!this.session.interruptedBy || !this.canDrive()
  }

  // 打断当前正在执行的技能。
  // 注意：这里**不**把 taskRunning 置 false——旧任务还在 await 里 unwind，
  // 由它自己的 finally 收尾，这样不会出现两个任务同时驱动 bot。
  cancelTask (reason) {
    if (!this.taskRunning || this.taskCancelled) return false
    this.runId++
    this.taskCancelled = reason
    if (this.session.busy === this.taskLock) this.session.interrupt(reason, true)
    this.moveOwner = 'none'
    return true
  }

  async runSkill (item, goal, myRun) {
    if (item.skill === 'flee') return this.runFlee(myRun)
    if (item.skill === 'wait') {
      const until = Date.now() + goal.args.ms
      while (Date.now() < until && !this.aborted(myRun)) await sleep(50)
      return !this.aborted(myRun)
    }

    const api = this.actions || require('../session').api
    this.releaseAll()
    this.session.applyPosture()
    this.moveOwner = 'pathfinder'
    switch (item.skill) {
      case 'goto':
        await api.move_to(this.session, { ...goal.target.pos, range: 1.5 })
        return true
      case 'gather':
      case 'mine':
        return this.runMine(api, goal, myRun)
      case 'attack': {
        const result = await api.attack(this.session, {
          entity_id: goal.target.entityId,
          max_hits: goal.args.maxHits
        })
        return result.killed || (goal.args.maxHits !== undefined && result.hits >= goal.args.maxHits)
      }
      case 'eat': {
        const foods = this.session.mcData?.foodsByName || this.bot.registry?.foodsByName || {}
        const candidates = this.bot.inventory.items().filter(i => foods[i.name] &&
          !['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken', 'suspicious_stew'].includes(i.name))
        const food = candidates.sort((a, b) => foods[b.name].foodPoints - foods[a.name].foodPoints)[0]
        if (!food) throw new Error('背包里没有食物')
        await api.use_item(this.session, { item: food.name, ms: 1800 })
        return true
      }
      case 'craft':
        return (await api.craft(this.session, goal.args)).gained >= goal.args.count
      case 'place': {
        const args = { item: goal.args.item }
        try {
          const placed = await api.place(this.session, args)
          return !!(placed && placed.placed)
        } catch (e) {
          // 1×1 竖井里没有能放熔炉的实心地面。先往旁边挖出一个两格深的凹槽再放。
          if (e.code !== 'no_support') throw e
          const opened = await this.openPlacePocket(api)
          if (!opened) throw e
          const placed = await api.place(this.session, args)
          return !!(placed && placed.placed)
        }
      }
      case 'smelt':
        return this.runSmelt(api, goal, myRun)
      case 'equip':
        await api.equip(this.session, { item: goal.args.item, slot: 'hand' })
        return true
      case 'chat':
        await api.chat(this.session, { message: goal.args.message })
        return true
      default:
        return false
    }
  }

  async runMine (api, goal, myRun) {
    if (goal.args.down) return this.runMineDown(api, goal, myRun)
    if (goal.args.ahead) return this.runMineAhead(api, goal, myRun)
    const { count, blockName, radius } = goal.args
    let dug = 0
    let extra = 0
    let walks = 0
    const walkFail = new Set(['out_of_reach', 'path_not_found', 'stalled', 'timeout'])
    while (dug < count && !this.aborted(myRun)) {
      const exposed = await findNearestBlock(this.bot, blockName, radius)
      if (this.aborted(myRun)) return false
      // 矿在脚下很深、人在竖井里时，寻路会贴着井壁转满一分钟然后 out_of_reach。改成挖过去。
      if (exposed && !this.preferTunnel(exposed.pos)) {
        const { x, y, z } = exposed.pos
        try {
          const result = await api.dig(this.session, { x, y, z, collect: true })
          if (!result || !result.dug) return false
          dug++
          walks = 0
          continue
        } catch (e) {
          if (!walkFail.has(e.code)) throw e
        }
      }
      // 矿埋在石头里、石头埋在泥土下：先挖离目标更近的一格，再走过去。
      const any = exposed || await findNearestBlock(this.bot, blockName, radius, { exposed: false })
      if (!any) throw new Error(`采到 ${dug}/${count}，附近没有更多 ${blockName}`)
      const step = this.digStepToward(any.pos)
      if (!step) {
        if (++walks > 4) throw new Error(`走不到 ${blockName}`)
        await api.move_to(this.session, { x: any.pos.x, y: any.pos.y, z: any.pos.z, range: 2 })
        continue
      }
      if (++extra > 48) throw new Error(`朝 ${blockName} 挖了太远`)
      const result = await api.dig(this.session, {
        x: step.position.x, y: step.position.y, z: step.position.z, collect: true
      })
      if (!result || !result.dug) return false
      if (step.name === blockName) dug++
    }
    return dug >= count
  }

  // 往脚下挖。熔岩或基岩就停，并尝试往旁边挪，避免在同一根柱子里反复失败。
  async runMineDown (api, goal, myRun) {
    const count = goal.args.count || 1
    let dug = 0
    let shifts = 0
    while (dug < count && !this.aborted(myRun)) {
      const feetY = Math.floor(this.bot.entity.position.y)
      if (feetY <= 16 && dug > 0) return true
      await this.clearBody(api)
      const block = this.blockUnderFeet()
      if (block && this.safeDig(block)) {
        const result = await api.dig(this.session, {
          x: block.position.x, y: block.position.y, z: block.position.z, collect: true
        })
        if (!result || !result.dug) return dug > 0
        dug++
        await this.waitFall(myRun)
        continue
      }
      if (shifts >= 4) return dug > 0
      const moved = await this.stepAside(api)
      if (!moved) return dug > 0
      shifts++
    }
    return dug >= count
  }

  // 在当前高度向前挖一条能走的洞，用来在铁矿层找矿。
  async runMineAhead (api, goal, myRun) {
    const count = goal.args.count || 8
    const primary = Array.isArray(goal.args.dir) ? goal.args.dir : [1, 0]
    const dirs = [primary, [1, 0], [-1, 0], [0, 1], [0, -1]]
    const seen = new Set()
    for (const dir of dirs) {
      const key = `${dir[0]},${dir[1]}`
      if (seen.has(key)) continue
      seen.add(key)
      const start = this.bot.entity.position
      await this.tunnel(api, dir, count, myRun)
      if (this.aborted(myRun)) return false
      const now = this.bot.entity.position
      if (Math.hypot(now.x - start.x, now.z - start.z) > 0.6) return true
    }
    return false
  }

  // 人嵌进方块时寻路直接失败。先把脚和头所在的实心格挖开。
  async clearBody (api) {
    const feet = this.bot.entity.position.floored()
    for (const dy of [0, 1]) {
      const b = this.bot.blockAt(feet.offset(0, dy, 0))
      if (!b || !b.position || b.name.endsWith('air') || b.boundingBox === 'empty') continue
      if (!this.safeDig(b)) continue
      try { await api.dig(this.session, { x: b.position.x, y: b.position.y, z: b.position.z, collect: true }) } catch (e) {}
    }
  }

  // 旁路一格时，goNear 会把“还差 1 格”当成已经到达。确认没挪动就自己朝前挤。
  async shove (dx, dz) {
    const bot = this.bot
    try { if (bot.pathfinder) bot.pathfinder.setGoal(null) } catch (e) {}
    try { await bot.look(Math.atan2(-dx, -dz), 0, true) } catch (e) {}
    try {
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      await sleep(400)
    } finally {
      try { bot.setControlState('forward', false) } catch (e) {}
      try { bot.setControlState('jump', false) } catch (e) {}
    }
  }

  movedHoriz (from) {
    const p = this.bot.entity.position
    return Math.hypot(p.x - from.x, p.z - from.z) > 0.6
  }

  async tunnel (api, dir, count, myRun) {
    const dx = dir[0] > 0 ? 1 : (dir[0] < 0 ? -1 : 0)
    const dz = dir[1] > 0 ? 1 : (dir[1] < 0 ? -1 : 0)
    if (!dx && !dz) return 0
    let dug = 0
    let steps = 0
    let stuck = 0
    while (dug < count && steps < count && !this.aborted(myRun)) {
      await this.clearBody(api)
      const feet = this.bot.entity.position.floored()
      const from = this.bot.entity.position.clone()
      for (const dy of [1, 0]) {
        const b = this.bot.blockAt(feet.offset(dx, dy, dz))
        if (!b || !b.position || b.name.endsWith('air') || b.boundingBox === 'empty') continue
        if (!this.safeDig(b)) return dug
        const result = await api.dig(this.session, {
          x: b.position.x, y: b.position.y, z: b.position.z, collect: true
        })
        if (!result || !result.dug) return dug
        dug++
        if (dug >= count) return dug
      }
      const cap = this.bot.blockAt(feet.offset(dx, 2, dz))
      if (cap && (cap.name === 'gravel' || cap.name === 'sand' || cap.name === 'red_sand') && this.safeDig(cap)) {
        try {
          const result = await api.dig(this.session, { x: cap.position.x, y: cap.position.y, z: cap.position.z, collect: true })
          if (result && result.dug) dug++
        } catch (e) {}
        if (dug >= count) return dug
      }
      try {
        await api.move_to(this.session, { x: feet.x + dx + 0.5, y: feet.y, z: feet.z + dz + 0.5, range: 0.35 })
      } catch (e) {}
      if (!this.movedHoriz(from)) await this.shove(dx, dz)
      if (!this.movedHoriz(from)) {
        if (++stuck >= 2) return dug
        continue
      }
      stuck = 0
      steps++
    }
    return dug
  }

  async runSmelt (api, goal, myRun) {
    const item = String(goal.args.item)
    const count = Math.max(1, Number(goal.args.count) || 1)
    const outName = item === 'raw_iron' || item === 'iron_ore' ? 'iron_ingot' : item
    const hit = await findNearestBlock(this.bot, 'furnace', 32)
    if (!hit) throw new Error('附近没有 furnace')
    const fuel = this.pickSmeltFuel(item)
    if (!fuel) throw new Error('没有燃料（需要 coal、charcoal 或木板）')
    const per = fuel === 'coal' || fuel === 'charcoal' ? 8 : 1
    const pos = [hit.pos.x, hit.pos.y, hit.pos.z]
    await api.window_act(this.session, {
      pos,
      ops: [
        { op: 'put', item, count, to: 'input' },
        { op: 'put', item: fuel, count: Math.max(1, Math.ceil(count / per)), to: 'fuel' }
      ]
    })
    const started = Date.now()
    while (Date.now() - started < 9000 && !this.aborted(myRun)) await sleep(500)
    for (let miss = 0; miss < 6 && !this.aborted(myRun); miss++) {
      try {
        const taken = await api.window_act(this.session, {
          pos,
          ops: [{ op: 'take', from: 'output', item: outName }]
        })
        const got = taken && taken.done && taken.done[0] && taken.done[0].took && taken.done[0].took[outName]
        if (got >= 1) return true
      } catch (e) {
        if (e.code !== 'no_output') throw e
      }
      await sleep(2000)
    }
    throw new Error(`熔炼没有拿到 ${outName}`)
  }

  pickSmeltFuel (smeltItem) {
    const items = this.bot.inventory.items()
    if (items.some(i => i.name === 'coal')) return 'coal'
    if (items.some(i => i.name === 'charcoal')) return 'charcoal'
    const plank = items.find(i => i.name.endsWith('_planks') && i.name !== smeltItem)
    return plank ? plank.name : null
  }

  // 目标在脚下，而且高度差不小于水平距离的一半时，寻路会卡在井壁上，改成一格格挖。
  preferTunnel (pos) {
    if (!pos || !this.bot || !this.bot.entity) return false
    const p = this.bot.entity.position
    const dx = pos.x + 0.5 - p.x
    const dy = pos.y + 0.5 - p.y
    const dz = pos.z + 0.5 - p.z
    const horiz = Math.hypot(dx, dz)
    if (horiz <= 4 && Math.abs(dy) <= 3) return false
    return dy < -1 && Math.abs(dy) >= horiz * 0.5
  }

  // 放置点要离脚至少曼哈顿 2，而且脚下是实心、头顶是空的。竖井里先挖出这样两格。
  async openPlacePocket (api) {
    const feet = this.bot.entity.position.floored()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const farFloor = this.bot.blockAt(feet.offset(dx * 2, -1, dz * 2))
      if (!farFloor || !farFloor.position || farFloor.boundingBox !== 'block' || this.isLava(farFloor)) continue
      const under = this.bot.blockAt(farFloor.position.offset(0, -1, 0))
      if (under && this.isLava(under)) continue
      let opened = true
      for (const step of [1, 2]) {
        for (const dy of [0, 1]) {
          const b = this.bot.blockAt(feet.offset(dx * step, dy, dz * step))
          if (!b || !b.position || b.name.endsWith('air') || b.boundingBox === 'empty') continue
          if (!this.safeDig(b)) { opened = false; break }
          try {
            const result = await api.dig(this.session, { x: b.position.x, y: b.position.y, z: b.position.z, collect: true })
            if (!result || !result.dug) { opened = false; break }
          } catch (e) {
            opened = false
            break
          }
        }
        if (!opened) break
      }
      if (opened) return true
    }
    return false
  }

  isLava (block) {
    return !!block && (block.name === 'lava' || block.name === 'flowing_lava')
  }

  safeDig (block) {
    if (!block || !block.position || !block.diggable) return false
    if (block.name === 'bedrock' || this.isLava(block)) return false
    if (block.name === 'crafting_table' || block.name === 'furnace' || block.name === 'chest') return false
    const under = this.bot.blockAt(block.position.offset(0, -1, 0))
    if (under && this.isLava(under)) return false
    return true
  }

  blockUnderFeet () {
    const feet = this.bot.entity.position.floored()
    for (let dy = 1; dy <= 4; dy++) {
      const b = this.bot.blockAt(feet.offset(0, -dy, 0))
      if (!b) return null
      if (b.name.endsWith('air') || b.boundingBox === 'empty') continue
      return b
    }
    return null
  }

  // 选一格已经露出、而且比现在更靠近目标的方块。
  digStepToward (targetPos) {
    const feet = this.bot.entity.position.floored()
    const offsets = [
      [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
      [0, -1, 0], [0, 1, 0],
      [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]
    ]
    let best = null
    for (const [dx, dy, dz] of offsets) {
      const b = this.bot.blockAt(feet.offset(dx, dy, dz))
      if (!b || !this.safeDig(b) || !isExposed(this.bot, b)) continue
      const dist = b.position.distanceTo(targetPos)
      if (!best || dist < best.dist) best = { block: b, dist }
    }
    return best ? best.block : null
  }

  // 脚下不能再挖（熔岩、基岩）时，在旁边开一格再站过去，换一根柱子继续往下。
  async stepAside (api) {
    const feet = this.bot.entity.position.floored()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const floor = this.bot.blockAt(feet.offset(dx, -1, dz))
      if (!floor || !floor.position || floor.boundingBox !== 'block' || this.isLava(floor)) continue
      const under = this.bot.blockAt(floor.position.offset(0, -1, 0))
      if (under && this.isLava(under)) continue
      let opened = true
      for (const dy of [1, 0]) {
        const b = this.bot.blockAt(feet.offset(dx, dy, dz))
        if (!b || !b.position || b.name.endsWith('air') || b.boundingBox === 'empty') continue
        if (!this.safeDig(b)) { opened = false; break }
        try {
          const result = await api.dig(this.session, { x: b.position.x, y: b.position.y, z: b.position.z, collect: true })
          if (!result || !result.dug) { opened = false; break }
        } catch (e) {
          opened = false
          break
        }
      }
      if (!opened) continue
      try {
        await api.move_to(this.session, { x: feet.x + dx + 0.5, y: feet.y, z: feet.z + dz + 0.5, range: 0.6 })
        return true
      } catch (e) {}
    }
    return false
  }

  async waitFall (myRun) {
    const y0 = this.bot.entity.position.y
    for (let i = 0; i < 20 && !this.aborted(myRun); i++) {
      if (this.bot.entity.onGround && this.bot.entity.position.y < y0 - 0.4) return
      await sleep(50)
    }
  }

  // 逃：直到威胁远离或超时。移动交给反射层（policy），这里只负责计时和判据。
  async runFlee (myRun) {
    const until = Date.now() + 15000
    while (Date.now() < until && !this.aborted(myRun)) {
      const th = this.session.nearestHostile(24)
      if ((!th || th.dist >= 16) && !this.override) return true
      await sleep(100)
    }
    return false
  }

  // ---------- 对外接口 ----------

  submit (skill, args, meta = {}) {
    const r = this.bus.submit(skill, args, meta)
    if (meta.priority === 'urgent' && this.cancelTask('preempted')) this.telemetry.preemptions++
    // 立刻起一个 task loop 线程（不 await）
    this.pumpTask()
    return r
  }

  state () {
    return {
      goal: { type: this.goal.type, target: this.goal.target || null },
      override: this.override,
      task_running: this.taskRunning,
      move_owner: this.moveOwner,
      skills: this.bus.snapshot()
    }
  }

  stats () {
    const tel = this.telemetry
    return {
      ticks: tel.ticks,
      uptime_ms: Date.now() - tel.startedAt,
      decision_ms_avg: tel.decisionMsAvg,
      decision_ms_max: tel.decisionMsMax,
      overrides: tel.overrides,
      preemptions: tel.preemptions,
      skills_started: tel.skillsStarted,
      skills_done: tel.skillsDone,
      skills_failed: tel.skillsFailed,
      yielded: tel.yielded,
      policy: this.policy ? this.policy.name : 'none',
      tick_source: this.tickSource || 'none'
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

module.exports = { Controller, TICK_MS }
