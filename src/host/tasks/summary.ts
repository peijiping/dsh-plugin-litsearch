/**
 * 任务序列化投影：历史列表与事件只传摘要，详情不含结果正文。
 */

import type { SearchTask, TaskDetail, TaskStats, TaskSummary } from '../../search/types.js'

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
    ...(task.progress === undefined ? {} : { progress: { ...task.progress } }),
    ...(task.error === undefined ? {} : { error: task.error }),
  }
}

export function toDetail(task: SearchTask): TaskDetail {
  return {
    ...toSummary(task),
    conditions: cloneConditions(task),
    notes: task.notes,
    groups: task.groups.map((group) => ({ ...group })),
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

function cloneConditions(task: SearchTask): TaskDetail['conditions'] {
  return {
    ...task.conditions,
    queries: task.conditions.queries.map((query) => ({ ...query })),
    sources: [...task.conditions.sources],
  }
}
