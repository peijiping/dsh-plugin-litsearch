/**
 * dsh-plugin-litsearch —— 插件入口（Host 半）。
 *
 * 做三件事：
 * 1. 导出 Schemastery `Config`（逐字段 `.volatile()`），让 dsh「设置中心」能
 *    渲染「文献检索」页；保存后无需重启即生效。
 * 2. 装配 `TaskService`（任务持久化 / 执行 / 事件），并把检索能力注册进 dsh
 *    工具表（`literature_search` / `literature_sources`）。
 * 3. 在宿主 web server 上注册 `/dsh-litsearch/api/*` 端点，供右侧栏面板与
 *    设置页取数。
 *
 * `webServer` / `tools` 的类型不在已安装的 dsh 包里，因此自定义最小结构接口并
 * 强转（与 dsh-plugin-zotero 同法）。
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createHandler, type WebServerLike } from './host/router.js'
import { literatureTools, type ToolsService } from './host/tools.js'
import { TaskService } from './host/tasks/service.js'
import { setSessionStore, type SessionStoreLike } from './host/workspace.js'
import {
  DEFAULT_ARXIV_INTERVAL_MS,
  DEFAULT_AUTO_DOWNLOAD_PDF,
  DEFAULT_AUTO_OPEN,
  DEFAULT_ENABLE_EPMC_FULLTEXT,
  DEFAULT_LANGUAGE,
  DEFAULT_MAX_TASK_TABS,
  DEFAULT_PAGE_SIZE,
  DEFAULT_PDF_CACHE_MAX_MB,
  DEFAULT_PDF_MAX_MB,
  DEFAULT_PUBMED_INTERVAL_MS,
  DEFAULT_RETENTION_COUNT,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_S2_INTERVAL_MS,
  DEFAULT_SOURCE_IDS,
  DEFAULT_SORT,
  DEFAULT_TASK_MAX_PAPERS,
  DEFAULT_ZOTERO_ATTACH_PDF,
  DEFAULT_ZOTERO_BASE_URL,
  DEFAULT_ZOTERO_ENABLED,
  DEFAULT_ZOTERO_TAG,
  MAX_LIMIT,
  REQUEST_TIMEOUT_MS,
  ROUTE_MATCH,
  setSettingsReader,
} from './search/config.js'
import type { SortMode, SourceId, TaskLanguage } from './search/types.js'
import { SOURCE_IDS, TASK_LANGUAGES } from './search/types.js'

export const name = 'dsh-plugin-litsearch'

/** 旧版默认下载目录；读取时视为「未配置」，让默认落点切换到工作目录。 */
const LEGACY_PDF_ROOT = join(homedir(), 'Downloads', 'dsh-litsearch')

/**
 * 插件配置 schema（逐字段 volatile）。
 *
 * volatile 是 dsh 配置表单的硬前提；用 `.volatile()` 后保存只提交新值并
 * 唤醒引用，条目本身不重挂，因此改配置无需重启 dsh。
 */
export const Config = Schema.object({
  /** 作为 OpenAlex / Crossref / NCBI 的联系邮箱；留空也可用。 */
  contactEmail: Schema.string().default('').volatile(),
  /** 可选 NCBI API Key（E-utilities 额度从 3 req/s 提升到 10 req/s）。 */
  ncbiApiKey: Schema.string().default('').role('secret').volatile(),
  /** 可选 Semantic Scholar API Key。 */
  s2ApiKey: Schema.string().default('').role('secret').volatile(),
  /** 可选 SerpAPI Key；配置后启用 Google Scholar 数据源（付费/有免费额度）。 */
  serpApiKey: Schema.string().default('').role('secret').volatile(),
  /** 各源最小请求间隔（毫秒）。 */
  pubmedIntervalMs: Schema.number().default(DEFAULT_PUBMED_INTERVAL_MS).volatile(),
  s2IntervalMs: Schema.number().default(DEFAULT_S2_INTERVAL_MS).volatile(),
  arxivIntervalMs: Schema.number().default(DEFAULT_ARXIV_INTERVAL_MS).volatile(),
  /** 默认每次加载条数。 */
  defaultPageSize: Schema.number().default(DEFAULT_PAGE_SIZE).volatile(),
  /** 单次上游请求超时（毫秒）。 */
  requestTimeoutMs: Schema.number().default(REQUEST_TIMEOUT_MS).volatile(),
  /** 默认数据源。 */
  defaultSources: Schema.array(
    Schema.union([
      Schema.const('pubmed'),
      Schema.const('europepmc'),
      Schema.const('openalex'),
      Schema.const('crossref'),
      Schema.const('semanticscholar'),
      Schema.const('arxiv'),
      Schema.const('pubtator'),
      Schema.const('googlescholar'),
    ]),
  )
    .default([...DEFAULT_SOURCE_IDS])
    .volatile(),
  defaultSort: Schema.union([
    Schema.const('relevance'),
    Schema.const('citations'),
    Schema.const('year'),
  ])
    .default(DEFAULT_SORT)
    .volatile(),
  defaultLanguage: Schema.union(
    TASK_LANGUAGES.map((code) => Schema.const(code)),
  )
    .default(DEFAULT_LANGUAGE)
    .volatile(),
  /** 模型发起检索后是否自动打开任务 tab。 */
  autoOpenTaskTab: Schema.boolean().default(DEFAULT_AUTO_OPEN).volatile(),
  /** 同时保留的任务 tab 上限。 */
  maxTaskTabs: Schema.number().default(DEFAULT_MAX_TASK_TABS).volatile(),
  /** 任务保留天数与条数（已保留任务不受限）。 */
  taskRetentionDays: Schema.number().default(DEFAULT_RETENTION_DAYS).volatile(),
  taskRetentionCount: Schema.number().default(DEFAULT_RETENTION_COUNT).volatile(),
  /** 单任务结果上限。 */
  taskMaxPapers: Schema.number().default(DEFAULT_TASK_MAX_PAPERS).volatile(),
  /** PDF 下载根目录；留空时跟随会话工作目录（其下的 dsh-litsearch/）。 */
  pdfRoot: Schema.string().default('').volatile(),
  /** 单个 PDF 最大体积（MB）。 */
  pdfMaxMb: Schema.number().default(DEFAULT_PDF_MAX_MB).volatile(),
  /** PDF 去重缓存总量上限（MB），启动时随任务清理一起修剪；0 表示关闭。 */
  pdfCacheMaxMb: Schema.number().default(DEFAULT_PDF_CACHE_MAX_MB).volatile(),
  /** 检索完成后自动下载缺失 PDF。 */
  autoDownloadPdf: Schema.boolean().default(DEFAULT_AUTO_DOWNLOAD_PDF).volatile(),
  /** 无 PDF 时用 Europe PMC HTML 全文兜底。 */
  enableEpmcFulltext: Schema.boolean().default(DEFAULT_ENABLE_EPMC_FULLTEXT).volatile(),
  /** Zotero 入口开关。 */
  zoteroEnabled: Schema.boolean().default(DEFAULT_ZOTERO_ENABLED).volatile(),
  zoteroBaseUrl: Schema.string().default(DEFAULT_ZOTERO_BASE_URL).volatile(),
  zoteroAttachPdf: Schema.boolean().default(DEFAULT_ZOTERO_ATTACH_PDF).volatile(),
  zoteroTag: Schema.string().default(DEFAULT_ZOTERO_TAG).volatile(),
})

export function apply(ctx: Context, config: Schemastery.TypeT<typeof Config>): void {
  // 每次读取都走 volatile 引用，始终拿到最新值。
  setSettingsReader(() => ({
    contactEmail: config.contactEmail.get().trim(),
    ncbiApiKey: config.ncbiApiKey.get().trim(),
    s2ApiKey: config.s2ApiKey.get().trim(),
    serpApiKey: config.serpApiKey.get().trim(),
    pubmedIntervalMs: clampInt(
      config.pubmedIntervalMs.get(),
      50,
      10_000,
      DEFAULT_PUBMED_INTERVAL_MS,
    ),
    s2IntervalMs: clampInt(config.s2IntervalMs.get(), 50, 60_000, DEFAULT_S2_INTERVAL_MS),
    arxivIntervalMs: clampInt(config.arxivIntervalMs.get(), 50, 60_000, DEFAULT_ARXIV_INTERVAL_MS),
    defaultPageSize: clampInt(config.defaultPageSize.get(), 1, MAX_LIMIT, DEFAULT_PAGE_SIZE),
    requestTimeoutMs: clampInt(
      config.requestTimeoutMs.get(),
      1_000,
      120_000,
      REQUEST_TIMEOUT_MS,
    ),
    defaultSources: normalizeSources(config.defaultSources.get()).filter(
      (id) => id !== 'googlescholar' || config.serpApiKey.get().trim() !== '',
    ),
    defaultSort: normalizeSort(config.defaultSort.get()),
    defaultLanguage: normalizeLanguage(config.defaultLanguage.get()),
    autoOpenTaskTab: config.autoOpenTaskTab.get(),
    maxTaskTabs: clampInt(config.maxTaskTabs.get(), 1, 20, DEFAULT_MAX_TASK_TABS),
    taskRetentionDays: clampInt(config.taskRetentionDays.get(), 1, 3_650, DEFAULT_RETENTION_DAYS),
    taskRetentionCount: clampInt(
      config.taskRetentionCount.get(),
      1,
      10_000,
      DEFAULT_RETENTION_COUNT,
    ),
    taskMaxPapers: clampInt(config.taskMaxPapers.get(), 10, 10_000, DEFAULT_TASK_MAX_PAPERS),
    pdfRoot: normalizePdfRoot(config.pdfRoot.get()),
    pdfMaxMb: clampInt(config.pdfMaxMb.get(), 1, 200, DEFAULT_PDF_MAX_MB),
    pdfCacheMaxMb: clampInt(
      config.pdfCacheMaxMb.get(),
      0,
      102_400,
      DEFAULT_PDF_CACHE_MAX_MB,
    ),
    autoDownloadPdf: config.autoDownloadPdf.get(),
    enableEpmcFulltext: config.enableEpmcFulltext.get(),
    zoteroEnabled: config.zoteroEnabled.get(),
    zoteroBaseUrl: normalizeBaseUrl(config.zoteroBaseUrl.get()),
    zoteroAttachPdf: config.zoteroAttachPdf.get(),
    zoteroTag: config.zoteroTag.get().trim().slice(0, 40) || DEFAULT_ZOTERO_TAG,
  }))

  // 任务状态是模型工具与 HTTP 路由的唯一事实源。
  const service = new TaskService()
  ctx.effect(() => () => service.dispose(), 'dsh-plugin-litsearch: task service')

  // 会话工作目录：PDF 默认落在其中，跟随用户当前项目。
  ctx.inject(['sessionPersistence'], (sessionCtx: Context) => {
    const store = (sessionCtx as unknown as { sessionPersistence: SessionStoreLike })
      .sessionPersistence
    setSessionStore(store)
    sessionCtx.effect(
      () => () => setSessionStore(undefined),
      'dsh-plugin-litsearch: session workspace',
    )
  })

  // 模型侧：原生注册，不依赖外部 MCP。
  ctx.inject(['tools'], (toolCtx: Context) => {
    const toolsService = (toolCtx as unknown as { tools: ToolsService }).tools
    for (const definition of literatureTools(service)) {
      toolCtx.effect(
        () => toolsService.register(definition),
        `dsh-plugin-litsearch: ${definition.name}`,
      )
    }
  })

  // 人侧：右侧栏面板与设置页通过回环端点读写任务。
  ctx.inject(['webServer'], (hostCtx: Context) => {
    const webServer = (hostCtx as unknown as { webServer: WebServerLike }).webServer
    const handler = createHandler(service)
    hostCtx.effect(
      () => webServer.register({ kind: 'prefix', path: ROUTE_MATCH, handler }),
      'dsh-plugin-litsearch: http routes',
    )
  })
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.floor(value), min), max)
}

function normalizeSources(value: readonly string[]): SourceId[] {
  const valid = SOURCE_IDS.filter((id) => value.includes(id))
  return valid.length === 0 ? [...DEFAULT_SOURCE_IDS] : valid
}

function normalizeSort(value: string): SortMode {
  return value === 'citations' || value === 'year' ? value : 'relevance'
}

function normalizeLanguage(value: string): TaskLanguage {
  return TASK_LANGUAGES.includes(value as TaskLanguage) ? (value as TaskLanguage) : 'any'
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, '')
  return /^https?:\/\//u.test(trimmed) ? trimmed : DEFAULT_ZOTERO_BASE_URL
}

/** 旧默认值等同未配置：改由会话工作目录决定下载落点。 */
function normalizePdfRoot(value: string): string {
  const trimmed = value.trim()
  return trimmed === LEGACY_PDF_ROOT ? '' : trimmed
}
