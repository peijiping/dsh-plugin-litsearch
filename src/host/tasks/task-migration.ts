import { europePmcTitle } from '../../search/paper-title.js'
import type { PaperRecord, SearchTask } from '../../search/types.js'
import { activeRoundOf, finishRound } from './rounds.js'
import { finalizeSteps } from './steps.js'
import { clearInvalidSupplementOrigins } from './supplements.js'
import { applyRisImports } from './ris-imports.js'

export const TASK_FILE_VERSION = 4
const LEGACY_ABSTRACT_LIMIT = 800

export function readTaskFile(text: string): { version: number; task: SearchTask } {
  const { version = 1, task } = JSON.parse(text) as { version?: number; task?: SearchTask }
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > TASK_FILE_VERSION
  ) {
    throw new Error('任务由不同版本的插件保存')
  }
  if (
    !task ||
    !Array.isArray(task.result?.papers) ||
    !task.stats ||
    typeof task.id !== 'string' ||
    typeof task.updatedAt !== 'string'
  ) {
    throw new Error('缺少必要的任务数据')
  }
  return { version, task }
}

/** 只补齐读取兼容所需字段，保留题录 ID、日期和用户状态。 */
export function migrateTask(task: SearchTask, version: number): void {
  if (!Array.isArray(task.rounds)) task.rounds = []
  task.states ??= {}
  task.groups ??= []
  task.notes ??= ''
  for (const paper of [...task.result.papers, ...(task.supplements ?? [])]) {
    if (
      version === 1 &&
      paper.abstract?.length === LEGACY_ABSTRACT_LIMIT + 1 &&
      paper.abstract.endsWith('…')
    ) {
      paper.abstractCompleteness = 'unknown'
    }
    if (paper.source === 'europepmc') {
      paper.title = europePmcTitle(paper.title) || paper.title
    }
  }
  if (version < 3 && task.result.papers.length) {
    task.legacyPaperIdentities ??= Object.fromEntries(
      task.result.papers.flatMap((paper) => paper.source === undefined ? [] : [[
        paper.paperId,
        {
          source: paper.source,
          sourceId: paper.sourceId,
          title: paper.title,
          ids: { ...paper.ids },
          url: paper.url,
        },
      ]]),
    )
  }
  clearInvalidSupplementOrigins(task)
  applyRisImports(task)
}

export function reportRecord(record: PaperRecord): PaperRecord {
  return record.source === 'europepmc'
    ? { ...record, title: europePmcTitle(record.title) || record.title }
    : record
}

/** 宿主已退出，旧的执行状态由已保存的页推断。 */
export function recoverInterruptedTask(task: SearchTask): boolean {
  if (task.status !== 'running' && task.status !== 'queued') return false
  task.status = 'canceled'
  task.progress = undefined
  task.error = '上次检索中断，已保存的结果可以继续查看'
  task.rev++
  finalizeSteps(task.steps ?? [], 'canceled', task.error)
  const round = activeRoundOf(task)
  if (round) {
    finishRound(round, task)
    for (const run of round.evidence?.runs ?? []) {
      const attempt = run.pages.at(-1)?.attempts.at(-1)
      if (attempt?.outcome !== 'started') continue
      attempt.outcome = 'canceled'
      attempt.endedAt = round.finishedAt
      attempt.detail = task.error
      run.progress.stopReason = 'canceled'
    }
  }
  return true
}
