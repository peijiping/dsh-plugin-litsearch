/**
 * 模型下载指令的范围解析（纯函数，便于单测）。
 *
 * 模型跑在 Host 侧，看不到右侧栏翻到第几页、用了什么筛选。范围统一由视图
 * 快照 + 服务端 `filterPapers` 算准，并逐个与任务结果取交集，最终只把一份
 * 「已校验的 paperId 清单」交给 Client —— 浏览器不再解析任何条件，也不会
 * 出现「模型理解的筛选」与「界面筛选」两套口径。
 */

import type {
  DownloadCommandItem,
  DownloadScope,
  Paper,
  PdfStatus,
  Screening,
  SearchTask,
  TaskLanguage,
  ViewSnapshot,
} from '../../search/types.js'
import type { PaperFilter } from './filter.js'

/**
 * 与 `types.ts` 的 `TASK_LANGUAGES` 一致。这里刻意只做类型导入、不产生运行时
 * 模块依赖：`src` 源码可被 `node --test` 直接加载，Host 构建产物仍走 `.js`。
 */
const LANGUAGE_VALUES: readonly TaskLanguage[] = [
  'any',
  'eng',
  'chi',
  'jpn',
  'kor',
  'fre',
  'ger',
  'spa',
  'rus',
  'ita',
  'por',
]

const SCREENING_VALUES: readonly Screening[] = ['unread', 'read', 'included', 'excluded']
const PDF_STATUS_VALUES: readonly PdfStatus[] = [
  'unknown',
  'available',
  'downloaded',
  'missing',
  'html-only',
  'paywalled',
  'blocked',
  'failed',
]

/**
 * 把视图快照的扁平筛选投影收窄回 `PaperFilter`。
 *
 * 快照来自 Client 的 `ResultsQuery`，键名与筛选口径一致；这里只按白名单取，
 * 未知键与非法枚举值一律忽略，避免模型/前端写入任意字段影响后台过滤。
 */
export function toPaperFilter(raw: ViewSnapshot['filters']): PaperFilter {
  const text = (key: string): string | undefined => {
    const value = raw[key]
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  const number = (key: string): number | undefined => {
    const value = raw[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }
  const flag = (key: string): boolean | undefined => (raw[key] === true ? true : undefined)
  const oneOf = <T extends string>(key: string, values: readonly T[]): T | undefined => {
    const value = raw[key]
    return typeof value === 'string' ? values.find((item) => item === value) : undefined
  }

  return {
    source: text('source'),
    q: text('q'),
    queryId: text('queryId'),
    type: text('type'),
    venue: text('venue'),
    author: text('author'),
    groupId: text('groupId'),
    yearFrom: number('yearFrom'),
    yearTo: number('yearTo'),
    openAccessOnly: flag('openAccessOnly'),
    hasPdf: flag('hasPdf'),
    missingFullText: flag('missingFullText'),
    newOnly: flag('newOnly'),
    screening: oneOf('screening', SCREENING_VALUES),
    language: oneOf('language', LANGUAGE_VALUES),
    pdfStatus: oneOf('pdfStatus', PDF_STATUS_VALUES),
  }
}

/** 视图筛选打底，工具显式字段覆盖同名项；显式值为 undefined 的不覆盖。 */
export function mergeDownloadFilter(base: PaperFilter, explicit: PaperFilter): PaperFilter {
  const merged: PaperFilter = { ...base }
  for (const [key, value] of Object.entries(explicit)) {
    if (value === undefined) continue
    Object.assign(merged, { [key]: value })
  }
  return merged
}

export interface ResolveDownloadOptions {
  scope: DownloadScope
  /** 已经合并好的筛选条件（视图筛选 + 工具显式条件），用于范围说明。 */
  filter: PaperFilter
  /**
   * 调用方用 `filterPapers(task, filter)` 得到的论文集合。
   *
   * 本文件刻意不引入运行时模块依赖，筛选只在一处发生，避免模型下载与
   * 界面结果出现两套口径；全量范围也不受 `/results` 的 200 条分页限制。
   */
  matched: readonly Paper[]
  /** `scope='ids'` 时模型给出的显式清单。 */
  explicitIds?: readonly string[]
  /** 视图快照；`currentPage` / `currentView` 需要它。 */
  snapshot?: ViewSnapshot
  /** 快照过期时由服务层重算的当前页 paperId（保持用户所见顺序）。 */
  pagePaperIds?: readonly string[]
  /** 分组名，仅用于范围说明。 */
  groupName?: string
}

export interface DownloadScopeResult {
  paperIds: string[]
  items: DownloadCommandItem[]
  /** 清单里不属于该任务或不满足条件的 id 数。 */
  ignored: number
  scopeLabel: string
}

/**
 * 解析范围 → 已校验的 paperId 清单。
 *
 * `ids` 按模型给定顺序、`currentPage` 按用户当前页顺序，其余按任务结果原序；
 * 每种范围都会再与 `filterPapers` 的结果取交集，因此叠加 `hasPdf`、年份等
 * 条件时与界面口径完全一致。全量直接用纯函数过滤，不受 `/results` 的 200
 * 条分页上限约束。
 */
export function resolveDownloadScope(
  task: SearchTask,
  options: ResolveDownloadOptions,
): DownloadScopeResult {
  const byId = new Map(task.result.papers.map((paper) => [paper.paperId, paper]))
  const eligible = new Set(options.matched.map((paper) => paper.paperId))

  let ordered: string[]
  switch (options.scope) {
    case 'ids': {
      const seen = new Set<string>()
      ordered = []
      for (const raw of options.explicitIds ?? []) {
        const id = raw.trim()
        if (id === '' || seen.has(id)) continue
        seen.add(id)
        ordered.push(id)
      }
      break
    }
    case 'currentPage': {
      ordered = [...(options.pagePaperIds ?? options.snapshot?.pagePaperIds ?? [])]
      break
    }
    default: {
      ordered = options.matched.map((paper) => paper.paperId)
      break
    }
  }

  const paperIds: string[] = []
  const items: DownloadCommandItem[] = []
  for (const id of ordered) {
    if (!eligible.has(id)) continue
    const paper = byId.get(id)
    if (paper === undefined) continue
    paperIds.push(id)
    const meta = [paper.venue, paper.year === null ? '' : String(paper.year)]
      .filter((part) => part !== '')
      .join(' · ')
    items.push({
      paperId: id,
      title: paper.title,
      source: paper.hitSources[0]?.source ?? paper.source,
      ...(meta === '' ? {} : { meta }),
    })
  }

  return {
    paperIds,
    items,
    ignored: ordered.length - paperIds.length,
    scopeLabel: buildScopeLabel(options.scope, paperIds.length, options),
  }
}

/** 生成给弹窗展示的中文范围说明（含篇数）；Client 只显示、不翻译、不再解析。 */
export function buildScopeLabel(
  scope: DownloadScope,
  count: number,
  options: Pick<ResolveDownloadOptions, 'filter' | 'snapshot' | 'groupName'>,
): string {
  const parts: string[] = []
  switch (scope) {
    case 'ids':
      parts.push('指定文献')
      break
    case 'currentPage':
      parts.push(`当前页（第 ${(options.snapshot?.pageIndex ?? 0) + 1} 页）`)
      break
    case 'currentView':
      parts.push('当前筛选全部')
      break
    case 'all':
      parts.push('整个任务全部文献')
      break
    case 'group':
      parts.push(`分组「${options.groupName ?? options.filter.groupId ?? ''}」`)
      break
    case 'filters':
      parts.push('按条件筛选')
      break
  }
  const filter = options.filter
  if (filter.hasPdf === true) parts.push('仅含 PDF 直链或已下载')
  if (filter.openAccessOnly === true) parts.push('仅开放获取')
  if (filter.q !== undefined && filter.q !== '') parts.push(`关键词「${filter.q}」`)
  if (filter.groupId !== undefined && scope !== 'group') parts.push(`分组 ${filter.groupId}`)
  if (filter.yearFrom !== undefined || filter.yearTo !== undefined) {
    parts.push(`${filter.yearFrom ?? '不限'}–${filter.yearTo ?? '不限'} 年`)
  }
  if (filter.source !== undefined) parts.push(`来源 ${filter.source}`)
  if (filter.screening !== undefined) parts.push(`筛读 ${filter.screening}`)
  if (filter.pdfStatus !== undefined) parts.push(`全文状态 ${filter.pdfStatus}`)
  if (filter.venue !== undefined && filter.venue !== '') parts.push(`出处 ${filter.venue}`)
  if (filter.author !== undefined && filter.author !== '') parts.push(`作者 ${filter.author}`)
  return `${parts.join(' · ')} · 共 ${count} 篇`
}
