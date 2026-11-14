'use strict'

// 客户端动作集合取自对外发布的 v1.3 规范。
const READS = new Set(['status', 'inventory'])
const CALLS = new Set([
  ...READS, 'auth/login', 'auth/logout', 'connect', 'find_blocks', 'get_block',
  'get_entities', 'advancements', 'move_to', 'dig', 'craft', 'place', 'equip',
  'attack', 'shoot', 'interact', 'use_item', 'window/view', 'window/act', 'stop'
])

class ApiError extends Error {
  constructor (code, message, details = {}) {
    super(message || code)
    this.code = code
    this.details = details
  }
}

function publicClient ({ url, token, username, password, fetchImpl = fetch }) {
  const base = new URL(url)
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
    throw new Error('赛事 API 需要 HTTPS，本地测试可用回环 HTTP')
  }
  if (base.username || base.password || base.search || base.hash || !/\/api\/v1\/?$/.test(base.pathname)) {
    throw new Error('赛事 API 地址应以 /api/v1 结尾')
  }

  async function call (name, args = {}, { timeout = 15000, signal } = {}) {
    if (!CALLS.has(name)) throw new Error(`未公开的 API 路径 ${name}`)
    const timeoutSignal = AbortSignal.timeout(timeout)
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    const headers = { accept: 'application/json' }
    if (token && name !== 'auth/login') headers.authorization = `Bearer ${token}`
    const method = READS.has(name) ? 'GET' : 'POST'
    if (method === 'POST') headers['content-type'] = 'application/json'
    try {
      const response = await fetchImpl(base.href.replace(/\/$/, '') + '/' + name, {
        method, headers, redirect: 'error', signal: requestSignal,
        ...(method === 'POST' ? { body: JSON.stringify(args) } : {})
      })
      const body = await response.text()
      let data
      try { data = JSON.parse(body) } catch {}
      if (!response.ok || data?.ok !== true) {
        const fallback = response.status === 429 ? 'rate_limited'
          : response.status === 401 && token ? 'invalid_token'
            : response.ok ? 'invalid_response' : `http_${response.status}`
        const retryAfter = response.headers.get('retry-after')
        const details = { ...data?.error }
        if (retryAfter && details.retry_after_s == null) {
          const seconds = Number(retryAfter)
          details.retry_after_s = Number.isFinite(seconds) ? seconds : (Date.parse(retryAfter) - Date.now()) / 1000
        }
        throw new ApiError(data?.error?.code || fallback, data?.error?.message, details)
      }
      return data.result ?? data
    } catch (e) {
      if (e instanceof ApiError || signal?.aborted) throw e
      throw new ApiError(timeoutSignal.aborted ? 'request_timeout' : 'network', `${name} 请求失败`)
    }
  }

  return {
    call,
    async login (opts) {
      if (!username || !password) throw new ApiError('credentials_required', '需要 API token 或账号密码')
      const result = await call('auth/login', { username, password }, opts)
      if (typeof result.token !== 'string' || !result.token) throw new ApiError('auth_error', '登录未返回 token')
      token = result.token
    },
    hasToken: () => !!token,
    forgetToken: () => { token = null }
  }
}

module.exports = { ApiError, publicClient }
