import { matchesIdentifier } from '../../search/lookup.js'
import type { Paper, SearchTask } from '../../search/types.js'
import { countScreening } from './states.js'

export function resultSupplements(task: SearchTask): Paper[] {
  const originals = new Map(task.supplements?.map((paper) => [paper.paperId, paper]))
  return task.result.papers
    .filter((paper) => paper.supplement !== undefined)
    .map((paper) => originals.get(paper.paperId) ?? paper)
}

/** 手工确认的记录独立于轮次保留，显示时覆盖同一篇题录并沿用人工状态。 */
export function applySupplements(
  task: SearchTask,
  papers: readonly Paper[],
  supplements: readonly Paper[] = task.supplements ?? [],
): void {
  let remaining = [...papers]
  const supplemented = supplements.map((entry) => {
    const identifier = entry.supplement
    const same = remaining.filter((paper) =>
      paper.paperId === entry.paperId || (identifier !== undefined && matchesIdentifier(paper, identifier) &&
        (['doi','pmid','pmcid','arxivId'] as const).every(key => !paper.ids[key] || !entry.ids[key] || paper.ids[key] === entry.ids[key])),
    )
    if (same.length > 1) return entry
    remaining = remaining.filter((paper) => !same.includes(paper))
    return {
      ...entry,
      matchedQueries: [...new Set(same.flatMap((paper) => paper.matchedQueries))],
      hitSources: same[0]?.hitSources ?? entry.hitSources,
    }
  })
  task.result.papers = [...supplemented, ...remaining]
  task.stats.supplemented = supplemented.length
  task.stats.screening = countScreening(task.result.papers, task.states)
}


/** 早期版本会给当前已命中的题录贴标；原始补录快照保留了这些命中检索式。 */
export function clearInvalidSupplementOrigins(task: SearchTask): boolean {
  const entries = task.supplements
  if (entries === undefined) return false
  const invalid = new Set(
    entries.filter((paper) => paper.matchedQueries.length > 0).map((paper) => paper.paperId),
  )
  if (invalid.size === 0) return false

  task.supplements = entries.filter((paper) => !invalid.has(paper.paperId))
  for (const paper of task.result.papers) {
    if (invalid.has(paper.paperId)) delete paper.supplement
  }
  task.stats.supplemented = task.supplements.length
  return true
}
