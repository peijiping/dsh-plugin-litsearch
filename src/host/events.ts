/**
 * 任务变更事件日志。
 *
 * Host→Client 没有原生广播通道，因此这里只维护一份「最近一次状态 + 单调递增
 * 的 globalRev」日志；客户端按 `sinceRev` 轮询拿增量。globalRev 只在宿主进程内
 * 单调递增，重启后归零 —— 客户端发现 `sinceRev` 比服务端大就以 `reset` 重新同步。
 */

import type { EventsPage, TaskSummary } from '../search/types.js'

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
}

export class TaskEvents {
  private rev = 0

  private readonly entries = new Map<string, EventEntry>()

  private focus: FocusEntry | undefined

  get currentRev(): number {
    return this.rev
  }

  publish(summary: TaskSummary): void {
    this.rev += 1
    this.entries.set(summary.id, { globalRev: this.rev, summary })
  }

  /** 请求客户端把某个任务 tab 打开/切到前台（面板关着时重新打开）。 */
  requestFocus(taskId: string, title: string, sessionId?: string): void {
    this.rev += 1
    this.focus = {
      globalRev: this.rev,
      taskId,
      title,
      at: Date.now(),
      ...(sessionId === undefined ? {} : { sessionId }),
    }
  }

  remove(id: string): void {
    this.entries.delete(id)
    if (this.focus?.taskId === id) this.focus = undefined
  }

  since(sinceRev: number): EventsPage {
    if (!Number.isFinite(sinceRev) || sinceRev < 0) {
      return { rev: this.rev, reset: true, tasks: [] }
    }
    if (sinceRev > this.rev) {
      return { rev: this.rev, reset: true, tasks: [] }
    }
    const tasks = [...this.entries.values()]
      .filter((entry) => entry.globalRev > sinceRev)
      .sort((a, b) => a.globalRev - b.globalRev)
      .map((entry) => entry.summary)
    const focus =
      this.focus !== undefined && this.focus.globalRev > sinceRev
        ? {
            taskId: this.focus.taskId,
            title: this.focus.title,
            at: this.focus.at,
            ...(this.focus.sessionId === undefined
              ? {}
              : { sessionId: this.focus.sessionId }),
          }
        : undefined
    return { rev: this.rev, reset: false, tasks, ...(focus === undefined ? {} : { focus }) }
  }
}
