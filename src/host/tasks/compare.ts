/**
 * 任务对比：按稳定的 `paperId` 做差分，标出新增 / 共有 / 缺失。
 *
 * 对比只读两份已加载结果，不触发重新检索；新增结果可回到结果页用 `new=1`
 * 筛选，或由模型/面板批量写入筛读状态。
 */

import type { ComparePaper, CompareResult, Paper, SearchTask } from '../../search/types.js'

export function compareTasks(task: SearchTask, base: SearchTask): CompareResult {
  const currentIds = new Set(task.result.papers.map((paper) => paper.paperId))
  const baseIds = new Set(base.result.papers.map((paper) => paper.paperId))

  let common = 0
  const added: ComparePaper[] = []
  const missing: ComparePaper[] = []
  for (const paper of task.result.papers) {
    if (baseIds.has(paper.paperId)) common += 1
    else added.push(toComparePaper(paper))
  }
  for (const paper of base.result.papers) {
    if (!currentIds.has(paper.paperId)) missing.push(toComparePaper(paper))
  }

  return {
    taskId: task.id,
    rev: task.rev,
    withTaskId: base.id,
    withTitle: base.title,
    counts: {
      added: added.length,
      common,
      missing: missing.length,
      total: task.result.papers.length,
      baseTotal: base.result.papers.length,
    },
    added,
    missing,
  }
}

function toComparePaper(paper: Paper): ComparePaper {
  return {
    paperId: paper.paperId,
    title: paper.title,
    authors: paper.authors.slice(0, 6),
    year: paper.year,
    venue: paper.venue,
    doi: paper.doi,
    openAccess: paper.openAccess,
  }
}
