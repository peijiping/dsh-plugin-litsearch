/**
 * 模型下载指令的客户端暂存与分发。
 *
 * 指令由全局 `/events` 轮询写入，但真正执行下载的是某个任务 tab 里的
 * `TaskPane`；tab 可能还没挂载（focus 正在拉起它），所以这里做模块级
 * 待消费队列，并按 commandId 幂等去重 —— 刷新页面也不会重放旧指令。
 */

import { useMemo, useSyncExternalStore } from 'react'

import type { DownloadCommand } from '../search/types'

const SEEN_KEY = 'dsh-litsearch.downloads.seen'
const SEEN_MAX = 200

/** 与自动聚焦一致：超过 10 分钟的指令视为过期，避免后台标签页回前台后重放。 */
export const DOWNLOAD_WINDOW_MS = 10 * 60 * 1000

/** 指令是否仍在有效期内（允许客户端时钟略慢 1 分钟）。 */
export function isFreshDownload(command: DownloadCommand, now = Date.now()): boolean {
  return (
    Number.isFinite(command.at) &&
    command.at <= now + 60_000 &&
    now - command.at <= DOWNLOAD_WINDOW_MS
  )
}

/** 指令是否属于这个任务 / 这个会话；拿不到当前会话 id 时不额外拦截。 */
export function isCommandFor(
  command: DownloadCommand,
  taskId: string,
  sessionId?: string,
): boolean {
  if (command.taskId !== taskId) return false
  if (command.sessionId === undefined || sessionId === undefined) return true
  return command.sessionId === sessionId
}

function loadSeen(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(SEEN_KEY)
    if (raw === null || raw === undefined || raw === '') return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is string => typeof item === 'string')
      .slice(-SEEN_MAX)
  } catch {
    return []
  }
}

function rememberSeen(commandId: string): void {
  seen.add(commandId)
  while (seen.size > SEEN_MAX) {
    const oldest = seen.values().next().value
    if (oldest === undefined) break
    seen.delete(oldest)
  }
  try {
    globalThis.localStorage?.setItem(SEEN_KEY, JSON.stringify([...seen]))
  } catch {
    // 隐私模式 / 存储配额不足：退化为仅内存去重，不影响本次会话。
  }
}

const seen = new Set<string>(loadSeen())
let pending: DownloadCommand[] = []
let version = 0
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getVersion(): number {
  return version
}

function getServerVersion(): number {
  return 0
}

function bump(): void {
  version += 1
  for (const listener of listeners) listener()
}

/**
 * 把 `/events` 增量里的下载指令写入待消费队列。
 *
 * 不受自动打开开关与首次轮询影响：下载指令总是入队，tab 由工具同时发出的
 * focus 请求拉起，未挂载时指令在此等待。
 */
export function publishDownloadCommands(
  commands: readonly DownloadCommand[] | undefined,
  screenSessionId?: string,
): void {
  if (commands === undefined || commands.length === 0) return
  let added = 0
  for (const command of commands) {
    if (!isFreshDownload(command)) continue
    if (seen.has(command.commandId)) continue
    if (command.sessionId !== undefined && screenSessionId !== undefined &&
        command.sessionId !== screenSessionId) {
      continue
    }
    if (pending.some((item) => item.commandId === command.commandId)) continue
    rememberSeen(command.commandId)
    pending = [...pending, command]
    added += 1
  }
  if (added > 0) bump()
}

/** 订阅某个任务的待消费指令；返回数组按到达顺序排列。 */
export function usePendingDownloadCommands(
  taskId: string | null,
): readonly DownloadCommand[] {
  const current = useSyncExternalStore(subscribe, getVersion, getServerVersion)
  return useMemo(() => {
    if (taskId === null) return []
    return pending.filter((command) => command.taskId === taskId)
    // version 由 useSyncExternalStore 订阅；current 变化即代表队列变化。
  }, [current, taskId])
}

/** 只读快照，供非 React 上下文（单测 / 诊断）查看待消费队列。 */
export function peekPendingDownloads(): readonly DownloadCommand[] {
  return pending
}

/** 指令已被某个 TaskPane 接走，避免别的 tab 或后续 effect 重复执行。 */
export function markConsumed(commandId: string): void {
  const next = pending.filter((command) => command.commandId !== commandId)
  if (next.length === pending.length) return
  pending = next
  bump()
}
