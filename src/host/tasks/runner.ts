import { DEFAULT_TASK_MAX_ROUNDS } from '../../search/config.js'
import { SearchError } from '../../search/errors.js'
import { cooldownUntil } from '../../search/health.js'
import { SourceSkipped } from '../../search/rate-limit.js'
import { requestTrace } from '../../search/request-trace.js'
import type { Attempt, ProviderPage, SourceRun } from '../../search/evidence.js'
import type { SearchRound, SearchTask, TaskOrigin, TaskStatus } from '../../search/types.js'
import { acceptPage, fetchPage, newEvidence, sameConditions } from './page-evidence.js'
import { rebuildRound } from './paper-groups.js'
import { finishRound, startRound } from './rounds.js'
import { buildSteps, finalizeSteps } from './steps.js'

export interface RunnerHooks {
  checkpoint(task: SearchTask, change: (draft: SearchTask) => void): Promise<void>
  publish(task: SearchTask): void
}
export interface PageTarget {
  roundId: string
  source: string
  queryId: string
  pageNo: number
}

function findRun(round: SearchRound, target: Pick<PageTarget, 'queryId' | 'source'>): SourceRun {
  const run = round.evidence?.runs.find((r) => r.queryId === target.queryId && r.source === target.source)
  if (!run) throw new SearchError('not_found', '没有找到该检索块的来源记录')
  return run
}

export function checkResume(task: SearchTask, target: PageTarget): void {
  const round = task.rounds.at(-1)
  if (!round?.evidence || round.id !== target.roundId || !sameConditions(round, task)) {
    throw new SearchError('conflict', '轮次或检索条件已变更，请按当前条件开新轮')
  }
  const run = findRun(round, target)
  if (
    run.progress.lastCommittedPage + 1 !== target.pageNo ||
    !['ready', 'rateLimited', 'canceled', 'error', 'timeout'].includes(run.progress.stopReason)
  ) {
    throw new SearchError('conflict', '该页进度已改变或来源不能继续，请刷新执行明细')
  }
  if (run.progress.retryAfter && Date.parse(run.progress.retryAfter) > Date.now()) {
    throw new SearchError('conflict', '来源仍在限流冷却中，请稍后重试')
  }
}

function statusOf(runs: SourceRun[]): TaskStatus {
  const failed = runs.filter((r) =>
    ['error', 'cursorExpired', 'timeout', 'duplicatePage'].includes(r.progress.stopReason),
  )
  if (
    failed.length &&
    runs.every((r) => r.progress.lastCommittedPage === 0) &&
    runs.every((r) => failed.includes(r) || r.progress.stopReason === 'rateLimited')
  )
    return 'error'
  if (
    failed.length ||
    runs.every((r) => r.progress.stopReason === 'rateLimited') ||
    runs.some((r) => r.progress.stopReason === 'canceled' || !r.pages.length)
  )
    return 'partial'
  return 'done'
}

export class TaskRunner {
  private readonly controllers = new Map<string, AbortController>()
  private readonly running = new Map<string, Promise<void>>()
  isRunning(id: string): boolean {
    return this.controllers.has(id)
  }
  wait(id: string): Promise<void> {
    return this.running.get(id) ?? Promise.resolve()
  }
  cancel(id: string): boolean {
    const controller = this.controllers.get(id)
    controller?.abort()
    return !!controller
  }
  cancelAll(): void {
    for (const controller of this.controllers.values()) controller.abort()
  }

  start(task: SearchTask, hooks: RunnerHooks, origin: TaskOrigin, target?: PageTarget): Promise<void> {
    if (this.isRunning(task.id)) throw new SearchError('conflict', '任务正在运行')
    if (target) checkResume(task, target)
    const controller = new AbortController()
    this.controllers.set(task.id, controller)
    const done = this.execute(task, hooks, origin, controller.signal, target).finally(() => {
      this.controllers.delete(task.id)
      this.running.delete(task.id)
    })
    this.running.set(task.id, done)
    return done
  }

  private async execute(
    task: SearchTask,
    hooks: RunnerHooks,
    origin: TaskOrigin,
    signal: AbortSignal,
    target?: PageTarget,
  ): Promise<void> {
    const commit = async (change: (draft: SearchTask) => void): Promise<void> => {
      await hooks.checkpoint(task, change)
      hooks.publish(task)
    }
    await commit((draft) => {
      let round = draft.rounds.at(-1)
      if (!target) {
        round = startRound(draft, origin, DEFAULT_TASK_MAX_ROUNDS)
        round.evidence = newEvidence(round.conditions)
        const queries = round.conditions.queries.filter((q) => q.enabled && q.text.trim())
        const sources = [...new Set(round.evidence.runs.map((r) => r.source))]
        draft.steps = buildSteps(queries, sources)
        // 删除已淘汰轮次独占的题录快照。
        const retained = new Set(
          draft.rounds.flatMap(
            (r) =>
              r.evidence?.runs.flatMap((run) =>
                run.pages.flatMap(
                  (p) => p.committed?.hits.flatMap((h) => (h.status === 'invalid' ? [] : [h.recordId])) ?? [],
                ),
              ) ?? [],
          ),
        )
        draft.records = Object.fromEntries(
          Object.entries(draft.records ?? {}).filter(([id]) => retained.has(id)),
        )
        draft.paperAliases ??= []
        draft.result.fetchedAt = undefined
        rebuildRound(draft, round)
      }
      if (!round?.evidence) throw new SearchError('conflict', '缺少本轮执行明细')
      round.finishedAt = undefined
      round.status = undefined
      round.error = undefined
      draft.error = undefined
      draft.status = 'running'
      draft.progress = { queryIndex: 0, queryTotal: new Set(round.evidence.runs.map((r) => r.queryId)).size }
    })
    const latest = () => task.rounds.at(-1)!
    const queryIds = [...new Set(latest().evidence!.runs.map((r) => r.queryId))]
    try {
      for (const [index, queryId] of queryIds.entries()) {
        if (signal.aborted) break
        if (target && target.queryId !== queryId) continue
        const pending = latest().evidence!.runs.filter(
          (r) => r.queryId === queryId && (!target || r.source === target.source),
        )
        const queryStep = 'q' + (index + 1)
        await commit((draft) => {
          const round = draft.rounds.at(-1)!
          draft.progress = { queryIndex: index + 1, queryTotal: queryIds.length }
          const group = draft.steps?.find((s) => s.id === queryStep)
          if (group) group.status = 'running'
          for (const source of pending) {
            const run = findRun(round, source)
            const pageNo = run.progress.lastCommittedPage + 1
            const page = run.pages.find((p) => p.pageNo === pageNo) ?? {
              pageNo,
              input: run.progress.next,
              attempts: [],
            }
            if (!run.pages.includes(page)) run.pages.push(page)
            page.attempts.push({ startedAt: new Date().toISOString(), outcome: 'started', requests: [] })
            const step = draft.steps?.find((s) => s.id === queryStep + ':' + source.source)
            if (step)
              Object.assign(step, { status: 'running', requestedLimit: run.pageSize, error: undefined })
          }
        })
        const outcomes = await Promise.allSettled(
          pending.map(async (descriptor) => {
            const run = findRun(latest(), descriptor)
            const input = run.pages.at(-1)!.input
            let result: ProviderPage | undefined
            let failure: Attempt['outcome'] = 'error'
            let detail: string | undefined
            let retryAfter: string | undefined
            try {
              result = await requestTrace.run(
                async (request) => {
                  await commit((draft) => {
                    findRun(draft.rounds.at(-1)!, descriptor)
                      .pages.at(-1)!
                      .attempts.at(-1)!
                      .requests.push(request)
                  })
                },
                () => fetchPage(run, latest().conditions, input, signal),
              )
            } catch (error) {
              if (signal.aborted) failure = 'canceled'
              else if (error instanceof SourceSkipped) {
                failure = 'rateLimited'
                const until = cooldownUntil(run.source)
                if (until > 0) retryAfter = new Date(until).toISOString()
              } else if (error instanceof SearchError && error.code === 'timeout') failure = 'timeout'
              else if (input && error instanceof SearchError && [400, 410].includes(error.status ?? 0))
                failure = 'cursorExpired'
              detail =
                error instanceof SearchError || error instanceof SourceSkipped
                  ? error.message
                  : '来源请求未成功'
            }
            await commit((draft) => {
              const round = draft.rounds.at(-1)!
              const live = findRun(round, descriptor)
              const page = live.pages.at(-1)!
              const attempt = page.attempts.at(-1)!
              attempt.endedAt = new Date().toISOString()
              if (result) acceptPage(draft, round, live, page, attempt, result)
              else {
                Object.assign(attempt, { outcome: failure, detail, retryAfter })
                Object.assign(live.progress, { stopReason: failure, retryAfter })
              }
              rebuildRound(draft, round)
              if (page.committed) draft.result.fetchedAt = attempt.endedAt
              const step = draft.steps?.find((s) => s.id === queryStep + ':' + descriptor.source)
              const success = attempt.outcome === 'committed'
              if (step)
                Object.assign(step, {
                  status: success
                    ? 'done'
                    : ['rateLimited', 'canceled'].includes(attempt.outcome)
                      ? 'skipped'
                      : 'failed',
                  error: success ? undefined : (detail ?? attempt.outcome),
                  count: live.pages.reduce((n, p) => n + (p.committed?.kept ?? 0), 0),
                  received: live.pages.reduce((n, p) => n + (p.committed?.observedEntries ?? 0), 0),
                  hasMore: live.capability === 'pageable' && success ? !!live.progress.next : undefined,
                })
              const group = draft.steps?.find((s) => s.id === queryStep)
              if (group) group.count = draft.stats.perQuery[queryId] ?? 0
            })
          }),
        )
        const failed = outcomes.find((outcome) => outcome.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
        await commit((draft) => {
          const group = draft.steps?.find((s) => s.id === queryStep)
          if (group) group.status = 'done'
        })
      }
    } finally {
      await commit((draft) => {
        const round = draft.rounds.at(-1)!
        const evidence = round.evidence!
        for (const run of evidence.runs) {
          if (signal.aborted && !run.pages.length) run.progress.stopReason = 'canceled'
          if (
            run.progress.stopReason === 'ready' &&
            run.progress.next &&
            evidence.counts.savedFromSearch >= evidence.taskMaxPapers
          ) {
            run.progress.stopReason = 'taskLimit'
          }
          const attempt = run.pages.at(-1)?.attempts.at(-1)
          if (attempt?.outcome === 'started') {
            attempt.outcome = 'error'
            attempt.detail = '本页未能保存，请重试'
            run.progress.stopReason = 'error'
          }
        }
        draft.status = signal.aborted ? 'canceled' : statusOf(evidence.runs)
        draft.error = signal.aborted ? '检索已取消' : undefined
        draft.progress = undefined
        const dedup = draft.steps?.find((s) => s.id === 'dedup')
        if (dedup) Object.assign(dedup, { status: 'done', count: evidence.counts.merged })
        finalizeSteps(draft.steps ?? [], draft.status, draft.error)
        rebuildRound(draft, round)
        finishRound(round, draft)
      })
    }
  }
}
