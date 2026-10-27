/**
 * 检索层公共类型：数据源无关的 `Paper`、请求参数与响应信封。
 *
 * 本文件同时被 Host 与 Client 引用，因此不得引入任何 Node 内置模块。
 */

/** 已接入的免费数据源 id；顺序即聚合展示顺序。 */
export const SOURCE_IDS = ['openalex', 'crossref'] as const

export type SourceId = (typeof SOURCE_IDS)[number]

/** 归一化后的文献条目。 */
export interface Paper {
  source: SourceId
  /** 数据源内部 id（如 OpenAlex Work id、Crossref DOI）。 */
  sourceId: string
  title: string
  authors: string[]
  year: number | null
  venue: string
  /** 裸 DOI（不带 https://doi.org/ 前缀），无则为空串。 */
  doi: string
  url: string
  abstract: string
  citedBy: number | null
  openAccess: boolean
  /** 开放获取全文/PDF 直链，无则为空串。 */
  pdfUrl: string
  type: string
}

export interface ProviderCapabilities {
  abstract: boolean
  citationCount: boolean
  openAccess: boolean
  pdf: boolean
}

export interface ProviderInfo {
  id: SourceId
  label: string
  homepage: string
  capabilities: ProviderCapabilities
}

/** 单次检索的请求参数（`query` 必填，其余可选）。 */
export interface SearchOptions {
  query: string
  sources?: SourceId[]
  limit?: number
  yearFrom?: number
  yearTo?: number
  openAccessOnly?: boolean
  signal?: AbortSignal
}

/** provider 实现拿到的已解析参数。 */
export interface ProviderSearchOptions {
  limit: number
  yearFrom?: number
  yearTo?: number
  openAccessOnly: boolean
  contactEmail: string
  timeoutMs: number
  signal?: AbortSignal
}

export interface Provider {
  info: ProviderInfo
  search(query: string, options: ProviderSearchOptions): Promise<Paper[]>
}

/** 单个数据源在一次检索中的结果状态。 */
export interface SourceStatus {
  id: SourceId
  ok: boolean
  count: number
  error?: string
}

export interface SearchResult {
  query: string
  limit: number
  papers: Paper[]
  sources: SourceStatus[]
}

/** Host HTTP 端点统一信封。 */
export type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: ApiError }

export type ApiErrorCode =
  | 'bad_request'
  | 'network_error'
  | 'upstream_error'
  | 'timeout'
  | 'internal_error'

export interface ApiError {
  code: ApiErrorCode
  message: string
}
