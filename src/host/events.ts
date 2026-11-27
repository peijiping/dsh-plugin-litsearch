/**
 * 任务变更事件日志。
 *
 * Host→Client 没有原生广播通道，因此这里只维护一份「最近一次状态 + 单调递增
 * 的 globalRev」日志；客户端按 `sinceRev` 轮询拿增量。globalRev 只在宿主进程内
 * 单调递增，重启后归零 —— 客户端发现 `sinceRev` 比服务端大就以 `reset` 重新同步。
 */

import type {
  DownloadCommand,
  EventsPage,
  PanelCommand,
  TaskSummary,
  ZoteroCommand,
} from '../search/types.js'

interface EventEntry {
  globalRev: number
  summary: TaskSummary
}

interface FocusEntry {
  globalRev: number
  taskId: string
  title: string
  at: number
  sessionId?: string
  force?: boolean
}

interface DownloadEntry {
  globalRev: number
  command: DownloadCommand
}

interface ZoteroEntry {
  globalRev: number
  command: ZoteroCommand
}

/** 事件日志里最多保留多少条模型指令，避免长时间运行无限增长。 */
const MAX_DOWNLOAD_ENTRIES = 50
const MAX_ZOTERO_ENTRIES = 50

export class TaskEvents {
  private rev = 0

  private readonly entries = new Map<string, EventEntry>()

  private focus: FocusEntry | undefined
  private readonly sessionFocus = new Map<string, FocusEntry>()
  private readonly removedTasks = new Map<string, number>()

  /** 下载指令日志：数组而非单值，两次轮询之间连发多条也不会互相覆盖。 */
  private readonly downloadEntries: DownloadEntry[] = []

  /** Zotero 同步指令日志，与下载并列，互不覆盖。 */
  private readonly zoteroEntries: ZoteroEntry[] = []

  private readonly panelEntries: Array<{ globalRev: number; command: PanelCommand }> = []

  get currentRev(): number {
    return this.rev
  }

  publish(summary: TaskSummary): void {
    this.rev += 1
    this.removedTasks.delete(summary.id)
    this.entries.set(summary.id, { globalRev: this.rev, summary })
  }

  /** 请求客户端把某个任务 tab 打开/切到前台（面板关着时重新打开）。 */
  requestFocus(taskId: string, title: string, sessionId?: string, force?: boolean): void {
    this.rev += 1
    this.focus = {
      globalRev: this.rev,
      taskId,
      title,
      at: Date.now(),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(force === true ? { force: true } : {}),
    }
    if (sessionId !== undefined) {
      this.sessionFocus.delete(sessionId)
      this.sessionFocus.set(sessionId, this.focus)
      if (this.sessionFocus.size > 100) {
        const oldest = this.sessionFocus.keys().next().value
        if (oldest !== undefined) this.sessionFocus.delete(oldest)
      }
    }
  }

  /** 下发一条模型批量下载指令；与 focus 一样推进 globalRev 走增量轮询。 */
  publishDownload(command: DownloadCommand): void {
    this.rev += 1
    this.downloadEntries.push({ globalRev: this.rev, command })
    if (this.downloadEntries.length > MAX_DOWNLOAD_ENTRIES) {
      this.downloadEntries.splice(0, this.downloadEntries.length - MAX_DOWNLOAD_ENTRIES)
    }
  }

  /** 下发一条模型 Zotero 同步指令；与下载指令一样推进 globalRev 走增量轮询。 */
  publishZotero(command: ZoteroCommand): void {
    this.rev += 1
    this.zoteroEntries.push({ globalRev: this.rev, command })
    if (this.zoteroEntries.length > MAX_ZOTERO_ENTRIES) {
      this.zoteroEntries.splice(0, this.zoteroEntries.length - MAX_ZOTERO_ENTRIES)
    }
  }

  publishPanel(command: PanelCommand): void {
    this.panelEntries.push({ globalRev: ++this.rev, command })
    if (this.panelEntries.length > 100) this.panelEntries.shift()
  }

  remove(id: string): void {
    this.entries.delete(id)
    this.removedTasks.set(id, ++this.rev)
    if (this.removedTasks.size > 200) {
      const oldest = this.removedTasks.keys().next().value
      if (oldest !== undefined) this.removedTasks.delete(oldest)
    }
    if (this.focus?.taskId === id) this.focus = undefined
    for (const [sessionId, focus] of this.sessionFocus) {
      if (focus.taskId === id) this.sessionFocus.delete(sessionId)
    }
    for (let index = this.downloadEntries.length - 1; index >= 0; index -= 1) {
      if (this.downloadEntries[index]?.command.taskId === id) this.downloadEntries.splice(index, 1)
    }
    for (let index = this.zoteroEntries.length - 1; index >= 0; index -= 1) {
      if (this.zoteroEntries[index]?.command.taskId === id) this.zoteroEntries.splice(index, 1)
    }
  }

  since(sinceRev: number, sessionId?: string): EventsPage {
    if (!Number.isFinite(sinceRev) || sinceRev < 0) {
      // 宿主重启 / 客户端状态错乱：重新对齐，不重放历史模型指令。
      return { rev: this.rev, reset: true, tasks: [], downloads: [], zotero: [] }
    }
    if (sinceRev > this.rev) {
      return { rev: this.rev, reset: true, tasks: [], downloads: [], zotero: [] }
    }
    const tasks = [...this.entries.values()]
      .filter((entry) => entry.globalRev > sinceRev)
      .sort((a, b) => a.globalRev - b.globalRev)
      .map((entry) => entry.summary)
    const focusEntry = sessionId === undefined ? this.focus :
      this.sessionFocus.get(sessionId) ?? (this.focus?.sessionId === undefined ? this.focus : undefined)
    const focus = focusEntry !== undefined && focusEntry.globalRev > sinceRev
      ? { taskId: focusEntry.taskId, title: focusEntry.title, at: focusEntry.at,
          sessionId: focusEntry.sessionId, force: focusEntry.force }
      : undefined
    const downloads = this.downloadEntries
      .filter((entry) => entry.globalRev > sinceRev)
      .sort((a, b) => a.globalRev - b.globalRev)
      .map((entry) => entry.command)
    const zotero = this.zoteroEntries
      .filter((entry) => entry.globalRev > sinceRev)
      .sort((a, b) => a.globalRev - b.globalRev)
      .map((entry) => entry.command)
    const removedTaskIds = [...this.removedTasks].filter(([, rev]) => rev > sinceRev).map(([id]) => id)
    const panel = this.panelEntries
      .filter(({ command }) => command.sessionId === sessionId)
      .map(({ command }) => command)
    return {
      rev: this.rev,
      reset: false,
      tasks,
      ...(removedTaskIds.length === 0 ? {} : { removedTaskIds }),
      ...(focus === undefined ? {} : { focus }),
      downloads,
      zotero,
      ...(panel.length === 0 ? {} : { panel }),
    }
  }
}
