/**
 * 数据源运行时健康：限流冷却、最近一次成功/失败与延迟。
 *
 * 只存在于 Host 进程内，不落盘；重启后视为全新状态。`/health` 与设置页
 * 诊断读取这里的快照，密钥不经过本模块。
 */

import type { SourceHealth, SourceId } from './types.js'
import { SOURCE_IDS } from './types.js'

interface SourceRuntime {
  lastOkAt?: number
  lastError?: string
  lastLatencyMs?: number
  cooldownUntil?: number
}

const runtimes = new Map<SourceId, SourceRuntime>()

function runtime(id: SourceId): SourceRuntime {
  let current = runtimes.get(id)
  if (current === undefined) {
    current = {}
    runtimes.set(id, current)
  }
  return current
}

export function cooldownUntil(id: SourceId): number {
  return runtime(id).cooldownUntil ?? 0
}

export function recordSourceOk(id: SourceId, latencyMs: number): void {
  const current = runtime(id)
  current.lastOkAt = Date.now()
  current.lastLatencyMs = Math.max(0, Math.round(latencyMs))
  current.lastError = undefined
}

export function recordSourceError(id: SourceId, message: string): void {
  runtime(id).lastError = message
}

export function recordSourceCooldown(id: SourceId, until: number, message: string): void {
  const current = runtime(id)
  current.cooldownUntil = Math.max(until, Date.now())
  current.lastError = message
}

export function sourceHealthList(): SourceHealth[] {
  const now = Date.now()
  return SOURCE_IDS.map((id): SourceHealth => {
    const current = runtime(id)
    const health: SourceHealth = { id }
    if (current.lastOkAt !== undefined) health.lastOkAt = new Date(current.lastOkAt).toISOString()
    if (current.lastError !== undefined) health.lastError = current.lastError
    if (current.lastLatencyMs !== undefined) health.lastLatencyMs = current.lastLatencyMs
    if (current.cooldownUntil !== undefined && current.cooldownUntil > now) {
      health.cooldownUntil = new Date(current.cooldownUntil).toISOString()
    }
    return health
  })
}

export function resetSourceHealth(): void {
  runtimes.clear()
}
