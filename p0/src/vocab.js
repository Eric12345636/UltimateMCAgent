'use strict'
// 名字词表：把 Minecraft 的方块/物品/实体/效果/群系名压成 N<id> 单 token。
// 词表由 tools/build-vocab.js 从 minecraft-data 生成，这里只读。

const fs = require('fs')
const path = require('path')

const FILE = path.resolve(__dirname, '../data/vocab.json')
const { UNKNOWN_NAME_PREFIX } = require('./format')

let cache = null

function load () {
  if (cache) return cache
  if (!fs.existsSync(FILE)) {
    throw new Error('缺少 data/vocab.json，先跑：npm run build:vocab')
  }
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  const byId = new Map()
  for (const [name, id] of Object.entries(raw.names)) byId.set(name, id)
  cache = { version: raw.version, protocol: raw.protocol, meta: raw.meta, byId, ids: raw.ids }
  return cache
}

// 名字 → token。词表里没有的名字（自定义物品、服务器特有名）走 X<原文>，不丢信息。
function nameToken (name) {
  if (name === undefined || name === null || name === '') return '-'
  const v = load()
  const id = v.byId.get(name)
  return id === undefined ? UNKNOWN_NAME_PREFIX + String(name) : 'N' + id
}

function id (name) {
  const v = load()
  const i = v.byId.get(name)
  return i === undefined ? -1 : i
}

function name (id) {
  const v = load()
  return v.ids[id]
}

function has (n) {
  return load().byId.has(n)
}

// 数字 → token。整数原样；小数保留 3 位（yaw/pitch 是 2 位精度，压到 1 位会丢信息）。
// 无论几位都是单个 token，不影响词表规模。
function num (n) {
  if (n === undefined || n === null || n === '') return '-'
  const f = Number(n)
  if (!Number.isFinite(f)) return '-'
  return Number.isInteger(f) ? String(f) : String(Math.round(f * 1000) / 1000)
}

// 布尔 → '1' / '0'
function bool (b) {
  return b ? '1' : '0'
}

module.exports = { load, nameToken, id, name, has, num, bool, FILE }
