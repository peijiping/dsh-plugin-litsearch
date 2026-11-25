/**
 * 检索层常量与运行时设置。
 *
 * 设置由插件入口在 `apply` 时注入，读取时逐次走 volatile 引用，因此设置中心
 * 保存配置后无需重启即生效。
 */

import type { SortMode, SourceId, TaskLanguage, TranslateEngine, TranslateTarget } from './types.js'
import { SOURCE_IDS } from './types.js'

/**
 * 默认数据源。
 *
 * Google Scholar 依赖用户自备的 SerpAPI Key，未配置时默认关闭，
 * 因此不进入默认勾选列表。
 */
export const DEFAULT_SOURCE_IDS: readonly SourceId[] = SOURCE_IDS.filter(
  (id) => id !== 'googlescholar',
)

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
/** SerpAPI 按次计费，保守限制为 1 次/秒。 */
export const DEFAULT_SERPAPI_INTERVAL_MS = 1000

/**
 * NCBI 要求 E-utilities 请求携带开发者邮箱（tool/email 需注册到 NCBI）。
 * 用户未填写 contactEmail 时回落到维护者邮箱。
 */
export const NCBI_CONTACT_EMAIL = 'peijiping@gmail.com'

/** 全文下载默认设置。 */
export const DEFAULT_PDF_MAX_MB = 30
/** PDF 去重缓存总量上限（MB）；0 表示关闭自动清理。 */
export const DEFAULT_PDF_CACHE_MAX_MB = 512
export const DEFAULT_AUTO_DOWNLOAD_PDF = false
export const DEFAULT_ENABLE_EPMC_FULLTEXT = true
/** 是否启用 PubMed Central 全文通道（按 PMID 反查 PMCID 后取 JATS XML）。 */
export const DEFAULT_ENABLE_PMC_FULLTEXT = true
/** 单个 PDF 候选的抓取总预算（与检索超时解耦）。 */
export const DEFAULT_PDF_TIMEOUT_MS = 60_000
/** 5xx / 网络错误的单候选重试次数。 */
export const DEFAULT_PDF_RETRY_COUNT = 1
/** 同一域名同时在途的下载数上限。 */
export const DEFAULT_PDF_PER_HOST_CONCURRENCY = 2
/** 下载时是否反查 OpenAlex / Europe PMC / OpenAIRE 的 OA 位置。 */
export const DEFAULT_ENABLE_OA_LOOKUP = true
/** 是否启用 arXiv HTML 作为第二条全文通道。 */
export const DEFAULT_ENABLE_ARXIV_HTML = true

/** Zotero connector 默认设置。 */
export const DEFAULT_ZOTERO_ENABLED = true
export const DEFAULT_ZOTERO_BASE_URL = 'http://127.0.0.1:23119'
export const DEFAULT_ZOTERO_ATTACH_PDF = true
export const DEFAULT_ZOTERO_TAG = 'dsh-litsearch'

// ---- 翻译 -------------------------------------------------------------------

/** 默认翻译引擎：Bing 免密钥、快，作为默认。 */
export const DEFAULT_TRANSLATE_ENGINE: TranslateEngine = 'bing'

/** 默认目标语言：自动判向（中文→英文，其它→中文简体）。 */
export const DEFAULT_TRANSLATE_TARGET: TranslateTarget = 'auto'

/**
 * 微软网页翻译端点（Edge 浏览器内置翻译用的那个，免鉴权）。
 *
 * 微软已于 2026-07 关停 `edge.microsoft.com/translate/auth` 令牌端点，
 * 但 `translatetext` 仍可用：POST JSON 字符串数组，`?to=` 指定目标语言，
 * 响应按数组顺序一一对应。它是网页接口而非正式 API，协议可能再变，
 * 因此设置里保留了 DeepSeek 作为可选引擎。
 */
export const BING_TRANSLATE_ENDPOINT = 'https://edge.microsoft.com/translate/translatetext'

/** 偶发要求 Bearer 时的临时 token 端点（多数情况下用不到）。 */
export const BING_TRANSLATE_AUTH_URL = 'https://edge.microsoft.com/translate/auth'

/** 单次翻译超时：Bing 通常 1s 内返回，DeepSeek 走模型留足余量。 */
export const TRANSLATE_TIMEOUT_MS = 20_000

/** 单条文本的翻译字符上限；超出直接报错，不静默截断。 */
export const TRANSLATE_MAX_CHARS = 8_000

/** DeepSeek 单块字符数：块太大容易被 maxTokens 截断，块太小调用次数多。 */
export const TRANSLATE_CHUNK_CHARS = 1_800

/** DeepSeek 并发翻译的块数。 */
export const TRANSLATE_CHUNK_CONCURRENCY = 3

/** DeepSeek 精翻使用的模型；宿主 provider 没有它时退到第一个模型。 */
export const TRANSLATE_MODEL = 'deepseek-flash'

/** 进程内翻译缓存条数上限（同一篇反复点不该反复花额度）。 */
export const TRANSLATE_CACHE_SIZE = 120

/** 写端点的自定义请求头（与 JSON content-type 一起构成非简单请求）。 */
export const WRITE_HEADER = 'x-dsh-litsearch-write'

/** 面板请求携带的会话 id；Host 用它解析会话工作目录。 */
export const SESSION_HEADER = 'x-dsh-litsearch-session'

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
  /** 可选 OpenAlex 免费 API Key；匿名 search 在集群高负载时会被临时限流。 */
  openalexApiKey: string
  /** 可选 Semantic Scholar API Key；提高配额。 */
  s2ApiKey: string
  /** 可选 SerpAPI Key；配置后启用 Google Scholar 数据源。 */
  serpApiKey: string
  /** 各源最小请求间隔覆盖值。 */
  pubmedIntervalMs: number
  s2IntervalMs: number
  arxivIntervalMs: number
  /** PDF 下载根目录；空串由 Host 回落到会话工作目录下的 dsh-litsearch/。 */
  pdfRoot: string
  pdfMaxMb: number
  pdfCacheMaxMb: number
  autoDownloadPdf: boolean
  enableEpmcFulltext: boolean
  /** 是否启用 PubMed Central 全文通道。 */
  enablePmcFulltext: boolean
  /** 单个 PDF 候选的抓取总预算（毫秒）。 */
  pdfTimeoutMs: number
  /** 5xx / 网络错误的重试次数（0 表示不重试）。 */
  pdfRetryCount: number
  /** 同域名并发下载上限。 */
  pdfPerHostConcurrency: number
  /** 下载时反查 OA 位置（OpenAlex / Europe PMC / OpenAIRE / Unpaywall）。 */
  enableOaLookup: boolean
  /** 是否启用 arXiv HTML 全文通道。 */
  enableArxivHtml: boolean
  zoteroEnabled: boolean
  zoteroBaseUrl: string
  zoteroAttachPdf: boolean
  zoteroTag: string
  /** 默认翻译引擎；标题与摘要会发送给所选服务。 */
  translateProvider: TranslateEngine
  /** 默认目标语言；`auto` = 中文→英文、其它→中文简体。 */
  translateTarget: TranslateTarget
}

/** 默认读取器：入口未注入时回落到常量。 */
let readSettings = (): LitsearchSettings => ({
  contactEmail: '',
  defaultPageSize: DEFAULT_PAGE_SIZE,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  defaultSources: [...DEFAULT_SOURCE_IDS],
  defaultSort: DEFAULT_SORT,
  defaultLanguage: DEFAULT_LANGUAGE,
  autoOpenTaskTab: DEFAULT_AUTO_OPEN,
  maxTaskTabs: DEFAULT_MAX_TASK_TABS,
  taskRetentionDays: DEFAULT_RETENTION_DAYS,
  taskRetentionCount: DEFAULT_RETENTION_COUNT,
  taskMaxPapers: DEFAULT_TASK_MAX_PAPERS,
  ncbiApiKey: '',
  openalexApiKey: '',
  s2ApiKey: '',
  serpApiKey: '',
  pubmedIntervalMs: DEFAULT_PUBMED_INTERVAL_MS,
  s2IntervalMs: DEFAULT_S2_INTERVAL_MS,
  arxivIntervalMs: DEFAULT_ARXIV_INTERVAL_MS,
  pdfRoot: '',
  pdfMaxMb: DEFAULT_PDF_MAX_MB,
  pdfCacheMaxMb: DEFAULT_PDF_CACHE_MAX_MB,
  autoDownloadPdf: DEFAULT_AUTO_DOWNLOAD_PDF,
  enableEpmcFulltext: DEFAULT_ENABLE_EPMC_FULLTEXT,
  enablePmcFulltext: DEFAULT_ENABLE_PMC_FULLTEXT,
  pdfTimeoutMs: DEFAULT_PDF_TIMEOUT_MS,
  pdfRetryCount: DEFAULT_PDF_RETRY_COUNT,
  pdfPerHostConcurrency: DEFAULT_PDF_PER_HOST_CONCURRENCY,
  enableOaLookup: DEFAULT_ENABLE_OA_LOOKUP,
  enableArxivHtml: DEFAULT_ENABLE_ARXIV_HTML,
  zoteroEnabled: DEFAULT_ZOTERO_ENABLED,
  zoteroBaseUrl: DEFAULT_ZOTERO_BASE_URL,
  zoteroAttachPdf: DEFAULT_ZOTERO_ATTACH_PDF,
  zoteroTag: DEFAULT_ZOTERO_TAG,
  translateProvider: DEFAULT_TRANSLATE_ENGINE,
  translateTarget: DEFAULT_TRANSLATE_TARGET,
})

/** 由插件入口在 `apply` 时注入。 */
export function setSettingsReader(reader: () => LitsearchSettings): void {
  readSettings = reader
}

/** 读取当前生效的设置。 */
export function getSettings(): LitsearchSettings {
  return readSettings()
}
