'use strict'
// 从当前背包推到 1 个 iron_ingot 的短链。
// 上层 7B 一次只肯吐一个技能，两步之间还要再等一轮模型。
// 这里用代码按配方把接下来最多 4 步排好，并模拟这几步之后的背包，
// 这样后面的合成在前面的步骤做完时材料是齐的。
// 背包里的工作台/熔炉只是物品，不算已经放在地上。

const LOGS = [
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
  'mangrove_log', 'cherry_log'
]
const STONE_PLUS = [
  'stone_pickaxe', 'copper_pickaxe', 'iron_pickaxe', 'diamond_pickaxe',
  'netherite_pickaxe', 'golden_pickaxe'
]
const ORES = ['iron_ore', 'deepslate_iron_ore']
const MAX_STEPS = 4
// 石镐 3 + 熔炉 8。先一次性挖够，避免挖 3 个就回去合成、再回来挖。
const COBBLE_GOAL = 11

function toSet (around) {
  const out = new Set()
  if (!around) return out
  const list = around instanceof Set ? around : around
  for (const b of list) {
    if (!b) continue
    out.add(typeof b === 'string' ? b : b.name)
  }
  return out
}

function plankOf (log) {
  return String(log).replace(/_log$/, '_planks')
}

function blockRecords (around) {
  const out = []
  if (!around || around instanceof Set) return out
  for (const b of around) {
    if (!b || typeof b !== 'object' || !b.name) continue
    out.push(b)
  }
  return out
}

function createState ({ have, around, pos, explore } = {}) {
  const bag = {}
  for (const [k, v] of Object.entries(have || {})) bag[k] = Number(v) || 0
  const p = Array.isArray(pos) ? pos : [pos && pos.x, pos && pos.y, pos && pos.z]
  const near = toSet(around)
  return {
    bag,
    around: near,
    blocks: blockRecords(around),
    x: Number(p[0]) || 0,
    y: Number.isFinite(Number(p[1])) ? Number(p[1]) : 64,
    z: Number(p[2]) || 0,
    explore: explore || null,
    tablePlaced: near.has('crafting_table'),
    furnacePlaced: near.has('furnace'),
    batchDone: false
  }
}

function count (s, name) {
  return s.bag[name] || 0
}

function planks (s) {
  let n = 0
  for (const name of Object.keys(s.bag)) if (name.endsWith('_planks')) n += s.bag[name]
  return n
}

function takePlanks (s, n) {
  let left = n
  for (const name of Object.keys(s.bag)) {
    if (!name.endsWith('_planks') || left <= 0) continue
    const use = Math.min(s.bag[name], left)
    s.bag[name] -= use
    left -= use
  }
}

function hasStonePick (s) {
  return STONE_PLUS.some(n => count(s, n) > 0)
}

function hasWoodPick (s) {
  return count(s, 'wooden_pickaxe') > 0
}

function hasFuel (s) {
  return count(s, 'coal') > 0 || count(s, 'charcoal') > 0 || planks(s) >= 1
}

function bestLog (s) {
  let name = null
  let n = 0
  for (const log of LOGS) {
    if (count(s, log) > n) { name = log; n = count(s, log) }
  }
  return name
}

function visibleLog (s) {
  return LOGS.find(n => s.around.has(n)) || null
}

function exploreDir (s) {
  const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]]
  const i = Math.abs(Math.floor(s.x / 8) + Math.floor(s.z / 8) * 3) % 4
  return dirs[i]
}

function gotoStep (s) {
  const e = s.explore
  if (e && Number.isFinite(Number(e.x)) && Number.isFinite(Number(e.y)) && Number.isFinite(Number(e.z))) {
    return { skill: 'goto', args: { x: e.x, y: e.y, z: e.z } }
  }
  return {
    skill: 'goto',
    args: { x: Math.round(s.x) + 8, y: Math.round(s.y), z: Math.round(s.z) }
  }
}

function mineStone (s, need) {
  const target = s.around.has('stone') ? 'stone' : (s.around.has('cobblestone') ? 'cobblestone' : null)
  if (!target) return null
  const n = Math.min(16, Math.max(1, need))
  return { skill: 'mine', args: { target, count: n } }
}

// 做木镐还差多少木板（含工作台和木棍）。已经放好的工作台不再扣 4 块。
function planksNeeded (s) {
  let need = 3
  if (count(s, 'stick') < 2) need += 2
  if (!s.tablePlaced && count(s, 'crafting_table') < 1) need += 4
  return Math.max(0, need - planks(s))
}

function craftPlanks (s, need) {
  const log = bestLog(s)
  if (!log) return null
  const ops = Math.min(count(s, log), Math.ceil(need / 4))
  if (ops < 1) return null
  return { skill: 'craft', args: { item: plankOf(log), count: ops * 4 } }
}

function ensureSticks (s) {
  if (count(s, 'stick') >= 2) return null
  if (planks(s) >= 2) return { skill: 'craft', args: { item: 'stick', count: 4 } }
  return null
}

function ensureTable (s) {
  if (s.tablePlaced) return null
  if (count(s, 'crafting_table') >= 1) return { skill: 'place', args: { item: 'crafting_table' } }
  if (planks(s) >= 4) return { skill: 'craft', args: { item: 'crafting_table', count: 1 } }
  return null
}

function woodProgress (s) {
  const need = planksNeeded(s)
  if (need > 0) {
    const crafted = craftPlanks(s, need)
    if (crafted) return crafted
    const vis = visibleLog(s)
    if (vis) return { skill: 'gather', args: { target: vis, count: Math.min(3, Math.ceil(need / 4)) } }
    return gotoStep(s)
  }
  const sticks = ensureSticks(s)
  if (sticks) return sticks
  const table = ensureTable(s)
  if (table) return table
  if (s.tablePlaced && planks(s) >= 3 && count(s, 'stick') >= 2) {
    return { skill: 'craft', args: { item: 'wooden_pickaxe', count: 1 } }
  }
  return gotoStep(s)
}

function ensureFurnace (s) {
  if (s.furnacePlaced || count(s, 'furnace') >= 1) return null
  if (count(s, 'cobblestone') < 8) {
    if (hasWoodPick(s) || hasStonePick(s)) {
      const dug = mineStone(s, 8 - count(s, 'cobblestone'))
      if (dug) return dug
    }
    return null
  }
  const table = ensureTable(s)
  if (table) return table
  if (s.tablePlaced) return { skill: 'craft', args: { item: 'furnace', count: 1 } }
  return null
}

function ensureFuel (s) {
  if (hasFuel(s)) return null
  const crafted = craftPlanks(s, 4)
  if (crafted) return crafted
  if (s.around.has('coal_ore')) return { skill: 'mine', args: { target: 'coal_ore', count: 1 } }
  if (s.around.has('deepslate_coal_ore')) return { skill: 'mine', args: { target: 'deepslate_coal_ore', count: 1 } }
  const vis = visibleLog(s)
  if (vis) return { skill: 'gather', args: { target: vis, count: 1 } }
  return null
}

// 勘测只给最近的一个矿。没有坐标时沿用旧行为（当作够得着）。
// 有坐标时，人还在矿层上面就继续下挖，高度对齐后再水平挖过去。
// 32 格勘测能看见 y=20 的矿，但 goNear 够不着，直接 mine 会 out_of_reach。
function nearestOre (s) {
  let best = null
  for (const b of s.blocks) {
    if (!ORES.includes(b.name) || !Array.isArray(b.pos) || b.pos.length < 3) continue
    const dx = Number(b.pos[0]) - s.x
    const dy = Number(b.pos[1]) - s.y
    const dz = Number(b.pos[2]) - s.z
    if (![dx, dy, dz].every(Number.isFinite)) continue
    const horiz = Math.hypot(dx, dz)
    const dist = Math.hypot(horiz, dy)
    if (!best || dist < best.dist) best = { name: b.name, dx, dy, dz, horiz, dist }
  }
  if (best) return best
  const name = ORES.find(n => s.around.has(n))
  return name ? { name, posless: true } : null
}

function oreInReach (ore) {
  if (!ore) return false
  if (ore.posless) return true
  return Math.abs(ore.dx) <= 4 && Math.abs(ore.dz) <= 4 && Math.abs(ore.dy) <= 2 && ore.dist <= 5.5
}

function dirToward (ore) {
  let dx = Math.sign(ore.dx)
  let dz = Math.sign(ore.dz)
  if (dx && dz) {
    if (Math.abs(ore.dx) >= Math.abs(ore.dz)) dz = 0
    else dx = 0
  }
  if (!dx && !dz) dx = 1
  return [dx, dz]
}

function descendToward (ore) {
  const n = Math.min(8, Math.max(1, Math.floor(-ore.dy)))
  return { skill: 'mine', args: { target: 'stone', count: n, down: true } }
}

function nextStep (s) {
  if (count(s, 'iron_ingot') >= 1 || s.batchDone) return null

  if (count(s, 'raw_iron') >= 1) {
    if (!s.furnacePlaced && count(s, 'furnace') >= 1) return { skill: 'place', args: { item: 'furnace' } }
    if (!s.furnacePlaced) {
      const made = ensureFurnace(s)
      if (made) return made
      // 有镐却凑不出熔炉：去找石头。完全没有镐则继续往下走木镐链。
      if (hasWoodPick(s) || hasStonePick(s)) return gotoStep(s)
    } else if (!hasFuel(s)) {
      return ensureFuel(s) || gotoStep(s)
    } else {
      return { skill: 'smelt', args: { item: 'raw_iron', count: 1 } }
    }
  }

  if (hasStonePick(s)) {
    // 先把熔炉和燃料放进背包再下挖，避免熔炉留在地面、人已经下到 32 格以外。
    if (!s.furnacePlaced && count(s, 'furnace') < 1) {
      const made = ensureFurnace(s)
      if (made) return made
    }
    if (!hasFuel(s)) {
      const fuel = ensureFuel(s)
      if (fuel) return fuel
    }
    const ore = nearestOre(s)
    if (ore && oreInReach(ore)) return { skill: 'mine', args: { target: ore.name, count: 1 } }
    if (ore && !ore.posless) {
      // 脚还站在矿层上面：先下到矿所在的那一格，再水平挖。一次下太多会挖过矿层。
      if (ore.dy <= -1) return descendToward(ore)
      return { skill: 'mine', args: { target: 'stone', count: 8, ahead: true, dir: dirToward(ore) } }
    }
    if (s.y > 16) return { skill: 'mine', args: { target: 'stone', count: 8, down: true } }
    return { skill: 'mine', args: { target: 'stone', count: 8, ahead: true, dir: exploreDir(s) } }
  }

  if (hasWoodPick(s)) {
    if (count(s, 'cobblestone') < COBBLE_GOAL) {
      const dug = mineStone(s, COBBLE_GOAL - count(s, 'cobblestone'))
      if (dug) return dug
      return gotoStep(s)
    }
    const table = ensureTable(s)
    if (table) return table
    const sticks = ensureSticks(s)
    if (sticks) return sticks
    if (s.tablePlaced && count(s, 'stick') >= 2) return { skill: 'craft', args: { item: 'stone_pickaxe', count: 1 } }
    return gotoStep(s)
  }

  return woodProgress(s)
}

function apply (s, step) {
  const a = step.args || {}
  if (step.skill === 'goto' || a.down || a.ahead || step.skill === 'smelt') s.batchDone = true
  if (step.skill === 'place') {
    s.bag[a.item] = count(s, a.item) - 1
    if (a.item === 'crafting_table') s.tablePlaced = true
    if (a.item === 'furnace') s.furnacePlaced = true
    return
  }
  if (step.skill === 'craft') {
    const item = a.item
    const n = a.count || 1
    if (String(item).endsWith('_planks')) {
      const log = String(item).replace(/_planks$/, '_log')
      s.bag[log] = count(s, log) - n / 4
      s.bag[item] = count(s, item) + n
      return
    }
    if (item === 'stick') {
      takePlanks(s, 2)
      s.bag.stick = count(s, 'stick') + 4
      return
    }
    if (item === 'crafting_table') {
      takePlanks(s, 4)
      s.bag.crafting_table = count(s, 'crafting_table') + 1
      return
    }
    if (item === 'wooden_pickaxe') {
      takePlanks(s, 3)
      s.bag.stick = count(s, 'stick') - 2
      s.bag.wooden_pickaxe = count(s, 'wooden_pickaxe') + 1
      return
    }
    if (item === 'stone_pickaxe') {
      s.bag.cobblestone = count(s, 'cobblestone') - 3
      s.bag.stick = count(s, 'stick') - 2
      s.bag.stone_pickaxe = count(s, 'stone_pickaxe') + 1
      return
    }
    if (item === 'furnace') {
      s.bag.cobblestone = count(s, 'cobblestone') - 8
      s.bag.furnace = count(s, 'furnace') + 1
    }
    return
  }
  if (step.skill === 'mine' || step.skill === 'gather') {
    const t = a.target
    const n = a.count || 1
    if (a.down || a.ahead) return
    if (t === 'stone' || t === 'cobblestone') s.bag.cobblestone = count(s, 'cobblestone') + n
    else if (t === 'iron_ore' || t === 'deepslate_iron_ore') s.bag.raw_iron = count(s, 'raw_iron') + n
    else if (t === 'coal_ore' || t === 'deepslate_coal_ore') s.bag.coal = count(s, 'coal') + n
    else s.bag[t] = count(s, t) + n
    return
  }
  if (step.skill === 'smelt') {
    s.bag.raw_iron = count(s, 'raw_iron') - (a.count || 1)
    s.bag.iron_ingot = count(s, 'iron_ingot') + (a.count || 1)
  }
}

function describe (step) {
  const a = step.args || {}
  if (step.skill === 'place' || step.skill === 'craft' || step.skill === 'smelt') {
    const n = a.count && step.skill !== 'place' ? `×${a.count}` : ''
    return `${step.skill} ${a.item}${n}`
  }
  if (step.skill === 'mine' || step.skill === 'gather') {
    const how = a.down ? '向下' : (a.ahead ? '向前' : '')
    return `${step.skill} ${a.target}${how ? '（' + how + '）' : ''}×${a.count || 1}`
  }
  if (step.skill === 'goto') return `goto ${a.x},${a.y},${a.z}`
  return step.skill
}

function planIronChain (input) {
  const s = createState(input)
  if (count(s, 'iron_ingot') >= 1) return { text: '已经有 iron_ingot', steps: [] }
  const steps = []
  while (steps.length < MAX_STEPS) {
    const step = nextStep(s)
    if (!step) break
    steps.push({ skill: step.skill, args: step.args || {} })
    apply(s, step)
  }
  if (!steps.length) {
    const g = gotoStep(s)
    steps.push({ skill: g.skill, args: g.args })
  }
  const text = steps.map(describe).join(' → ') + '（目标：拿到 iron_ingot）'
  return { text, steps }
}

module.exports = { planIronChain }
