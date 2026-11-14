'use strict'
// CoE 单元测试（node --test）。全部离线，不需要 Minecraft 服务端。
//
// 覆盖的是纯逻辑部分：L-obs 编码、Skill 编译、SkillBus 仲裁、规则反射策略。
// 真机行为仍然由 test/live_test.py 验收。

const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const fs = require('fs')
const { EventEmitter } = require('node:events')
const { setImmediate: flush } = require('node:timers/promises')

const local = require('../src/coe/local')
const skills = require('../src/coe/skills')
const busMod = require('../src/coe/skillbus')
const policy = require('../src/coe/policy')
const coe = require('../src/coe')

// ---- 造一个假 bot ----

// 世界：y <= 63 是石头，y >= 64 是空气。overrides 可以按 "x,y,z" 覆盖。
function point (x, y, z) {
  return {
    x, y, z,
    offset: (dx, dy, dz) => point(x + dx, y + dy, z + dz),
    floored: () => point(Math.floor(x), Math.floor(y), Math.floor(z)),
    distanceTo: p => Math.hypot(p.x - x, p.y - y, p.z - z)
  }
}

function fakeBot (overrides = {}, entity = {}) {
  const world = new Map()
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  const set = (x, y, z, b) => world.set(key(x, y, z), b)
  for (let x = -8; x <= 8; x++) {
    for (let z = -8; z <= 8; z++) {
      for (let y = 60; y <= 63; y++) set(x, y, z, { name: 'stone', type: 'material', boundingBox: 'block' })
    }
  }
  for (const [k, b] of Object.entries(overrides)) {
    const [x, y, z] = k.split(',').map(Number)
    set(x, y, z, b)
  }
  const controls = new Map()
  return Object.assign(new EventEmitter(), {
    entity: Object.assign({
      position: point(0, 64, 0),
      yaw: 0,
      pitch: 0,
      onGround: true,
      isInWater: false,
      isInLava: false,
      isOnFire: false,
      isSneaking: false
    }, entity),
    health: entity.health ?? 20,
    food: 20,
    oxygenLevel: 20,
    entities: {},
    getControlState: k => controls.get(k) || false,
    setControlState: (k, value) => controls.set(k, value),
    blockAt: (p) => {
      const at = p.floored()
      return world.get(key(at.x, at.y, at.z)) || { name: 'air', type: 'air', boundingBox: 'empty' }
    }
  })
}

const AIR = { name: 'air', type: 'air', boundingBox: 'empty' }
const WATER = { name: 'water', type: 'liquid', boundingBox: 'empty' }
const LAVA = { name: 'lava', type: 'liquid', boundingBox: 'empty' }
const LADDER = { name: 'ladder', type: 'vine', boundingBox: 'empty' }
const GRASS = { name: 'short_grass', type: 'plant', boundingBox: 'empty' }

// ---- L-obs ----

test('yaw=0 时正前方是 -Z，右手边是 +X', () => {
  const f = local.frame(0)
  assert.strictEqual(f.fx, 0)
  assert.strictEqual(f.fz, -1)
  assert.strictEqual(f.rx, 1)
  assert.strictEqual(f.rz, 0)
})

test('方位投影到局部坐标系', () => {
  const f = local.frame(0)
  assert.strictEqual(local.bearingIndex(0, -1, f), 0)   // 正前方
  assert.strictEqual(local.bearingIndex(1, 0, f), 2)    // 正右方
  assert.strictEqual(local.bearingIndex(0, 1, f), 4)     // 正后方
  assert.strictEqual(local.bearingIndex(-1, 0, f), 6)   // 正左方
  assert.strictEqual(local.bearingIndex(1, -1, f), 1)   // 右前
})

test('方块分类：空气 / 固体 / 植物 / 水 / 岩浆 / 梯子', () => {
  assert.strictEqual(local.surfaceClass(AIR), local.SURF.AIR)
  assert.strictEqual(local.surfaceClass({ name: 'stone', type: 'material', boundingBox: 'block' }), local.SURF.SOLID)
  assert.strictEqual(local.surfaceClass(GRASS), local.SURF.PASS)
  assert.strictEqual(local.surfaceClass(WATER), local.SURF.LIQ)
  assert.strictEqual(local.surfaceClass(LAVA), local.SURF.HAZ)
  assert.strictEqual(local.surfaceClass(LADDER), local.SURF.CLIMB)
})

test('地面类别：空且有地=flat，空且没地=hole，脚下岩浆=magma', () => {
  assert.strictEqual(local.terrainOf(local.SURF.AIR, local.SURF.SOLID), local.T.FLAT)
  assert.strictEqual(local.terrainOf(local.SURF.AIR, local.SURF.AIR), local.T.HOLE)
  assert.strictEqual(local.terrainOf(local.SURF.AIR, local.SURF.HAZ), local.T.MAGMA)
  assert.strictEqual(local.terrainOf(local.SURF.SOLID, local.SURF.SOLID), local.T.WALL)
  assert.strictEqual(local.terrainOf(local.SURF.LIQ, local.SURF.LIQ), local.T.LIQ)
  // 没加载的区块按墙处理，宁可不过也不往未知里走
  assert.strictEqual(local.terrainOf(null, null), local.T.WALL)
})

test('平地场景里，四个方向都是 flat', () => {
  const bot = fakeBot()
  const s = local.senseFromBot(bot, { goal: { type: 'idle' } })
  assert.ok(s)
  assert.strictEqual(s.geom.length, 8)
  for (const g of s.geom) {
    assert.strictEqual(g.terr[0], local.T.FLAT)
    assert.strictEqual(g.terr[3], local.T.FLAT)
    assert.strictEqual(g.height, 0)
  }
})

test('前方挖个洞，N 方向就变成 hole', () => {
  const bot = fakeBot({ '0,63,1': AIR, '0,62,1': AIR })
  const s = local.senseFromBot(bot, { goal: { type: 'idle' } })
  // yaw=0 朝 -Z，所以 N 是 -Z 方向；+Z 是 S
  assert.strictEqual(s.geom[4].terr[0], local.T.HOLE)   // S = (0,1)
  assert.strictEqual(s.geom[0].terr[0], local.T.FLAT)   // N = (0,-1)
})

test('脚下的洞会被识别成 magma', () => {
  const bot = fakeBot({ '0,63,1': LAVA })
  const s = local.senseFromBot(bot, { goal: { type: 'idle' } })
  assert.strictEqual(s.geom[4].terr[0], local.T.MAGMA)
})

test('编码成 token：结构固定、确定性、词表全覆盖', () => {
  const bot = fakeBot()
  const a = local.localTokens(bot, { goal: { type: 'goto', target: { pos: { x: 10, y: 64, z: 10 } } } })
  const b = local.localTokens(bot, { goal: { type: 'goto', target: { pos: { x: 10, y: 64, z: 10 } } } })
  assert.deepStrictEqual(a, b)
  assert.ok(a[0] === '<self>' && a.includes('<prev>') && a.includes('<goal>'))
  assert.ok(a.includes('hp6'), '满血应该是 hp6')
  assert.ok(a.includes('gtgoto'))
  assert.ok(a.includes('gd4'), '10 格远属于 8-16 档')
  const vocab = new Set(local.localVocab())
  for (const t of a) assert.ok(vocab.has(t), 'token 不在词表里：' + t)
})

test('提交的词表文件和 localVocab() 一致', () => {
  const file = path.resolve(__dirname, '../src/coe/local-vocab.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepStrictEqual(raw.tokens, local.localVocab())
})

test('敌对实体被识别成威胁，并给出局部方位', () => {
  const bot = fakeBot()
  bot.entities = { 7: { id: 7, type: 'hostile', name: 'zombie', position: { x: 3, y: 64, z: 0 }, health: 20, maxHealth: 20 } }
  const s = local.senseFromBot(bot, { goal: { type: 'idle' } })
  assert.strictEqual(s.threat.present, true)
  assert.strictEqual(s.threat.bearing, 2)     // 正右方
  assert.strictEqual(s.threat.hpFrac, 1)
  const tokens = local.encodeLocal(s)
  assert.ok(tokens.includes('tb2'))
  assert.ok(tokens.includes('td2'))            // 3 格属于 2-4 档
  assert.ok(tokens.includes('th3'))            // 满血
})

test('没有敌对实体时威胁字段是占位值', () => {
  const s = local.senseFromBot(fakeBot(), { goal: { type: 'idle' } })
  assert.strictEqual(s.threat.present, false)
  const tokens = local.encodeLocal(s)
  assert.ok(tokens.includes('tbn'))
  assert.ok(tokens.includes('tdf'))
})

// ---- Skill ----

test('技能校验会指出缺参数和非法参数', () => {
  assert.strictEqual(skills.validateSkill('goto', { x: 1, y: 2, z: 3 }).ok, true)
  assert.strictEqual(skills.validateSkill('goto', { x: 1 }).ok, false)
  assert.strictEqual(skills.validateSkill('nope', {}).ok, false)
  assert.strictEqual(skills.validateSkill('attack', { entity_id: 'x' }).ok, false)
  assert.strictEqual(skills.validateSkill('chat', { message: '/tp 1 2 3' }).ok, false)
  assert.strictEqual(skills.validateSkill('chat', { message: 'a'.repeat(101) }).ok, false)
  assert.strictEqual(skills.validateSkill('chat', { message: '第一行\n第二行' }).ok, false)
  assert.strictEqual(skills.validateSkill('wait', { ms: 999999 }).ok, false)
})

test('从 LLM 的自由文本里抽技能', () => {
  const list = skills.parseSkills('好的：```json\n[{"skill":"gather","target":"oak_log","count":4}]\n```')
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].skill, 'gather')
  assert.strictEqual(list[0].args.target, 'oak_log')

  assert.strictEqual(skills.parseSkills('{"skills":[{"skill":"wait","ms":500}],"comment":["解析完整对象"]}').length, 1)
  assert.strictEqual(skills.parseSkills('{"skill":"chat","message":"hi"}').length, 1)
  assert.strictEqual(skills.parseSkills('完全不是 JSON').length, 0)
  assert.strictEqual(skills.parseSkills('[]').length, 0)
})

test('goto 技能编译成 goto goal', async () => {
  const r = await skills.compileGoal('goto', { x: 1, y: 2, z: 3 }, {})
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.goal.type, 'goto')
  assert.deepStrictEqual(r.goal.target.pos, { x: 1, y: 2, z: 3 })
})

test('挖矿技能编译失败时给出可读原因', async () => {
  const r = await skills.compileGoal('mine', { target: 'diamond_block' }, { bot: fakeBot() })
  assert.strictEqual(r.ok, false)
  assert.ok(/没有/.test(r.error))
})

// ---- SkillBus ----

test('同类技能会去重，不会越堆越多', () => {
  const b = new busMod.SkillBus()
  b.submit('gather', { target: 'oak_log' })
  b.submit('gather', { target: 'oak_log', count: 2 })
  assert.strictEqual(b.queue.length, 1)
  assert.strictEqual(b.queue[0].args.count, 2)
})

test('不同物品的合成可以同时排队', () => {
  const b = new busMod.SkillBus()
  b.submit('craft', { item: 'oak_planks' })
  b.submit('craft', { item: 'stick' })
  b.submit('place', { item: 'crafting_table' })
  assert.strictEqual(b.queue.length, 3)
  assert.deepStrictEqual(b.queue.map(q => q.args.item), ['oak_planks', 'stick', 'crafting_table'])
})

test('紧急技能插队', () => {
  const b = new busMod.SkillBus()
  b.submit('goto', { x: 1, y: 2, z: 3 })
  b.submit('flee', {}, { priority: 'urgent' })
  assert.strictEqual(b.queue[0].skill, 'flee')
})

test('队列满了丢最旧的非紧急技能', () => {
  const b = new busMod.SkillBus({ max: 2 })
  b.submit('gather', { target: 'a' })
  b.submit('mine', { target: 'b' })
  b.submit('craft', { item: 'c' })
  assert.strictEqual(b.queue.length, 2)
  assert.strictEqual(b.queue[0].skill, 'mine')
  assert.strictEqual(b.queue[1].skill, 'craft')
})

test('next/done 的交接', () => {
  const b = new busMod.SkillBus()
  b.submit('wait', { ms: 10 })
  assert.strictEqual(b.next().skill, 'wait')
  assert.strictEqual(b.next(), null, '正在执行的技能不会被重复取出')
  b.done()
  assert.strictEqual(b.current, null)
})

// ---- 规则反射策略 ----

test('方向 → WASD 组合', () => {
  assert.deepStrictEqual(policy.moveKeys(0), { forward: true, back: false, left: false, right: false })
  assert.deepStrictEqual(policy.moveKeys(2), { forward: false, back: false, left: false, right: true })
  assert.deepStrictEqual(policy.moveKeys(5), { forward: false, back: true, left: true, right: false })
  assert.deepStrictEqual(policy.moveKeys(8), { forward: false, back: false, left: false, right: false })
})

test('在岩浆里：立刻跑开并起跳', () => {
  const bot = fakeBot({}, { isInLava: true })
  const s = local.senseFromBot(bot, { goal: { type: 'idle' } })
  const a = policy.ruleAct(s, s.goal)
  assert.strictEqual(a.jump, true)
  assert.strictEqual(a.sprint, true)
  assert.notStrictEqual(a.move, local.MOVE_NONE)
})

test('贴身敌对实体：非交战目标时逃跑并举盾', () => {
  const bot = fakeBot()
  bot.entities = { 7: { id: 7, type: 'hostile', name: 'zombie', position: { x: 2, y: 64, z: 0 }, health: 20, maxHealth: 20 } }
  const s = local.senseFromBot(bot, { goal: { type: 'idle' } })
  const a = policy.ruleAct(s, s.goal)
  assert.strictEqual(a.shield, true)
  assert.strictEqual(a.sprint, true)
  assert.notStrictEqual(a.move, local.MOVE_NONE)
})

test('交战目标：贴身敌对实体时出手而不是跑', () => {
  const bot = fakeBot()
  bot.entities = { 7: { id: 7, type: 'hostile', name: 'zombie', position: { x: 2, y: 64, z: 0 }, health: 20, maxHealth: 20 } }
  const s = local.senseFromBot(bot, { goal: { type: 'attack' } })
  const a = policy.ruleAct(s, s.goal)
  assert.strictEqual(a.attack, true)
})

test('逃跑目标：远离威胁方向', () => {
  const bot = fakeBot()
  bot.entities = { 7: { id: 7, type: 'hostile', name: 'zombie', position: { x: 2, y: 64, z: 0 }, health: 20, maxHealth: 20 } }
  const s = local.senseFromBot(bot, { goal: { type: 'flee' } })
  const a = policy.ruleAct(s, s.goal)
  assert.strictEqual(a.sprint, true)
  assert.strictEqual(a.move, 6, '威胁在正右方（方位 2），应该往正左方（方位 6）跑')
})

test('走向目标：朝目标方位移动', () => {
  const bot = fakeBot()
  const s = local.senseFromBot(bot, { goal: { type: 'goto', target: { pos: { x: 0, y: 64, z: -10 } } } })
  const a = policy.ruleAct(s, s.goal)
  assert.strictEqual(a.move, 0, '目标在 -Z，应该是正前方')
  assert.strictEqual(a.sprint, true, '距离远且前方通畅，应该冲刺')
})

test('bestDir 优先选平地而不是洞', () => {
  const geom = []
  for (let i = 0; i < 8; i++) {
    geom.push({ terr: [local.T.FLAT, local.T.FLAT, local.T.FLAT, local.T.FLAT], height: 0 })
  }
  geom[0] = { terr: [local.T.HOLE, local.T.HOLE, local.T.HOLE, local.T.HOLE], height: null }
  assert.notStrictEqual(policy.bestDir(geom, null), 0)
})

function digForwardHole (bot) {
  const overrides = {}
  for (let z = -4; z <= -1; z++) {
    for (let y = 60; y <= 63; y++) overrides[`${0},${y},${z}`] = AIR
  }
  return fakeBot(overrides)
}

test('走向目标：前方第二格是岩浆时提前绕开', () => {
  const bot = fakeBot({ '0,64,-2': LAVA })
  const s = local.senseFromBot(bot, { goal: { type: 'goto', target: { pos: { x: 0, y: 64, z: -10 } } } })
  assert.strictEqual(s.geom[0].terr[0], local.T.FLAT)
  assert.strictEqual(s.geom[0].terr[1], local.T.HAZ)
  const a = policy.ruleAct(s, s.goal)
  assert.notStrictEqual(a.move, 0)
})

test('水下缺氧：抬头并起跳，并且不往水更深处游', () => {
  const bot = fakeBot({ '0,64,-1': WATER }, { isInWater: true })
  bot.oxygenLevel = 4
  const s = local.senseFromBot(bot, { goal: { type: 'idle' } })
  assert.strictEqual(s.geom[0].terr[0], local.T.LIQ)
  const a = policy.ruleAct(s, s.goal)
  assert.ok(a.pitch_delta < 0, '缺氧时 pitch 增量必须为负（抬头）')
  assert.strictEqual(a.jump, true)
  assert.strictEqual(a.sneak, false, '水里潜行会下沉')
  assert.notStrictEqual(a.move, 0, '正前方是水，应该朝陆地游')
})

test('水下缺氧：抬头并起跳', () => {
  const bot = fakeBot({}, { isInWater: true })
  bot.oxygenLevel = 4
  const s = local.senseFromBot(bot, { goal: { type: 'idle' } })
  const a = policy.ruleAct(s, s.goal)
  assert.ok(a.pitch_delta < 0, '缺氧时 pitch 增量必须为负（抬头）')
  assert.strictEqual(a.jump, true)
  assert.strictEqual(a.sneak, false, '水里潜行会下沉')
})

test('站在洞边：正前方是洞时潜行，且不往洞里走', () => {
  const bot = digForwardHole()
  const idle = local.senseFromBot(bot, { goal: { type: 'idle' } })
  assert.strictEqual(idle.geom[0].terr[0], local.T.HOLE)
  const stay = policy.ruleAct(idle, idle.goal)
  assert.strictEqual(stay.sneak, true)
  assert.strictEqual(stay.move, local.MOVE_NONE)
  const going = local.senseFromBot(bot, { goal: { type: 'goto', target: { pos: { x: 0, y: 64, z: -10 } } } })
  const a = policy.ruleAct(going, going.goal)
  assert.notStrictEqual(a.move, 0, '正前方是洞，不能沿目标方位走下去')
  assert.notStrictEqual(a.move, local.MOVE_NONE, '两侧是平地，应该绕开')
})

// ---- 控制器（不需要真服务器） ----

function fakeSession (bot = null) {
  return {
    busy: null,
    activeStopOn: null,
    interruptedBy: null,
    actionEpoch: 0,
    alive: true,
    posture: { sneak: false, shield: false, jump: false },
    events: [],
    seq: 0,
    pushEvent (type, data) { this.events.push({ seq: ++this.seq, type, ...(data || {}) }) },
    claimLock (name, owner) {
      if (this.busy) return null
      if (owner === 'http') this.controller?.yieldToHttp()
      this.actionEpoch++
      this.interruptedBy = null
      return (this.busy = { name, owner })
    },
    releaseLock (lock) {
      if (this.busy === lock) { this.busy = null; this.interruptedBy = null }
    },
    interrupt (reason) { this.interruptedBy = reason },
    isReady () { return !!this.bot },
    applyPosture () {},
    attachController (controller) {
      this.controller = controller
      controller.onBotReady(this.bot)
    },
    detachController () {
      this.controller?.detach()
      this.controller = null
    },
    nearestHostile () { return null },
    bot,
    log () {}
  }
}

test('控制器在没有 bot 时不会崩，状态可读', () => {
  const s = fakeSession()
  const c = new coe.Controller(s, { policy: new policy.RulePolicy() })
  c.attach()
  assert.strictEqual(c.state().goal.type, 'idle')
  assert.strictEqual(c.stats().policy, 'rule')
  c.detach()
})

test('控制器把技能放进队列并认领动作锁', async () => {
  const s = fakeSession(fakeBot())
  const calls = []
  const c = new coe.Controller(s, { actions: { move_to: async (_, args) => calls.push(args) } })
  c.attach()
  c.submit('goto', { x: 1, y: 2, z: 3 })
  assert.strictEqual(s.busy.owner, 'controller')
  await flush()
  assert.deepStrictEqual(calls, [{ x: 1, y: 2, z: 3, range: 1.5 }])
  assert.strictEqual(s.busy, null)
  assert.strictEqual(c.stats().skills_done, 1)
  c.detach()
})

test('规则策略永远不会返回空动作对象', () => {
  const s = local.senseFromBot(fakeBot(), { goal: { type: 'idle' } })
  const a = policy.ruleAct(s, s.goal)
  assert.strictEqual(typeof a.move, 'number')
  for (const k of ['sprint', 'jump', 'sneak', 'shield', 'attack', 'use', 'dig']) {
    assert.strictEqual(typeof a[k], 'boolean')
  }
})

test('同一个 bot 只绑定一次 tick（死亡重生不会让反思循环跑两遍）', () => {
  const s = fakeSession()
  const c = new coe.Controller(s, { policy: new policy.RulePolicy() })
  const bot = new EventEmitter()
  c.onBotReady(bot)
  c.onBotReady(bot)
  assert.strictEqual(bot.listenerCount('physicsTick'), 1)
  c.onBotGone()
  assert.strictEqual(bot.listenerCount('physicsTick'), 0)
  c.onBotReady(bot)
  assert.strictEqual(bot.listenerCount('physicsTick'), 1)
  c.detach()
  assert.strictEqual(bot.listenerCount('health'), 0)
})

test('否决窗口内不启动新技能：保命优先于上层意图', async () => {
  const s = fakeSession()
  const c = new coe.Controller(s, { policy: new policy.RulePolicy() })
  c.attach()
  // 手动制造一个否决（危险判定由规则策略负责，这里直接调仲裁入口）
  c.applyOverride('threat', null)
  assert.strictEqual(c.goal.type, 'flee')
  c.submit('gather', { target: 'oak_log' })
  await new Promise(r => setTimeout(r, 60))
  assert.strictEqual(c.state().goal.type, 'flee', '否决窗口内 goal 应该还是 flee')
  assert.strictEqual(c.state().task_running, false, '否决窗口内不该启动任务')
  c.detach()
})

test('被否决的技能会留下 skill_failed 事件，危险消失后恢复空闲', async () => {
  const bot = fakeBot()
  const s = fakeSession(bot)
  let done
  const c = new coe.Controller(s, { actions: { move_to: () => new Promise(r => { done = r }) } })
  c.attach()
  c.submit('goto', { x: 1, y: 64, z: 3 })
  await flush()
  c.applyOverride('lava')
  done()
  await flush()
  const failed = s.events.filter(e => e.type === 'skill_failed')
  assert.strictEqual(failed.length, 1)
  assert.ok(/override/.test(failed[0].reason))
  c.override.until = 0
  await c.doTick(bot)
  assert.strictEqual(c.goal.type, 'idle')
  c.detach()
})

test('技能把编译参数传给合成、装备、聊天和攻击动作', async () => {
  const bot = fakeBot()
  bot.entities[7] = { name: 'zombie', id: 7, position: point(2, 64, 0) }
  const s = fakeSession(bot)
  const calls = []
  const actions = Object.fromEntries(['craft', 'equip', 'chat', 'attack'].map(skill => [skill, async (_, args) => {
    calls.push([skill, args])
    return { gained: 4, killed: true }
  }]))
  const c = new coe.Controller(s, { actions })
  c.attach()
  for (const [skill, args] of [
    ['craft', { item: 'stick', count: 4 }], ['equip', { item: 'stone_sword' }],
    ['chat', { message: 'hello' }], ['attack', { entity: 'zombie' }]
  ]) {
    c.submit(skill, args)
    await flush()
  }
  assert.deepStrictEqual(calls, [
    ['craft', { item: 'stick', count: 4 }], ['equip', { item: 'stone_sword', slot: 'hand' }],
    ['chat', { message: 'hello' }], ['attack', { entity_id: 7, max_hits: undefined }]
  ])
  assert.strictEqual(c.stats().skills_done, 4)
  c.detach()
})

test('HTTP 持锁时不清按键，也不执行接管前的推理', async () => {
  const bot = fakeBot()
  const s = fakeSession(bot)
  let resolve
  const c = new coe.Controller(s, { policy: { act: () => new Promise(r => { resolve = r }) } })
  s.attachController(c)
  c.goal = { type: 'goto', target: { pos: point(1, 64, 0) } }
  const pending = c.doTick(bot)
  const lock = s.claimLock('control', 'http')
  bot.setControlState('back', true)
  await c.doTick(bot)
  assert.strictEqual(bot.getControlState('back'), true)
  s.releaseLock(lock)
  resolve({ ...policy.emptyAction(), move: 0 })
  await pending
  assert.strictEqual(bot.getControlState('forward'), false)
  c.detach()
})

test('紧急技能抢占，卸载时取消执行和队列', async () => {
  const bot = fakeBot()
  const s = fakeSession(bot)
  let resolve
  const c = new coe.Controller(s, { actions: { move_to: () => new Promise(r => { resolve = r }) } })
  s.attachController(c)
  c.submit('goto', { x: 2, y: 64, z: 1 })
  await flush()
  c.submit('flee', {}, { priority: 'urgent' })
  assert.strictEqual(s.interruptedBy, 'preempted')
  c.detach()
  assert.strictEqual(bot.listenerCount('physicsTick'), 0)
  resolve()
  await flush()
  assert.strictEqual(s.busy, null)
  assert.strictEqual(c.bus.queue.length, 0)
  assert.strictEqual(c.stats().skills_started, 1)
})

test('并发挂载只创建一个控制器，卸载期间不驱动 bot', async () => {
  const bot = fakeBot()
  const s = fakeSession(bot)
  const [a, b] = await Promise.all([coe.attachController(s), coe.attachController(s)])
  assert.strictEqual(a, b)
  assert.strictEqual(bot.listenerCount('physicsTick'), 1)
  coe.detachController(s)
  assert.strictEqual(bot.listenerCount('physicsTick'), 0)
})

test('HTTP 移动时录制教师键位，当前动作与上一帧观测配对', async () => {
  const bot = fakeBot()
  const s = fakeSession(bot)
  const c = new coe.Controller(s)
  s.attachController(c)
  const rec = new coe.Recorder()
  const pairs = []
  rec.stream = {}
  rec.write = (obs, act) => pairs.push({ obs, act })
  c.setRecorder(rec)
  const lock = s.claimLock('move_to', 'http')
  lock.teacherGoal = { type: 'goto', target: { pos: point(3, 64, 0) } }
  bot.setControlState('forward', true)
  await c.doTick(bot)
  bot.setControlState('forward', false)
  bot.setControlState('right', true)
  await c.doTick(bot)
  assert.strictEqual(pairs.length, 1)
  assert.strictEqual(pairs[0].act.move, 2)
  assert.ok(pairs[0].obs.includes('gtgoto'))
  c.detach()
})

// ---- 上层：观测渲染 ----

const { renderObservation, classifyThreat } = require('../src/coe/render')

test('威胁等级由代码判定，不由 LLM 算', () => {
  // 参数是 get_entities 的响应形状
  const mk = d => ({ entities: [{ type: 'hostile', name: 'zombie', dist: d }] })
  assert.strictEqual(classifyThreat(mk(2.5)).level, 'danger')
  assert.strictEqual(classifyThreat(mk(6)).level, 'warn')
  assert.strictEqual(classifyThreat(mk(12.6)).level, 'safe')
  assert.strictEqual(classifyThreat({ entities: [] }).level, 'none')
  assert.strictEqual(classifyThreat(null).level, 'none')
})

test('渲染出的观测包含五个段落，且距离是算好的', () => {
  const raw = {
    status: { health: 14, food: 13, pos: [100, 12, -50], is_day: false, biome: 'cave', held: { name: 'stone_pickaxe' } },
    inventory: { items: [{ name: 'coal', count: 9 }, { name: 'torch', count: 32 }] },
    findBlocks: { blocks: [{ name: 'coal_ore', dist: 4.6 }, { name: 'cobblestone', dist: 3.6 }] },
    entities: { entities: [{ type: 'hostile', name: 'zombie', dist: 2.5 }] },
    events: { events: [{ type: 'hurt', damage: 2 }] }
  }
  const text = renderObservation(raw)
  for (const sec of ['状态:', '威胁等级:', '资源:', '背包:', '最近事件:']) {
    assert.ok(text.includes(sec), '缺少段落 ' + sec)
  }
  assert.ok(text.includes('危险'), '僵尸 2.5 格应该是危险')
  assert.ok(text.includes('cobblestone 3.6格'), '资源要按距离排')
  assert.ok(text.includes('coal x9'))
  assert.ok(text.includes('受到攻击'))
  // 资源按距离升序
  assert.ok(text.indexOf('cobblestone') < text.indexOf('coal_ore'))
})

// ---- 上层：LLM 客户端 ----

const { Planner, buildSkillSchema, proposeSkills } = require('../src/coe/llm')
const { scoreScenario } = require('../src/coe/rubric')
const SCENARIOS = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/coe/scenarios.json'), 'utf8')).scenarios

test('技能 schema 覆盖全部技能（wait 除外）', () => {
  const schema = buildSkillSchema()
  assert.strictEqual(schema.type, 'array')
  // oneOf 里每个技能一条分支，用 const 约束技能名
  const names = schema.items.oneOf.map(b => b.properties.skill.const)
  // wait 不在上层动作空间里：「没事做」应该是不下发技能，而不是空转一秒
  const expected = skills.SKILL_NAMES.filter(n => n !== 'wait')
  assert.deepStrictEqual(names.sort(), expected.sort())
  assert.ok(!names.includes('wait'))
  // 参数必须禁止多余字段，否则模型会塞进 distance 之类的垃圾
  for (const branch of schema.items.oneOf) {
    assert.strictEqual(branch.properties.args.additionalProperties, false)
  }
})

test('parseSkills 认得 {skill, args:{...}} 形态', () => {
  const list = skills.parseSkills('[{"skill":"gather","args":{"target":"oak_log","count":4}}]')
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].args.target, 'oak_log')
  assert.strictEqual(list[0].args.count, 4)
})

test('attack 按实体名引用，代码再解析成 id', () => {
  assert.strictEqual(skills.validateSkill('attack', { entity: 'zombie' }).ok, true)
  assert.strictEqual(skills.validateSkill('attack', { entity_id: 812 }).ok, true)
  assert.strictEqual(skills.validateSkill('attack', { entity: 812 }).ok, false)
  assert.strictEqual(skills.validateSkill('attack', {}).ok, false)
})

test('实体引用的各种写法都能解析', () => {
  const bot = {
    entity: { position: { distanceTo: () => 1 } },
    entities: {
      812: { id: 812, name: 'zombie', type: 'hostile', position: { distanceTo: () => 1 } },
      4301: { id: 4301, name: 'Creeper', type: 'hostile', position: { distanceTo: () => 5 } }
    }
  }
  assert.strictEqual(skills.resolveEntity(bot, 'zombie'), 812)
  assert.strictEqual(skills.resolveEntity(bot, 'zombie#812'), 812)
  assert.strictEqual(skills.resolveEntity(bot, '812'), 812)
  assert.strictEqual(skills.resolveEntity(bot, 812), 812)
  assert.strictEqual(skills.resolveEntity(bot, 'Creeper'), 4301, '大小写不敏感')
  assert.strictEqual(skills.resolveEntity(bot, 'creeper'), 4301, '类型名也能匹配')
  assert.strictEqual(skills.resolveEntity(bot, '不存在'), null)
})

test('Planner 把渲染文本喂给客户端并解析出技能', async () => {
  let seen = null
  const fakeClient = {
    async chat (messages) {
      seen = messages
      return { ok: true, content: '[{"skill":"gather","args":{"target":"oak_log","count":2}}]', ms: 123 }
    }
  }
  const p = new Planner({ client: fakeClient })
  const res = await p.plan({
    status: { health: 20, pos: [1, 2, 3], is_day: true, biome: 'forest', held: { name: 'iron_sword' } },
    entities: { entities: [] }
  })
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.skills.length, 1)
  assert.strictEqual(res.skills[0].skill, 'gather')
  assert.ok(seen[1].content.includes('威胁等级: 无'), '用户消息里要有渲染后的观测')
})

test('LLM 失败时不抛异常，只是 ok:false', async () => {
  const fakeClient = {
    async chat () { return { ok: false, error: '超时 8000ms', ms: 8000 } }
  }
  const p = new Planner({ client: fakeClient })
  const res = await p.plan({ status: {}, entities: { entities: [] } })
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.error, '超时 8000ms')
})

test('威胁等级由代码决定技能顺序，不指望模型听话', () => {
  const p = new Planner({ client: { async chat () { return { ok: true, content: '[]' } } } })
  // 危险：模型把 attack 排在 flee 前面 → 代码要把它挪到后面
  const danger = p.arrange(
    [{ skill: 'attack', args: { entity: 'zombie' } }, { skill: 'flee', args: {} }],
    { level: 'danger' }
  )
  assert.strictEqual(danger[0].skill, 'flee')
  // 危险：模型完全没提 flee → 代码补一个
  const noFlee = p.arrange([{ skill: 'attack', args: { entity: 'zombie' } }], { level: 'danger' })
  assert.strictEqual(noFlee[0].skill, 'flee')
  // 安全：去掉 flee
  const safe = p.arrange(
    [{ skill: 'flee', args: {} }, { skill: 'gather', args: { target: 'oak_log' } }],
    { level: 'safe' }
  )
  assert.strictEqual(safe.length, 1)
  assert.strictEqual(safe[0].skill, 'gather')
  // 吃饱了还吃 → 去掉 eat（API 会报 not_hungry）
  const full = p.arrange(
    [{ skill: 'eat', args: {} }, { skill: 'gather', args: { target: 'oak_log' } }],
    { level: 'none' }, { food: 20 }
  )
  assert.strictEqual(full.length, 1)
  assert.strictEqual(full[0].skill, 'gather')
  // 没吃饱就允许 eat
  const hungry = p.arrange([{ skill: 'eat', args: {} }], { level: 'none' }, { food: 12 })
  assert.strictEqual(hungry.length, 1)
})

test('proposeSkills 单独通过全部离线场景', () => {
  for (const sc of SCENARIOS) {
    const scored = scoreScenario(sc, proposeSkills(sc.raw))
    assert.strictEqual(scored.pass, true, `${sc.name} 失败 ${scored.failed.join(',')} 技能 ${scored.skills.join(',')}`)
  }
})

test('安全时模型只给 attack：丢掉后改成采集或赶路', async () => {
  const sc = SCENARIOS.find(s => s.name === 'plain_collect')
  const p = new Planner({
    client: { async chat () { return { ok: true, content: '[{"skill":"attack","args":{"entity":"zombie"}}]', ms: 1 } } }
  })
  const res = await p.plan(sc.raw)
  const scored = scoreScenario(sc, res.skills)
  assert.strictEqual(res.ok, true)
  assert.strictEqual(scored.pass, true, scored.failed.join(','))
  assert.ok(!res.skills.some(s => s.skill === 'attack' || s.skill === 'flee'))
})

test('模型给空数组：没有资源时改成有限坐标的 goto', async () => {
  const sc = SCENARIOS.find(s => s.name === 'no_resources')
  const p = new Planner({
    client: { async chat () { return { ok: true, content: '[]', ms: 1 } } }
  })
  const res = await p.plan(sc.raw)
  assert.strictEqual(res.skills[0].skill, 'goto')
  assert.strictEqual(res.skills[0].args.x, 308)
  assert.strictEqual(res.skills[0].args.y, 64)
  assert.strictEqual(res.skills[0].args.z, 300)
  assert.strictEqual(scoreScenario(sc, res.skills).pass, true)
})

test('没有镐也没有工作台时，只挖木头会改成先合成', async () => {
  const sc = SCENARIOS.find(s => s.name === 'workbench_ready')
  const p = new Planner({
    client: {
      async chat () {
        return {
          ok: true,
          content: '[{"skill":"mine","args":{"target":"oak_log"}},{"skill":"gather","args":{"target":"birch_log"}}]',
          ms: 1
        }
      }
    }
  })
  const res = await p.plan(sc.raw)
  const scored = scoreScenario(sc, res.skills)
  assert.strictEqual(scored.pass, true, scored.failed.join(','))
  assert.ok(res.skills.some(s => s.skill === 'craft'))
})

test('模型已经跟上确定目标时，丢掉后面凑数的技能', async () => {
  const raw = {
    status: { health: 20, food: 18, pos: [0, 12, 0] },
    inventory: { items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'cobblestone', count: 16 }] },
    findBlocks: { blocks: [{ name: 'coal_ore', dist: 3.2 }, { name: 'iron_ore', dist: 5.1 }] },
    entities: { entities: [] },
    suggestion: { text: 'mine iron_ore', skill: { skill: 'mine', args: { target: 'iron_ore' } } }
  }
  const content = JSON.stringify([
    { skill: 'mine', args: { target: 'iron_ore' } },
    { skill: 'craft', args: { item: 'crafting_table' } },
    { skill: 'goto', args: { x: 8, y: 64, z: 0 } }
  ])
  const p = new Planner({ client: { async chat () { return { ok: true, content, ms: 1 } } } })
  const res = await p.plan(raw)
  assert.deepStrictEqual(res.skills.map(s => s.skill), ['mine'])
  assert.strictEqual(res.skills[0].args.target, 'iron_ore')
})

test('没有确定目标时，仍保留模型给出的下一条技能', async () => {
  const raw = {
    status: { health: 20, food: 20, pos: [0, 64, 0] },
    inventory: { items: [] },
    findBlocks: { blocks: [{ name: 'iron_ore', dist: 5 }] },
    entities: { entities: [] }
  }
  const content = JSON.stringify([
    { skill: 'mine', args: { target: 'iron_ore' } },
    { skill: 'craft', args: { item: 'stick' } }
  ])
  const p = new Planner({ client: { async chat () { return { ok: true, content, ms: 1 } } } })
  const res = await p.plan(raw)
  assert.deepStrictEqual(res.skills.map(s => s.skill), ['mine', 'craft'])
})

test('危险时确定目标仍是逃跑，模型多给的攻击不会留下', async () => {
  const raw = {
    status: { health: 14, food: 20, pos: [10, 64, 10] },
    inventory: { items: [{ name: 'oak_log', count: 8 }] },
    findBlocks: { blocks: [{ name: 'oak_log', dist: 4 }] },
    entities: { entities: [{ type: 'hostile', name: 'zombie', dist: 2.5 }] },
    suggestion: { text: 'flee', skill: { skill: 'flee', args: {} } }
  }
  const content = JSON.stringify([
    { skill: 'flee', args: {} },
    { skill: 'attack', args: { entity: 'zombie' } },
    { skill: 'gather', args: { target: 'oak_log' } }
  ])
  const p = new Planner({ client: { async chat () { return { ok: true, content, ms: 1 } } } })
  const res = await p.plan(raw)
  assert.deepStrictEqual(res.skills.map(s => s.skill), ['flee'])
})

test('安全时建议已经排了多步，就按这个顺序执行', async () => {
  const steps = [
    { skill: 'place', args: { item: 'crafting_table' } },
    { skill: 'craft', args: { item: 'wooden_pickaxe' } },
    { skill: 'mine', args: { target: 'stone', count: 11 } }
  ]
  const raw = {
    status: { health: 20, food: 20, pos: [0, 71, 0] },
    inventory: { items: [{ name: 'oak_planks', count: 6 }, { name: 'stick', count: 4 }, { name: 'crafting_table', count: 1 }] },
    findBlocks: { blocks: [{ name: 'stone', dist: 3 }] },
    entities: { entities: [] },
    suggestion: { text: 'place → craft → mine', skill: steps[0], steps }
  }
  const p = new Planner({
    maxSkills: 4,
    client: { async chat () { return { ok: true, content: '[{"skill":"craft","args":{"item":"wooden_pickaxe"}}]', ms: 1 } } }
  })
  const res = await p.plan(raw)
  assert.deepStrictEqual(res.skills.map(s => s.skill), ['place', 'craft', 'mine'])
  assert.strictEqual(res.skills[0].args.item, 'crafting_table')
})

test('向下挖不要求目标方块已经出现在资源里', async () => {
  const raw = {
    status: { health: 20, food: 20, pos: [0, 71, 0] },
    inventory: { items: [] },
    findBlocks: { blocks: [{ name: 'dirt', dist: 1 }] },
    entities: { entities: [] },
    suggestion: {
      text: '向下',
      skill: { skill: 'mine', args: { target: 'stone', count: 8, down: true } },
      steps: [{ skill: 'mine', args: { target: 'stone', count: 8, down: true } }]
    }
  }
  const p = new Planner({
    client: { async chat () { return { ok: true, content: '[]', ms: 1 } } }
  })
  const res = await p.plan(raw)
  assert.strictEqual(res.skills[0].skill, 'mine')
  assert.strictEqual(res.skills[0].args.down, true)
})

test('危险时不用铁锭链替换逃跑', async () => {
  const steps = [
    { skill: 'place', args: { item: 'crafting_table' } },
    { skill: 'craft', args: { item: 'wooden_pickaxe' } }
  ]
  const raw = {
    status: { health: 20, food: 20, pos: [0, 64, 0] },
    inventory: { items: [{ name: 'crafting_table', count: 1 }] },
    findBlocks: { blocks: [] },
    entities: { entities: [{ type: 'hostile', name: 'zombie', dist: 2.5 }] },
    suggestion: { text: 'place', skill: steps[0], steps }
  }
  const p = new Planner({
    client: {
      async chat () {
        return { ok: true, content: '[{"skill":"flee","args":{}},{"skill":"attack","args":{"entity":"zombie"}}]', ms: 1 }
      }
    }
  })
  const res = await p.plan(raw)
  assert.strictEqual(res.skills[0].skill, 'flee')
  assert.ok(!res.skills.some(s => s.skill === 'place'))
})

test('危险时模型只说一句 chat：代码仍把 flee 放在第一位', async () => {
  const sc = SCENARIOS.find(s => s.name === 'zombie_point_blank')
  const p = new Planner({
    client: { async chat () { return { ok: true, content: '[{"skill":"chat","args":{"message":"hi"}}]', ms: 1 } } }
  })
  const res = await p.plan(sc.raw)
  assert.strictEqual(res.skills[0].skill, 'flee')
  assert.strictEqual(scoreScenario(sc, res.skills).pass, true)
})

const { planIronChain } = require('../src/coe/iron')

test('卡住的背包先放下工作台，而不是直接合成木镐', () => {
  const r = planIronChain({
    have: { oak_planks: 6, stick: 4, crafting_table: 1 },
    around: ['stone'],
    pos: [306, 71, 59]
  })
  assert.ok(r.steps.length >= 1 && r.steps.length <= 4)
  assert.strictEqual(r.steps[0].skill, 'place')
  assert.strictEqual(r.steps[0].args.item, 'crafting_table')
  const names = r.steps.map(s => s.skill + ':' + ((s.args && (s.args.item || s.args.target)) || ''))
  assert.ok(names.indexOf('place:crafting_table') < names.indexOf('craft:wooden_pickaxe'))
  assert.ok(names.includes('mine:stone'))
})

test('有粗铁、熔炉物品和煤时先放下熔炉再烧', () => {
  const r = planIronChain({
    have: { raw_iron: 1, furnace: 1, coal: 2 },
    around: [],
    pos: [0, 40, 0]
  })
  assert.deepStrictEqual(r.steps.map(s => s.skill), ['place', 'smelt'])
  assert.strictEqual(r.steps[0].args.item, 'furnace')
  assert.strictEqual(r.steps[1].args.item, 'raw_iron')
})

test('已经有铁锭时不再排步骤', () => {
  const r = planIronChain({
    have: { iron_ingot: 1, raw_iron: 3, cobblestone: 20 },
    around: ['iron_ore'],
    pos: [0, 16, 0]
  })
  assert.deepStrictEqual(r.steps, [])
})

test('有石镐且还在高处时往下挖', () => {
  const r = planIronChain({
    have: { stone_pickaxe: 1, furnace: 1, oak_planks: 2, cobblestone: 8 },
    around: [],
    pos: [0, 71, 0]
  })
  assert.strictEqual(r.steps[0].skill, 'mine')
  assert.strictEqual(r.steps[0].args.down, true)
})

test('勘测里的铁矿还在脚下很深时继续往下挖', () => {
  const r = planIronChain({
    have: { stone_pickaxe: 1, furnace: 1, oak_planks: 3, cobblestone: 19 },
    around: [{ name: 'iron_ore', pos: [303, 20, 48], dist: 32 }],
    pos: [307, 49, 61]
  })
  assert.strictEqual(r.steps.length, 1)
  assert.strictEqual(r.steps[0].skill, 'mine')
  assert.strictEqual(r.steps[0].args.target, 'stone')
  assert.strictEqual(r.steps[0].args.down, true)
  assert.ok(r.steps[0].args.count >= 1 && r.steps[0].args.count <= 8)
  assert.ok(!r.steps.some(s => s.args && s.args.target === 'iron_ore'))
})

test('高度已经落到铁矿这一层时朝矿挖过去', () => {
  const r = planIronChain({
    have: { stone_pickaxe: 1, furnace: 1, oak_planks: 3 },
    around: [{ name: 'iron_ore', pos: [303, 20, 48] }],
    pos: [307, 20.1, 61]
  })
  assert.strictEqual(r.steps[0].skill, 'mine')
  assert.strictEqual(r.steps[0].args.ahead, true)
  assert.deepStrictEqual(r.steps[0].args.dir, [0, -1])
  assert.ok(!r.steps.some(s => s.args && s.args.target === 'iron_ore'))
})

test('铁矿就在身边时直接挖', () => {
  const r = planIronChain({
    have: { stone_pickaxe: 1, furnace: 1, oak_planks: 1 },
    around: [{ name: 'iron_ore', pos: [2, 16, 1] }],
    pos: [0, 16, 0]
  })
  assert.strictEqual(r.steps[0].skill, 'mine')
  assert.strictEqual(r.steps[0].args.target, 'iron_ore')
  assert.ok(r.steps[0].args.down !== true)
  assert.ok(r.steps.some(s => s.skill === 'place' && s.args.item === 'furnace'))
  assert.ok(r.steps.some(s => s.skill === 'smelt' && s.args.item === 'raw_iron'))
})
