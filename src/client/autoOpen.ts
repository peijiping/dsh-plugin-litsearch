/**
 * 模型任务的自动打开 + 任务标题缓存 + 「待打开」队列。
 *
 * Host→Client 没有广播通道，这里按 `sinceRev` 轮询 `/events`：
 * - 首次轮询只对齐版本号，不把宿主启动前的历史任务全打开；
 * - 之后只对 `origin === 'model'` 的新任务调 `openResource`；
 * - `maxTaskTabs` 已满时不打开，改放进「待打开」队列，由主面板横幅提示；
 * - 宿主重启（`reset`）时重新对齐，不做任何打开动作。
 */

import { useSyncExternalStore } from 'react'

import { DEFAULT_AUTO_OPEN, DEFAULT_MAX_TASK_TABS } from '../search/config'
import type { TaskSummary } from '../search/types'
import { fetchEvents, fetchTask } from './api'
import { getHealth, refreshHealth } from './health'

const OPENED_KEY = 'dsh-litsearch.opened'
const PENDING_KEY = 'dsh-litsearch.pending'
const TITLES_KEY = 'dsh-litsearch.titles'
const POLL_MS = 1500
const MAX_REMEMBERED = 200

export interface PendingTask {
  id: string
  title: string
}

// ---- 本地存储 --------------------------------------------------------------

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    if (raw === null || raw === undefined || raw === '') return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value))
  } catch {
    // 存储配额满 / 隐私模式：功能降级，不影响检索。
  }
}

// ---- 标题缓存 --------------------------------------------------------------

let titles: Record<string, string> = readTitles()
const titleListeners = new Set<() => void>()
const titleLoading = new Set<string>()

function readTitles(): Record<string, string> {
  const stored = readJson<unknown>(TITLES_KEY, {})
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return {}
  const result: Record<string, string> = {}
  for (const [id, value] of Object.entries(stored)) {
    if (typeof value === 'string') result[id] = value
  }
  return result
}

export function rememberTaskTitle(id: string, title: string): void {
  if (id === '' || title === '' || titles[id] === title) return
  titles[id] = title
  const ids = Object.keys(titles)
  if (ids.length > MAX_REMEMBERED) {
    for (const stale of ids.slice(0, ids.length - MAX_REMEMBERED)) delete titles[stale]
  }
  writeJson(TITLES_KEY, titles)
  for (const listener of titleListeners) listener()
}

export function getTaskTitle(id: string | null): string | undefined {
  return id === null ? undefined : titles[id]
}

function subscribeTitles(listener: () => void): () => void {
  titleListeners.add(listener)
  return () => {
    titleListeners.delete(listener)
  }
}

/** 标题席位用：缓存缺失时补取一次详情。 */
export function ensureTaskTitle(id: string): void {
  if (titles[id] !== undefined || titleLoading.has(id)) return
  titleLoading.add(id)
  void fetchTask(id)
    .then((detail) => {
      rememberTaskTitle(detail.id, detail.title)
    })
    .catch(() => undefined)
    .finally(() => {
      titleLoading.delete(id)
    })
}

export function useTaskTitle(id: string | null): string | undefined {
  return useSyncExternalStore(
    subscribeTitles,
    () => getTaskTitle(id),
    () => getTaskTitle(id),
  )
}

// ---- 待打开队列 ------------------------------------------------------------

let pending: PendingTask[] = readPending()
const pendingListeners = new Set<() => void>()

function readPending(): PendingTask[] {
  const stored = readJson<unknown>(PENDING_KEY, [])
  if (!Array.isArray(stored)) return []
  return stored.filter((entry): entry is PendingTask => {
    if (entry === null || typeof entry !== 'object') return false
    const record = entry as { id?: unknown; title?: unknown }
    return typeof record.id === 'string' && typeof record.title === 'string'
  })
}

function persistPending(): void {
  writeJson(PENDING_KEY, pending)
  for (const listener of pendingListeners) listener()
}

export function getPendingTasks(): PendingTask[] {
  return pending
}

export function subscribePending(listener: () => void): () => void {
  pendingListeners.add(listener)
  return () => {
    pendingListeners.delete(listener)
  }
}

export function usePendingTasks(): PendingTask[] {
  return useSyncExternalStore(subscribePending, getPendingTasks, getPendingTasks)
}

export function removePendingTask(id: string): void {
  const next = pending.filter((entry) => entry.id !== id)
  if (next.length === pending.length) return
  pending = next
  persistPending()
}

function enqueuePending(task: TaskSummary): void {
  if (pending.some((entry) => entry.id === task.id)) return
  pending = [...pending, { id: task.id, title: task.title }]
  persistPending()
}

// ---- 自动打开 --------------------------------------------------------------

interface AutoOpenOptions {
  open(id: string, title: string): void
}

let opened: string[] = readOpened()

function readOpened(): string[] {
  const stored = readJson<unknown>(OPENED_KEY, [])
  return Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === 'string') : []
}

function rememberOpened(id: string): void {
  if (opened.includes(id)) return
  opened = [...opened, id]
  if (opened.length > MAX_REMEMBERED) opened = opened.slice(opened.length - MAX_REMEMBERED)
  writeJson(OPENED_KEY, opened)
}

/**
 * 启动轮询；返回解除器。宿主侧设置通过 {@link getHealth} 即时读取。
 */
export function startAutoOpen(options: AutoOpenOptions): () => void {
  let rev = -1
  let seeded = false
  let ticks = 0
  let stopped = false

  const tick = async (): Promise<void> => {
    if (stopped || document.hidden) return
    ticks += 1
    if (ticks % 10 === 0) void refreshHealth()

    let page: Awaited<ReturnType<typeof fetchEvents>>
    try {
      page = await fetchEvents(rev < 0 ? 0 : rev)
    } catch {
      return
    }
    if (stopped) return

    if (page.reset) {
      rev = page.rev
      seeded = true
      return
    }

    const first = !seeded
    seeded = true
    rev = page.rev
    if (first) return

    const settings = getHealth()?.settings
    if (!(settings?.autoOpenTaskTab ?? DEFAULT_AUTO_OPEN)) return
    const maxTabs = settings?.maxTaskTabs ?? DEFAULT_MAX_TASK_TABS

    for (const task of page.tasks) {
      if (task.origin !== 'model') continue
      if (opened.includes(task.id)) continue
      rememberOpened(task.id)
      rememberTaskTitle(task.id, task.title)
      if (opened.length > maxTabs) {
        enqueuePending(task)
        continue
      }
      options.open(task.id, task.title)
    }
  }

  void tick()
  const timer = setInterval(() => {
    void tick()
  }, POLL_MS)

  return () => {
    stopped = true
    clearInterval(timer)
  }
}
