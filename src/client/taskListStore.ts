/**
 * 任务列表变更广播。
 *
 * 同一个 client bundle 里主页历史、任务列表弹窗可能挂在不同 tab 上；
 * 任一处新建 / 重命名 / 删除任务后 bump 一个版本号，其它处据此重拉列表。
 */

import { useSyncExternalStore } from 'react'

import type { TaskSummary } from '../search/types'

let version = 0
const listeners = new Set<() => void>()

const summaries = new Map<string, TaskSummary>()
const summaryListeners = new Set<(summary: TaskSummary) => void>()

export function notifyTaskListChanged(): void {
  version += 1
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): number {
  return version
}

function getServerSnapshot(): number {
  return 0
}

export function useTaskListVersion(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/**
 * 把 `/events` 拿到的任务摘要广播给已挂载的任务 tab。
 *
 * 任务完成后 `useTask` 会停止轮询；模型在宿主侧开新一轮时只能靠这里通知，
 * 否则面板会一直停在上一次的结果上。按 rev 去重，避免同一变更反复触发重取。
 */
export function publishTaskSummaries(tasks: readonly TaskSummary[]): void {
  for (const summary of tasks) {
    if (summaries.get(summary.id)?.rev === summary.rev) continue
    summaries.set(summary.id, summary)
    for (const listener of summaryListeners) listener(summary)
  }
}

export function subscribeTaskSummary(
  listener: (summary: TaskSummary) => void,
): () => void {
  summaryListeners.add(listener)
  return () => {
    summaryListeners.delete(listener)
  }
}
