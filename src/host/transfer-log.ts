import { SearchError } from '../search/errors.js'
import type { DownloadCommand, PdfDownloadResult, ZoteroCommand, ZoteroSyncResult } from '../search/types.js'

type Kind = 'download' | 'zotero'
interface Item {
  status: 'pending' | 'running' | 'done' | 'needsPdf' | 'failed' | 'canceled'
  result?: PdfDownloadResult | ZoteroSyncResult
  error?: string
}

interface Batch {
  kind: Kind
  taskId: string
  sessionId?: string
  roundId: string | null
  items: Map<string, Item>
}

export class TransferLog {
  private readonly batches = new Map<string, Batch>()

  add(kind: Kind, command: DownloadCommand | ZoteroCommand, roundId: string | null): void {
    this.batches.set(command.commandId, {
      kind, taskId: command.taskId, sessionId: command.sessionId, roundId,
      items: new Map(command.paperIds.map((id) => [id, { status: 'pending' }])),
    })
    if (this.batches.size > 75) {
      const oldest = this.batches.keys().next().value
      if (oldest !== undefined) this.batches.delete(oldest)
    }
  }

  details(id: string, sessionId: string | undefined, offset: number, limit: number) {
    const batch = this.get(id, sessionId)
    const items = [...batch.items].map(([paperId, item]) => ({ paperId, ...item }))
    const counts = { pending: 0, running: 0, done: 0, needsPdf: 0, failed: 0, canceled: 0 }
    for (const item of items) counts[item.status] += 1
    const status = counts.running > 0 ? 'running' : counts.pending > 0 ? 'pending' :
      counts.failed > 0 ? 'failed' : counts.canceled > 0 ? 'canceled' : counts.needsPdf > 0 ? 'needsPdf' : 'done'
    return { commandId: id, taskId: batch.taskId, kind: batch.kind, roundId: batch.roundId, status, counts,
      total: items.length, items: items.slice(offset, offset + limit) }
  }

  cancel(id: string, sessionId: string | undefined): void {
    for (const item of this.get(id, sessionId).items.values()) {
      if (item.status === 'pending') item.status = 'canceled'
    }
  }

  async run<T extends PdfDownloadResult | ZoteroSyncResult>(
    id: string | undefined, kind: Kind, taskId: string, sessionId: string | undefined,
    roundId: string | null, paperId: string | undefined, execute: () => Promise<T>,
  ): Promise<T> {
    if (id === undefined) return execute()
    const batch = this.get(id, sessionId)
    const item = paperId === undefined ? undefined : batch.items.get(paperId)
    if (batch.taskId !== taskId || batch.kind !== kind || item === undefined) {
      throw new SearchError('bad_request', '文献不属于这条下载或同步指令')
    }
    if (item.status === 'canceled' || item.status === 'running') {
      throw new SearchError('conflict', '该文献的操作已取消或正在执行')
    }
    if (roundId !== batch.roundId) {
      item.status = 'failed'
      item.error = '轮次已切换，请重新提交下载或同步请求'
      throw new SearchError('conflict', item.error)
    }
    item.status = 'running'
    delete item.error
    delete item.result
    try {
      const result = await execute()
      item.result = result
      if ('status' in result) {
        item.status = result.status === 'downloaded' ? 'done' : 'failed'
      } else if (result.items.some((entry) => entry.transfer?.parent.status === 'done' &&
        entry.transfer.collection === 'done' && entry.transfer.attachment.status === 'pending')) {
        item.status = 'needsPdf'
      } else {
        item.status = result.ok ? 'done' : 'failed'
      }
      return result
    } catch (error) {
      item.status = 'failed'
      item.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  remove(taskId: string): void {
    for (const [id, batch] of this.batches) {
      if (batch.taskId === taskId) this.batches.delete(id)
    }
  }

  private get(id: string, sessionId: string | undefined): Batch {
    const batch = this.batches.get(id)
    if (batch === undefined || batch.sessionId !== sessionId) {
      throw new SearchError('not_found', '当前会话没有这条下载或同步指令')
    }
    return batch
  }
}
