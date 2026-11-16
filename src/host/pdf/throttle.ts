/**
 * 按 host 限并发 + 429 冷却。
 *
 * 批量下载最容易被同一家出版商限流：这里让同一域名最多 N 个并发在途，
 * 收到 429 时按 `Retry-After`（或兜底 10s）冷却该域名，冷却期内直接跳过，
 * 不去打明知会失败的请求。
 */

import { getSettings } from '../../search/config.js'

const MAX_COOLDOWN_MS = 10 * 60 * 1000
const DEFAULT_COOLDOWN_MS = 10_000

interface HostState {
  active: number
  waiters: Array<() => void>
  cooldownUntil: number
}

const hosts = new Map<string, HostState>()

function hostState(host: string): HostState {
  let state = hosts.get(host)
  if (state === undefined) {
    state = { active: 0, waiters: [], cooldownUntil: 0 }
    hosts.set(host, state)
  }
  return state
}

/** 取 URL 的 host；非法地址返回空串（由调用方先行校验协议）。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 在指定 host 的并发额度内执行。 */
export async function withHostSlot<T>(
  host: string,
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const aborted = (): boolean => signal?.aborted === true
  if (aborted()) throw new Error('请求已取消')
  const state = hostState(host)
  const limit = Math.max(1, Math.round(getSettings().pdfPerHostConcurrency))
  if (state.active >= limit) {
    await new Promise<void>((resolve) => state.waiters.push(resolve))
  }
  state.active += 1
  try {
    if (aborted()) throw new Error('请求已取消')
    return await fn()
  } finally {
    state.active = Math.max(0, state.active - 1)
    const next = state.waiters.shift()
    if (next !== undefined) next()
  }
}

/** 剩余冷却毫秒数；0 表示未冷却。 */
export function hostCoolingMs(host: string): number {
  const state = hosts.get(host)
  if (state === undefined) return 0
  return Math.max(0, state.cooldownUntil - Date.now())
}

/** 记录 429 冷却；多次命中取更晚的截止时间，并封顶 10 分钟。 */
export function recordHostCooldown(host: string, ms: number): void {
  const state = hostState(host)
  const until = Date.now() + Math.min(Math.max(0, ms), MAX_COOLDOWN_MS)
  state.cooldownUntil = Math.max(state.cooldownUntil, until)
}

export function defaultCooldownMs(): number {
  return DEFAULT_COOLDOWN_MS
}

/** 测试用：清空全部 host 状态。 */
export function resetHostThrottle(): void {
  hosts.clear()
}
