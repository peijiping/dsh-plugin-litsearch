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
  PageBase,
  Paper,
  PdfStatus,
  Screening,
  SearchTask,
  TaskLanguage,
  ViewSnapshot,
} from '../../search/types.js'
import type { PaperFilter } from './filter.js'

/**
 * 每页篇数的兜底值，与 `types.ts` 的 `RESULT_PAGE_SIZE`（面板分页粒度）一致。
 *
 * 本文件要能被 `node --test` 直接加载，因此不做任何运行时模块导入（`.js`
 * 后缀在同环境里无法回落到 `.ts`）；真正的每页条数总由调用方通过视图快照
 * 传入，这里只兜底。`test/download-scope.test.ts` 会断言它仍是 20。
 */
const FALLBACK_PAGE_SIZE = 20

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
    hasFullText: flag('hasFullText'),
    newOnly: flag('newOnly'),
    supplementedOnly: flag('supplementedOnly'),
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
  /** 视图快照；`currentPage` / `currentView` / `pages` 需要它。 */
  snapshot?: ViewSnapshot
  /** 快照过期时由服务层重算的当前页 paperId（保持用户所见顺序）。 */
  pagePaperIds?: readonly string[]
  /** `scope='pages'` 时模型给的 1-based 页码。 */
  pages?: readonly number[]
  /** 页码基准，默认 `view`（先切页再套附加条件）。 */
  pageBase?: PageBase
  /**
   * `pageBase='view'` 时切页用的集合：只含视图筛选、**不含**工具附加条件。
   *
   * 缺省回落到 `matched`（即先筛后切页），与 `pageBase='filtered'` 等价。
   * 与 `matched` 一样，需由调用方按界面排序排好后再传入。
   */
  viewMatched?: readonly Paper[]
  /** 每页篇数；缺省取客户端上报值。 */
  pageSize?: number
  /** 分组名，仅用于范围说明。 */
  groupName?: string
}

export interface DownloadScopeResult {
  paperIds: string[]
  items: DownloadCommandItem[]
  /** 清单里不属于该任务或不满足条件的 id 数。 */
  ignored: number
  scopeLabel: string
  /** `scope='pages'` 时按当前每页篇数算出的总页数。 */
  pageCount?: number
  /** 请求但超出总页数的页码（1-based）；非空时调用方应拒绝下发。 */
  outOfRange?: number[]
}

export interface PageWindowOptions {
  pages: readonly number[]
  pageBase: PageBase
  /** `pageBase='filtered'` 的基础集合（筛选已全部合并）。 */
  matched: readonly Paper[]
  /** `pageBase='view'` 的基础集合（只含视图筛选）。 */
  viewMatched: readonly Paper[]
  /** 每页篇数；缺省用 `FALLBACK_PAGE_SIZE`。 */
  pageSize?: number
}

export interface PageWindowResult {
  /** 页窗口内按页序（跨页不重复）展开的 paperId。 */
  paperIds: string[]
  pageSize: number
  pageCount: number
  outOfRange: number[]
}

/**
 * 把「第 4–5 页」解析成 paperId 清单。
 *
 * 页码语义固定在「用户屏幕上那一页」：每页 `pageSize` 条（面板恒为 20）。
 * **前置条件**：`matched` / `viewMatched` 必须已按界面排序排好（调用方用
 * `filter.sortPapers`），否则切出来的页与面板不一致。
 *
 * `pageBase='view'` 时先切页、再与附加条件取交集，这样「第二页里有 PDF 的
 * 文献」不会因为加了 `hasPdf` 而把页面整体前移。
 */
export function resolvePageWindow(options: PageWindowOptions): PageWindowResult {
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? FALLBACK_PAGE_SIZE))
  const base = options.pageBase === 'view' ? options.viewMatched : options.matched

  const pageCount = Math.max(1, Math.ceil(base.length / pageSize))
  const outOfRange: number[] = []
  const seen = new Set<string>()
  const paperIds: string[] = []

  for (const page of [...options.pages].sort((a, b) => a - b)) {
    const index = Math.floor(page) - 1
    if (index < 0 || page > pageCount) {
      outOfRange.push(page)
      continue
    }
    const start = index * pageSize
    for (const paper of base.slice(start, start + pageSize)) {
      if (seen.has(paper.paperId)) continue
      seen.add(paper.paperId)
      paperIds.push(paper.paperId)
    }
  }

  return { paperIds, pageSize, pageCount, outOfRange }
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
  let pageCount: number | undefined
  let outOfRange: number[] | undefined
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
    case 'selected': {
      ordered = [...new Set(options.snapshot?.selectedIds ?? [])]
      break
    }
    case 'currentPage': {
      ordered = [...(options.pagePaperIds ?? options.snapshot?.pagePaperIds ?? [])]
      break
    }
    case 'pages': {
      const window = resolvePageWindow({
        pages: options.pages ?? [],
        pageBase: options.pageBase ?? 'view',
        matched: options.matched,
        viewMatched: options.viewMatched ?? options.matched,
        ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
      })
      ordered = window.paperIds
      pageCount = window.pageCount
      outOfRange = window.outOfRange
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
      source: paper.hitSources[0]?.source ?? paper.source ?? 'ris',
      ...(meta === '' ? {} : { meta }),
    })
  }

  return {
    paperIds,
    items,
    ignored: ordered.length - paperIds.length,
    scopeLabel: buildScopeLabel(options.scope, paperIds.length, options),
    ...(pageCount === undefined ? {} : { pageCount }),
    ...(outOfRange === undefined ? {} : { outOfRange }),
  }
}

/** 生成给弹窗展示的中文范围说明（含篇数）；Client 只显示、不翻译、不再解析。 */
export function buildScopeLabel(
  scope: DownloadScope,
  count: number,
  options: Pick<ResolveDownloadOptions, 'filter' | 'snapshot' | 'groupName' | 'pages'>,
): string {
  const parts: string[] = []
  switch (scope) {
    case 'ids':
      parts.push('指定文献')
      break
    case 'selected':
      parts.push('右侧栏已勾选')
      break
    case 'currentPage':
      parts.push(`当前页（第 ${(options.snapshot?.pageIndex ?? 0) + 1} 页）`)
      break
    case 'pages':
      parts.push(`第 ${describePages(options.pages ?? [])} 页`)
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

/** 页码列表 → 可读文案：`[2]` → `2`，`[4,5,6]` → `4–6`，`[2,5]` → `2、5`。 */
export function describePages(pages: readonly number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b)
  if (sorted.length === 0) return ''
  const chunks: string[] = []
  let start = sorted[0]
  let prev = sorted[0]
  for (let index = 1; index < sorted.length; index += 1) {
    const page = sorted[index]
    if (page === prev + 1) {
      prev = page
      continue
    }
    chunks.push(start === prev ? String(start) : `${start}–${prev}`)
    start = page
    prev = page
  }
  chunks.push(start === prev ? String(start) : `${start}–${prev}`)
  return chunks.join('、')
}
