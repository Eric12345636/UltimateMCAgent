'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { publicClient } = require('../src/competition/api')
const { ROUND_MS, scoringTable, completedAdvancements } = require('../src/competition/rules')
const { Strategy, islandBounds } = require('../src/competition/strategy')
const { runCompetition, execute } = require('../src/competition/runner')

const markdown = [
  '| `minecraft:story/mine_stone` | Stone Age | 1 | 5 | 计分 |',
  '| `minecraft:story/upgrade_tools` | Getting an Upgrade | 1 | 5 | 计分 |',
  '| `minecraft:story/obtain_armor` | Suit Up | 1 | 5 | 计分 |',
  '| `minecraft:story/shiny_gear` | Cover Me with Diamonds | 4 | 60 | 计分 |',
  '| `minecraft:adventure/trade` | What a Deal! | 2 | 15 | 岛上有村庄时计分 |',
  '| `minecraft:adventure/adventuring_time` | Adventuring Time | 5 | — | 不计分 |'
].join('\n')
const mineStone = 'minecraft:story/mine_stone'
const upgrade = 'minecraft:story/upgrade_tools'
const armor = 'minecraft:story/obtain_armor'
const smelt = 'minecraft:story/smelt_iron'
const trade = 'minecraft:adventure/trade'
const obsidian = 'minecraft:story/form_obsidian'
const bounds = islandBounds({ overworld: { center: [0, 0], radius: 40 } })

test('只计时限内、规则表允许的原版进度，按 ID 去重', () => {
  const table = scoringTable(markdown)
  assert.equal(table.get(mineStone), 5)
  assert.equal(table.get('minecraft:story/shiny_gear'), 60)
  assert.equal(table.has(trade), false)
  assert.equal(scoringTable(markdown, [trade]).get(trade), 15)
  assert.throws(() => scoringTable(markdown, ['minecraft:adventure/adventuring_time']))
  const sample = [
    [mineStone, 1001], [mineStone, 1001], [armor, 999], [trade, 1100],
    ['minecraft:recipes/tools/iron_pickaxe', 1100], ['custom:adventure/custom', 1100],
    [upgrade, 1000 + ROUND_MS]
  ].map(([id, completed_at]) => ({ id, completed_at, status: 'completed' }))
  assert.equal(completedAdvancements(sample, table, 1000, 1000 + ROUND_MS).points, 5)
})

test('客户端发送发布规范中的请求并拒绝内部端点', async () => {
  const calls = []
  const client = publicClient({ url: 'http://127.0.0.1:18900/api/v1', token: 'test-token', fetchImpl: async (url, req) => {
    calls.push([url, req.method, req.headers.authorization, req.body])
    return new Response(JSON.stringify({ ok: true, result: { ready: true } }))
  } })
  await client.call('status')
  await client.call('advancements', { status: 'completed' })
  await assert.rejects(client.call('controller/plan'), /未公开/)
  assert.deepEqual(calls, [
    ['http://127.0.0.1:18900/api/v1/status', 'GET', 'Bearer test-token', undefined],
    ['http://127.0.0.1:18900/api/v1/advancements', 'POST', 'Bearer test-token', '{"status":"completed"}']
  ])
})

test('客户端保留网关限流的重试时间', async () => {
  const client = publicClient({ url: 'http://127.0.0.1:18900/api/v1', token: 'test-token', fetchImpl: async () =>
    new Response('Too many requests', { status: 429, headers: { 'retry-after': '12' } }) })
  await assert.rejects(client.call('status'), e => e.code === 'rate_limited' && e.details.retry_after_s === 12)
})

test('离线开局从空背包走完木镐、石器和石镐进度', async () => {
  let t = 500
  let tablePlaced = false
  let mined = 0
  const minedLogs = new Set()
  const requests = []
  const inventory = new Map()
  const completed = []
  const add = (name, count) => inventory.set(name, (inventory.get(name) || 0) + count)
  const mark = id => completed.push({ id, status: 'completed', completed_at: t })
  const status = { ready: true, alive: true, food: 20, health: 20, is_day: true, dimension: 'overworld', pos: [0, 64, 0] }
  const client = {
    hasToken: () => true,
    async call (name, args = {}) {
      t += 10
      requests.push([name, args])
      switch (name) {
        case 'status': return status
        case 'inventory': return { items: [...inventory].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })) }
        case 'advancements': return { advancements: completed }
        case 'get_entities': return { entities: [] }
        case 'find_blocks': {
          const blocks = [
            ...[2, 3, 4].filter(z => !minedLogs.has(z)).map(z => ({ name: 'birch_log', pos: [2, 64, z], dist: 3 })),
            ...[3, 4, 5].slice(mined).map(z => ({ name: 'stone', pos: [3, 64, z], dist: 6 })),
            ...(tablePlaced ? [{ name: 'crafting_table', pos: [1, 64, 0], dist: 1 }] : [])
          ]
          return { blocks: blocks.filter(b => args.types.includes(b.name)) }
        }
        case 'get_block':
          if (args.pos[0] === 2 && args.pos[2] >= 2) return { name: 'birch_log' }
          if (args.pos[0] === 3 && args.pos[2] >= 3) return { name: 'stone' }
          return { name: args.pos[1] < 64 ? 'grass_block' : 'air' }
        case 'dig':
          if (args.pos[0] === 2) {
            assert.ok(!minedLogs.has(args.pos[2]))
            minedLogs.add(args.pos[2])
            add('birch_log', 1)
          }
          else {
            assert.ok(inventory.get('wooden_pickaxe'))
            add('cobblestone', 1)
            if (++mined === 1) mark(mineStone)
          }
          return { dug: args.pos[0] === 2 ? 'birch_log' : 'stone' }
        case 'craft': {
          const recipes = {
            birch_planks: ['birch_log', 1, 4], crafting_table: ['birch_planks', 4, 1],
            stick: ['birch_planks', 2, 4], wooden_pickaxe: ['birch_planks', 3, 1],
            stone_pickaxe: ['cobblestone', 3, 1]
          }
          const [input, cost, gained] = recipes[args.item]
          assert.ok(inventory.get(input) >= cost, args.item)
          add(input, -cost)
          if (args.item.endsWith('_pickaxe')) {
            assert.ok(tablePlaced && inventory.get('stick') >= 2)
            add('stick', -2)
          }
          add(args.item, gained)
          if (args.item === 'stone_pickaxe') mark(upgrade)
          return { gained }
        }
        case 'place':
          assert.deepEqual(args.pos, [1, 64, 0])
          tablePlaced = true
          add('crafting_table', -1)
          return { placed: args.item }
        default: throw new Error('Unexpected ' + name)
      }
    }
  }
  const full = scoringTable(markdown)
  const table = new Map([[mineStone, full.get(mineStone)], [upgrade, full.get(upgrade)]])
  const signal = new AbortController()
  const result = await runCompetition({
    client, table, bounds, start: 1000, duration: 120000, now: () => t, signal: signal.signal,
    pause: async ms => { t += ms },
    log: event => { if (event.type === 'action' && inventory.get('stone_pickaxe')) signal.abort() }
  })
  assert.deepEqual(result.advancements.sort(), [mineStone, upgrade])
  assert.equal(result.points, 10)
  assert.equal(requests.filter(([name]) => name === 'dig').length, 6)
  const inventoryReads = requests.filter(([name]) => name === 'inventory').length
  const scans = requests.filter(([name, args]) => name === 'find_blocks' && args.types.includes('birch_log')).length
  assert.ok(scans < inventoryReads / 2)
})

test('交易读取报价后只下单可支付的一次交易', () => {
  const strategy = new Strategy({ table: new Map([[trade, scoringTable(markdown, [trade]).get(trade)]]), bounds })
  const status = { dimension: 'overworld', pos: [0, 64, 0], health: 20, food: 20 }
  const entity = { id: 7, name: 'villager', type: 'passive', pos: [2, 64, 0], dist: 2 }
  const obs = { status, entities: [entity], blocks: [], completed: new Set(), inventory: { items: [{ name: 'wheat', count: 18 }] } }
  const view = strategy.candidates(obs)[0]
  assert.equal(view.phase, 'trade_view')
  strategy.feedback(view, status, {
    options: [
      { index: 0, uses: 0, max_uses: 1, give: [{ name: 'emerald', count: 1 }] },
      { index: 1, uses: 0, max_uses: 1, give: [{ name: 'wheat', count: 16 }] }
    ]
  })
  assert.deepEqual(strategy.candidates(obs)[0].args.ops, [{ op: 'select', option: 1, times: 1 }])
})

test('熔炉按观测状态投料、等待并收取铁锭', () => {
  let t = 1000
  const strategy = new Strategy({ table: new Map([[smelt, 5]]), bounds, now: () => t })
  const status = { dimension: 'overworld', pos: [0, 64, 0], health: 20, food: 20 }
  const obs = {
    status, entities: [], blocks: [{ name: 'furnace', pos: [1, 64, 0], dist: 1 }], completed: new Set(),
    inventory: { items: [{ name: 'coal', count: 1 }, { name: 'raw_iron', count: 1 }] }
  }
  const view = strategy.candidates(obs)[0]
  strategy.feedback(view, status, { sections: { input: [], fuel: [], output: [] } })
  const fill = strategy.candidates(obs)[0]
  assert.deepEqual(fill.args.ops, [
    { op: 'put', item: 'coal', count: 1, to: 'fuel' },
    { op: 'put', item: 'raw_iron', count: 1, to: 'input' }
  ])
  strategy.feedback(fill, status, { done: fill.args.ops })
  obs.inventory.items = []
  const check = strategy.candidates(obs)[0]
  assert.equal(check.name, 'window/view')
  strategy.feedback(check, status, {
    info: { burning: true },
    sections: { input: [{ name: 'raw_iron', count: 1 }], fuel: [], output: [] }
  })
  const wait = strategy.candidates(obs)[0]
  assert.equal(wait.phase, 'check_iron')
  strategy.feedback(wait, status, { sections: { input: [], fuel: [], output: [{ name: 'iron_ingot', count: 1 }] } })
  t += 3001
  assert.deepEqual(strategy.candidates(obs)[0].args.ops, [{ op: 'take', item: 'iron_ingot', count: 1, from: 'output' }])
})

test('不可达资源进入冷却，同类候选继续可用', () => {
  const strategy = new Strategy({ table: new Map([[mineStone, 5]]), bounds, now: () => 1000 })
  const status = { dimension: 'overworld', pos: [0, 64, 0], health: 20, food: 20 }
  const blocks = [{ name: 'stone', pos: [2, 64, 0], dist: 2 }, { name: 'stone', pos: [3, 64, 0], dist: 3 }]
  const obs = { status, entities: [], blocks, completed: new Set(), inventory: { items: [{ name: 'wooden_pickaxe', count: 1 }] } }
  const first = strategy.candidates(obs)[0]
  strategy.feedback(first, status, null, { code: 'path_not_found' })
  assert.deepEqual(strategy.candidates(obs)[0].args.pos, blocks[1].pos)
})

test('凝固黑曜石使用岩浆旁已确认的落点', async () => {
  const strategy = new Strategy({ table: new Map([[obsidian, 15]]), bounds })
  const status = { dimension: 'overworld', pos: [0, 64, 0], food: 20, health: 20 }
  const step = strategy.candidates({
    status, completed: new Set(), entities: [],
    blocks: [{ name: 'lava', pos: [2, 64, 0], dist: 2, properties: { level: 0 } }],
    inventory: { items: [{ name: 'water_bucket', count: 1 }] }
  })[0]
  assert.equal(step.target, obsidian)
  const call = async (name, args) => {
    if (name === 'get_block') return { name: args.pos[1] === 63 ? 'stone' : 'air' }
    assert.equal(name, 'interact')
    assert.deepEqual(args, { item: 'water_bucket', pos: [1, 63, 0] })
    return { changed: true }
  }
  assert.equal((await execute(call, strategy, step, status)).changed, true)
})

test('开赛前等待，收官时不启动超出剩余时间的动作', async () => {
  let t = 2000
  const calls = []
  const client = {
    hasToken: () => true,
    async call (name) {
      calls.push([name, t])
      if (name === 'status') return { ready: true, alive: true, food: 20, health: 20, dimension: 'overworld', pos: [0, 64, 0] }
      if (name === 'inventory') return { items: [{ name: 'wooden_pickaxe', count: 1 }] }
      if (name === 'find_blocks') return { blocks: [{ name: 'stone', pos: [2, 64, 0], dist: 2 }] }
      if (name === 'get_entities') return { entities: [] }
      if (name === 'advancements') return { advancements: [] }
      throw new Error('unexpected ' + name)
    }
  }
  const result = await runCompetition({
    client, table: new Map([[mineStone, 5]]), bounds, start: 5000, duration: 5000,
    now: () => t, pause: async ms => { t += ms }, log () {}
  })
  assert.equal(result.reason, 'deadline')
  assert.ok(calls.every(([, at]) => at >= 5000))
  assert.ok(calls.every(([name, at]) => at < 10000 || name === 'advancements'))
})

test('执行器拒绝越界目标，探索拒绝无支撑落点', async () => {
  const strategy = new Strategy({ table: new Map(), bounds, now: () => 10000 })
  const status = { dimension: 'overworld', pos: [32, 64, 0] }
  const call = async (_, { pos }) => {
    assert.ok(Math.hypot(pos[0], pos[2]) <= 39)
    return { name: 'air' }
  }
  assert.equal(await strategy.explore(call, status), null)
  await assert.rejects(execute(call, strategy, { name: 'dig', args: { pos: [50, 64, 0] } }, status), { code: 'outside_island' })
})
