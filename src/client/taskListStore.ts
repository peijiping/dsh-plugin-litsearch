/**
 * 任务列表变更广播。
 *
 * 同一个 client bundle 里主页历史、任务列表弹窗可能挂在不同 tab 上；
 * 任一处新建 / 重命名 / 删除任务后 bump 一个版本号，其它处据此重拉列表。
 */

import { useSyncExternalStore } from 'react'

let version = 0
const listeners = new Set<() => void>()

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
