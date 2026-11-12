/**
 * 任务执行器。
 *
 * 多检索式按「先 query 后 source」串行扇出（每条式内部并发各源），每完成一条
 * 式就自增 rev 并持久化，客户端据此显示 i/N 进度。取消通过 AbortSignal 透传到
 * 每个上游请求；已拿到的结果保留，状态标 `canceled`。
 */

import { DEFAULT_TASK_MAX_ROUNDS, MAX_LIMIT, getSettings } from '../../search/config.js'
import { searchSources } from '../../search/aggregate.js'
import { mergeHits, type RankedHit } from '../../search/identity.js'
import type {
  PaperRecord,
  SearchTask,
  SourceId,
  SourceStatus,
  TaskConditions,
  TaskOrigin,
} from '../../search/types.js'
import { matchesLanguage } from './filter.js'
import { finishRound, startRound } from './rounds.js'
import { countScreening } from './states.js'

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

  /** 正在执行的那一轮的完成 Promise，供「等待上一轮结束」使用。 */
  private readonly running = new Map<string, Promise<void>>()

  isRunning(id: string): boolean {
    return this.controllers.has(id)
  }

  /** 返回当前这一轮的完成 Promise；空闲时立即 resolve。 */
  wait(id: string): Promise<void> {
    return this.running.get(id) ?? Promise.resolve()
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

  /**
   * 启动一次执行（= 任务内新开一轮）；controller 同步登记，因此调用方返回时
   * `isRunning` 已为 true。`origin` 记录这一轮是谁发起的，用于历史时间轴。
   */
  start(task: SearchTask, hooks: RunnerHooks, origin: TaskOrigin = task.origin): Promise<void> {
    const controller = new AbortController()
    this.controllers.set(task.id, controller)
    const done = this.execute(task, hooks, controller, origin).finally(() => {
      this.controllers.delete(task.id)
      this.running.delete(task.id)
    })
    this.running.set(task.id, done)
    return done
  }

  private async execute(
    task: SearchTask,
    hooks: RunnerHooks,
    controller: AbortController,
    origin: TaskOrigin,
  ): Promise<void> {
    const queries = task.conditions.queries.filter(
      (query) => query.enabled && query.text.trim() !== '',
    )
    if (queries.length === 0) throw new Error('没有启用的检索式')

    // 开跑前先落一条轮次快照：条件是深拷贝，之后改条件不会影响历史。
    const round = startRound(task, origin, DEFAULT_TASK_MAX_ROUNDS)

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
          if (result.skipped === true) {
            // 限流跳过不是故障：不标 failed、不进 partial，只留中性说明。
            status.skipped = true
            status.note = result.error
          } else if (!result.ok) {
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
      task.stats.rawHits = hits.length
      task.stats.deduped = merged.length
      task.stats.screening = countScreening(papers, task.states)

      const failed = task.result.sources.filter((source) => !source.ok && !source.skipped)
      const succeeded = task.result.sources.filter((source) => source.ok && !source.skipped)
      const skipped = task.result.sources.filter((source) => source.skipped)
      // 全被限流跳过且结果为空时仍标 partial 提示重跑，但不显示任何红色失败。
      task.status =
        succeeded.length === 0 && failed.length > 0
          ? 'error'
          : failed.length > 0 || (succeeded.length === 0 && skipped.length > 0)
            ? 'partial'
            : 'done'
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
      // 无论成功 / 取消 / 异常都回填本轮元数据，时间轴不会留下「永远运行中」的轮次。
      finishRound(round, task)
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
