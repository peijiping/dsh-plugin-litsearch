/**
 * 任务内检索轮次的纯逻辑。
 *
 * 这里只依赖类型（type-only import），不引入任何运行时模块，因此单测可以
 * 直接 import 源码，不必先编译出 lib/。轮数上限由调用方从配置注入。
 */

import type {
  SearchRound,
  SearchTask,
  TaskConditions,
  TaskOrigin,
} from '../../search/types.js'

/** 旧版本落盘的任务没有 rounds；所有读取路径统一按空数组兼容。 */
export function roundsOf(task: SearchTask): SearchRound[] {
  return Array.isArray(task.rounds) ? task.rounds : []
}

/**
 * 条件深拷贝。
 *
 * 轮次快照必须使用它：`queries[].perSource`、`types`、`sources` 都是可变引用，
 * 浅拷贝会让历史轮次的条件跟着后续编辑一起变。
 */
export function cloneConditions(conditions: TaskConditions): TaskConditions {
  return {
    ...conditions,
    queries: conditions.queries.map((query) => ({
      ...query,
      ...(query.perSource === undefined ? {} : { perSource: { ...query.perSource } }),
    })),
    sources: [...conditions.sources],
    ...(conditions.types === undefined ? {} : { types: [...conditions.types] }),
  }
}

/** 轮次深拷贝，避免投影对象与内存任务共享条件引用。 */
export function cloneRound(round: SearchRound): SearchRound {
  return {
    ...round,
    conditions: cloneConditions(round.conditions),
    ...(round.stats === undefined
      ? {}
      : { stats: { ...round.stats, perQuery: { ...round.stats.perQuery } } }),
  }
}

/** 只保留最近 max 轮；返回新数组（调用方负责写回）。 */
export function trimRoundList(rounds: SearchRound[], max: number): SearchRound[] {
  return rounds.length <= max ? rounds : rounds.slice(rounds.length - max)
}

/**
 * 开跑前挂一条轮次快照，返回该轮对象供结束时回填。
 *
 * 序号取「上一轮 index + 1」，即使旧轮次被裁剪也不会复用旧号。
 */
export function startRound(
  task: SearchTask,
  origin: TaskOrigin,
  max: number,
  now: string = new Date().toISOString(),
): SearchRound {
  const previous = roundsOf(task)
  const index = previous.length > 0 ? previous[previous.length - 1].index + 1 : 1
  const round: SearchRound = {
    id: `r${index}`,
    index,
    createdAt: now,
    origin,
    conditions: cloneConditions(task.conditions),
  }
  task.rounds = trimRoundList([...previous, round], max)
  return round
}

/** 无论成功 / 取消 / 异常都回填本轮元数据，时间轴不会留下「永远运行中」。 */
export function finishRound(
  round: SearchRound,
  task: SearchTask,
  now: string = new Date().toISOString(),
): void {
  round.finishedAt = now
  round.status = task.status
  round.stats = {
    rawHits: task.stats.rawHits,
    deduped: task.stats.deduped,
    loaded: task.result.papers.length,
    perQuery: { ...task.stats.perQuery },
  }
  round.skippedSources = task.result.sources.filter((source) => source.skipped === true).length
  round.failedSources = task.result.sources.filter(
    (source) => !source.ok && source.skipped !== true,
  ).length
  if (task.error !== undefined) round.error = task.error
}
