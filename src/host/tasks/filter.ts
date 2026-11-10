/**
 * 结果筛选：`/results` 与 `/stats` 共用同一份口径。
 *
 * 任何新筛选条件都必须先加到这里，避免列表与统计出现两套过滤逻辑。
 */

import type { Paper, Screening, SearchTask, TaskLanguage } from '../../search/types.js'

export interface PaperFilter {
  source?: string
  yearFrom?: number
  yearTo?: number
  openAccessOnly?: boolean
  q?: string
  screening?: Screening
  /** 只保留命中该检索式的论文。 */
  queryId?: string
  /** 文献类型（精确匹配，不分大小写）。 */
  type?: string
  language?: TaskLanguage
  /** 只保留已有 PDF 直链的论文。 */
  hasPdf?: boolean
}

export function filterPapers(task: SearchTask, filter: PaperFilter = {}): Paper[] {
  const needle = filter.q?.trim().toLowerCase() ?? ''
  const type = filter.type?.trim().toLowerCase() ?? ''
  return task.result.papers.filter((paper) => {
    if (filter.source !== undefined && !paper.hitSources.some((hit) => hit.source === filter.source)) {
      return false
    }
    if (filter.yearFrom !== undefined && (paper.year ?? 0) < filter.yearFrom) return false
    if (filter.yearTo !== undefined && (paper.year ?? Number.MAX_SAFE_INTEGER) > filter.yearTo) {
      return false
    }
    if (filter.openAccessOnly === true && !paper.openAccess) return false
    if (filter.queryId !== undefined && !paper.matchedQueries.includes(filter.queryId)) return false
    if (type !== '' && paper.type.toLowerCase() !== type) return false
    if (filter.language !== undefined && !matchesLanguage(paper, filter.language)) return false
    if (filter.hasPdf === true && paper.pdfUrl === '') return false
    if (filter.screening !== undefined && screeningOf(task, paper) !== filter.screening) return false
    if (needle !== '') {
      const haystack = `${paper.title}\n${paper.abstract}`.toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })
}

export function screeningOf(task: SearchTask, paper: Paper): Screening {
  return task.states[paper.paperId]?.screening ?? 'unread'
}

export function matchesLanguage(paper: Paper, language: TaskLanguage): boolean {
  if (language === 'any') return true
  const value = (paper.language ?? '').toLowerCase()
  if (language === 'chi') return value.startsWith('chi') || value.startsWith('zh')
  return value.startsWith('eng') || value.startsWith('en')
}

/** 稳定的筛选指纹（统计缓存 key 的一部分）。 */
export function filterKey(filter: PaperFilter): string {
  return [
    filter.source ?? '',
    filter.yearFrom ?? '',
    filter.yearTo ?? '',
    filter.openAccessOnly === true ? '1' : '',
    filter.q ?? '',
    filter.screening ?? '',
    filter.queryId ?? '',
    filter.type ?? '',
    filter.language ?? '',
    filter.hasPdf === true ? '1' : '',
  ].join('|')
}
