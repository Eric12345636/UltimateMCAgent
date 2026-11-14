#!/usr/bin/env node
'use strict'

const { readFile } = require('node:fs/promises')
const { dirname, resolve } = require('node:path')
const { publicClient } = require('./api')
const { ROUND_MS, scoringTable } = require('./rules')
const { islandBounds } = require('./strategy')
const { runCompetition } = require('./runner')

async function main () {
  const file = process.argv[2]
  if (!file || file === '--help') {
    console.log('用法：npm run compete -- <赛事配置.json>\n配置见 docs/COMPETITION.md')
    return
  }
  const config = JSON.parse(await readFile(file, 'utf8'))
  const start = typeof config.start === 'number' ? config.start
    : /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(config.start) ? Date.parse(config.start) : NaN
  const duration = config.durationSeconds === undefined ? ROUND_MS : config.durationSeconds * 1000
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(duration) || duration < 1000 || duration > ROUND_MS) {
    throw new Error('请填入裁判公布的开始时间，运行时长需为 1 秒至 8 小时')
  }
  if (Date.now() >= start + duration) throw new Error('配置的比赛时间已结束')
  const rules = config.rules ? resolve(dirname(resolve(file)), config.rules) : resolve(__dirname, '../../../RULES.md')
  const table = scoringTable(await readFile(rules, 'utf8'), config.confirmedAdvancements)
  const bounds = islandBounds(config.islands)
  const client = publicClient({
    url: config.api,
    token: process.env.MC_AGENT_TOKEN,
    username: process.env.MC_AGENT_USER,
    password: process.env.MC_AGENT_PASSWORD
  })
  const stop = new AbortController()
  const cancel = () => stop.abort()
  process.on('SIGINT', cancel)
  process.on('SIGTERM', cancel)
  try {
    await runCompetition({ client, table, bounds, start, duration, signal: stop.signal })
  } finally {
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
  }
}

main().catch(e => {
  console.error(e.code || 'error', e.message)
  process.exitCode = 1
})
