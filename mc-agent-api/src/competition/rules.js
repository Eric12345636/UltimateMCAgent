'use strict'

const ROUND_MS = 8 * 60 * 60 * 1000
const POINTS = [0, 5, 15, 30, 60, 100]

function scoringTable (markdown, confirmed = []) {
  const allowed = new Map()
  const selected = new Set(confirmed)
  const rows = new Set()
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^\|\s*`(minecraft:[a-z_]+\/[a-z0-9_]+)`\s*\|[^|]+\|\s*([1-5])\s*\|\s*(\d+|—)\s*\|([^|]+)\|/)
    if (!match) continue
    const [, id, difficulty, points, note] = match
    if (rows.has(id)) throw new Error(`计分表包含重复进度 ${id}`)
    rows.add(id)
    if (points === '—') continue
    if (Number(points) !== POINTS[Number(difficulty)]) throw new Error(`进度分值与难度不符 ${id}`)
    if (note.trim() === '计分' || selected.has(id)) {
      allowed.set(id, Number(points))
      selected.delete(id)
    }
  }
  if (!allowed.size) throw new Error('规则文件里没有找到计分进度')
  if (selected.size) throw new Error(`计分表中没有可启用的进度 ${[...selected].join(', ')}`)
  return allowed
}

function completedAdvancements (advancements, table, start, end) {
  const completed = new Set()
  const scored = new Map()
  for (const a of advancements) {
    if (a.status !== 'completed') continue
    completed.add(a.id)
    const time = Number(a.completed_at)
    if (table.has(a.id) && a.completed_at != null && time >= start && time < end) {
      const previous = scored.get(a.id)
      if (previous === undefined || time < previous) scored.set(a.id, time)
    }
  }
  const points = [...scored.keys()].reduce((total, id) => total + table.get(id), 0)
  return { completed, scored, points }
}

module.exports = { ROUND_MS, scoringTable, completedAdvancements }
