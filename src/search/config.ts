/**
 * 检索层常量与运行时设置。
 *
 * 设置由插件入口在 `apply` 时注入，读取时逐次走 volatile 引用，因此设置中心
 * 保存配置后无需重启即生效。
 */

import type { SortMode, SourceId, TaskLanguage } from './types.js'
import { SOURCE_IDS } from './types.js'

/** 插件版本（与 package.json 同步；仅用于 /health 诊断展示）。 */
export const PLUGIN_VERSION = '0.1.0'

/** 默认每次加载条数。 */
export const DEFAULT_PAGE_SIZE = 20

/**
 * 单次上游请求超时（毫秒）。
 *
 * Europe PMC 的 `resultType=core` 明显慢于其它源，15s 容易误判为失败；
 * 这里给全局一个更宽裕的默认值，检索层仍对该源单独设下限。
 */
export const REQUEST_TIMEOUT_MS = 20_000

/** 返回条数上限，防止一次请求拉爆上游与宿主。 */
export const MAX_LIMIT = 50

/** 默认排序。 */
export const DEFAULT_SORT: SortMode = 'relevance'

/** 默认语言筛选。 */
export const DEFAULT_LANGUAGE: TaskLanguage = 'any'

/** 模型发起检索时默认自动打开任务 tab。 */
export const DEFAULT_AUTO_OPEN = true

/** 同时保留的任务 tab 上限。 */
export const DEFAULT_MAX_TASK_TABS = 5

/** 任务保留天数与条数。 */
export const DEFAULT_RETENTION_DAYS = 90
export const DEFAULT_RETENTION_COUNT = 120

/** 单任务结果上限。 */
export const DEFAULT_TASK_MAX_PAPERS = 1500

/** 单任务保留的检索轮数上限；只记元数据，超出后淘汰最旧的轮次。 */
export const DEFAULT_TASK_MAX_ROUNDS = 30

/** 各源默认最小请求间隔（毫秒）；PubMed/S2/arXiv 可由设置覆盖。 */
export const DEFAULT_PUBMED_INTERVAL_MS = 350
export const DEFAULT_S2_INTERVAL_MS = 3000
export const DEFAULT_ARXIV_INTERVAL_MS = 3000

/** 全文下载默认设置。 */
export const DEFAULT_PDF_MAX_MB = 30
export const DEFAULT_AUTO_DOWNLOAD_PDF = false
export const DEFAULT_ENABLE_EPMC_FULLTEXT = true

/** Zotero connector 默认设置。 */
export const DEFAULT_ZOTERO_ENABLED = true
export const DEFAULT_ZOTERO_BASE_URL = 'http://127.0.0.1:23119'
export const DEFAULT_ZOTERO_ATTACH_PDF = true
export const DEFAULT_ZOTERO_TAG = 'dsh-litsearch'

/** 持久化时单条摘要保留的字符数。 */
export const MAX_ABSTRACT_CHARS = 800

/** 写端点的自定义请求头（与 JSON content-type 一起构成非简单请求）。 */
export const WRITE_HEADER = 'x-dsh-litsearch-write'

/** Host 路由前缀（Client fetch 路径与 handler 的剥离基准，带尾斜杠）。 */
export const ROUTE_PREFIX = '/dsh-litsearch/api/'

/**
 * 注册到 `webServer` 的 prefix 路径。
 *
 * 必须**不带尾斜杠**：宿主按 `pathname === prefix || pathname.startsWith(prefix + '/')`
 * 匹配，带尾斜杠会变成 `.../api//tasks`，永远匹配不上。
 */
export const ROUTE_MATCH = '/dsh-litsearch/api'

export interface LitsearchSettings {
  /** 联系邮箱，作为 OpenAlex / Crossref polite pool 与 NCBI email 标识；留空也可用。 */
  contactEmail: string
  defaultPageSize: number
  requestTimeoutMs: number
  defaultSources: SourceId[]
  defaultSort: SortMode
  defaultLanguage: TaskLanguage
  autoOpenTaskTab: boolean
  maxTaskTabs: number
  taskRetentionDays: number
  taskRetentionCount: number
  taskMaxPapers: number
  /** 可选 NCBI API Key；有 key 时 E-utilities 额度更高。 */
  ncbiApiKey: string
  /** 可选 Semantic Scholar API Key；提高配额。 */
  s2ApiKey: string
  /** 各源最小请求间隔覆盖值。 */
  pubmedIntervalMs: number
  s2IntervalMs: number
  arxivIntervalMs: number
  /** PDF 下载根目录；空串由 Host 回落到 ~/Downloads/dsh-litsearch。 */
  pdfRoot: string
  pdfMaxMb: number
  autoDownloadPdf: boolean
  enableEpmcFulltext: boolean
  zoteroEnabled: boolean
  zoteroBaseUrl: string
  zoteroAttachPdf: boolean
  zoteroTag: string
}

/** 默认读取器：入口未注入时回落到常量。 */
let readSettings = (): LitsearchSettings => ({
  contactEmail: '',
  defaultPageSize: DEFAULT_PAGE_SIZE,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  defaultSources: [...SOURCE_IDS],
  defaultSort: DEFAULT_SORT,
  defaultLanguage: DEFAULT_LANGUAGE,
  autoOpenTaskTab: DEFAULT_AUTO_OPEN,
  maxTaskTabs: DEFAULT_MAX_TASK_TABS,
  taskRetentionDays: DEFAULT_RETENTION_DAYS,
  taskRetentionCount: DEFAULT_RETENTION_COUNT,
  taskMaxPapers: DEFAULT_TASK_MAX_PAPERS,
  ncbiApiKey: '',
  s2ApiKey: '',
  pubmedIntervalMs: DEFAULT_PUBMED_INTERVAL_MS,
  s2IntervalMs: DEFAULT_S2_INTERVAL_MS,
  arxivIntervalMs: DEFAULT_ARXIV_INTERVAL_MS,
  pdfRoot: '',
  pdfMaxMb: DEFAULT_PDF_MAX_MB,
  autoDownloadPdf: DEFAULT_AUTO_DOWNLOAD_PDF,
  enableEpmcFulltext: DEFAULT_ENABLE_EPMC_FULLTEXT,
  zoteroEnabled: DEFAULT_ZOTERO_ENABLED,
  zoteroBaseUrl: DEFAULT_ZOTERO_BASE_URL,
  zoteroAttachPdf: DEFAULT_ZOTERO_ATTACH_PDF,
  zoteroTag: DEFAULT_ZOTERO_TAG,
})

/** 由插件入口在 `apply` 时注入。 */
export function setSettingsReader(reader: () => LitsearchSettings): void {
  readSettings = reader
}

/** 读取当前生效的设置。 */
export function getSettings(): LitsearchSettings {
  return readSettings()
}
