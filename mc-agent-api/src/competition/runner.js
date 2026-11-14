'use strict'

const { setTimeout: sleep } = require('node:timers/promises')
const { ApiError } = require('./api')
const { ROUND_MS, completedAdvancements } = require('./rules')
const { Strategy, RESOURCES, dimensionOf, inside } = require('./strategy')

const RETRYABLE = new Set(['busy', 'not_ready', 'not_connected', 'disconnected', 'wrong_server', 'dead', 'rate_limited'])
const uncertain = code => code === 'network' || code === 'request_timeout' || code === 'invalid_response' || /^http_5\d\d$/.test(code)
const ACTION_TIMEOUT = {
  move_to: 14000, dig: 85000, craft: 85000, place: 70000, attack: 24000,
  interact: 65000, use_item: 35000, shoot: 10000, equip: 10000, 'window/view': 65000, 'window/act': 70000
}
const BLOCK_REFRESH_MS = 8000

async function scanBlocks (call, bounds) {
  const results = await Promise.all(RESOURCES.map(types => call('find_blocks', { types, radius: 24, limit: 8 })))
  return results.flatMap(result => result.blocks).filter(b => inside(bounds, b.pos))
}

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

async function execute (call, strategy, step, status) {
  const { placement, targetPos, furnaceKey, block, nearLava, ...args } = step.args
  const bounds = strategy.bounds[dimensionOf(status.dimension)]
  if (placement) {
    args.pos = await strategy.placement(call, status)
    if (!args.pos) throw new ApiError('no_support', '附近没有可安全放置的落点')
  }
  if (nearLava) {
    args.pos = await strategy.coolingSurface(call, status, nearLava)
    if (!args.pos) throw new ApiError('no_support', '岩浆旁没有可放水的地面')
  }
  const positions = [args.pos, args.target?.pos, targetPos].filter(Boolean)
  if (positions.some(pos => !inside(bounds, pos))) throw new ApiError('outside_island', '动作目标超出岛屿范围')
  if (block) {
    const current = await call('get_block', { pos: args.pos })
    if (current.name !== block || current.diggable === false) throw new ApiError('target_changed', '方块已经改变')
  }
  if (step.phase === 'approach_table') {
    args.pos = await strategy.adjacentStand(call, status, args.pos)
    if (!args.pos) throw new ApiError('no_support', '工作台旁没有可到达的站位')
    args.range = 1
  }
  if (step.name === 'move_to') args.timeout = 10000
  const result = await call(step.name, args, ACTION_TIMEOUT[step.name])
  if (result.interrupted_by) throw new ApiError('interrupted', result.interrupted_by)
  if (step.name === 'attack' && !result.killed) throw new ApiError('target_alive', '目标未击败')
  return result
}

async function runCompetition ({
  client, table, bounds, start, duration = ROUND_MS, signal, now = Date.now,
  pause = (ms, signal) => sleep(ms, undefined, { signal }), log = value => console.log(JSON.stringify(value))
}) {
  const end = start + duration
  const strategy = new Strategy({ table, bounds, now })
  const completed = new Set()
  const scored = new Map()
  let nextScoreAt = start
  let nextConnectAt = start
  let points = 0
  let failures = 0
  let loggedIn = false
  let pendingAction = false
  let blockScan
  let reason = 'deadline'
  const report = (type, fields = {}) => log({ type, t: now(), ...fields })
  const remaining = () => end - now()
  const call = (name, args, timeout = 12000) => {
    if (remaining() <= 0 || signal?.aborted) throw new ApiError('round_ended', '比赛时间已结束')
    return client.call(name, args, { timeout: Math.max(1, Math.min(timeout, remaining())), signal })
  }
  const wait = ms => pause(Math.max(1, Math.min(ms, remaining())), signal)
  const readScore = async (read, final = false) => {
    const result = await read('advancements', { status: 'completed', include_recipes: false })
    const score = completedAdvancements(result.advancements || [], table, start, end)
    for (const id of score.completed) completed.add(id)
    for (const [id, at] of score.scored) if (!scored.has(id)) scored.set(id, at)
    const total = [...scored.keys()].reduce((sum, id) => sum + table.get(id), 0)
    if (total !== points || final) report('score', { points: total, advancements: [...scored.keys()] })
    points = total
  }

  try {
    while (now() < start && !signal?.aborted) await pause(Math.min(start - now(), 30000), signal)
    while (remaining() > 0 && !signal?.aborted) {
      try {
        if (!client.hasToken()) {
          await client.login({ timeout: Math.max(1, Math.min(12000, remaining())), signal })
          loggedIn = true
        }
        const status = await call('status')
        if (!status.ready || !status.alive || status.busy) {
          await wait(1500)
          continue
        }
        pendingAction = false
        const dim = dimensionOf(status.dimension)
        const island = bounds[dim]
        if (!inside(island, status.pos, 0)) {
          reason = 'outside_island'
          break
        }
        if (now() >= nextScoreAt) {
          try {
            await readScore(call)
            nextScoreAt = now() + 15000
          } catch (e) {
            if (e.code !== 'not_ready') throw e
            nextScoreAt = now() + 3000
          }
        }
        const refresh = !blockScan || blockScan.dim !== dim || now() >= blockScan.expires ||
          distance(status.pos, blockScan.pos) >= 3
        const [inventory, entities, blocks] = await Promise.all([
          call('inventory'),
          call('get_entities', { radius: 24 }),
          refresh ? scanBlocks(call, island) : blockScan.blocks
        ])
        if (refresh) blockScan = { blocks, pos: status.pos, dim, expires: now() + BLOCK_REFRESH_MS }
        const rankedBlocks = blocks.map(b => ({ ...b, dist: distance(b.pos, status.pos) })).sort((a, b) => a.dist - b.dist)
        const seenEntities = entities.entities || []
        const candidates = strategy.candidates({ status, inventory, blocks: rankedBlocks, entities: seenEntities, completed })
        const threat = seenEntities.find(e => e.id === status.nearest_hostile?.id)
        const danger = status.in_lava || status.on_fire || status.submerged || (status.nearest_hostile?.dist ?? Infinity) < 4
        const fits = step => remaining() > ACTION_TIMEOUT[step.name] + 2000
        const step = candidates.find(fits) || (remaining() > ACTION_TIMEOUT.move_to + 2000 &&
          await strategy.explore(call, status, danger ? threat || {} : null))
        if (!step) {
          await wait(1000)
          failures = 0
          continue
        }
        // 以接口预算为准，留出结束前查询进度的时间。
        if (!fits(step)) {
          await wait(Math.min(remaining(), 2000))
          continue
        }
        pendingAction = true
        try {
          const result = await execute(call, strategy, step, status)
          strategy.feedback(step, status, result)
          if (step.name === 'dig') {
            blockScan.blocks = blockScan.blocks.filter(b => distance(b.pos, step.args.pos) !== 0)
          }
          if (step.name === 'place' || step.name === 'interact') blockScan = null
          report('action', { name: step.name, phase: step.phase, goal: step.target, ok: true })
          if (step.target && !['place', 'window/view'].includes(step.name)) {
            nextScoreAt = now()
          }
          failures = 0
          pendingAction = false
        } catch (e) {
          pendingAction = !!signal?.aborted || uncertain(e.code)
          if (pendingAction || e.code === 'target_changed') blockScan = null
          strategy.feedback(step, status, null, e)
          report('action', { name: step.name, phase: step.phase, goal: step.target, ok: false, code: e.code || 'internal' })
          if (pendingAction || RETRYABLE.has(e.code) || ['invalid_token', 'round_ended'].includes(e.code)) throw e
          await wait(300)
        }
      } catch (e) {
        if (signal?.aborted || e.code === 'round_ended') break
        if (e.code === 'invalid_token') {
          blockScan = null
          client.forgetToken()
          await wait(1000)
          continue
        }
        if (!RETRYABLE.has(e.code) && !uncertain(e.code)) throw e
        if (e.code === 'not_connected' && client.hasToken() && now() >= nextConnectAt) {
          nextConnectAt = now() + 30000
          try { await call('connect') } catch (connectError) { report('connect', { code: connectError.code || 'internal' }) }
        }
        failures++
        const retryMs = Number(e.details?.retry_after_s) * 1000
        await wait(Math.max(Number.isFinite(retryMs) ? retryMs : 0, Math.min(15000, 1000 * 2 ** Math.min(failures, 4))))
      }
    }
    if (signal?.aborted) reason = 'cancelled'
  } catch (e) {
    if (!signal?.aborted) throw e
    reason = 'cancelled'
  } finally {
    if (client.hasToken() && (loggedIn || now() >= start || pendingAction)) {
      const cleanup = (name, args) => client.call(name, args, { timeout: 3000 })
      if (pendingAction || reason === 'outside_island') {
        try { await cleanup('stop') } catch (e) { report('cleanup', { code: e.code || 'internal' }) }
      }
      try { await readScore(cleanup, true) } catch (e) { report('score_unavailable', { code: e.code || 'internal' }) }
      if (loggedIn) {
        try { await cleanup('auth/logout') } catch (e) { report('cleanup', { code: e.code || 'internal' }) }
      }
    }
  }
  const summary = { reason, points, advancements: [...scored.keys()] }
  report('finished', summary)
  return summary
}

module.exports = { runCompetition, execute }
