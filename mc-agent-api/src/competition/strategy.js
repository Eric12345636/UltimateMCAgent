'use strict'

const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak']
const LOGS = WOODS.map(wood => wood + '_log')
const PLANKS = WOODS.map(wood => wood + '_planks')
const STONE = ['stone', 'cobblestone', 'cobbled_deepslate', 'deepslate']
const FUEL = ['coal', 'charcoal', ...PLANKS, ...LOGS]
const BEDS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'].map(color => color + '_bed')
const FISH = ['cod', 'salmon', 'tropical_fish', 'pufferfish']
const FOOD = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken',
  'cooked_salmon', 'cooked_cod', 'bread', 'baked_potato', 'apple', 'carrot', 'beef',
  'porkchop', 'mutton', 'salmon', 'cod', 'melon_slice', 'sweet_berries']
const BREED = { cow: 'wheat', sheep: 'wheat', pig: 'carrot', chicken: 'wheat_seeds' }
const TAMING = { wolf: 'bone', cat: 'cod', parrot: 'wheat_seeds' }
const NATURAL_GROUND = new Set(['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'stone', 'cobblestone',
  'deepslate', 'sand', 'red_sand', 'sandstone', 'gravel', 'snow_block', 'mud', 'clay', 'terracotta'])
const AIR = new Set(['air', 'cave_air', 'void_air'])
const PASSABLE = new Set([...AIR, 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dandelion', 'poppy', 'snow'])
const ORES = {
  iron: ['iron_ore', 'deepslate_iron_ore'],
  coal: ['coal_ore', 'deepslate_coal_ore'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore']
}
const ENCHANTABLE = ['diamond_sword', 'iron_sword', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'book']
const TOOL_TIERS = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite']
const DIGGABLE_GRASS = ['short_grass', 'tall_grass']
const adv = (group, name) => `minecraft:${group}/${name}`

const RESOURCES = [
  LOGS, STONE, [...ORES.iron, ...ORES.coal, ...ORES.diamond],
  ['crafting_table', 'furnace', 'enchanting_table'], ['water', 'lava', 'farmland'], BEDS, DIGGABLE_GRASS,
  ['wheat', 'carrots', 'potatoes', 'lapis_ore', 'deepslate_lapis_ore'], ['obsidian']
]

function dimensionOf (value) {
  return String(value || '').replace(/^minecraft:/, '').replace(/^the_/, '')
}

function position (value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
}

function islandBounds (input) {
  const bounds = {}
  for (const [key, value] of Object.entries(input || {})) {
    const dim = dimensionOf(key)
    const { center, radius } = value || {}
    if (!['overworld', 'nether'].includes(dim) || !Array.isArray(center) || center.length !== 2 ||
        !center.every(Number.isFinite) || !Number.isFinite(radius) || radius < 2) {
      throw new Error(`岛屿范围无效 ${key}`)
    }
    bounds[dim] = { center, radius }
  }
  if (!bounds.overworld) throw new Error('需要填入赛方公布的主世界岛中心 [x,z] 和半径')
  return bounds
}

function inside (bounds, pos, margin = 1) {
  return !!bounds && position(pos) &&
    Math.hypot(pos[0] - bounds.center[0], pos[2] - bounds.center[1]) <= bounds.radius - margin
}

function inventoryCounts (inventory) {
  const counts = new Map()
  for (const { name, count } of inventory.items || []) counts.set(name, (counts.get(name) || 0) + count)
  return counts
}

const action = (name, args, phase = name) => ({ name, args, phase })
const itemOp = (op, item, count, section) => ({ op, item, count, [op === 'put' ? 'to' : 'from']: section })
const keyOf = pos => pos.map(Math.floor).join(',')

class Strategy {
  constructor ({ table, bounds, now = Date.now }) {
    this.table = table
    this.bounds = bounds
    this.now = now
    this.cooldowns = new Map()
    this.furnaces = new Map()
    this.visited = new Map()
    this.fed = new Map()
    this.trades = new Map()
    this.nextExploreAt = 0
  }

  candidates ({ status, inventory, blocks, entities, completed }) {
    const dim = dimensionOf(status.dimension)
    const bounds = this.bounds[dim]
    const here = status.pos
    if (!inside(bounds, here, 0)) return []
    const counts = inventoryCounts(inventory)
    const has = (name, amount = 1) => (counts.get(name) || 0) >= amount
    const pick = list => list.find(name => has(name))
    const obsBlocks = blocks.filter(b => inside(bounds, b.pos))
    const obsEntities = entities.filter(e => e.type !== 'player' && e.name !== 'player' && inside(bounds, e.pos))
    const nearest = (list, names, max = 24) => list.find(o => names.includes(o.name) && o.dist <= max)
    const station = name => nearest(obsBlocks, [name], 12)
    const table = station('crafting_table')
    const furnace = station('furnace')
    const logs = pick(LOGS)
    const plankCount = PLANKS.reduce((total, item) => total + (counts.get(item) || 0), 0)
    const pickTier = TOOL_TIERS.findLastIndex(tier => tier !== 'golden' && has(tier + '_pickaxe'))
    const sword = TOOL_TIERS.findLast(tier => has(tier + '_sword'))
    const safe = !status.in_lava && !status.on_fire && !status.submerged && (status.nearest_hostile?.dist ?? Infinity) >= 4
    const routes = []
    const craft = (item, count = 1) => action('craft', { item, count })
    const dig = block => block && action('dig', { pos: block.pos, collect: true, block: block.name })
    const interact = (target, item) => target && action('interact', {
      ...(target.id !== undefined ? { entity_id: target.id, targetPos: target.pos } : { pos: target.pos }),
      ...(item ? { item } : {})
    })
    const place = item => action('place', { item, placement: true })
    const gather = (names, max) => {
      for (const block of obsBlocks) {
        if (!names.includes(block.name) || block.dist > max) continue
        const step = dig(block)
        if ((this.cooldowns.get(this.key(step, dim)) || 0) <= this.now()) return step
      }
      return null
    }

    const score = (group, id, cost, next) => {
      const target = adv(group, id)
      const points = this.table.get(target)
      if (!points || completed.has(target)) return
      const step = next()
      if (step) routes.push({ ...step, target, utility: points / cost })
    }
    const wood = amount => plankCount >= amount ? null
      : logs ? craft(logs.replace(/_log$/, '_planks'), amount - plankCount) : gather(LOGS, 24)
    const bench = () => {
      if (table) {
        const [x, y, z] = table.pos
        const distance = Math.hypot(x + 0.5 - here[0], y - here[1], z + 0.5 - here[2])
        return distance > 3 ? action('move_to', { pos: table.pos, range: 1 }, 'approach_table') : null
      }
      return has('crafting_table') ? place('crafting_table')
        : plankCount >= 4 ? craft('crafting_table') : wood(4)
    }
    const sticks = amount => has('stick', amount) ? null : plankCount >= 2 ? craft('stick', amount) : wood(2)
    const woodenPick = () => bench() || sticks(2) || wood(3) || craft('wooden_pickaxe')
    const cobble = () => pickTier < 0 ? woodenPick() : gather(STONE, 18)
    const stonePick = () => bench() || sticks(2) || (!has('cobblestone', 3) && !has('cobbled_deepslate', 3) ? cobble() : craft('stone_pickaxe'))
    const ironOre = () => pickTier < 2 ? stonePick() : gather(ORES.iron, 24)
    const iron = amount => {
      if (has('iron_ingot', amount)) return null
      if (!furnace) return has('furnace') ? place('furnace')
        : has('cobblestone', 8) || has('cobbled_deepslate', 8) ? bench() || craft('furnace') : cobble()
      const needed = amount - (counts.get('iron_ingot') || 0)
      const raw = counts.get('raw_iron') || 0
      const fuel = pick(FUEL)
      const target = { pos: furnace.pos }
      const furnaceKey = dim + ':' + keyOf(furnace.pos)
      const view = this.furnaces.get(furnaceKey)
      if (!view || this.now() - view.at > 12000) return action('window/view', { target, furnaceKey })
      const sections = view.sections || {}
      const output = sections.output?.find(i => i.name === 'iron_ingot')
      if (output) return action('window/act', { target, ops: [itemOp('take', 'iron_ingot', needed, 'output')], furnaceKey }, 'take_iron')
      const input = sections.input?.find(i => i.name === 'raw_iron')
      if (sections.input?.length && !input) return null
      const ops = []
      if (!view.info?.burning && !sections.fuel?.length && fuel && (input || raw)) {
        const capacity = ['coal', 'charcoal'].includes(fuel) ? 8 : 1.5
        ops.push(itemOp('put', fuel, Math.ceil(Math.min(needed, (input?.count || 0) + raw) / capacity), 'fuel'))
      }
      const missingInput = needed - (input?.count || 0)
      if (raw > 0 && missingInput > 0 && (view.info?.burning || sections.fuel?.length || fuel)) {
        ops.push(itemOp('put', 'raw_iron', Math.min(raw, missingInput), 'input'))
      }
      if (ops.length) return action('window/act', { target, ops, furnaceKey }, 'smelt_iron')
      if (input && (view.info?.burning || sections.fuel?.length)) return action('window/view', { target, furnaceKey }, 'check_iron')
      if (!fuel && !view.info?.burning) return (pickTier >= 0 && gather(ORES.coal, 16)) || wood(2)
      if (!input || missingInput > 0) return ironOre()
      return null
    }
    const bucket = () => bench() || iron(3) || craft('bucket')
    const diamond = () => pickTier < 3 ? bench() || sticks(2) || iron(3) || craft('iron_pickaxe')
      : gather(ORES.diamond, 22)

    // 优先选择当前可完成的计分项，再为高分项补必要的材料和工具。
    score('story', 'mine_stone', pickTier < 0 ? 5 : 1, cobble)
    score('story', 'upgrade_tools', 2, () => has('stone_pickaxe') ? null : stonePick())
    score('story', 'smelt_iron', 5, () => iron(1))
    score('story', 'iron_tools', 5, () => has('iron_pickaxe') ? null : bench() || sticks(2) || iron(3) || craft('iron_pickaxe'))
    score('story', 'obtain_armor', 5, () => inventory.armor?.feet?.name === 'iron_boots' || has('iron_boots')
      ? null : bench() || iron(4) || craft('iron_boots'))
    if (nearest(obsBlocks, ORES.diamond, 22) || pickTier < 3 && (has('iron_ingot', 3) || has('raw_iron', 3))) {
      score('story', 'mine_diamond', pickTier < 3 ? 12 : 2, diamond)
    }
    score('story', 'shiny_gear', 8, () => has('diamond', 4) ? bench() || craft('diamond_boots')
      : pickTier >= 3 ? gather(ORES.diamond, 22) : null)
    const lava = nearest(obsBlocks, ['lava'], 12)
    const water = nearest(obsBlocks, ['water'], 12)
    const sourceLava = lava && Number(lava.properties?.level ?? 0) === 0
    if (sourceLava) {
      score('story', 'lava_bucket', has('bucket') ? 1 : 9, () => has('bucket') ? interact(lava, 'bucket') : bucket())
    }
    const fish = nearest(obsEntities, FISH, 7)
    if (fish && has('water_bucket')) score('husbandry', 'tactical_fishing', 1, () => interact(fish, 'water_bucket'))
    const sourceWater = water && Number(water.properties?.level ?? 0) === 0
    if (sourceWater) {
      if (fish && !has('water_bucket')) score('husbandry', 'tactical_fishing', 6, () =>
        has('bucket') ? interact(water, 'bucket') : bucket())
      if (has('fishing_rod')) {
        score('husbandry', 'fishy_business', 4, () => action('use_item', { item: 'fishing_rod', target: { pos: water.pos }, timeout: 25000 }))
      } else if (has('string', 2)) {
        score('husbandry', 'fishy_business', 8, () => bench() || sticks(3) || craft('fishing_rod'))
      }
    }
    if (dim === 'overworld' && sourceLava) {
      score('story', 'form_obsidian', has('water_bucket') ? 2 : 10, () => {
        if (has('water_bucket')) return action('interact', { nearLava: lava.pos, item: 'water_bucket' }, 'cool_lava')
        if (sourceWater && has('bucket')) return interact(water, 'bucket')
        return sourceWater ? bucket() : null
      })
    }
    const enchanting = station('enchanting_table')
    const enchantable = pick(ENCHANTABLE)
    if (enchanting && enchantable && status.xp_level >= 1) {
      score('story', 'enchant_item', 2, () => !has('lapis_lazuli')
        ? (pickTier >= 2 ? gather(['lapis_ore', 'deepslate_lapis_ore'], 16) : null)
        : action('window/act', {
          target: { pos: enchanting.pos }, ops: [
            itemOp('put', enchantable, 1, 'item'), itemOp('put', 'lapis_lazuli', 1, 'lapis'),
            { op: 'select', option: 0 }, { op: 'take', count: 1, from: 'item' }
          ]
        }, 'enchant'))
    } else if (!enchanting && has('enchanting_table')) {
      score('story', 'enchant_item', 6, () => place('enchanting_table'))
    } else if (!enchanting && has('diamond', 2) && has('book')) {
      score('story', 'enchant_item', 8, () => has('obsidian', 4) ? bench() || craft('enchanting_table')
        : pickTier >= 4 ? gather(['obsidian'], 12) : null)
    }
    const bed = nearest(obsBlocks, BEDS, 10)
    if (status.is_day === false && safe) {
      score('adventure', 'sleep_in_bed', bed ? 1 : 5, () => {
        if (bed) return interact(bed)
        const carried = pick(BEDS)
        if (carried) return place(carried)
        const wool = BEDS.map(b => b.replace(/_bed$/, '_wool')).find(name => has(name, 3))
        if (wool) return bench() || wood(3) || craft(wool.replace(/_wool$/, '_bed'))
        const sheep = nearest(obsEntities, ['sheep'], 8)
        return sheep && has('shears') ? interact(sheep, 'shears') : null
      })
    }
    const farmland = nearest(obsBlocks, ['farmland'], 12)
    if (farmland) {
      score('husbandry', 'plant_seed', has('wheat_seeds') ? 1 : 5, () =>
        has('wheat_seeds') ? interact(farmland, 'wheat_seeds') : gather(DIGGABLE_GRASS, 9))
    }
    const crops = obsBlocks.filter(b => b.mature === true && b.dist <= 12)
    for (const [animal, item] of Object.entries(BREED)) {
      const group = obsEntities.filter(e => e.name === animal && e.dist <= 9)
      const eligible = group.find(e => !this.fed.has(e.id) || this.now() - this.fed.get(e.id) > 30000)
      const recentlyFed = group.some(e => this.fed.has(e.id) && this.now() - this.fed.get(e.id) <= 30000)
      if (group.length >= 2) score('husbandry', 'breed_an_animal', 3, () => has(item, recentlyFed ? 1 : 2)
        ? interact(eligible, item) : dig(nearest(crops, [item === 'carrot' ? 'carrots' : item], 12)))
    }
    for (const [animal, item] of Object.entries(TAMING)) {
      const entity = nearest(obsEntities, [animal], 9)
      if (entity && has(item) && entity.type !== 'hostile') score('husbandry', 'tame_an_animal', 3, () => interact(entity, item))
    }
    const hostile = obsEntities.find(e => e.type === 'hostile' && e.dist <= 8 &&
      ['zombie', 'husk', 'spider', 'skeleton'].includes(e.name))
    if (status.health >= 14 && sword && hostile) {
      score('adventure', 'kill_a_mob', 2, () => action('attack', { entity_id: hostile.id, targetPos: hostile.pos, timeout: 12000 }))
    }
    const ranged = obsEntities.find(e => e.type === 'hostile' && e.dist >= 5 && e.dist <= 16)
    if (ranged && has('arrow') && status.health >= 12 && safe) {
      score('adventure', 'shoot_arrow', has('bow') ? 1 : 6, () => has('bow')
        ? action('shoot', { entity_id: ranged.id, targetPos: ranged.pos, weapon: 'bow' })
        : has('string', 3) ? bench() || sticks(3) || craft('bow') : null)
    }
    const villager = nearest(obsEntities, ['villager'], 12)
    if (villager) {
      const target = { entity_id: villager.id }
      const seen = this.trades.get(villager.id)
      if (!seen || this.now() - seen.at > 45000) {
        score('adventure', 'trade', 6, () => action('window/view', { target, targetPos: villager.pos }, 'trade_view'))
      } else {
        const option = seen.options.find(o => Number.isSafeInteger(o.index) && Array.isArray(o.give) && o.give.length &&
          o.uses < o.max_uses && o.give.every(i => has(i.name, i.count)))
        if (option) score('adventure', 'trade', 1, () => action('window/act', {
          target, targetPos: villager.pos, ops: [{ op: 'select', option: option.index, times: 1 }]
        }, 'trade'))
      }
    }

    const food = pick(FOOD)
    if (food && (status.food <= 12 || (status.health <= 13 && status.food < 20)) && safe) {
      routes.push({ ...action('use_item', { item: food, timeout: 8000 }, 'eat'), utility: 100 })
    }
    if (!food && status.food < 16 && safe) {
      const crop = nearest(crops, ['wheat', 'carrots', 'potatoes'], 10)
      if (has('wheat', 3) && table) {
        routes.push({ ...(bench() || craft('bread')), utility: 10 })
      } else if (crop) routes.push({ ...dig(crop), utility: 6 })
      const animal = nearest(obsEntities, ['cow', 'pig', 'sheep'], 10)
      if (animal && sword && status.health >= 10) {
        routes.push({ ...action('attack', { entity_id: animal.id, targetPos: animal.pos, timeout: 10000 }, 'food'), utility: 4 })
      }
    }
    if (safe && !sword && table && (has('cobblestone', 2) || has('cobbled_deepslate', 2))) {
      const step = bench() || sticks(1) || craft('stone_sword')
      routes.push({ ...step, utility: 1 })
    }
    if (!status.in_lava && !status.submerged) {
      for (const [slot, kind] of [['feet', 'boots'], ['head', 'helmet'], ['torso', 'chestplate'], ['legs', 'leggings']]) {
        const previous = inventory.armor?.[slot === 'torso' ? 'chest' : slot]?.name
        const priority = ['leather', 'golden', 'chainmail', 'iron', 'diamond', 'netherite']
        const tier = priority.findLastIndex(material => has(material + '_' + kind))
        if (tier > -1 && tier > priority.indexOf(previous?.split('_')[0])) {
          routes.push({ ...action('equip', { item: priority[tier] + '_' + kind, slot }), utility: 20 })
        }
      }
    }
    const urgent = status.in_lava || status.on_fire || status.submerged || (status.nearest_hostile?.dist ?? Infinity) < 4
    const unique = new Map()
    for (const route of routes.sort((a, b) => b.utility - a.utility)) {
      if (urgent && !['eat', 'attack'].includes(route.name)) continue
      const key = this.key(route, dim)
      if (!unique.has(key) && (this.cooldowns.get(key) || 0) <= this.now()) unique.set(key, route)
    }
    return [...unique.values()]
  }

  key (step, dim) {
    const { item, pos, target, nearLava, entity_id: entityId } = step.args
    return JSON.stringify([dim, step.phase, item, pos || target || nearLava, entityId])
  }

  feedback (step, status, result, error) {
    const dim = dimensionOf(status.dimension)
    const key = this.key(step, dim)
    const now = this.now()
    for (const [key, expires] of this.cooldowns) if (expires <= now) this.cooldowns.delete(key)
    for (const [id, at] of this.fed) if (now - at > 30000) this.fed.delete(id)
    const seconds = error ? 25 : step.phase === 'check_iron' ? 3 : 0
    if (seconds) this.cooldowns.set(key, now + seconds * 1000)
    const furnaceKey = step.args.furnaceKey
    if (furnaceKey) {
      const window = result?.window?.sections ? result.window : result
      if (window?.sections && step.name === 'window/view') this.furnaces.set(furnaceKey, { ...window, at: now })
      else this.furnaces.delete(furnaceKey)
    }
    if (result?.used && Object.values(result.used).some(count => count > 0) &&
        step.target === adv('husbandry', 'breed_an_animal')) this.fed.set(step.args.entity_id, now)
    if (step.phase === 'trade_view' && Array.isArray(result?.options)) {
      this.trades.set(step.args.target.entity_id, { options: result.options, at: now })
    }
  }

  async standable (call, bounds, x, y, z, empty = false) {
    if (!inside(bounds, [x, y, z])) return false
    try {
      const [floor, feet, head] = await Promise.all([-1, 0, 1].map(dy => call('get_block', { pos: [x, y + dy, z] })))
      const passable = empty ? AIR : PASSABLE
      return NATURAL_GROUND.has(floor.name) && passable.has(feet.name) && passable.has(head.name)
    } catch (e) {
      if (e.code === 'not_loaded') return false
      throw e
    }
  }

  async placement (call, status) {
    const [x, y, z] = status.pos.map(Math.floor)
    const bounds = this.bounds[dimensionOf(status.dimension)]
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1], [2, 0], [0, 2], [-2, 0], [0, -2]]) {
      if (await this.standable(call, bounds, x + dx, y, z + dz, true)) return [x + dx, y, z + dz]
    }
    return null
  }

  async adjacentStand (call, status, near) {
    const bounds = this.bounds[dimensionOf(status.dimension)]
    if (!inside(bounds, near)) return null
    const [x, y, z] = near.map(Math.floor)
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
      if (await this.standable(call, bounds, x + dx, y + dy, z + dz)) return [x + dx, y + dy, z + dz]
    }
    return null
  }

  async coolingSurface (call, status, lava) {
    const bounds = this.bounds[dimensionOf(status.dimension)]
    if (!inside(bounds, lava)) return null
    const [x, y, z] = lava
    const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    const distance = ([dx, dz]) => Math.hypot(x + dx - status.pos[0], z + dz - status.pos[2])
    for (const [dx, dz] of offsets.sort((a, b) => distance(a) - distance(b))) {
      if (await this.standable(call, bounds, x + dx, y, z + dz, true)) return [x + dx, y - 1, z + dz]
    }
    return null
  }

  async explore (call, status, threat) {
    const retreat = !!threat
    if (!retreat && this.now() < this.nextExploreAt) return null
    if (status.in_vehicle) return null
    const [x, y, z] = status.pos.map(Math.floor)
    const dim = dimensionOf(status.dimension)
    const bounds = this.bounds[dim]
    const directions = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]]
    const d = retreat ? 5 : 10
    const options = [d, Math.floor(d / 2)].flatMap(distance => directions.map(([dx, dz]) => [
      x + dx * distance, y, z + dz * distance
    ])).filter(p => inside(bounds, p))
    const seen = p => this.visited.get(dim + ':' + keyOf(p)) || 0
    const distance = p => Math.hypot(p[0] - threat.pos[0], p[2] - threat.pos[2])
    options.sort(threat?.pos ? (a, b) => distance(b) - distance(a) : (a, b) => seen(a) - seen(b))
    for (const p of options) {
      if (!retreat && seen(p) && this.now() - seen(p) < 120000) continue
      if (threat?.pos && distance(p) <= distance(status.pos)) continue
      for (const dy of [0, 1, -1, 2, -2]) {
        const pos = [p[0], p[1] + dy, p[2]]
        if (await this.standable(call, bounds, ...pos)) {
          this.visited.set(dim + ':' + keyOf(p), this.now())
          return action('move_to', { pos, range: 1 }, 'explore')
        }
      }
    }
    this.nextExploreAt = this.now() + 3000
    return null
  }
}

module.exports = { Strategy, RESOURCES, inside, islandBounds, dimensionOf }
