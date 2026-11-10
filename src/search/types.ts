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
  /** 是否成功参与检索；因限流跳过的源不算失败，也为 true。 */
  ok: boolean
  count: number
  error?: string
  /** 因遵守上游限流而跳过，不计入失败 / partial，面板只给中性提示。 */
  skipped?: boolean
  /** 跳过原因（中性文案）。 */
  note?: string
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

/** 全文获取状态；`unknown` 表示尚未尝试。 */
export type PdfStatus =
  | 'unknown'
  | 'available'
  | 'downloaded'
  | 'html-only'
  | 'paywalled'
  | 'blocked'
  | 'failed'

/** 论文级人工筛选状态。 */
export interface PaperState {
  screening: Screening
  groupId?: string
  shortlistOrder?: number
  note?: string
  tags?: string[]
  pdfStatus?: PdfStatus
  /** 失败原因（面向用户的一句话）。 */
  pdfError?: string
  /** 已下载到用户目录的绝对路径。 */
  pdfFile?: string
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
  /** paperId → 筛读状态；只含有过人工操作或继承的条目。 */
  states: Record<string, PaperState>
  /** 建立任务时继承筛读状态的来源任务。 */
  fromTaskId?: string
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
    /** 相对 `fromTaskId` 的新增篇数；无基准任务时缺省。 */
    newVsBase?: number
  }
  screeningProgress: { included: number; excluded: number; pending: number }
  unavailableFullText: { paywalled: number; blocked: number; failed: number }
  /** 全文覆盖：与台账同一口径。 */
  fullText: FullTextCoverage
}

/** 全文获取覆盖计数。 */
export interface FullTextCoverage {
  unknown: number
  available: number
  downloaded: number
  htmlOnly: number
  paywalled: number
  blocked: number
  failed: number
}

// ---- P3：筛读、分组、对比与导出 -------------------------------------------

/** 单篇论文的批量注解输入（`POST /tasks/:id/annotate`）。 */
export interface AnnotationInput {
  paperId: string
  screening?: Screening
  /** `null` 表示移出分组。 */
  groupId?: string | null
  /** `null` 表示清除必读顺序。 */
  shortlistOrder?: number | null
  note?: string
  tags?: string[]
  /** 全文状态由 Host 下载/同步流程写入，面板也可显示与筛选。 */
  pdfStatus?: PdfStatus
  pdfError?: string
  pdfFile?: string
}

/** 单篇 PDF 下载结果。 */
export interface PdfDownloadResult {
  paperId: string
  status: PdfStatus
  bytes: number
  /** 用户目录中的可读文件名。 */
  filename?: string
  path?: string
  url?: string
  error?: string
}

/** Zotero connector 探测结果。 */
export interface ZoteroProbeResult {
  ok: boolean
  version?: string
  collection?: {
    id: number | string
    name: string
    libraryID?: number
    filesEditable?: boolean
  }
  error?: string
}

/** Zotero 批量同步结果。 */
export interface ZoteroSyncResult {
  ok: boolean
  saved: number
  attached: number
  failed: number
  messages: string[]
}

/** 下载目录可写性测试结果。 */
export interface StorageProbeResult {
  ok: boolean
  root: string
  writable: boolean
  error?: string
}

export interface AnnotationResult {
  taskId: string
  rev: number
  updated: number
}

/** 单篇论文详情（独立论文页使用）。 */
export interface PaperDetail {
  taskId: string
  taskTitle: string
  rev: number
  paper: Paper
  state?: PaperState
  groups: TaskGroup[]
}

/** PubTator 标注的单个实体（按标识符与原文去重）。 */
export interface PaperEntity {
  text: string
  type: string
  identifier: string
  database: string
  name: string
  /** 同一实体在标题/摘要/全文中出现的次数。 */
  count: number
}

/** 单篇论文的 PubTator 实体结果。 */
export interface PaperEntities {
  paperId: string
  pmid: string
  entities: PaperEntity[]
  fetchedAt: string
}

/** 对比视图里的轻量论文投影。 */
export interface ComparePaper {
  paperId: string
  title: string
  authors: string[]
  year: number | null
  venue: string
  doi: string
  openAccess: boolean
}

export interface CompareResult {
  taskId: string
  rev: number
  withTaskId: string
  withTitle: string
  counts: {
    added: number
    common: number
    missing: number
    total: number
    baseTotal: number
  }
  /** 当前任务有、基准任务没有的论文。 */
  added: ComparePaper[]
  /** 基准任务有、当前任务没有的论文。 */
  missing: ComparePaper[]
}

export type ExportFormat = 'csv' | 'ris' | 'bibtex' | 'md'

export interface ExportFile {
  filename: string
  mime: string
  content: string
}

export type CleanupScope = 'tasks' | 'pdf' | 'all'

export interface CleanupResult {
  scope: CleanupScope
  removed: number
  freedBytes: number
  remaining: number
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
  fullText: {
    pdfRoot: string
    pdfMaxMb: number
    autoDownload: boolean
    epmcFulltext: boolean
  }
  zotero: {
    enabled: boolean
    baseUrl: string
    attachPdf: boolean
    tag: string
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
