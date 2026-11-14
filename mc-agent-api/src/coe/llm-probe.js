'use strict'
// 上层 LLM 的实机探针：验证本机 Ollama + qwen2.5-mc:7b 能不能按 Skill schema 产出合法技能。
// 这不是正式客户端，只是把「上层能不能用」这件事先验掉。
const http = require('http')

const SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      skill: { type: 'string', enum: ['goto', 'gather', 'mine', 'attack', 'flee', 'eat', 'craft', 'equip', 'wait', 'chat'] },
      args: { type: 'object' },
      reason: { type: 'string' }
    },
    required: ['skill', 'args']
  }
}

const SYSTEM = '你是 Minecraft Java 版生存 agent 的上层决策器。根据观测决定下一步要执行的技能。只输出 JSON 数组，不要解释。\n' +
  '可用技能：\n' +
  '  goto(x,y,z) 走到坐标；gather(target,count) 采集方块；mine(target,count) 挖方块；attack(entity_id) 攻击实体；\n' +
  '  flee 逃离威胁；eat 进食；craft(item,count) 合成；equip(item) 换手持；wait(ms) 短暂等待；chat(message) 说话。\n' +
  '决策规则：\n' +
  '1. 敌对实体距离超过 8 格不算威胁，不要 flee，也不要 attack。\n' +
  '2. 默认选能推进当前生存目标的技能（gather / mine / goto），不要用 wait 拖延。\n' +
  '3. wait 只能用于 200-800 毫秒的短暂停顿，绝对不要超过 1000。\n' +
  '4. 一次最多输出 2 个技能，按优先级排列。\n' +
  '5. 没有明确目标方块时，先用 gather 采集离自己最近的、能拿到手的目标。\n' +
  '6. 威胁等级是"危险"时，第一个技能必须是 flee。\n' +
  '7. 威胁等级是"安全"时，绝对不要输出 flee。\n' +
  '8. 威胁等级是"警戒"时，不要 flee，但可以先 attack 击退它。'

const SCENARIOS = [
  {
    name: 'A 威胁等级=安全（僵尸 12.6 格）',
    obs: '状态: 生命 20/20 饱食 20/20 位置[10,64,10] 白天 森林 手持iron_sword\n' +
      '威胁等级: 安全（最近敌对实体 zombie 12.6格）\n' +
      '资源: crafting_table 2.8格 / oak_log 4.5格 / stone 4.6格\n' +
      '背包: oak_log x12 stick x4 crafting_table x1 iron_sword x1\n' +
      '最近事件: 受到攻击 掉血3'
  },
  {
    name: 'B 威胁等级=危险（僵尸 2.5 格）',
    obs: '状态: 生命 14/20 饱食 20/20 位置[10,64,10] 白天 森林 手持iron_sword\n' +
      '威胁等级: 危险（最近敌对实体 zombie 2.5格，正在逼近）\n' +
      '资源: crafting_table 2.8格 / oak_log 4.5格\n' +
      '背包: oak_log x12 crafting_table x1 iron_sword x1\n' +
      '最近事件: 受到攻击 掉血2'
  },
  {
    name: 'C 威胁等级=安全（苦力怕 7.6 格）',
    obs: '状态: 生命 14/20 饱食 13/20 位置[100,12,-50] 夜晚 洞穴 手持stone_pickaxe\n' +
      '威胁等级: 安全（最近敌对实体 creeper 7.6格）\n' +
      '资源: cobblestone 3.6格 / coal_ore 4.6格 / iron_ore 6.2格\n' +
      '背包: cobblestone x34 coal x9 raw_iron x3 torch x32'
  },
  {
    name: 'D 威胁等级=警戒（僵尸 6 格）',
    obs: '状态: 生命 20/20 饱食 20/20 位置[10,64,10] 白天 森林 手持iron_sword\n' +
      '威胁等级: 警戒（最近敌对实体 zombie 6.0格）\n' +
      '资源: oak_log 4.5格 / stone 4.6格\n' +
      '背包: oak_log x12 stick x4 iron_sword x1'
  }
]

const OBS = SCENARIOS[0].obs

function chat (body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({
      host: '127.0.0.1', port: 11434, path: '/api/chat', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
    }, res => {
      let buf = ''
      res.on('data', c => { buf += c })
      res.on('end', () => {
        try { resolve(JSON.parse(buf)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.end(data)
  })
}

async function main () {
  const model = process.env.MC_LLM_MODEL || 'qwen2.5-mc:7b'
  for (const sc of SCENARIOS) {
    const body = {
      model,
      stream: false,
      format: SCHEMA,
      options: { temperature: 0.2, num_predict: 200, keep_alive: '10m' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: sc.obs }
      ]
    }
    const t0 = Date.now()
    const r = await chat(body)
    const ms = Date.now() - t0
    const content = r.message && r.message.content
    console.log(`\n--- ${sc.name}  ${ms} ms ---`)
    console.log(content)
    try {
      const parsed = JSON.parse(content)
      console.log('   技能：', parsed.map(x => x.skill + '(' + JSON.stringify(x.args) + ')').join('  |  '))
    } catch (e) {
      console.log('   !! 不是合法 JSON')
    }
  }

  // 并发：多个 bot 同时要决策时会怎样
  console.log('\n--- 并发 3 个请求 ---')
  const t0 = Date.now()
  const rs = await Promise.all([1, 2, 3].map(() => chat({
    model,
    stream: false,
    format: SCHEMA,
    options: { temperature: 0.2, num_predict: 120, keep_alive: '10m' },
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: SCENARIOS[0].obs }]
  })))
  console.log('   3 个并发总耗时', Date.now() - t0, 'ms')
  for (let i = 0; i < rs.length; i++) {
    const ok = !!(rs[i].message && rs[i].message.content)
    console.log(`   #${i + 1} 合法=${ok} ${ok ? rs[i].message.content.slice(0, 60) : JSON.stringify(rs[i].error || '')}`)
  }
}

main().catch(e => { console.error(e.message); process.exit(1) })
