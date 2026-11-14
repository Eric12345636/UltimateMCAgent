'use strict'
// 压缩层测试：token 预算、结构稳定性、确定性。

const test = require('node:test')
const assert = require('node:assert')

const { compress, vocab, loadScenarios } = require('../src')

const scenarios = loadScenarios()
const forest = scenarios.find(s => s.name === 'forest')
const mine = scenarios.find(s => s.name === 'mine')

test('词表已生成且覆盖夹具里出现的所有名字', () => {
  const v = vocab.load()
  assert.ok(v.meta.nameCount > 1500, '词表规模太小')
  for (const s of scenarios) {
    for (const b of s.observation.blocks) assert.ok(vocab.has(b.name), `词表缺方块 ${b.name}`)
    for (const e of s.observation.entities) assert.ok(vocab.has(e.name), `词表缺实体 ${e.name}`)
    for (const it of s.observation.inventory.items) assert.ok(vocab.has(it.name), `词表缺物品 ${it.name}`)
  }
})

test('压缩结果结构完整', () => {
  const c = compress(forest.observation)
  assert.equal(c.tokens[0], '<s>')
  assert.equal(c.tokens[c.tokens.length - 1], '</s>')
  assert.ok(c.tokens.includes('pos'))
  assert.ok(c.tokens.includes('hp'))
  assert.ok(c.tokens.includes('inv'))
  assert.ok(c.tokens.includes('blk'))
  assert.ok(c.tokens.includes('ent'))
  assert.ok(c.tokens.includes('ev'))
})

test('候选方块的下标从 0 连续编号，指针才对得上', () => {
  const c = compress(forest.observation)
  const idxs = []
  for (let i = 0; i < c.tokens.length; i++) if (c.tokens[i] === 'blk') idxs.push(Number(c.tokens[i + 1]))
  assert.deepStrictEqual(idxs, forest.observation.blocks.map((_, i) => i))
})

test('实体候选同样从 0 连续编号', () => {
  const c = compress(mine.observation)
  const idxs = []
  for (let i = 0; i < c.tokens.length; i++) if (c.tokens[i] === 'ent') idxs.push(Number(c.tokens[i + 1]))
  assert.deepStrictEqual(idxs, mine.observation.entities.map((_, i) => i))
})

test('名字全部压成单 token（N<id>）', () => {
  const c = compress(forest.observation)
  const nameTokens = c.tokens.filter(t => /^N\d+$/.test(t))
  assert.ok(nameTokens.length > 5)
  // 名字不该再以明文出现在 token 里
  assert.ok(!c.tokens.includes('oak_log'), 'oak_log 应该被压成 N<id>')
  assert.ok(!c.tokens.includes('zombie'), 'zombie 应该被压成 N<id>')
})

test('token 量在预算内（单步 ≤ 320）', () => {
  for (const s of scenarios) {
    const c = compress(s.observation)
    assert.ok(c.stats.total <= 320,
      `${s.name} 压了 ${c.stats.total} token，超预算：${JSON.stringify(c.stats.sections)}`)
  }
})

test('压缩是确定性的（同样输入 → 同样 token）', () => {
  const a = compress(forest.observation)
  const b = compress(forest.observation)
  assert.deepStrictEqual(a.tokens, b.tokens)
})

test('各段落能单独关掉，用来做消融', () => {
  const full = compress(forest.observation)
  const noEnt = compress(forest.observation, { includeEntities: false })
  const noInv = compress(forest.observation, { includeInventory: false })
  assert.ok(noEnt.tokens.length < full.tokens.length)
  assert.ok(noInv.tokens.length < full.tokens.length)
  assert.ok(!noEnt.tokens.includes('ent'))
  assert.ok(!noInv.tokens.includes('inv'))
})

test('未知名字走 X<原文>，不丢信息', () => {
  assert.match(vocab.nameToken('some_custom_item'), /^Xsome_custom_item$/)
})
