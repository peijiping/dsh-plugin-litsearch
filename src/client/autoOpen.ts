/**
 * 模型任务的自动打开 + 任务标题缓存 + 「待打开」队列。
 *
 * Host→Client 没有广播通道，这里按 `sinceRev` 轮询 `/events`：
 * - 首次轮询只对齐版本号，不把宿主启动前的历史任务全打开；
 * - 模型每次运行任务都会请求 `focus`：直接打开/聚焦该任务 tab（面板关着时
 *   重新打开），不受「一轮只开一个」限制，但仍尊重自动打开开关；
 * - 之后只对 `origin === 'model'` 的新任务调 `openResource`；
 * - 同一轮（2 分钟）最多自动打开 1 个 tab，其余进「待打开」队列，由主面板横幅提示；
 * - `maxTaskTabs` 按「最近真的打开过的 tab」计数（带 30 分钟有效期），不再用
 *   累计历史集合长度，关掉/删掉的任务不会永久占着名额；
 * - 宿主重启（`reset`）时重新对齐，不做任何打开动作。
 */

import { useSyncExternalStore } from 'react'

import { DEFAULT_AUTO_OPEN, DEFAULT_MAX_TASK_TABS } from '../search/config'
import type { TaskSummary } from '../search/types'
import { fetchEvents, fetchTask } from './api'
import { publishDownloadCommands } from './downloadCommandStore'
import { getHealth, refreshHealth } from './health'
import { publishTaskSummaries } from './taskListStore'
import { publishZoteroCommands } from './zoteroCommandStore'

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
  /** 当前屏幕上的会话 id；聚焦请求来自别的对话时不抢占这个面板。 */
  sessionId?: () => string | undefined
}

/** 自动打开过的任务记录：id + 首次处理时间 + 是否真的开过 tab。 */
interface OpenedEntry {
  id: string
  at: number
  tab?: boolean
}

/** 一个 tab 名额的有效期；宿主没有「查询/关闭 tab」的 API，过期自动释放名额。 */
const TAB_WINDOW_MS = 30 * 60_000
/** 同一轮对话窗口：这段时间内最多自动打开 1 个 tab，其余进待打开队列。 */
const ROUND_WINDOW_MS = 2 * 60_000

/** 聚焦请求的有效期：更早的请求可能是上次使用留下的，重新加载页面时不再弹出。 */
const FOCUS_WINDOW_MS = 10 * 60_000

let opened: OpenedEntry[] = readOpened()

function readOpened(): OpenedEntry[] {
  const stored = readJson<unknown>(OPENED_KEY, [])
  if (!Array.isArray(stored)) return []
  const result: OpenedEntry[] = []
  for (const item of stored) {
    // 旧版本存的是 string[]（累计历史）：当成「早就处理过」，不占 tab 名额。
    if (typeof item === 'string') {
      result.push({ id: item, at: 0 })
      continue
    }
    if (item === null || typeof item !== 'object') continue
    const record = item as { id?: unknown; at?: unknown; tab?: unknown }
    if (typeof record.id !== 'string') continue
    result.push({
      id: record.id,
      at: typeof record.at === 'number' ? record.at : 0,
      ...(record.tab === true ? { tab: true } : {}),
    })
  }
  return result
}

/**
 * 记录「已处理过这个模型任务」。
 *
 * `openedTab=false` 表示这次没打开、只进了待打开队列；依然要记下来，否则
 * 下一次事件轮询会反复尝试，窗口一过就突然弹出一排 tab。
 */
function rememberOpened(id: string, openedTab: boolean): void {
  opened = [
    ...opened.filter((entry) => entry.id !== id),
    {
      id,
      at: Date.now(),
      ...(openedTab ? { tab: true } : {}),
    },
  ]
  if (opened.length > MAX_REMEMBERED) opened = opened.slice(opened.length - MAX_REMEMBERED)
  writeJson(OPENED_KEY, opened)
}

/** 当前仍占着名额的 tab 数（只数真的打开过、且未过期的记录）。 */
function activeTabCount(): number {
  const cutoff = Date.now() - TAB_WINDOW_MS
  return opened.filter((entry) => entry.tab === true && entry.at >= cutoff).length
}

function isFreshFocus(focus: { at: number }): boolean {
  return Date.now() - focus.at <= FOCUS_WINDOW_MS
}

function lastAutoOpenAt(): number {
  const cutoff = Date.now() - TAB_WINDOW_MS
  let last = 0
  for (const entry of opened) {
    if (entry.tab === true && entry.at >= cutoff && entry.at > last) last = entry.at
  }
  return last
}

/**
 * 任务被删除后清掉本地缓存：否则它会一直占着自动打开的计数、留在待打开
 * 队列里，标题缓存也会显示一个已经不存在的任务名。
 */
export function forgetTask(id: string): void {
  if (opened.some((entry) => entry.id === id)) {
    opened = opened.filter((entry) => entry.id !== id)
    writeJson(OPENED_KEY, opened)
  }
  removePendingTask(id)
  if (titles[id] !== undefined) {
    delete titles[id]
    writeJson(TITLES_KEY, titles)
    for (const listener of titleListeners) listener()
  }
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

    // 已挂载的任务 tab 靠这份增量同步宿主侧的变化（例如模型在同一任务里开新一轮）。
    publishTaskSummaries(page.tasks)

    // 模型下载指令总是入队，不受「自动打开开关 / 首次轮询」影响：tab 可能还没
    // 挂载，指令在 store 里等工具同时发出的 focus 把 tab 拉起后再被消费。
    publishDownloadCommands(page.downloads, options.sessionId?.())
    // Zotero 同步指令与下载并列入队：两条链路各自消费，互不覆盖。
    publishZoteroCommands(page.zotero, options.sessionId?.())

    const settings = getHealth()?.settings
    const autoOpen = settings?.autoOpenTaskTab ?? DEFAULT_AUTO_OPEN
    // 聚焦请求优先处理，且不因「首次轮询」而丢弃：页面在后台时轮询会暂停，
    // 回到前台后的第一次轮询不能把刚发生的检索当成历史。
    if (autoOpen && page.focus !== undefined && isFreshFocus(page.focus)) {
      const screen = options.sessionId?.()
      const target = page.focus.sessionId
      // 只处理当前屏幕这个对话的聚焦；别的对话的检索不抢占这里的面板。
      if (target === undefined || (screen !== undefined && target === screen)) {
        alsoFocus(page.focus.taskId, page.focus.title)
      } else {
        rememberOpened(page.focus.taskId, false)
      }
    }
    if (first || !autoOpen) return
    const maxTabs = settings?.maxTaskTabs ?? DEFAULT_MAX_TASK_TABS

    for (const task of page.tasks) {
      if (task.origin !== 'model') continue
      // opened 是「已处理」集合，只用来去重，绝不再拿累计长度当当前 tab 数。
      if (opened.some((entry) => entry.id === task.id)) continue
      rememberTaskTitle(task.id, task.title)

      const tooManyTabs = activeTabCount() >= maxTabs
      const sameRound = Date.now() - lastAutoOpenAt() < ROUND_WINDOW_MS
      if (tooManyTabs || sameRound) {
        // 兜底：模型万一没复用任务，一轮也只弹一个 tab，其余交给用户从横幅打开。
        rememberOpened(task.id, false)
        enqueuePending(task)
        continue
      }
      rememberOpened(task.id, true)
      options.open(task.id, task.title)
    }
  }

  const alsoFocus = (id: string, title: string): void => {
    rememberTaskTitle(id, title)
    rememberOpened(id, true)
    options.open(id, title)
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
