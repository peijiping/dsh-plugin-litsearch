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

export class TaskEvents {
  private rev = 0

  private readonly entries = new Map<string, EventEntry>()

  get currentRev(): number {
    return this.rev
  }

  publish(summary: TaskSummary): void {
    this.rev += 1
    this.entries.set(summary.id, { globalRev: this.rev, summary })
  }

  remove(id: string): void {
    this.entries.delete(id)
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
    return { rev: this.rev, reset: false, tasks }
  }
}
