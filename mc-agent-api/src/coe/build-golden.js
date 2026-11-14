'use strict'
// 生成「黄金向量」：p1/data/golden_local.json
//
// 用途：L-obs 编码是训练侧（Python）与运行侧（Node）之间的契约。
// 这里用 Node 侧（真值）生成若干场景的 **期望 token 序列**，
// Python 侧重新编码同样的场景必须逐 token 一致（p1/tests/test_golden.py）。
// 编码一改，黄金向量必须重新生成，两端测试同时通过。
//
// 用法：node src/coe/build-golden.js [输出路径]

const fs = require('fs')
const path = require('path')
const local = require('./local')

// 造一个确定性的世界：y <= fillBelow 是 fill，其余是空气
function makeWorld (fillBelow, fill) {
  const w = { fill_below: fillBelow, fill, blocks: {} }
  return w
}

function position (x, y, z) {
  return {
    x, y, z,
    offset: (dx, dy, dz) => position(x + dx, y + dy, z + dz),
    floored: () => position(Math.floor(x), Math.floor(y), Math.floor(z))
  }
}

function worldBot (spec, entity = {}, entities = {}) {
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  const map = new Map()
  const { fill_below, fill, blocks } = spec
  // 显式覆盖优先；其余按「y <= fill_below 是 fill，否则空气」判定。
  // 这个规则与 Python 侧 coe/tokens.py 的 World 完全一致（两侧都不能有边界），
  // 否则同一场景两侧会对远处方块给出不同分类。
  for (const [k, name] of Object.entries(blocks || {})) {
    const [x, y, z] = k.split(',').map(Number)
    map.set(key(x, y, z), {
      name,
      type: name === 'air' ? 'air' : (name === 'water' || name === 'lava' ? 'liquid' : 'material'),
      boundingBox: name === 'air' ? 'empty' : (name === 'water' || name === 'lava' ? 'empty' : 'block')
    })
  }
  const { x, y, z } = entity.position || { x: 0, y: 64, z: 0 }
  return {
    entity: {
      yaw: 0,
      onGround: true,
      ...entity,
      position: position(x, y, z),
      metadata: [entity.isOnFire ? 1 : 0]
    },
    health: entity.health ?? 20,
    food: 20,
    oxygenLevel: entity.oxygenLevel ?? 20,
    entities,
    getControlState: k => k === 'sneak' && !!entity.isSneaking,
    blockAt: (p) => {
      const at = p.floored()
      const k = key(at.x, at.y, at.z)
      const hit = map.get(k)
      if (hit) return hit
      if (Math.floor(p.y) <= fill_below) {
        return { name: fill, type: 'material', boundingBox: 'block' }
      }
      return { name: 'air', type: 'air', boundingBox: 'empty' }
    }
  }
}

// 场景表：每条都是「世界 + 自身 + 实体 + 目标」
const CASES = [
  {
    name: 'flat_plain',
    desc: '平地，四个方向都是 flat',
    world: makeWorld(63, 'stone'),
    entity: {},
    entities: {},
    goal: { type: 'idle' }
  },
  {
    name: 'hole_ahead',
    desc: '前方挖了个洞',
    world: { ...makeWorld(63, 'stone'), blocks: { '0,63,-1': 'air', '0,62,-1': 'air' } },
    entity: {},
    entities: {},
    goal: { type: 'idle' }
  },
  {
    name: 'lava_ahead',
    desc: '前方是岩浆',
    world: { ...makeWorld(63, 'stone'), blocks: { '0,63,-1': 'lava' } },
    entity: {},
    entities: {},
    goal: { type: 'idle' }
  },
  {
    name: 'water_pool',
    desc: '前方是水',
    world: { ...makeWorld(63, 'stone'), blocks: { '0,63,-1': 'water' } },
    entity: {},
    entities: {},
    goal: { type: 'idle' }
  },
  {
    name: 'wall_and_step',
    desc: '正前方是墙，右侧有一级台阶',
    world: { ...makeWorld(63, 'stone'), blocks: { '0,64,-1': 'stone', '1,64,-1': 'stone' } },
    entity: {},
    entities: {},
    goal: { type: 'idle' }
  },
  {
    name: 'ladder',
    desc: '正前方是梯子',
    world: { ...makeWorld(63, 'stone'), blocks: { '0,64,-1': 'ladder' } },
    entity: {},
    entities: {},
    goal: { type: 'idle' }
  },
  {
    name: 'turned_around',
    desc: '转身之后几何方向要跟着转',
    world: makeWorld(63, 'stone'),
    entity: { yaw: Math.PI / 2 },
    entities: {},
    goal: { type: 'idle' }
  },
  {
    name: 'hostile_close',
    desc: '右前方有敌对实体',
    world: makeWorld(63, 'stone'),
    entity: {},
    entities: {
      '7': { id: 7, type: 'hostile', name: 'zombie', position: { x: 3, y: 64, z: -3 }, health: 20, maxHealth: 20 }
    },
    goal: { type: 'idle' }
  },
  {
    name: 'in_lava',
    desc: '人已经在岩浆里',
    world: { ...makeWorld(63, 'stone'), blocks: { '0,63,0': 'lava' } },
    entity: { isInLava: true },
    entities: {},
    goal: { type: 'flee' }
  },
  {
    name: 'underwater',
    desc: '在水里，氧气快没了',
    world: { ...makeWorld(63, 'stone'), blocks: { '0,63,0': 'water', '0,64,0': 'water' } },
    entity: { isInWater: true, oxygenLevel: 4, position: { x: 0, y: 63.5, z: 0 } },
    entities: {},
    goal: { type: 'idle' }
  },
  {
    name: 'goal_goto',
    desc: '有 goto 目标',
    world: makeWorld(63, 'stone'),
    entity: {},
    entities: {},
    goal: { type: 'goto', target: { pos: { x: 0, y: 64, z: -10 } } }
  },
  {
    name: 'goal_mine_block',
    desc: '有挖矿目标（目标方块是石头）',
    world: makeWorld(63, 'stone'),
    entity: {},
    entities: {},
    goal: { type: 'mine', target: { pos: { x: 2, y: 63, z: -2 }, blockName: 'stone' } }
  },
  {
    name: 'low_health',
    desc: '残血 + 远处有敌对实体',
    world: makeWorld(63, 'stone'),
    entity: { health: 4 },
    entities: {
      '9': { id: 9, type: 'hostile', name: 'creeper', position: { x: -6, y: 64, z: 6 }, health: 20, maxHealth: 20 }
    },
    goal: { type: 'idle' }
  },
  {
    name: 'flee_hostile',
    desc: '逃离时用最近威胁的位置填目标条件',
    world: makeWorld(63, 'stone'),
    entity: { isOnFire: true, isSneaking: true },
    entities: {
      '7': { id: 7, type: 'hostile', name: 'zombie', position: { x: 3, y: 64, z: -3 } }
    },
    goal: { type: 'flee', target: null }
  }
]

function main () {
  const out = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..', 'p1', 'data', 'golden_local.json'))
  const cases = []
  for (const c of CASES) {
    const bot = worldBot(c.world, c.entity, c.entities)
    const sense = local.senseFromBot(bot, { goal: c.goal, prev: null, hurtTicks: 99 })
    if (!sense) throw new Error('场景 ' + c.name + ' 采样失败')
    cases.push({
      name: c.name,
      desc: c.desc,
      world: c.world,
      entity: c.entity,
      entities: c.entities,
      goal: c.goal,
      sense,
      obs: local.encodeLocal(sense)
    })
  }
  const payload = {
    version: 1,
    note: 'L-obs 编码黄金向量。Node 侧（src/coe/local.js）是真值，Python 侧必须逐 token 一致。改编码后重新生成。',
    tokens: local.localVocab(),
    cases
  }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(payload, null, 1))
  console.log('写入', out, '共', cases.length, '个场景，', payload.tokens.length, '个 token')
  for (const c of cases) console.log(' ', c.name.padEnd(18), c.obs.length, 'token')
}

main()
