/**
 * 检索层公共类型：数据源无关的论文记录、任务模型与请求响应信封。
 *
 * 本文件同时被 Host 与 Client 引用，因此不得引入任何 Node 内置模块。
 */

/** 已接入的免费数据源 id；顺序即聚合展示顺序。 */
export const SOURCE_IDS = [
  'pubmed',
  'europepmc',
  'openalex',
  'crossref',
  'semanticscholar',
  'arxiv',
  'pubtator',
] as const

export type SourceId = (typeof SOURCE_IDS)[number]

/** 排序方式。 */
export type SortMode = 'relevance' | 'citations' | 'year'

/** 语言筛选。 */
export type TaskLanguage = 'any' | 'eng' | 'chi'

/** 论文的持久标识集合（裸值，不带 URL 前缀）。 */
export interface PaperIds {
  doi: string
  pmid: string
  pmcid: string
  arxivId: string
}

/** provider 归一化后的论文记录（尚无跨源身份）。 */
export interface PaperRecord {
  source: SourceId
  /** 数据源内部 id（如 OpenAlex Work id、Crossref DOI）。 */
  sourceId: string
  ids: PaperIds
  title: string
  authors: string[]
  year: number | null
  venue: string
  /** 裸 DOI（不带 https://doi.org/ 前缀），无则为空串。 */
  doi: string
  url: string
  abstract: string
  /** 上游给出的语言标记（如 eng / chi），未知时缺省。 */
  language?: string
  citedBy: number | null
  openAccess: boolean
  /** 开放获取全文/PDF 直链，无则为空串。 */
  pdfUrl: string
  type: string
}

/** 一次命中：某个数据源在某个检索式里的排位。 */
export interface PaperHit {
  source: SourceId
  /** 该源内的 1-based 排位。 */
  rank: number
}

/** 合并后的论文条目（任务结果的最小单位为它）。 */
export interface Paper extends PaperRecord {
  /** 稳定身份键的散列，跨任务/跨检索一致。 */
  paperId: string
  hitSources: PaperHit[]
  /** 命中该论文的检索式 id。 */
  matchedQueries: string[]
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
  /** 面向用户/模型的限流说明。 */
  rateLimit: string
  /** 检索式语法特点。 */
  syntax: string
  /** 是否需要（可选）密钥才能获得更高额度。 */
  optionalKey: boolean
}

/** 单次检索的请求参数（任务执行器使用）。 */
export interface SearchOptions {
  query: string
  /** 单源语法覆写（来自 QueryBlock.perSource）。 */
  perSource?: Partial<Record<SourceId, string>>
  sources: SourceId[]
  limit: number
  yearFrom?: number | undefined
  yearTo?: number | undefined
  openAccessOnly: boolean
  contactEmail: string
  timeoutMs: number
  signal?: AbortSignal | undefined
  /** 诊断测试用：忽略限流冷却，仍走队列与最小间隔。 */
  bypassCooldown?: boolean
}

/** provider 实现拿到的已解析参数。 */
export interface ProviderSearchOptions {
  limit: number
  yearFrom?: number | undefined
  yearTo?: number | undefined
  openAccessOnly: boolean
  contactEmail: string
  timeoutMs: number
  signal?: AbortSignal | undefined
  /** 诊断测试用：忽略限流冷却。 */
  bypassCooldown?: boolean
  /** 可选密钥；provider 只用于请求参数/请求头，不得写日志。 */
  ncbiApiKey?: string
  s2ApiKey?: string
}

export interface Provider {
  info: ProviderInfo
  search(query: string, options: ProviderSearchOptions): Promise<PaperRecord[]>
}

/** 单个数据源在一次检索中的结果状态。 */
export interface SourceStatus {
  id: SourceId
  ok: boolean
  count: number
  error?: string
  /** 该源不支持下推、结果被后置过滤过。 */
  filtered?: boolean
}

// ---- 任务模型 --------------------------------------------------------------

export type TaskStatus = 'draft' | 'queued' | 'running' | 'done' | 'partial' | 'error' | 'canceled'

export type TaskOrigin = 'model' | 'panel' | 'history' | 'api'

export type Screening = 'unread' | 'read' | 'included' | 'excluded'

/** 一条具名检索式；单检索式任务即长度 1。 */
export interface QueryBlock {
  id: string
  name: string
  text: string
  /** 单源语法覆写；缺省时按源降级适配。 */
  perSource?: Partial<Record<SourceId, string>>
  enabled: boolean
}

export interface TaskConditions {
  queries: QueryBlock[]
  sources: SourceId[]
  yearFrom?: number | undefined
  yearTo?: number | undefined
  openAccessOnly: boolean
  language: TaskLanguage
  types?: string[]
  sort: SortMode
  /** 每次加载条数。 */
  pageSize: number
}

/** 论文级人工筛选状态。 */
export interface PaperState {
  screening: Screening
  groupId?: string
  shortlistOrder?: number
  note?: string
  tags?: string[]
}

export interface TaskGroup {
  id: string
  name: string
  description?: string
  order: number
}

export interface TaskProgress {
  queryIndex: number
  queryTotal: number
  source?: SourceId
}

export interface TaskStats {
  /** queryId → 该检索式原始命中数。 */
  perQuery: Record<string, number>
  rawHits: number
  deduped: number
  screening: Record<Screening, number>
}

export interface TaskResult {
  papers: Paper[]
  sources: SourceStatus[]
  fetchedAt?: string
}

export interface SearchTask {
  id: string
  title: string
  conditions: TaskConditions
  status: TaskStatus
  origin: TaskOrigin
  sessionId?: string
  fromTaskId?: string
  /** 每次状态/条件变化自增。 */
  rev: number
  createdAt: string
  updatedAt: string
  pinned: boolean
  /** 任务级失败原因（数据源级失败在 `result.sources[].error`）。 */
  error?: string
  /** 任务级研究笔记。 */
  notes: string
  groups: TaskGroup[]
  progress?: TaskProgress
  stats: TaskStats
  result: TaskResult
  /** paperId → 筛选状态。 */
  states: Record<string, PaperState>
}

/** 历史列表与事件推送用的任务摘要。 */
export interface TaskSummary {
  id: string
  title: string
  status: TaskStatus
  origin: TaskOrigin
  createdAt: string
  updatedAt: string
  rev: number
  pinned: boolean
  error?: string
  stats: TaskStats
  progress?: TaskProgress
}

/** 任务详情（不含结果正文，结果走分页端点）。 */
export interface TaskDetail extends TaskSummary {
  conditions: TaskConditions
  notes: string
  groups: TaskGroup[]
  result: {
    totalLoaded: number
    sources: SourceStatus[]
    fetchedAt?: string
  }
}

/** `/tasks/:id/results` 的分页响应。 */
export interface ResultsPage {
  taskId: string
  rev: number
  total: number
  offset: number
  limit: number
  papers: Paper[]
}

/** 概览统计的计数项。 */
export interface CountEntry {
  key: string
  count: number
  included: number
}

export interface SourceStat {
  id: SourceId
  hits: number
  uniqueOnly: number
  oa: number
  withPdf: number
}

export interface QueryContribution {
  queryId: string
  name: string
  hits: number
  uniqueOnly: number
  /** 与其它检索式的两两重叠计数（key = queryId）。 */
  overlap: Record<string, number>
}

export interface YearStat {
  year: number
  count: number
  included: number
}

/** `/tasks/:id/stats` 的统计口径与结果。 */
export interface TaskStatsReport {
  taskId: string
  rev: number
  scope: 'task' | 'filtered'
  /** 参与统计的已加载篇数。 */
  loaded: number
  /** 任务已加载总数（未筛选）。 */
  totalHint: number
  funnel: {
    rawHits: number
    deduped: number
    filtered: number
    included: number
    excluded: number
    unread: number
    read: number
  }
  bySource: SourceStat[]
  byQuery: QueryContribution[]
  byYear: YearStat[]
  byType: CountEntry[]
  byLanguage: CountEntry[]
  topVenues: CountEntry[]
  topAuthors: CountEntry[]
  metrics: {
    oaRate: number
    pdfRate: number
    htmlOnlyRate: number
    medianCitations: number
    topCited: string[]
    latest: string[]
  }
  screeningProgress: { included: number; excluded: number; pending: number }
  unavailableFullText: { paywalled: number; blocked: number; failed: number }
}

/** 单个数据源的运行时健康状态（/health 与设置页诊断使用）。 */
export interface SourceHealth {
  id: SourceId
  lastOkAt?: string
  lastError?: string
  lastLatencyMs?: number
  cooldownUntil?: string
}

/** 单源诊断结果。 */
export interface ProbeResult {
  target: SourceId
  ok: boolean
  latencyMs: number
  count: number
  error?: string
  cooldownUntil?: string
}

/** `/events` 的响应；`reset` 表示客户端的 sinceRev 比服务端新（宿主重启）。 */
export interface EventsPage {
  rev: number
  reset: boolean
  tasks: TaskSummary[]
}

/** `/health` 的响应：数据源能力 + 客户端需要的默认设置（不含密钥）。 */
export interface HealthInfo {
  ok: boolean
  globalRev: number
  sources: ProviderInfo[]
  sourceHealth: SourceHealth[]
  /** 密钥是否已配置（只给布尔值，绝不返回密钥）。 */
  keys: { ncbi: boolean; s2: boolean }
  settings: {
    defaultSources: SourceId[]
    defaultPageSize: number
    defaultSort: SortMode
    defaultLanguage: TaskLanguage
    autoOpenTaskTab: boolean
    maxTaskTabs: number
  }
  /** 任务文件存放目录（设置页只读展示）。 */
  storageDir: string
  version: string
}

/** Host HTTP 端点统一信封。 */
export type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: ApiError }

export type ApiErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'conflict'
  | 'network_error'
  | 'upstream_error'
  | 'timeout'
  | 'internal_error'

export interface ApiError {
  code: ApiErrorCode
  message: string
}
