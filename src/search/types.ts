/**
 * 检索层公共类型：数据源无关的论文记录、任务模型与请求响应信封。
 *
 * 本文件同时被 Host 与 Client 引用，因此不得引入任何 Node 内置模块。
 */

/**
 * 已接入的数据源 id；顺序即聚合展示顺序。
 *
 * 除 `googlescholar` 外均为免费公开 API；`googlescholar` 依赖用户自备的
 * SerpAPI Key，未配置时默认不参与检索。其余 10 个默认全部参与检索。
 */
export const SOURCE_IDS = [
  'pubmed',
  'europepmc',
  'openalex',
  'crossref',
  'semanticscholar',
  'arxiv',
  'pubtator',
  'doaj',
  'openreview',
  'openaire',
  'googlescholar',
] as const

export type SourceId = (typeof SOURCE_IDS)[number]

/** 排序方式。 */
export type SortMode = 'relevance' | 'citations' | 'year'

/** 语言筛选；取值沿用 PubMed 的三字母语言码。 */
export type TaskLanguage =
  | 'any'
  | 'eng'
  | 'chi'
  | 'jpn'
  | 'kor'
  | 'fre'
  | 'ger'
  | 'spa'
  | 'rus'
  | 'ita'
  | 'por'

/** 语言候选项；顺序即下拉与胶囊的展示顺序。 */
export const TASK_LANGUAGES: readonly TaskLanguage[] = [
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

/** 论文的持久标识集合（裸值，不带 URL 前缀）。 */
export interface PaperIds {
  doi: string
  pmid: string
  pmcid: string
  arxivId: string
}

/** OA 位置的来源，用于候选合并时的 `alsoIn` 与界面说明。 */
export type OaSource =
  | 'metadata'
  | 'publisher-rule'
  | 'unpaywall'
  | 'openalex'
  | 'europepmc'
  | 'openaire'
  | 'arxiv'
  | 'doi'

/**
 * 一条可点击/可尝试的全文位置。
 *
 * `oa` 只表示「确认开放获取」，订阅落地页与 DOI 页恒为 false——
 * 这样界面上永远不会把订阅链接误读成可下载。
 */
export interface OaLocation {
  url: string
  /** `pdf` 可尝试下载；`html` 是网页全文；`landing` 是落地页。 */
  kind: 'pdf' | 'landing' | 'html'
  source: OaSource
  oa: boolean
  /** 上游标记的最佳 OA 位置。 */
  best?: boolean
  license?: string
  /** 仅 text-mining 许可的链接，不作为自动下载候选。 */
  textMining?: boolean
  /** 同一 URL 被其它源命中的来源。 */
  alsoIn?: OaSource[]
}

/** 单个候选的抓取结果，供失败时逐条解释。 */
export interface PdfAttempt {
  url: string
  host: string
  kind: 'paywalled' | 'blocked' | 'not_pdf' | 'too_large' | 'unsafe' | 'failed'
  detail: string
  status?: number
  ms: number
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
  /** 多源 OA 位置（含直链、网页全文、落地页）；缺省表示上游只给了 `pdfUrl`。 */
  oaLocations?: OaLocation[]
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
  /** 源查询开始（在调用 provider.search 前同步触发）。 */
  onSourceStart?: (source: SourceId) => void
  /** 源查询结束（fulfilled / rejected 均触发，早于 allSettled 整体返回）。 */
  onSourceDone?: (outcome: SourceOutcome) => void
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
  openalexApiKey?: string
  s2ApiKey?: string
  serpApiKey?: string
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
  | 'missing'
  | 'html-only'
  | 'paywalled'
  | 'blocked'
  | 'failed'

/**
 * PDF 下载失败的根因分类。
 *
 * 除了 `failed`（网络/超时/体积等程序故障）之外，其余都属于「后台拿不到、
 * 但浏览器可能能打开」，界面按此分流，避免把订阅受限误报成功能失败。
 */
export type PdfFailureReason = 'no-candidate' | 'blocked' | 'paywalled' | 'not-pdf' | 'failed'

/** 是否需要引导用户到浏览器手动保存。 */
export function isManualPdfFailure(reason: PdfFailureReason | undefined): boolean {
  return reason !== undefined && reason !== 'failed'
}

/** 文献 → Zotero 的同步状态；缺省表示尚未同步。 */
export type ZoteroSyncStatus = 'synced' | 'failed'

/** 论文级人工筛选状态。 */
export interface PaperState {
  screening: Screening
  groupId?: string
  pdfStatus?: PdfStatus
  /** 失败原因（面向用户的一句话）。 */
  pdfError?: string
  /** 已下载到用户目录的绝对路径。 */
  pdfFile?: string
  /** 最近一次 Zotero 同步结果；缺省为未同步。 */
  zoteroStatus?: ZoteroSyncStatus
  /** 同步到的 Zotero 目录名，便于列表直接展示。 */
  zoteroCollection?: string
  /** 同步失败原因（面向用户的一句话）。 */
  zoteroError?: string
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

/** 步骤类别：检索式分组 / 单源查询 / 跨源去重。 */
export type TaskStepKind = 'query' | 'source' | 'dedup'

/** 步骤状态。跳过（限流/取消）与失败分开，UI 用不同颜色。 */
export type TaskStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed'

/**
 * 一轮检索中一个可观察的步骤。
 * 轮首按固定数量预生成，执行中按 id 原地更新，不追加、不删除。
 */
export interface TaskStep {
  /** 稳定 id：检索式 `q{i}`；源 `q{i}:{sourceId}`；去重 `dedup`。 */
  id: string
  kind: TaskStepKind
  /** 用户可见短标签：检索式取 name（无则 text），源取 sourceId，去重取固定值。 */
  label: string
  /** 1-based；仅 query/source 步骤有。 */
  queryIndex?: number
  /** 仅 source 步骤有，用于 `source.<id>` 中文名映射。 */
  source?: SourceId
  status: TaskStepStatus
  /** 该步条数：源=过滤后条数；检索式=其下各源之和；去重=merged.length。 */
  count?: number
  /** failed 的报错 / skipped 的中性原因。 */
  error?: string
}

/** `searchSources` 的单源结束回调载荷。 */
export interface SourceOutcome {
  source: SourceId
  ok: boolean
  count: number
  error?: string
  skipped?: boolean
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

/**
 * 任务内一次检索（一轮）的元数据快照。
 *
 * 只留「这一轮用什么条件、什么时候跑、跑出多少、结果如何」，**不保存文献列表**：
 * 当前结果永远是最新一轮的 `result.papers`，筛读状态按 paperId 跨轮保留。
 * 历史轮次用于时间轴回看与「回填条件重跑」。
 */
export interface SearchRound {
  /** 任务内稳定 id，形如 `r3`。 */
  id: string
  /** 从 1 开始递增的序号（轮次被裁剪后仍保持递增，不复用旧号）。 */
  index: number
  createdAt: string
  finishedAt?: string
  /** 本轮发起方：模型工具 / 右侧栏面板。 */
  origin: TaskOrigin
  /** 本轮检索条件快照，深拷贝，与后续轮次的修改完全隔离。 */
  conditions: TaskConditions
  /** 运行中为空，结束后回填任务状态。 */
  status?: TaskStatus
  /** 本轮命中统计快照。 */
  stats?: {
    rawHits: number
    deduped: number
    loaded: number
    perQuery: Record<string, number>
  }
  /** 因遵守上游限流而跳过的数据源数量。 */
  skippedSources?: number
  /** 真实失败的数据源数量。 */
  failedSources?: number
  /** 取消 / 异常原因。 */
  error?: string
}

export interface SearchTask {
  id: string
  title: string
  conditions: TaskConditions
  status: TaskStatus
  origin: TaskOrigin
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
  /** 关联的会话工作目录；PDF 默认下载到其下的 dsh-litsearch/。 */
  workspace?: string
  progress?: TaskProgress
  /**
   * 当前轮步骤进度。轮首重建、下一轮覆盖，轮末保留最后状态。
   * 旧任务无此字段，读取路径统一按 undefined 兼容。
   */
  steps?: TaskStep[]
  stats: TaskStats
  result: TaskResult
  /** paperId → 筛选状态。 */
  states: Record<string, PaperState>
  /**
   * 任务内检索轮次（按时间升序，只保留最近若干轮）。
   * 旧版本落盘的任务没有该字段，读取时统一按 `[]` 兼容。
   */
  rounds: SearchRound[]
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
  /** 已完成 + 进行中的轮次数（旧数据兼容为 0）。 */
  roundCount: number
}

/** 任务详情（不含结果正文，结果走分页端点）。 */
export interface TaskDetail extends TaskSummary {
  conditions: TaskConditions
  /** 当前轮步骤进度（详情轮询透传，摘要/事件不带）。 */
  steps?: TaskStep[]
  notes: string
  groups: TaskGroup[]
  /** 轮次元数据，供时间轴展示与条件回填；按时间升序。 */
  rounds: SearchRound[]
  /** paperId → 筛读状态；只含有过人工操作或继承的条目。 */
  states: Record<string, PaperState>
  /** 建立任务时继承筛读状态的来源任务。 */
  fromTaskId?: string
  /** PDF 实际保存目录（供面板悬停提示）。 */
  downloadDir?: string
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
  /** 出现过的出处，按命中数降序；筛选项直接用这份清单（最多 500 条）。 */
  topVenues: CountEntry[]
  /** 出现过的作者，按命中数降序；筛选项直接用这份清单（最多 500 条）。 */
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
  missing: number
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
  /** 失败根因；成功时缺省。 */
  reason?: PdfFailureReason
  /** 可点击的全文位置（成功与失败都返回），客户端据此渲染动作条。 */
  links?: OaLocation[]
  /** 逐候选的失败记录，便于解释「为什么下不到」。 */
  attempts?: PdfAttempt[]
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

/** Zotero 可写入的目标（库或分类），id 为 connector 的 treeViewID。 */
export interface ZoteroTarget {
  id: string
  name: string
  level: number
  filesEditable?: boolean
  recent?: boolean
}

/** Zotero 目标目录列表。 */
export interface ZoteroTargetsResult {
  ok: boolean
  targets: ZoteroTarget[]
  /** 当前 Zotero 里选中的目标。 */
  current?: { id: string; name: string }
  error?: string
}

/** 单篇同步结果。 */
export interface ZoteroSyncItemResult {
  paperId: string
  ok: boolean
  attached: boolean
  error?: string
}

/** Zotero 批量同步结果。 */
export interface ZoteroSyncResult {
  ok: boolean
  saved: number
  attached: number
  failed: number
  messages: string[]
  items: ZoteroSyncItemResult[]
}

/** 同步前查重命中的依据：本插件条目 id → DOI → PMID → arXiv → 标题+年份。 */
export type ZoteroDuplicateMatch = 'id' | 'doi' | 'pmid' | 'arxiv' | 'title'

/** 目标目录里已存在的文献。 */
export interface ZoteroDuplicate {
  paperId: string
  matchedBy: ZoteroDuplicateMatch
}

/** 同步前查重结果；查不了时 `ok=false`，调用方按正常流程同步。 */
export interface ZoteroDuplicateCheckResult {
  /** true = 完成查重；false = 未查重（未开启本机 API、目录无法定位等），不阻塞同步。 */
  ok: boolean
  duplicates: ZoteroDuplicate[]
  /** 未查重原因或补充说明，直接展示给用户。 */
  note?: string
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
  /** PDF 实际保存目录（供面板悬停提示）。 */
  downloadDir?: string
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

/** 客户端需要打开/聚焦的任务（模型刚在当前任务里发起了一轮检索）。 */
export interface TaskFocus {
  taskId: string
  title: string
  /** 请求时间（epoch ms）；客户端据此丢弃过期的聚焦请求。 */
  at: number
  /** 发起检索的会话；客户端只在该会话可见时打开，避免抢占其他对话的面板。 */
  sessionId?: string
  /** 用户显式要求切换任务；客户端据此忽略「自动打开任务」开关。 */
  force?: boolean
}

/**
 * 结果列表每页篇数。
 *
 * 面板分页与模型侧「第 N 页」共用这一个常量：它是**界面翻页**的粒度，
 * 与任务条件的 `pageSize`（每源条数，可调 1–50）不是一回事，两者不可混用。
 */
export const RESULT_PAGE_SIZE = 20

/** 模型侧下载范围；工具把自然语言收敛成这 7 种之一。 */
export type DownloadScope =
  | 'ids'
  | 'currentPage'
  | 'currentView'
  | 'pages'
  | 'all'
  | 'group'
  | 'filters'

/**
 * 按页取数时页码的基准列表。
 *
 * - `view`（默认）：先按面板视图（筛选 + 排序）切页，再在页内套模型附加条件。
 *   「第二页里有 PDF 的文献」就是这个口径：用户看到的是第 2 页那 20 条。
 * - `filtered`：先把附加条件合并进筛选再切页。
 *   「有 PDF 的文献的第 2 页」用这个。
 */
export type PageBase = 'view' | 'filtered'

/**
 * 客户端当前视图快照。
 *
 * 模型工具跑在 Host 侧，看不到右侧栏翻到第几页、用了什么筛选。面板按变化
 * 节流上报这份快照，Host 才能把「当前页」「当前筛选全部」算准。仅存内存，
 * 宿主重启即失效（与事件日志 rev 一致）。
 */
export interface ViewSnapshot {
  sessionId: string
  taskId: string
  /** 上报时间（epoch ms）；Host 只接受 30 分钟内的快照。 */
  at: number
  pageIndex: number
  pageSize: number
  /** 客户端看到的结果总数；给出「共 N 页」时用它，缺省则由 Host 按任务重算。 */
  total?: number
  /** 当前结果排序；快照缺 paperIds 时用它重算当前页。 */
  sort?: SortMode
  /** 当前生效的筛选；键名沿用 ResultsQuery，值已去除 undefined / 空串。 */
  filters: Record<string, string | number | boolean>
  /** 当前页按用户所见顺序的 paperId。 */
  pagePaperIds: string[]
  /** 跨页累计勾选的 paperId。 */
  selectedIds: string[]
  /** 客户端看到的任务 rev；每下载一篇都会自增，故只做宽松校验。 */
  rev: number
}

/** 一条待下载文献的展示元数据；由 Host 生成，Client 无需再查详情。 */
export interface DownloadCommandItem {
  paperId: string
  title: string
  source: string
  /** `期刊 · 年份` 之类的副行，可缺省。 */
  meta?: string
}

/**
 * 模型发起的批量下载指令。
 *
 * 范围在 Host 侧已解析、逐个校验完毕；右侧栏只按 paperIds 执行，不解析
 * 任何条件，也不反查别的任务。弹窗靠 scopeLabel / reason / items 让用户
 * 看清「大模型正在下载哪些文献」。
 */
export interface DownloadCommand {
  commandId: string
  taskId: string
  sessionId?: string
  at: number
  origin: 'model'
  /** 用户原话 / 模型对范围的解释，弹窗里展示。 */
  reason: string
  /** Host 生成的中文范围说明（含篇数），Client 纯展示。 */
  scopeLabel: string
  paperIds: string[]
  items: DownloadCommandItem[]
}

/**
 * 模型发起的批量存入 Zotero 指令。
 *
 * 与下载指令共用同一套范围解析与 `items` 展示元数据；多出来的只有目标目录：
 * 用户在对话里点名了目录且 Host 匹配成功时带上 `target` 并 `autoStart`，
 * 否则弹窗加载好文献后由用户自己选目录再点「同步」。
 */
export interface ZoteroCommand {
  commandId: string
  taskId: string
  sessionId?: string
  at: number
  origin: 'model'
  /** 用户原话 / 模型对范围的解释，弹窗里展示。 */
  reason: string
  /** Host 生成的中文范围说明（含篇数），Client 纯展示。 */
  scopeLabel: string
  paperIds: string[]
  items: DownloadCommandItem[]
  /** 对话里点名、且已在 Zotero 目录列表里核实过的目标目录。 */
  target?: ZoteroTarget
  /** true = 目录已确定，弹窗加载完立即自动同步；false = 等用户选目录。 */
  autoStart: boolean
}

/** `/events` 的响应；`reset` 表示客户端的 sinceRev 比服务端新（宿主重启）。 */
export interface EventsPage {
  rev: number
  reset: boolean
  tasks: TaskSummary[]
  focus?: TaskFocus
  /** 增量下发的模型下载指令；数组而非单值，避免两次轮询间连发时丢指令。 */
  downloads?: DownloadCommand[]
  /** 增量下发的模型 Zotero 同步指令，与 downloads 并列、互不影响。 */
  zotero?: ZoteroCommand[]
}

/** `/health` 的响应：数据源能力 + 客户端需要的默认设置（不含密钥）。 */
export interface HealthInfo {
  ok: boolean
  globalRev: number
  sources: ProviderInfo[]
  sourceHealth: SourceHealth[]
  /** 密钥是否已配置（只给布尔值，绝不返回密钥）。 */
  keys: { ncbi: boolean; openalex: boolean; s2: boolean; serpapi: boolean }
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
    /** 是否启用 PubMed Central JATS XML 全文通道。 */
    pmcFulltext: boolean
    /** 下载时是否反查 OA 位置（OpenAlex / Europe PMC / OpenAIRE / Unpaywall）。 */
    oaLookup: boolean
    /** 是否启用 arXiv HTML 全文通道。 */
    arxivHtml: boolean
    pdfTimeoutMs: number
    pdfRetryCount: number
    pdfPerHostConcurrency: number
  }
  zotero: {
    enabled: boolean
    baseUrl: string
    attachPdf: boolean
    tag: string
  }
  /** 任务文件存放目录（设置页只读展示）。 */
  storageDir: string
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
