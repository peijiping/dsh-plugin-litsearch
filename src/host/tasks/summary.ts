/**
 * 任务序列化投影：历史列表与事件只传摘要，详情不含结果正文。
 */

import { DEFAULT_TASK_MAX_ROUNDS } from '../../search/config.js'
import type { SearchRound, SearchTask, TaskStats, TaskSummary, TaskDetail } from '../../search/types.js'
import { cloneConditions, cloneRound, roundsOf, trimRoundList } from './rounds.js'

export { cloneConditions, cloneRound, roundsOf } from './rounds.js'

/** 按插件配置裁剪轮次（纯逻辑在 rounds.ts，上限在这里注入）。 */
export function trimRounds(rounds: SearchRound[]): SearchRound[] {
  return trimRoundList(rounds, DEFAULT_TASK_MAX_ROUNDS)
}

export function toSummary(task: SearchTask): TaskSummary {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    origin: task.origin,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    rev: task.rev,
    pinned: task.pinned,
    stats: cloneStats(task.stats),
    roundCount: roundsOf(task).length,
    ...(task.progress === undefined ? {} : { progress: { ...task.progress } }),
    ...(task.error === undefined ? {} : { error: task.error }),
  }
}

export function toDetail(task: SearchTask): TaskDetail {
  const states: TaskDetail['states'] = {}
  for (const [paperId, state] of Object.entries(task.states)) {
    states[paperId] = { ...state, ...(state.tags === undefined ? {} : { tags: [...state.tags] }) }
  }
  return {
    ...toSummary(task),
    conditions: cloneConditions(task.conditions),
    notes: task.notes,
    groups: task.groups.map((group) => ({ ...group })),
    rounds: roundsOf(task).map(cloneRound),
    states,
    ...(task.fromTaskId === undefined ? {} : { fromTaskId: task.fromTaskId }),
    result: {
      totalLoaded: task.result.papers.length,
      sources: task.result.sources.map((source) => ({ ...source })),
      ...(task.result.fetchedAt === undefined ? {} : { fetchedAt: task.result.fetchedAt }),
    },
  }
}

function cloneStats(stats: TaskStats): TaskSummary['stats'] {
  return {
    perQuery: { ...stats.perQuery },
    rawHits: stats.rawHits,
    deduped: stats.deduped,
    screening: { ...stats.screening },
  }
}
