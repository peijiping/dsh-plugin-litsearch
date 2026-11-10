/**
 * `/health` 的共享快照。
 *
 * 面板、设置页与自动打开都要读「当前默认源 / 页面条数 / 自动打开开关」。
 * Host 侧设置改了不会主动推送，这里用一份模块级快照 + 定时刷新兜底。
 */

import { useSyncExternalStore } from 'react'

import type { HealthInfo } from '../search/types'
import { fetchHealth } from './api'

let snapshot: HealthInfo | null = null

const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function getHealth(): HealthInfo | null {
  return snapshot
}

export function subscribeHealth(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 拉取一次健康信息；失败时保留旧快照并返回 null。 */
export async function refreshHealth(signal?: AbortSignal): Promise<HealthInfo | null> {
  try {
    const next = await fetchHealth(signal)
    snapshot = next
    emit()
    return next
  } catch {
    return null
  }
}

export function useHealth(): HealthInfo | null {
  return useSyncExternalStore(subscribeHealth, getHealth, getHealth)
}
