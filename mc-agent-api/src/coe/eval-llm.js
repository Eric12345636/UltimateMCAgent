'use strict'
// 上层决策的离线评测：拿一组固定场景跑 LLM，用确定性规则打分，出报告，还能和上次比。
//
// 这就是「本地不装 MC 也能观测模型行为并人工改进」的闭环：
//   1. 改提示词 / 改观测渲染 / 改技能表 / 改阈值
//   2. 跑 node src/coe/eval-llm.js
//   3. 看哪些场景从过变成不过（回归）、哪些从不过变成过（改进）
//
// 用法：
//   node src/coe/eval-llm.js                  # 跑一遍并和基线比
//   node src/coe/eval-llm.js --save           # 跑完把结果存成新基线
//   node src/coe/eval-llm.js --baseline x.json
//   node src/coe/eval-llm.js --only zombie    # 只跑名字里含关键字的场景
//   node src/coe/eval-llm.js --json           # 机器可读输出
//
// 前提：Ollama 在跑（ollama ps 看得到模型）。

const fs = require('fs')
const path = require('path')
const { Planner, OllamaClient } = require('./llm')
const { scoreScenario, summarize } = require('./rubric')

const SCENARIO_FILE = path.resolve(__dirname, 'scenarios.json')
const BASELINE_FILE = path.resolve(__dirname, 'eval-baseline.json')

function parseArgs () {
  const a = { save: false, json: false, only: null, baseline: BASELINE_FILE, temp: 0, repeat: 1 }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--save') a.save = true
    else if (argv[i] === '--json') a.json = true
    else if (argv[i] === '--only') a.only = argv[++i]
    else if (argv[i] === '--baseline') a.baseline = path.resolve(argv[++i])
    else if (argv[i] === '--temp') a.temp = Number(argv[++i])
    else if (argv[i] === '--repeat') a.repeat = Math.max(1, Number(argv[++i]))
  }
  return a
}

function loadScenarios () {
  const raw = JSON.parse(fs.readFileSync(SCENARIO_FILE, 'utf8'))
  return raw.scenarios || []
}

function loadBaseline (file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    return null
  }
}

async function main () {
  const args = parseArgs()
  const scenarios = loadScenarios().filter(s => !args.only || s.name.includes(args.only))

  const client = new OllamaClient({
    endpoint: process.env.MC_LLM_ENDPOINT || 'http://127.0.0.1:11434',
    model: process.env.MC_LLM_MODEL || 'qwen2.5-mc:7b',
    keepAlive: '30m',
    timeoutMs: 20000,
    // 评测默认贪心解码：temperature=0.2 时同一场景两次跑的结论可能不一样，
    // 那样分数波动就没法当回归信号用了。
    temperature: args.temp
  })
  const health = await client.health()
  if (!health.ok) {
    console.error('Ollama 不可达：' + health.error)
    process.exit(1)
  }
  const planner = new Planner({ client })

  const results = []
  for (const sc of scenarios) {
    // 重复跑多次：用「通过率」而不是「一次通过」来衡量，噪声就显出来了
    const runs = []
    for (let k = 0; k < args.repeat; k++) {
      const res = await planner.plan(sc.raw)
      const scored = scoreScenario(sc, res.ok ? res.skills : [], planner.maxSkills)
      scored.error = res.ok ? null : res.error
      scored.latency_ms = res.ms || 0
      scored.raw = res.raw_content || null
      runs.push(scored)
    }
    const passedRuns = runs.filter(r => r.pass).length
    const merged = {
      name: sc.name,
      desc: sc.desc,
      threat: runs[0].threat,
      skills: runs[0].skills,
      pass: passedRuns === runs.length,
      pass_rate: passedRuns / runs.length,
      runs: runs.length,
      checks: runs[0].checks,
      failed: runs[0].failed,
      variants: runs.map(r => r.skills.join(',') || '(无)'),
      latency_ms: Math.round(runs.reduce((s, r) => s + (r.latency_ms || 0), 0) / runs.length)
    }
    results.push(merged)
  }

  const sum = summarize(results)
  const baseline = loadBaseline(args.baseline)
  const baselineMap = new Map((baseline && baseline.results || []).map(r => [r.name, r]))

  if (args.json) {
    console.log(JSON.stringify({ summary: sum, results, baseline: baseline ? baseline.summary : null }, null, 2))
  } else {
    console.log('='.repeat(72))
    console.log(`上层决策评测  模型=${client.model}  场景=${scenarios.length}  重复=${args.repeat}  温度=${args.temp}`)
    console.log('='.repeat(72))
    for (const r of results) {
      const mark = r.pass_rate === 1 ? 'PASS' : (r.pass_rate > 0 ? 'FLAKY' : 'FAIL')
      const diff = baselineMap.has(r.name) ? diffAgainst(baselineMap.get(r.name), r) : ''
      const rate = args.repeat > 1 ? ` ${(r.pass_rate * 100).toFixed(0)}%` : ''
      console.log(`[${mark}] ${r.name.padEnd(30)} 威胁=${String(r.threat).padEnd(6)}${rate} ${r.variants.join(' | ')}${diff ? '  ' + diff : ''}`)
      for (const c of r.checks.filter(c => !c.ok)) {
        console.log(`        ✗ ${c.rule}: ${c.detail}`)
      }
      if (r.error) console.log(`        ! LLM 失败: ${r.error}`)
    }
    console.log('-'.repeat(72))
    console.log(`通过 ${sum.passed}/${sum.total}  (${(sum.pass_rate * 100).toFixed(0)}%)`)
    if (sum.failing_rules.length) {
      console.log('最常失败的规则：')
      for (const f of sum.failing_rules.slice(0, 8)) console.log(`  ${String(f.count).padStart(2)}× ${f.rule}`)
    }
    if (baseline) {
      const b = baseline.summary
      const delta = sum.pass_rate - (b ? b.pass_rate : 0)
      const sign = delta > 0 ? '+' : ''
      console.log(`基线对比：${b.passed}/${b.total} → ${sum.passed}/${sum.total}  (${sign}${(delta * 100).toFixed(0)}%)`)
    } else {
      console.log('（还没有基线，跑一次 --save 存下来，之后就能看回归）')
    }
  }

  if (args.save) {
    fs.writeFileSync(args.baseline, JSON.stringify({
      saved_at: new Date().toISOString(),
      model: client.model,
      summary: sum,
      results: results.map(r => ({ name: r.name, pass: r.pass, skills: r.skills, failed: r.failed }))
    }, null, 2))
    if (!args.json) console.log('基线已存到 ' + args.baseline)
  }

  process.exit(sum.failed === 0 ? 0 : 1)
}

// 和基线比：这个场景是修好了还是退化了
function diffAgainst (base, now) {
  const baseRate = base.pass_rate === undefined ? (base.pass ? 1 : 0) : base.pass_rate
  const nowRate = now.pass_rate === undefined ? (now.pass ? 1 : 0) : now.pass_rate
  if (baseRate === nowRate) return ''
  if (nowRate > baseRate) return ' ← 修好了'
  return ' ← 退化了'
}

main().catch(e => { console.error(e); process.exit(1) })
