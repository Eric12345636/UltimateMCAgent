'use strict'
// 上层端到端验收：真的连本机 Ollama，把渲染好的观测喂给 qwen2.5-mc:7b，
// 检查拿回来的技能是不是合法的、能落到 API 上。
//
// 这不是单元测试（需要 Ollama 在跑），是手动/冒烟脚本：
//   node src/coe/llm-e2e.js
//
// 跑之前先确认 Ollama 的配置生效了：
//   ollama ps        → CONTEXT 应该是 8192，PROCESSOR 应该是 100% GPU

const { Planner, OllamaClient } = require('./llm')
const { validateSkill } = require('./skills')

const SCENARIOS = [
  {
    name: '林地开局：有树有工作台，僵尸 12.6 格',
    raw: {
      status: { health: 20, food: 20, pos: [10, 64, 10], is_day: true, biome: 'forest', held: { name: 'iron_sword' } },
      inventory: { items: [{ name: 'oak_log', count: 12 }, { name: 'stick', count: 4 }, { name: 'crafting_table', count: 1 }, { name: 'iron_sword', count: 1 }] },
      findBlocks: { blocks: [{ name: 'crafting_table', dist: 2.8 }, { name: 'oak_log', dist: 4.5 }, { name: 'stone', dist: 4.6 }] },
      entities: { entities: [{ type: 'hostile', name: 'zombie', id: 812, dist: 12.6 }, { type: 'animal', name: 'cow', id: 900, dist: 5.8 }] },
      events: { events: [{ type: 'hurt', damage: 3 }] }
    }
  },
  {
    name: '矿洞深处：苦力怕 7.6 格，有煤矿',
    raw: {
      status: { health: 14, food: 13, pos: [100, 12, -50], is_day: false, biome: 'cave', held: { name: 'stone_pickaxe' } },
      inventory: { items: [{ name: 'cobblestone', count: 34 }, { name: 'coal', count: 9 }, { name: 'raw_iron', count: 3 }, { name: 'torch', count: 32 }] },
      findBlocks: { blocks: [{ name: 'cobblestone', dist: 3.6 }, { name: 'coal_ore', dist: 4.6 }, { name: 'iron_ore', dist: 6.2 }] },
      entities: { entities: [{ type: 'hostile', name: 'creeper', id: 4301, dist: 7.6 }, { type: 'hostile', name: 'skeleton', id: 4302, dist: 13.4 }] },
      events: { events: [{ type: 'hurt', damage: 2 }] }
    }
  },
  {
    name: '僵尸贴脸：必须先逃',
    raw: {
      status: { health: 14, food: 20, pos: [10, 64, 10], is_day: true, biome: 'forest', held: { name: 'iron_sword' } },
      inventory: { items: [{ name: 'oak_log', count: 12 }, { name: 'iron_sword', count: 1 }] },
      findBlocks: { blocks: [{ name: 'crafting_table', dist: 2.8 }, { name: 'oak_log', dist: 4.5 }] },
      entities: { entities: [{ type: 'hostile', name: 'zombie', id: 812, dist: 2.5 }] },
      events: { events: [{ type: 'hurt', damage: 2 }] }
    }
  }
]

async function main () {
  const client = new OllamaClient({
    endpoint: process.env.MC_LLM_ENDPOINT || 'http://127.0.0.1:11434',
    model: process.env.MC_LLM_MODEL || 'qwen2.5-mc:7b',
    keepAlive: '30m',
    timeoutMs: 20000
  })

  const health = await client.health()
  console.log('Ollama:', JSON.stringify(health))
  if (!health.ok) {
    console.log('Ollama 不可达，先启动它：ollama app.exe')
    process.exit(1)
  }

  const planner = new Planner({ client })
  let allValid = true
  for (const sc of SCENARIOS) {
    const t0 = Date.now()
    const res = await planner.plan(sc.raw)
    const ms = Date.now() - t0
    console.log(`\n--- ${sc.name}  ${ms} ms ---`)
    console.log(res.observation)
    if (!res.ok) {
      console.log('  !! 失败:', res.error)
      allValid = false
      continue
    }
    console.log('  原始输出:', res.raw_content)
    if (!res.skills.length) {
      console.log('  !! 没解析出技能')
      allValid = false
      continue
    }
    for (const sk of res.skills) {
      const v = validateSkill(sk.skill, sk.args)
      console.log(`  技能 ${sk.skill} ${JSON.stringify(sk.args)}  合法=${v.ok}${v.ok ? '' : ' (' + v.error + ')'}`)
      if (!v.ok) allValid = false
    }
  }
  console.log('\n' + (allValid ? '全部通过' : '有失败项'))
  console.log('客户端统计:', JSON.stringify(client.stats()))
  process.exit(allValid ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })

