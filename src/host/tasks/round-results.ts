import { isDeepStrictEqual } from 'node:util'

import { DEFAULT_TASK_MAX_ROUNDS } from '../../search/config.js'
import { SearchError } from '../../search/errors.js'
import type { SearchRound, SearchTask } from '../../search/types.js'
import { readRoundSearchResults } from './paper-groups.js'
import { activeRoundOf, cloneConditions, roundStats, startRound } from './rounds.js'
import { countScreening } from './states.js'
import { applySupplements } from './supplements.js'

export function archiveRoundResults(task: SearchTask): void {
  const round = activeRoundOf(task)
  if (!round) return
  const { papers, sources, fetchedAt } = task.result
  const fromEvidence = readRoundSearchResults(task, round).papers
  round.resultSnapshot = {
    paperIds: papers.map((paper) => paper.paperId),
    papers: papers.filter((paper) => !isDeepStrictEqual(fromEvidence.get(paper.paperId), paper)),
    sources,
    fetchedAt,
    steps: task.steps,
  }
  round.stats = roundStats(task)
}

export function createDraftRound(task: SearchTask, source: SearchRound): void {
  archiveRoundResults(task)
  task.conditions = cloneConditions(source.conditions)
  task.status = 'draft'
  task.error = undefined
  task.progress = undefined
  task.steps = undefined
  task.result = { papers: [], sources: [] }
  task.stats = {
    rawHits: 0,
    deduped: 0,
    perQuery: {},
    screening: countScreening(task.result.papers, task.states),
  }
  const round = startRound(task, 'panel', DEFAULT_TASK_MAX_ROUNDS)
  round.status = 'draft'
  round.stats = roundStats(task)
}

export function selectRoundResults(task: SearchTask, round: SearchRound): void {
  const snapshot = round.resultSnapshot
  const { papers, sources, perQuery } = readRoundSearchResults(task, round)
  for (const paper of snapshot?.papers ?? []) papers.set(paper.paperId, paper)
  const paperIds = snapshot?.paperIds ?? round.evidence?.savedPaperIds ?? []
  const restored = paperIds.map((id) => {
    const paper = papers.get(id)
    if (!paper) throw new SearchError('conflict', '本轮的题录快照不完整，无法切换查询结果')
    return paper
  })

  archiveRoundResults(task)
  task.activeRoundId = round.id
  task.conditions = cloneConditions(round.conditions)
  task.status = round.status ?? 'done'
  task.error = round.error
  task.progress = undefined
  task.steps = snapshot?.steps
  task.result = {
    papers: restored,
    sources: snapshot?.sources ?? sources,
    fetchedAt: snapshot ? snapshot.fetchedAt : round.finishedAt,
  }
  const hits = round.stats?.perQuery ?? perQuery
  task.stats = {
    perQuery: { ...hits },
    rawHits: round.stats?.rawHits ?? Object.values(hits).reduce((sum, count) => sum + count, 0),
    deduped: round.stats?.deduped ?? round.evidence?.counts.merged ?? 0,
    supplemented: restored.filter((paper) => paper.supplement !== undefined).length,
    screening: countScreening(restored, task.states),
  }
  if (!snapshot && round.evidence) {
    // 旧版逐页快照单独保存了在线结果，补录按进入下一轮前的时间范围恢复。
    const nextRound = task.rounds.find((entry) => entry.index > round.index)
    const cutoff = nextRound?.createdAt ?? round.finishedAt
    const supplements = (task.supplements ?? []).filter(
      (paper) => paper.supplement !== undefined && cutoff !== undefined && paper.supplement.addedAt <= cutoff,
    )
    applySupplements(task, restored, supplements)
  }
  round.resultSnapshot = undefined
}
