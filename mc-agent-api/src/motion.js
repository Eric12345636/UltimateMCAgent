'use strict'

const TICKS_PER_SECOND = 20
const round = n => +n.toFixed(3)

// 速度按 bot 每个物理 tick 的实际位移算（格/秒）。
// mineflayer 的 entity.velocity 是摩擦之后留给下一 tick 的值
// （站在地上大约是真实步行速度的 0.546 倍，而且站着也会留着 -0.078 格/tick 的重力项），
// 不是这一拍真正走了多远。
function createMotionTracker () {
  let prev = null
  let last = null
  return {
    tick (pos) {
      if (!pos || ![pos.x, pos.y, pos.z].every(Number.isFinite)) { prev = null; last = null; return }
      if (prev) {
        const d = [pos.x - prev.x, pos.y - prev.y, pos.z - prev.z]
        // 传送 / 重生不是移动
        last = Math.hypot(d[0], d[1], d[2]) > 10 ? null : d
      }
      prev = { x: pos.x, y: pos.y, z: pos.z }
    },
    reset () { prev = null; last = null },
    summary () {
      if (!last) return { speed: null, velocity: null }
      const v = last.map(n => n * TICKS_PER_SECOND)
      return { speed: round(Math.hypot(v[0], v[2])), velocity: v.map(n => round(n) || 0) }
    }
  }
}

module.exports = { createMotionTracker }
