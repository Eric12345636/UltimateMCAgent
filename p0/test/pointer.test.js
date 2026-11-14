'use strict'
// 指针层测试：动作参数 ⇄ 紧凑 token 的双向还原，以及保真度指标。

const test = require('node:test')
const assert = require('node:assert')

const {
  buildObservation, encodeAction, decodeAction, toRequest, sameRequest, fidelity, loadScenarios
} = require('../src')

const scenarios = loadScenarios()
const forest = scenarios.find(s => s.name === 'forest')
const mine = scenarios.find(s => s.name === 'mine')

test('夹具能正常加载，候选表按距离排序', () => {
  assert.ok(scenarios.length >= 2)
  const blocks = forest.observation.blocks
  for (let i = 1; i < blocks.length; i++) {
    assert.ok(blocks[i - 1].dist <= blocks[i].dist, '方块候选必须按距离升序')
  }
  const ents = forest.observation.entities
  for (let i = 1; i < ents.length; i++) {
    assert.ok(ents[i - 1].dist <= ents[i].dist, '实体候选必须按距离升序')
  }
})

test('每个教师调用都能编码成指针', () => {
  for (const s of scenarios) {
    for (const call of s.teacher_calls) {
      const enc = encodeAction(call.verb, call.args, s.observation, { strict: true })
      assert.ok(enc.ok, `${s.name}/${call.verb} 编码失败：${enc.error}`)
      assert.equal(enc.tokens[0], '<a>')
      assert.equal(enc.tokens[enc.tokens.length - 1], '</a>')
    }
  }
})

test('指针能还原出完全一致的 HTTP 请求', () => {
  for (const s of scenarios) {
    for (const call of s.teacher_calls) {
      const enc = encodeAction(call.verb, call.args, s.observation, { strict: true })
      const dec = decodeAction(enc.tokens, s.observation)
      assert.ok(dec, `${s.name}/${call.verb} 解码返回空`)
      const original = toRequest(call.verb, call.args)
      const restored = toRequest(dec.verb, dec.args)
      assert.ok(sameRequest(original, restored),
        `${s.name}/${call.verb} 还原不一致\n原始: ${JSON.stringify(original)}\n还原: ${JSON.stringify(restored)}`)
    }
  }
})

test('保真度：可见目标的调用 100% 可达', () => {
  for (const s of scenarios) {
    const f = fidelity(s.teacher_calls, s.observation)
    assert.equal(f.reachable, f.total,
      `${s.name} 有 ${f.total - f.reachable} 个调用不可达：\n` +
      f.failures.map(x => `  ${x.verb} ${JSON.stringify(x.args)} → ${x.reason}`).join('\n'))
    assert.equal(f.reachableRate, 1)
  }
})

test('严格模式下看不见的目标会被拒绝，宽松模式下用字面表达', () => {
  const obs = forest.observation
  const hidden = { verb: 'dig', args: { x: 500, y: 64, z: 500 } }

  const strict = encodeAction(hidden.verb, hidden.args, obs, { strict: true })
  assert.equal(strict.ok, false)
  assert.match(strict.error, /不在候选表/)

  const loose = encodeAction(hidden.verb, hidden.args, obs, { strict: false })
  assert.ok(loose.ok)
  const dec = decodeAction(loose.tokens, obs)
  assert.ok(dec)
  assert.ok(sameRequest(toRequest(dec.verb, dec.args), toRequest(hidden.verb, hidden.args)))
})

test('move_to 省略 y 时不能被带 y 的候选块顶替', () => {
  const obs = forest.observation
  // [10,64,17] 在候选里，但省略 y 的语义是"只走 XZ"，不能编码成 b4
  const enc = encodeAction('move_to', { x: 10, z: 17 }, obs, { strict: true })
  assert.ok(enc.ok)
  assert.ok(!enc.tokens.includes('b4'), '省略 y 时不应产生方块指针')
  assert.ok(enc.tokens.includes('px'), '应退化成 px 字面坐标')
  const dec = decodeAction(enc.tokens, obs)
  assert.equal(dec.args.x, 10)
  assert.equal(dec.args.z, 17)
  assert.equal(dec.args.y, undefined, 'y 必须保持缺省')
})

test('use_item 的嵌套 target 能正确还原', () => {
  const obs = mine.observation
  const call = { verb: 'use_item', args: { item: 'torch', target: { pos: [98, 12, -47] } } }
  const enc = encodeAction(call.verb, call.args, obs, { strict: true })
  assert.ok(enc.ok)
  const dec = decodeAction(enc.tokens, obs)
  assert.ok(dec.args.target)
  assert.ok(Array.isArray(dec.args.target.pos), 'target 必须是嵌套的 {pos:[...]} 形状')
  assert.deepStrictEqual(dec.args.target.pos, [98, 12, -47])
})

test('posture 是全量设置语义：只写 true 的开关，缺省即 false', () => {
  const obs = forest.observation
  const enc = encodeAction('posture', { sneak: true }, obs, { strict: true })
  assert.ok(enc.ok)
  assert.ok(enc.tokens.includes('sneak'))
  assert.ok(!enc.tokens.includes('shield'), 'false 的开关不该占 token')

  const dec = decodeAction(enc.tokens, obs)
  assert.equal(dec.args.sneak, true)
  // 语义等价：{sneak:true} ≡ {sneak:true,shield:false,jump:false}
  assert.ok(sameRequest(
    toRequest('posture', dec.args),
    toRequest('posture', { sneak: true, shield: false, jump: false })
  ))
})

test('名字走词表编码，实体 id 原样保留', () => {
  const obs = forest.observation
  const enc = encodeAction('attack', { entity_id: 812 }, obs, { strict: true })
  assert.ok(enc.ok)
  // e<idx> 是指针，真正的 id 在还原时才从候选表取
  assert.ok(enc.tokens.includes('e1'))
  const dec = decodeAction(enc.tokens, obs)
  assert.equal(dec.args.entity_id, 812)
})

test('解码垃圾输入不崩，返回 null', () => {
  const obs = forest.observation
  assert.equal(decodeAction([], obs), null)
  assert.equal(decodeAction(['<a>', '不存在的动词', '</a>'], obs), null)
  assert.equal(decodeAction(['<a>', 'dig', 't', 'b999', '</a>'], obs), null, '越界的指针必须被拒')
  assert.equal(decodeAction(['<a>', 'craft', 'item', '</a>'], obs), null)
  assert.equal(decodeAction(['<a>', 'dig', '</a>'], obs), null)
  assert.equal(decodeAction(['<a>', 'dig', 't', 'p', '1', '2', '</a>'], obs), null)
})

test('未知物品名可以原样往返', () => {
  const obs = { blocks: [], entities: [] }
  const args = { item: 'custom:item' }
  const enc = encodeAction('equip', args, obs)
  assert.deepEqual(decodeAction(enc.tokens, obs), { verb: 'equip', args })
})
