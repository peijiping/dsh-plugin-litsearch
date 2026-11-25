import { matchesIdentifier } from '../../search/lookup.js'
import type { Paper, SearchTask } from '../../search/types.js'
import { countScreening } from './states.js'

/** 手工确认的记录独立于轮次保留，显示时覆盖同一篇题录并沿用人工状态。 */
export function applySupplements(task: SearchTask, papers: readonly Paper[]): void {
  let remaining = [...papers]
  const supplemented = (task.supplements ?? []).map((entry) => {
    const identifier = entry.supplement
    const same = remaining.filter((paper) =>
      paper.paperId === entry.paperId || (identifier !== undefined && matchesIdentifier(paper, identifier)),
    )
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
