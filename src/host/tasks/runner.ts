/**
 * 任务执行器。
 *
 * 多检索式按「先 query 后 source」串行扇出（每条式内部并发各源），每完成一条
 * 式就自增 rev 并持久化，客户端据此显示 i/N 进度。取消通过 AbortSignal 透传到
 * 每个上游请求；已拿到的结果保留，状态标 `canceled`。
 */

import { MAX_LIMIT, getSettings } from '../../search/config.js'
import { searchSources } from '../../search/aggregate.js'
import { mergeHits, type RankedHit } from '../../search/identity.js'
import type {
  PaperRecord,
  SearchTask,
  SourceId,
  SourceStatus,
  TaskConditions,
  TaskLanguage,
} from '../../search/types.js'
import { countScreening, pruneStates } from './states.js'

export interface RunnerHooks {
  persist(task: SearchTask): Promise<void>
  publish(task: SearchTask): void
}

class RunCanceled extends Error {
  constructor() {
    super('检索已取消')
    this.name = 'RunCanceled'
  }
}

export class TaskRunner {
  private readonly controllers = new Map<string, AbortController>()

  isRunning(id: string): boolean {
    return this.controllers.has(id)
  }

  /** 中止运行；返回是否确实有任务在跑。 */
  cancel(id: string): boolean {
    const controller = this.controllers.get(id)
    if (controller === undefined) return false
    controller.abort()
    return true
  }

  cancelAll(): void {
    for (const controller of this.controllers.values()) controller.abort()
  }

  /** 启动一次执行；controller 同步登记，因此调用方返回时 `isRunning` 已为 true。 */
  start(task: SearchTask, hooks: RunnerHooks): Promise<void> {
    const controller = new AbortController()
    this.controllers.set(task.id, controller)
    return this.execute(task, hooks, controller).finally(() => {
      this.controllers.delete(task.id)
    })
  }

  private async execute(
    task: SearchTask,
    hooks: RunnerHooks,
    controller: AbortController,
  ): Promise<void> {
    const queries = task.conditions.queries.filter(
      (query) => query.enabled && query.text.trim() !== '',
    )
    if (queries.length === 0) throw new Error('没有启用的检索式')

    task.status = 'running'
    task.error = undefined
    task.result.papers = []
    task.result.sources = []
    task.result.fetchedAt = undefined
    task.stats = {
      perQuery: {},
      rawHits: 0,
      deduped: 0,
      screening: { unread: 0, read: 0, included: 0, excluded: 0 },
    }
    task.progress = { queryIndex: 0, queryTotal: queries.length }
    touch(task, hooks)
    await hooks.persist(task)

    const hits: RankedHit[] = []
    const statusById = new Map<SourceId, SourceStatus>()
    const perSourceLimit = clampRequestLimit(task.conditions.pageSize)

    try {
      for (const [index, query] of queries.entries()) {
        task.progress = { queryIndex: index + 1, queryTotal: queries.length }
        touch(task, hooks)
        await hooks.persist(task)

        const results = await searchSources({
          query: query.text,
          perSource: query.perSource,
          sources: task.conditions.sources,
          limit: perSourceLimit,
          yearFrom: task.conditions.yearFrom,
          yearTo: task.conditions.yearTo,
          openAccessOnly: task.conditions.openAccessOnly,
          contactEmail: '',
          timeoutMs: 0,
          signal: controller.signal,
        })
        if (controller.signal.aborted) throw new RunCanceled()

        for (const result of results) {
          const records = result.records.filter((record) =>
            matchesConditions(record, task.conditions),
          )
          const status = statusById.get(result.source) ?? {
            id: result.source,
            ok: true,
            count: 0,
          }
          if (records.length < result.records.length) status.filtered = true
          status.count += records.length
          if (!result.ok) {
            status.ok = false
            status.error = result.error
          }
          statusById.set(result.source, status)

          task.stats.perQuery[query.id] =
            (task.stats.perQuery[query.id] ?? 0) + records.length
          records.forEach((record, position) => {
            hits.push({
              record,
              source: result.source,
              rank: position + 1,
              queryId: query.id,
            })
          })
        }
      }

      const merged = mergeHits(hits)
      const papers = merged
        .filter((paper) => matchesConditions(paper, task.conditions))
        .slice(0, getSettings().taskMaxPapers)

      task.result.papers = papers
      task.result.sources = [...statusById.values()]
      task.result.fetchedAt = new Date().toISOString()
      task.states = pruneStates(task.states, papers)
      task.stats.rawHits = hits.length
      task.stats.deduped = merged.length
      task.stats.screening = countScreening(papers, task.states)

      const failed = task.result.sources.filter((source) => !source.ok)
      const succeeded = task.result.sources.filter((source) => source.ok)
      task.status = succeeded.length === 0 && failed.length > 0 ? 'error' : failed.length > 0 ? 'partial' : 'done'
      task.progress = undefined
    } catch (error) {
      if (controller.signal.aborted || error instanceof RunCanceled) {
        task.status = 'canceled'
        task.error = '检索已取消'
      } else {
        task.status = 'error'
        task.error = error instanceof Error ? error.message : String(error)
      }
      task.result.sources = [...statusById.values()]
      task.stats.screening = countScreening(task.result.papers, task.states)
      task.progress = undefined
    } finally {
      touch(task, hooks)
      await hooks.persist(task)
    }
  }
}

function touch(task: SearchTask, hooks: RunnerHooks): void {
  task.rev += 1
  task.updatedAt = new Date().toISOString()
  hooks.publish(task)
}

/** 每个源多取一些给跨源/跨式去重留余量，但不放大到打爆上游。 */
function clampRequestLimit(pageSize: number): number {
  const base = Number.isFinite(pageSize) ? pageSize : 20
  return Math.min(Math.max(Math.floor(base) * 2, 10), MAX_LIMIT)
}

function matchesConditions(
  paper: PaperRecord,
  conditions: TaskConditions,
): boolean {
  if (conditions.yearFrom !== undefined && (paper.year ?? 0) < conditions.yearFrom) return false
  if (
    conditions.yearTo !== undefined &&
    (paper.year ?? Number.MAX_SAFE_INTEGER) > conditions.yearTo
  ) {
    return false
  }
  if (conditions.openAccessOnly && !paper.openAccess) return false
  if (!matchesLanguage(paper, conditions.language)) return false
  if (conditions.types !== undefined && conditions.types.length > 0) {
    const type = paper.type.toLowerCase()
    if (!conditions.types.some((wanted) => wanted.toLowerCase() === type)) return false
  }
  return true
}

function matchesLanguage(paper: PaperRecord, language: TaskLanguage): boolean {
  if (language === 'any') return true
  const value = (paper.language ?? '').toLowerCase()
  if (language === 'chi') return value.startsWith('chi') || value.startsWith('zh')
  return value.startsWith('eng') || value.startsWith('en')
}
