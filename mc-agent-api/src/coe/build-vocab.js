'use strict'
// 生成 L-obs 的 token 词表：src/coe/local-vocab.json
//
// 词表是**训练侧与运行侧的共同契约**：Python 侧（p1/）读同一个文件，
// ONNX 模型的输入 token id 就是这个数组的下标。改了编码就要重新生成，
// 然后同步更新 p1/data/golden_local.json。
//
// 用法：node src/coe/build-vocab.js

const fs = require('fs')
const path = require('path')
const { localVocab } = require('./local')

const out = path.resolve(__dirname, 'local-vocab.json')
const list = localVocab()
fs.writeFileSync(out, JSON.stringify({ version: '1', tokens: list }, null, 0))
console.log('写入', out, '共', list.length, '个 token')
