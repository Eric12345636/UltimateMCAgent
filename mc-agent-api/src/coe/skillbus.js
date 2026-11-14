'use strict'
// SkillBus：上层技能队列。
//
// 上层（LLM）随时可以下发新技能，但下层不可能立刻执行——它正在执行一个长步骤。
// 所以这里区分「排队中的技能」和「正在执行的技能」：
//   - 新技能进队列，默认清掉同类旧技能（避免旧的 gather 排在新 goto 前面）
//   - 队列满了丢最旧的
//   - 紧急技能（flee）可以插队并打断当前执行

class SkillBus {
  constructor (opts = {}) {
    this.max = Number.isSafeInteger(opts.max) && opts.max > 0 ? opts.max : 4
    this.queue = []
    this.current = null
    this.seq = 0
  }

  // 提交一个技能。返回 { ok, seq, dropped }
  submit (skill, args, meta = {}) {
    const item = {
      seq: ++this.seq,
      skill,
      args: args || {},
      reason: meta.reason || '',
      priority: meta.priority === 'urgent' ? 1 : 0,
      at: Date.now()
    }
    // 同一目标才去重。gather oak_log 仍会挤掉上一个 oak_log，
    // 但 craft 木板和 craft 木棍可以同时排着，否则多步计划会被压成一步。
    const key = skillKey(skill, args)
    this.queue = this.queue.filter(q => skillKey(q.skill, q.args) !== key)
    // 紧急技能插队
    if (item.priority) this.queue.unshift(item)
    else this.queue.push(item)
    let dropped = null
    while (this.queue.length > this.max) {
      // 丢最旧的非紧急技能
      let idx = this.queue.findIndex(q => q.priority === 0)
      if (idx < 0) idx = this.queue.length - 1
      dropped = this.queue.splice(idx, 1)[0]
    }
    return { ok: true, seq: item.seq, dropped: dropped ? dropped.skill : null }
  }

  // 取下一个要执行的技能
  next () {
    if (this.current) return null
    const item = this.queue.shift() || null
    if (item) this.current = item
    return item
  }

  // 当前技能执行完毕
  done () {
    const cur = this.current
    this.current = null
    return cur
  }

  // 打断当前技能（紧急技能或上层撤销）
  cancel () {
    const cur = this.current
    this.current = null
    return cur
  }

  clear () {
    this.queue = []
    this.current = null
  }

  peek () {
    return this.current || this.queue[0] || null
  }

  snapshot () {
    return {
      current: this.current ? { seq: this.current.seq, skill: this.current.skill, args: this.current.args } : null,
      queued: this.queue.map(q => ({ seq: q.seq, skill: q.skill, args: q.args }))
    }
  }
}

// goto 看落点，挖掘看目标方块和方向，合成/放置/熔炼看物品。其余技能同时只留一条。
function skillKey (skill, args) {
  const a = args || {}
  if (skill === 'goto') return `goto:${Number(a.x)}:${Number(a.z)}`
  if (skill === 'gather' || skill === 'mine') return `${skill}:${a.target}:${a.down ? 1 : 0}:${a.ahead ? 1 : 0}`
  if (skill === 'craft' || skill === 'equip' || skill === 'place' || skill === 'smelt') return `${skill}:${a.item}`
  return skill
}

module.exports = { SkillBus, skillKey }
