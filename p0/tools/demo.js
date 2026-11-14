'use strict'
// 演示：把一个场景压成 token，并做一遍「教师调用 → 指针 → 还原」的往返。
//
//   node tools/demo.js [场景名]
//
// 不需要 Minecraft 服务端，全离线。

const { loadScenarios, compress, encodeAction, decodeAction, toRequest } = require('../src')

const only = process.argv[2]
const scenarios = loadScenarios().filter(s => !only || s.name === only)

for (const s of scenarios) {
  const c = compress(s.observation)
  console.log('='.repeat(78))
  console.log(`场景 ${s.name}：${s.desc || ''}`)
  console.log('-'.repeat(78))
  console.log(`token 数 ${c.stats.total}  （方块 ${c.stats.blockCount} / 实体 ${c.stats.entityCount} / 背包 ${c.stats.inventoryCount}）`)
  console.log('分段：', JSON.stringify(c.stats.sections))
  console.log('-'.repeat(78))
  console.log(c.text)
  console.log('-'.repeat(78))
  console.log('教师调用 → 指针 → 还原：')
  for (const call of s.teacher_calls) {
    const enc = encodeAction(call.verb, call.args, s.observation, { strict: true })
    if (!enc.ok) {
      console.log(`  ✗ ${call.verb.padEnd(10)} ${enc.error}`)
      continue
    }
    const dec = decodeAction(enc.tokens, s.observation)
    const req = toRequest(dec.verb, dec.args)
    console.log(`  ✓ ${call.verb.padEnd(10)} ${enc.tokens.join(' ')}`)
    console.log(`    ${'-'.repeat(8)} → ${req.method} /${req.path} ${JSON.stringify(req.body)}`)
  }
  console.log()
}
