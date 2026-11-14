'use strict'
// 上层决策的**确定性评分器**。
//
// 为什么需要它：真服跑一轮要好几分钟，而且每次状态都不一样，没法比较。
// 有了这个评分器，一组固定场景 + 一个固定的 LLM 就能在几秒内跑完——
// 改提示词/改观测渲染/改技能表之后立刻能看到全局影响。这是人工迭代闭环的关键。
//
// 评分全是规则，没有模型参与，所以可复现、可 diff。
//
// 和 render.js 是同一套阈值（THREAT_DANGER / THREAT_WARN），改一处要改两处。

const { classifyThreat } = require('./render')

function observedBlockNames (raw) {
  const blocks = (raw.findBlocks && raw.findBlocks.blocks) || []
  return blocks.map(b => b.name).filter(Boolean)
}

function observedEntityNames (raw) {
  const ents = (raw.entities && raw.entities.entities) || []
  return ents.map(e => (e && (e.name || e.type))).filter(Boolean)
}

// 'zombie#812' → 'zombie'
function normEntity (ref) {
  return String(ref).split('#')[0].trim().toLowerCase()
}

// 给一个场景的技能列表打分
function scoreScenario (scenario, skills, maxSkills = 2) {
  const raw = scenario.raw || {}
  const expect = scenario.expect || {}
  const checks = []
  const check = (rule, ok, detail) => checks.push({ rule, ok: !!ok, detail: detail || '' })

  skills = skills || []
  const names = skills.map(s => s.skill)
  const threat = classifyThreat(raw.entities)

  // 0) 威胁等级：观测算出来的要和场景期望一致（不一致说明场景数据本身写错了）
  if (expect.threat_level) {
    check('threat_level_matches', threat.level === expect.threat_level,
      `观测算出 ${threat.level}，场景期望 ${expect.threat_level}`)
  }

  // 1) 数量
  check('skill_count', names.length <= maxSkills, `给了 ${names.length} 个技能（上限 ${maxSkills}）`)

  // 2) 非空
  check('has_skill', names.length > 0, '没有给出任何技能')

  // 3) 安全：危险时第一个必须逃；安全时不能逃
  if (expect.first_must_be) {
    const first = names[0] || null
    check('first_skill', first === expect.first_must_be,
      `第一个技能是 ${first}，期望 ${expect.first_must_be}`)
  }
  if (expect.threat_level === 'safe' && !(expect.must_include || []).includes('flee')) {
    check('no_unnecessary_flee', !names.includes('flee'), '威胁等级是安全，却要逃')
  }

  // 4) 期望包含 / 不包含
  for (const sk of expect.must_include || []) {
    check('must_include:' + sk, names.includes(sk), `缺少技能 ${sk}`)
  }
  for (const sk of expect.must_not_include || []) {
    check('must_not_include:' + sk, !names.includes(sk), `不该出现技能 ${sk}`)
  }

  // 5) 目标必须真的看得见（不能编造方块名 / 实体名）
  const blockNames = observedBlockNames(raw)
  const entityNames = observedEntityNames(raw)
  for (const s of skills) {
    if (s.skill === 'gather' || s.skill === 'mine') {
      const t = s.args && s.args.target
      if (t !== undefined && t !== null) {
        check('target_visible:' + t, blockNames.includes(t),
          `观测里没有 ${t}（可见：${blockNames.join(', ') || '无'}）`)
      }
    }
    if (s.skill === 'attack') {
      const ent = s.args && s.args.entity
      if (ent !== undefined && ent !== null) {
        const lower = entityNames.map(normEntity)
        check('entity_visible:' + ent, lower.includes(normEntity(ent)),
          `观测里没有 ${ent}（可见：${entityNames.join(', ') || '无'}）`)
      }
    }
  }

  // 6) 拖延：无威胁时不该用 wait；wait 的时长也不能大
  if (names.includes('wait') && (threat.level === 'none' || threat.level === 'safe')) {
    check('no_stall', false, '没有威胁却用了 wait')
  }
  for (const s of skills) {
    if (s.skill === 'wait') {
      const ms = s.args && s.args.ms
      check('wait_short', Number.isInteger(ms) && ms >= 0 && ms <= 1000, `wait 的时长是 ${ms}`)
    }
  }

  // 7) 偏好（提示性的，不算硬失败）
  const prefer = expect.prefer || []
  if (prefer.length) {
    check('prefer_any', names.some(n => prefer.includes(n)),
      `没有一个技能落在偏好集合 ${prefer.join('/')} 里`)
  }

  const failed = checks.filter(c => !c.ok)
  return {
    name: scenario.name,
    desc: scenario.desc,
    threat: threat.level,
    skills: names,
    pass: failed.length === 0,
    checks,
    failed: failed.map(c => c.rule)
  }
}

// 汇总
function summarize (results) {
  const total = results.length
  const passed = results.filter(r => r.pass).length
  const byRule = {}
  for (const r of results) {
    for (const rule of r.failed) byRule[rule] = (byRule[rule] || 0) + 1
  }
  return {
    total,
    passed,
    failed: total - passed,
    pass_rate: total ? passed / total : 0,
    failing_rules: Object.entries(byRule).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ rule: k, count: v }))
  }
}

module.exports = { scoreScenario, summarize, observedBlockNames, observedEntityNames, normEntity }
