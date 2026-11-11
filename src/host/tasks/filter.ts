/**
 * 结果筛选：`/results` 与 `/stats` 共用同一份口径。
 *
 * 任何新筛选条件都必须先加到这里，避免列表与统计出现两套过滤逻辑。
 */

import type {
  Paper,
  PdfStatus,
  Screening,
  SearchTask,
  TaskLanguage,
} from '../../search/types.js'

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
  /** 只保留已有 PDF 直链或已下载的论文。 */
  hasPdf?: boolean
  /** 只保留尚无可用全文（PDF 或 EPMC HTML）的论文。 */
  missingFullText?: boolean
  /** 只保留有效全文状态恰为该值的论文（与覆盖率的 pdfStatusOf 同一口径）。 */
  pdfStatus?: PdfStatus
  /** 只保留归入该分组的论文。 */
  groupId?: string
  /** 期刊/出处（精确匹配，不分大小写）。 */
  venue?: string
  /** 作者（仅匹配 authors 中的完整姓名，不分大小写）。 */
  author?: string
  /** 只保留相对 `fromTaskId` 新增的论文。 */
  newOnly?: boolean
  /** 由服务层按基准任务解析出的新增集合；不参与指纹。 */
  newPaperIds?: ReadonlySet<string>
}

export function filterPapers(task: SearchTask, filter: PaperFilter = {}): Paper[] {
  const needle = filter.q?.trim().toLowerCase() ?? ''
  const type = filter.type?.trim().toLowerCase() ?? ''
  const venue = filter.venue?.trim().toLowerCase() ?? ''
  const author = filter.author?.trim().toLowerCase() ?? ''
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
    if (venue !== '' && paper.venue.trim().toLowerCase() !== venue) return false
    if (author !== '' && !paper.authors.some((name) => name.trim().toLowerCase() === author)) {
      return false
    }
    if (filter.language !== undefined && !matchesLanguage(paper, filter.language)) return false
    if (filter.hasPdf === true && pdfStatusOf(task, paper) !== 'downloaded' && paper.pdfUrl === '') {
      return false
    }
    if (filter.missingFullText === true) {
      const status = pdfStatusOf(task, paper)
      if (status === 'downloaded' || status === 'available' || status === 'html-only') return false
    }
    if (filter.pdfStatus !== undefined && pdfStatusOf(task, paper) !== filter.pdfStatus) {
      return false
    }
    if (filter.groupId !== undefined && task.states[paper.paperId]?.groupId !== filter.groupId) {
      return false
    }
    if (filter.newOnly === true) {
      const base = filter.newPaperIds
      if (base !== undefined && base.has(paper.paperId)) return false
    }
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

/** 有效全文状态：没有人工/下载记录时，上游给的 PDF 直链视为可用。 */
export function pdfStatusOf(task: SearchTask, paper: Paper): PdfStatus {
  const recorded = task.states[paper.paperId]?.pdfStatus
  if (recorded !== undefined) return recorded
  return paper.pdfUrl === '' ? 'unknown' : 'available'
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
    filter.missingFullText === true ? '1' : '',
    filter.pdfStatus ?? '',
    filter.groupId ?? '',
    filter.venue ?? '',
    filter.author ?? '',
    filter.newOnly === true ? '1' : '',
  ].join('|')
}
