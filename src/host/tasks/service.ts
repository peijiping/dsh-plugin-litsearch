/**
 * TaskService：任务工作台的唯一事实源。
 *
 * 负责校验/规范化任务条件、维护内存与磁盘状态、串行化执行并广播 rev。
 * 模型工具与面板 HTTP 路由都只调用这里，保证两边操作同一份状态。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { MAX_LIMIT, PLUGIN_VERSION, getSettings } from '../../search/config.js'
import { SearchError } from '../../search/errors.js'
import { cooldownUntil, sourceHealthList } from '../../search/health.js'
import { PROVIDER_INFOS } from '../../search/providers/index.js'
import { searchSources } from '../../search/aggregate.js'
import { fullTextHtml, jatsToHtml, epmcXmlUrl } from '../../search/oa.js'
import { fetchPubtatorEntities } from '../../search/pubtator-entities.js'
import type {
  AnnotationInput,
  AnnotationResult,
  CleanupResult,
  CleanupScope,
  CompareResult,
  EventsPage,
  ExportFile,
  ExportFormat,
  HealthInfo,
  Paper,
  PaperDetail,
  PaperEntities,
  PaperState,
  PdfDownloadResult,
  PdfStatus,
  ProbeResult,
  QueryBlock,
  ResultsPage,
  SearchRound,
  SearchTask,
  SortMode,
  SourceId,
  StorageProbeResult,
  TaskConditions,
  TaskDetail,
  TaskGroup,
  TaskLanguage,
  TaskOrigin,
  TaskStatsReport,
  TaskSummary,
  ZoteroProbeResult,
  ZoteroSyncResult,
} from '../../search/types.js'
import { SOURCE_IDS } from '../../search/types.js'
import { TaskEvents } from '../events.js'
import { buildExport, type ExportContext } from '../export/index.js'
import {
  cleanupPdfCache,
  epmcFullTextAvailable,
  persistPdf,
  probePdfRoot,
  prunePdfCache,
  readSavedPdf,
  readableFilename,
  resolvePdf,
  resolvePdfRoot,
} from '../pdf/store.js'
import { ZoteroConnector } from '../zotero/connector.js'
import { normalizeWorkspace } from '../workspace.js'
import { compareTasks } from './compare.js'
import { filterPapers, type PaperFilter } from './filter.js'
import { TaskRunner } from './runner.js'
import { computeStats } from './stats.js'
import { applyAnnotations, countScreening, emptyState, normalizeGroups } from './states.js'
import { TaskStore } from './store.js'
import { cloneRound, roundsOf, toDetail, toSummary } from './summary.js'

const MAX_QUERIES = 20
const MAX_TITLE = 120
const MAX_PAGE_LIMIT = 200
const MAX_TYPES = 20
const PROBE_QUERY = 'machine learning'

/** 已下载文件存在性检查的短缓存：详情轮询时不必反复 stat 同一批文件。 */
const PDF_EXISTS_TTL_MS = 10_000
const pdfExistsCache = new Map<string, { exists: boolean; at: number }>()

async function pdfFileExists(filePath: string): Promise<boolean> {
  const cached = pdfExistsCache.get(filePath)
  if (cached !== undefined && Date.now() - cached.at < PDF_EXISTS_TTL_MS) return cached.exists
  const exists = await stat(filePath)
    .then((info) => info.isFile())
    .catch(() => false)
  pdfExistsCache.set(filePath, { exists, at: Date.now() })
  return exists
}

/**
 * 已下载的 PDF 可能被用户在文件管理器里删掉（也可能从废纸篓恢复）：
 * 每次读取任务时校准状态，删除后回到 `missing`，点击即可重新下载。
 */
async function reconcilePdfFiles(task: SearchTask): Promise<boolean> {
  const downloads = Object.entries(task.states).filter(
    ([, state]) =>
      state.pdfFile !== undefined &&
      (state.pdfStatus === 'downloaded' || state.pdfStatus === 'missing'),
  )
  if (downloads.length === 0) return false
  const checks = await Promise.all(
    downloads.map(async ([paperId, state]) => ({
      paperId,
      exists: await pdfFileExists(state.pdfFile ?? ''),
    })),
  )
  let changed = false
  for (const { paperId, exists } of checks) {
    const current = task.states[paperId]
    if (current === undefined) continue
    if (current.pdfStatus === 'downloaded' && !exists) {
      task.states[paperId] = { ...current, pdfStatus: 'missing' }
      changed = true
    } else if (current.pdfStatus === 'missing' && exists) {
      task.states[paperId] = { ...current, pdfStatus: 'downloaded' }
      changed = true
    }
  }
  return changed
}

export interface QueryInput {
  name?: string
  text: string
  perSource?: QueryBlock['perSource']
  enabled?: boolean
}

export interface CreateTaskInput {
  title?: string
  query?: string
  queries?: QueryInput[]
  sources?: SourceId[]
  pageSize?: number
  yearFrom?: number
  yearTo?: number
  openAccessOnly?: boolean
  language?: TaskLanguage
  types?: string[]
  sort?: SortMode
  origin: TaskOrigin
  fromTaskId?: string
  /** 发起方所在会话的工作目录；下载默认落在这里。 */
  workspace?: string
  runNow?: boolean
}

export interface TaskPatch {
  title?: string
  notes?: string
  pinned?: boolean
  groups?: TaskGroup[]
  conditions?: {
    queries?: QueryInput[]
    sources?: SourceId[]
    pageSize?: number
    yearFrom?: number | null
    yearTo?: number | null
    openAccessOnly?: boolean
    language?: TaskLanguage
    types?: string[] | null
    sort?: SortMode
  }
}

export interface ResultsFilter extends PaperFilter {
  offset?: number
  limit?: number
  sort?: SortMode
}

export interface TaskListFilter {
  q?: string
  origin?: TaskOrigin
  pinned?: boolean
}

export class TaskService {
  readonly ready: Promise<void>

  private readonly store = new TaskStore()

  private readonly events = new TaskEvents()

  private readonly runner = new TaskRunner()

  /**
   * 全局「当前任务」：最后一次使用或打开的任务。
   *
   * 不按对话、也不按时间过期——同一主题的后续检索必须在原任务里加一轮，
   * 跨对话、宿主重启都成立。只有用户显式新建任务或点开别的任务时才会改变。
   */
  private currentTaskId: string | undefined

  private currentTaskAt = 0

  constructor() {
    this.ready = this.restore()
  }

  /**
   * 先加载任务索引，再恢复「当前任务」快照。
   *
   * 快照缺失或指向已删除任务时，自举为最近更新的任务，避免下一轮检索
   * 又新建一个同名任务。
   */
  private async restore(): Promise<void> {
    try {
      await this.store.load({
        retentionDays: getSettings().taskRetentionDays,
        retentionCount: getSettings().taskRetentionCount,
      })
    } catch (error) {
      console.warn('[dsh-plugin-litsearch] 任务目录加载失败：', error)
    }
    // 与任务自动清理同批执行：按总量上限修剪 PDF 去重缓存（0 表示关闭）。
    await this.trimPdfCache()
    let restored = false
    try {
      const snapshot = await this.store.loadCurrent()
      if (
        snapshot?.current !== undefined &&
        this.store.summary(snapshot.current.taskId) !== undefined
      ) {
        this.currentTaskId = snapshot.current.taskId
        this.currentTaskAt = snapshot.current.at
        restored = true
      }
    } catch (error) {
      console.warn('[dsh-plugin-litsearch] 当前任务快照加载失败：', error)
    }
    if (!restored) this.bootstrapCurrentTask()
  }

  /** 按设置的总量上限修剪 PDF 去重缓存；失败只告警，不阻断启动。 */
  private async trimPdfCache(): Promise<void> {
    const maxMb = getSettings().pdfCacheMaxMb
    if (maxMb <= 0) return
    try {
      const outcome = await prunePdfCache(this.store.root, maxMb * 1024 * 1024)
      if (outcome.removed > 0) {
        console.info(
          `[dsh-plugin-litsearch] PDF 缓存已修剪：删除 ${outcome.removed} 个文件，释放 ${Math.round(outcome.freedBytes / 1024 / 1024)} MB（上限 ${maxMb} MB）`,
        )
      }
    } catch (error) {
      console.warn('[dsh-plugin-litsearch] PDF 缓存修剪失败：', error)
    }
  }

  /** 没有可用快照时，把最近更新的任务设为当前任务并落盘。 */
  private bootstrapCurrentTask(): void {
    const latest = this.store.list()[0]
    if (latest === undefined) {
      // 任务已全部删除：清掉快照里的旧 id，避免 current.json 指向不存在的任务。
      this.currentTaskId = undefined
      this.currentTaskAt = 0
      this.persistCurrent()
      return
    }
    this.currentTaskId = latest.id
    this.currentTaskAt = Date.parse(latest.updatedAt) || Date.now()
    this.persistCurrent()
  }

  get globalRev(): number {
    return this.events.currentRev
  }

  get root(): string {
    return this.store.root
  }

  isRunning(id: string): boolean {
    return this.runner.isRunning(id)
  }

  health(): HealthInfo {
    const settings = getSettings()
    return {
      ok: true,
      globalRev: this.events.currentRev,
      sources: [...PROVIDER_INFOS],
      sourceHealth: sourceHealthList(),
      keys: {
        ncbi: settings.ncbiApiKey !== '',
        s2: settings.s2ApiKey !== '',
        serpapi: settings.serpApiKey !== '',
      },
      settings: {
        defaultSources: [...settings.defaultSources],
        defaultPageSize: settings.defaultPageSize,
        defaultSort: settings.defaultSort,
        defaultLanguage: settings.defaultLanguage,
        autoOpenTaskTab: settings.autoOpenTaskTab,
        maxTaskTabs: settings.maxTaskTabs,
      },
      fullText: {
        pdfRoot: settings.pdfRoot.trim() === '' ? '' : resolvePdfRoot(),
        pdfMaxMb: settings.pdfMaxMb,
        autoDownload: settings.autoDownloadPdf,
        epmcFulltext: settings.enableEpmcFulltext,
      },
      zotero: {
        enabled: settings.zoteroEnabled,
        baseUrl: settings.zoteroBaseUrl,
        attachPdf: settings.zoteroAttachPdf,
        tag: settings.zoteroTag,
      },
      storageDir: this.store.root,
      version: PLUGIN_VERSION,
    }
  }

  async eventsSince(sinceRev: number): Promise<EventsPage> {
    await this.ready
    return this.events.since(sinceRev)
  }

  async list(filter: TaskListFilter = {}): Promise<TaskSummary[]> {
    await this.ready
    const needle = filter.q?.trim().toLowerCase() ?? ''
    return this.store.list().filter((task) => {
      if (filter.origin !== undefined && task.origin !== filter.origin) return false
      if (filter.pinned !== undefined && task.pinned !== filter.pinned) return false
      if (needle !== '' && !task.title.toLowerCase().includes(needle)) return false
      return true
    })
  }

  async get(id: string): Promise<SearchTask> {
    await this.ready
    const task = this.store.cached(id) ?? (await this.store.loadTask(id))
    if (task === undefined) throw new SearchError('not_found', `任务不存在：${id}`)
    // 旧版本落盘的任务没有 rounds，所有读路径统一补成数组。
    if (!Array.isArray(task.rounds)) task.rounds = []
    return task
  }

  async getDetail(id: string, workspace?: string): Promise<TaskDetail> {
    const task = await this.get(id)
    if (await reconcilePdfFiles(task)) await this.store.save(task)
    const target = normalizeWorkspace(workspace) ?? normalizeWorkspace(task.workspace)
    return { ...toDetail(task), downloadDir: resolvePdfRoot(target) }
  }

  /** 任务内轮次历史（时间升序、深拷贝）。 */
  async getRounds(id: string): Promise<SearchRound[]> {
    return roundsOf(await this.get(id)).map(cloneRound)
  }

  /**
   * 当前任务：最近一次使用或打开的任务。
   *
   * 没有时间窗口、也不区分对话；只要任务还在就一直有效。任务被全部删除后
   * 返回 undefined，由调用方决定是否新建。
   */
  async currentTask(): Promise<SearchTask | undefined> {
    await this.ready
    if (this.currentTaskId === undefined) return undefined
    const task = await this.tryGet(this.currentTaskId)
    if (task !== undefined) return task
    this.currentTaskId = undefined
    this.bootstrapCurrentTask()
    if (this.currentTaskId === undefined) return undefined
    return this.tryGet(this.currentTaskId)
  }

  /** 记住最近使用的任务（下一次模型检索默认落在这里）。 */
  setCurrentTask(id: string): void {
    this.currentTaskId = id
    this.currentTaskAt = Date.now()
    this.persistCurrent()
  }

  /** 请求客户端打开/聚焦某任务 tab（面板被关掉时重新打开）。 */
  focusTask(id: string, title: string, sessionId?: string): void {
    this.events.requestFocus(id, title, sessionId)
  }

  private persistCurrent(): void {
    void this.store.saveCurrent({
      version: 1,
      ...(this.currentTaskId === undefined
        ? {}
        : { current: { taskId: this.currentTaskId, at: this.currentTaskAt } }),
    })
  }

  /** 用户从任务列表点开某任务 = 进入该任务，之后的模型检索默认落在这里。 */
  async activate(id: string, workspace?: string): Promise<SearchTask> {
    const task = await this.get(id)
    await this.applyWorkspace(task, workspace)
    this.setCurrentTask(task.id)
    return task
  }

  /** 记下任务最近一次所在的工作目录；只改变下载落点，不改变 rev。 */
  private async applyWorkspace(task: SearchTask, workspace?: string): Promise<void> {
    const next = normalizeWorkspace(workspace)
    if (next === undefined || next === task.workspace) return
    task.workspace = next
    await this.store.save(task)
  }

  /** 等待该任务当前这一轮结束；返回是否确实已空闲。 */
  async waitUntilIdle(id: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (!this.runner.isRunning(id)) return true
    if (signal?.aborted === true) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      await Promise.race([
        this.runner.wait(id),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, timeoutMs))
        }),
        ...(signal === undefined
          ? []
          : [
              new Promise<void>((resolve) => {
                onAbort = () => resolve()
                signal.addEventListener('abort', onAbort, { once: true })
              }),
            ]),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (signal !== undefined && onAbort !== undefined) {
        signal.removeEventListener('abort', onAbort)
      }
    }
    return !this.runner.isRunning(id)
  }

  async create(input: CreateTaskInput): Promise<SearchTask> {
    await this.ready
    const settings = getSettings()
    const conditions = this.readConditions(input, settings)
    const title = readTitle(input.title, conditions)
    const inherited =
      input.fromTaskId === undefined ? undefined : await this.get(input.fromTaskId)
    const workspace = normalizeWorkspace(input.workspace)
    const now = new Date().toISOString()
    const task: SearchTask = {
      id: `t${Date.now().toString(36)}${randomUUID().slice(0, 6)}`,
      title,
      conditions,
      status: 'draft',
      origin: input.origin,
      rev: 1,
      createdAt: now,
      updatedAt: now,
      pinned: false,
      notes: '',
      groups: [],
      stats: {
        perQuery: {},
        rawHits: 0,
        deduped: 0,
        screening: { unread: 0, read: 0, included: 0, excluded: 0 },
      },
      result: { papers: [], sources: [] },
      rounds: [],
      states: inherited === undefined ? {} : inheritStates(inherited),
      ...(workspace === undefined ? {} : { workspace }),
      ...(input.fromTaskId === undefined ? {} : { fromTaskId: input.fromTaskId }),
    }

    this.store.put(task)
    await this.store.save(task)
    // 新建的任务就是「当前任务」：后续检索默认在它里面加轮次。
    this.setCurrentTask(task.id)
    this.events.publish(toSummary(task))

    if (input.runNow !== false) {
      void this.begin(task, 'new').catch((error: unknown) => {
        console.warn('[dsh-plugin-litsearch] 任务执行失败：', error)
      })
    }
    return task
  }

  async update(id: string, patch: TaskPatch, expectedRev?: number): Promise<SearchTask> {
    const task = await this.get(id)
    if (expectedRev !== undefined && expectedRev !== task.rev) {
      throw new SearchError('conflict', `任务已被更新（当前 rev=${task.rev}），请刷新后重试`)
    }
    if (this.runner.isRunning(id)) {
      throw new SearchError('conflict', '任务正在运行，请等待完成或先取消')
    }

    if (patch.title !== undefined) {
      const title = patch.title.trim()
      if (title === '') throw new SearchError('bad_request', '任务标题不能为空')
      task.title = title.slice(0, MAX_TITLE)
    }
    if (patch.notes !== undefined) task.notes = patch.notes
    if (patch.pinned !== undefined) task.pinned = patch.pinned
    if (patch.groups !== undefined) {
      const groups = normalizeGroups(patch.groups) ?? []
      task.groups = groups
      // 删除分组后，原来归入它的论文回到未分组，而不是指向不存在的 id。
      const ids = new Set(groups.map((group) => group.id))
      for (const state of Object.values(task.states)) {
        if (state.groupId !== undefined && !ids.has(state.groupId)) delete state.groupId
      }
    }
    if (patch.conditions !== undefined) {
      task.conditions = mergeConditions(task.conditions, patch.conditions)
    }

    task.rev += 1
    task.updatedAt = new Date().toISOString()
    await this.store.save(task)
    this.events.publish(toSummary(task))
    return task
  }

  async remove(id: string): Promise<void> {
    const task = await this.get(id)
    // 先等这一轮收尾（finally 里还会落一次盘），再删文件，避免任务被写回。
    if (this.runner.cancel(task.id)) await this.runner.wait(task.id)
    await this.store.remove(task.id)
    // 模型工具导出到 <storage>/out/<taskId>/ 的文件随任务一起清掉。
    await rm(join(this.store.root, 'out', task.id), { recursive: true, force: true })
    this.events.remove(task.id)
    if (this.currentTaskId !== task.id) return
    this.currentTaskId = undefined
    this.bootstrapCurrentTask()
  }

  /**
   * 启动一次执行（任务内新一轮）；返回的 Promise 在运行结束后 resolve 为最新任务。
   *
   * 任务已缓存时同步登记运行态，调用方紧接着调 `waitUntilIdle` 也不会误判为空闲。
   */
  run(
    id: string,
    mode: 'new' | 'more' = 'new',
    origin: TaskOrigin = 'panel',
    workspace?: string,
  ): Promise<SearchTask> {
    const cached = this.store.cached(id)
    if (cached !== undefined) {
      try {
        return this.begin(cached, mode, origin, workspace)
      } catch (error) {
        return Promise.reject(error)
      }
    }
    return this.get(id).then((task) => this.begin(task, mode, origin, workspace))
  }

  /**
   * 在同一任务内开新一轮：全量替换检索条件后执行，**不新建任务、不新开 tab**。
   *
   * 与 `update` 的增量 patch 不同，这里按 CreateTaskInput 重算条件，缺省项回落到
   * 当前设置而不是沿用旧值，保证「提交完整新条件」的语义明确。
   */
  async rerun(id: string, input: CreateTaskInput, origin: TaskOrigin): Promise<SearchTask> {
    const task = await this.get(id)
    if (this.runner.isRunning(id)) {
      throw new SearchError('conflict', '任务正在运行，请等待当前轮次结束')
    }
    const nextTitle = input.title?.trim() ?? ''
    if (nextTitle !== '') task.title = nextTitle.slice(0, MAX_TITLE)
    task.conditions = this.readConditions(input, getSettings())
    const workspace = normalizeWorkspace(input.workspace)
    if (workspace !== undefined) task.workspace = workspace
    task.rev += 1
    task.updatedAt = new Date().toISOString()
    await this.store.save(task)
    this.events.publish(toSummary(task))
    this.setCurrentTask(task.id)
    return this.begin(task, 'new', origin)
  }

  async cancel(id: string): Promise<SearchTask> {
    const task = await this.get(id)
    if (!this.runner.cancel(id)) throw new SearchError('conflict', '任务未在运行')
    return task
  }

  async results(id: string, filter: ResultsFilter = {}): Promise<ResultsPage> {
    const task = await this.get(id)
    const limit = clampInt(filter.limit ?? task.conditions.pageSize, 1, MAX_PAGE_LIMIT)
    const offset = clampInt(filter.offset ?? 0, 0, Number.MAX_SAFE_INTEGER)
    const papers = filterPapers(task, await this.withBaseFilter(task, filter))

    const sort = filter.sort ?? task.conditions.sort
    if (sort === 'citations') {
      papers.sort((a, b) => (b.citedBy ?? -1) - (a.citedBy ?? -1))
    } else if (sort === 'year') {
      papers.sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
    }

    return {
      taskId: task.id,
      rev: task.rev,
      total: papers.length,
      offset,
      limit,
      papers: papers.slice(offset, offset + limit),
    }
  }

  async stats(
    id: string,
    filter: PaperFilter = {},
    scope: 'task' | 'filtered' = 'task',
  ): Promise<TaskStatsReport> {
    const task = await this.get(id)
    const base = await this.baseInfo(task)
    const resolved = base === undefined ? filter : await this.withBaseFilter(task, filter)
    return computeStats(task, resolved, scope, base)
  }

  /** 写入筛读 / 分组；返回新的 rev 与命中条数。 */
  async annotate(
    id: string,
    inputs: readonly AnnotationInput[],
    expectedRev?: number,
  ): Promise<AnnotationResult> {
    const task = await this.get(id)
    if (expectedRev !== undefined && expectedRev !== task.rev) {
      throw new SearchError('conflict', `任务已被更新（当前 rev=${task.rev}），请刷新后重试`)
    }
    const outcome = applyAnnotations(task, inputs)
    task.states = outcome.states
    task.stats.screening = countScreening(task.result.papers, task.states)
    task.rev += 1
    task.updatedAt = new Date().toISOString()
    await this.store.save(task)
    this.events.publish(toSummary(task))
    return { taskId: task.id, rev: task.rev, updated: outcome.updated }
  }

  async compare(id: string, withTaskId: string): Promise<CompareResult> {
    if (withTaskId.trim() === '') throw new SearchError('bad_request', '缺少对比任务 id')
    if (withTaskId === id) throw new SearchError('bad_request', '不能与自身对比')
    const task = await this.get(id)
    const base = await this.get(withTaskId)
    return compareTasks(task, base)
  }

  /** 生成导出内容；`paperIds` 为空表示按当前筛选导出全部。 */
  async export(
    id: string,
    format: ExportFormat,
    filter: PaperFilter = {},
    paperIds?: readonly string[],
  ): Promise<ExportFile> {
    const task = await this.get(id)
    const resolved = await this.withBaseFilter(task, filter)
    let papers = filterPapers(task, resolved)
    if (paperIds !== undefined && paperIds.length > 0) {
      const wanted = new Set(paperIds)
      papers = papers.filter((paper) => wanted.has(paper.paperId))
    }
    const base = task.fromTaskId === undefined ? undefined : await this.tryGet(task.fromTaskId)
    const context: ExportContext = { task, papers, generatedAt: new Date() }
    if (base !== undefined) context.base = base
    return buildExport(context, format)
  }

  /** 把导出内容写到 `<storage>/out/<taskId>/`，供模型工具返回落盘路径。 */
  async exportToDisk(
    id: string,
    format: ExportFormat,
    filter: PaperFilter = {},
    paperIds?: readonly string[],
  ): Promise<{ path: string; file: ExportFile; count: number }> {
    const task = await this.get(id)
    const file = await this.export(id, format, filter, paperIds)
    const dir = join(this.store.root, 'out', task.id)
    await mkdir(dir, { recursive: true })
    const path = join(dir, file.filename)
    await writeFile(path, file.content, 'utf8')
    let papers = filterPapers(task, await this.withBaseFilter(task, filter))
    if (paperIds !== undefined && paperIds.length > 0) {
      const wanted = new Set(paperIds)
      papers = papers.filter((paper) => wanted.has(paper.paperId))
    }
    return { path, file, count: papers.length }
  }

  /** 设置页清理：任务文件与 PDF 缓存。 */
  async cleanup(scope: CleanupScope): Promise<CleanupResult> {
    if (scope === 'pdf') {
      const outcome = await cleanupPdfCache(this.store.root)
      return {
        scope,
        removed: outcome.removed,
        freedBytes: outcome.freedBytes,
        remaining: this.store.list().length,
      }
    }
    const tasks = await this.store.cleanupUnpinned()
    const pdf =
      scope === 'all' ? await cleanupPdfCache(this.store.root) : { removed: 0, freedBytes: 0 }
    return {
      scope,
      removed: tasks.removed + pdf.removed,
      freedBytes: tasks.freedBytes + pdf.freedBytes,
      remaining: this.store.list().length,
    }
  }

  /**
   * 「查看已下载」前的存在性检查：页面加载后文件可能被删除或移走。
   * 缺失时把状态改为 `missing` 并广播，所有面板随即显示「下载文件已删除」。
   */
  async recheckPdf(id: string, paperId: string): Promise<{ exists: boolean }> {
    const task = await this.get(id)
    findPaper(task, paperId)
    const state = task.states[paperId]
    const filePath = state?.pdfFile
    if (state === undefined || filePath === undefined) return { exists: false }
    pdfExistsCache.delete(filePath)
    const exists = await pdfFileExists(filePath)
    if (exists && state.pdfStatus !== 'downloaded') {
      await this.setPdfState(task, paperId, { pdfStatus: 'downloaded', pdfFile: filePath })
    } else if (!exists && state.pdfStatus !== 'missing') {
      await this.setPdfState(task, paperId, { pdfStatus: 'missing', pdfFile: filePath })
    }
    return { exists }
  }

  /** 下载单篇 PDF；失败时写入失败状态，若有 EPMC 全文则降级为 html-only。 */
  async downloadPdf(
    id: string,
    paperId: string,
    workspace?: string,
  ): Promise<PdfDownloadResult> {
    const task = await this.get(id)
    const paper = findPaper(task, paperId)
    const target = normalizeWorkspace(workspace) ?? normalizeWorkspace(task.workspace)
    if (target !== undefined) task.workspace = target
    const settings = getSettings()
    const resolution = await resolvePdf(paper)
    if (!resolution.ok || resolution.buffer === undefined) {
      const fallback =
        settings.enableEpmcFulltext && epmcFullTextAvailable(paper) ? 'html-only' : resolution.status
      await this.setPdfState(task, paperId, {
        pdfStatus: fallback,
        pdfError: resolution.error ?? '下载失败',
      })
      const result: PdfDownloadResult = {
        paperId,
        status: fallback,
        bytes: 0,
        error: resolution.error ?? '下载失败',
      }
      return result
    }

    const saved = await persistPdf(resolution.buffer, this.store.root, paper, target)
    await this.setPdfState(task, paperId, {
      pdfStatus: 'downloaded',
      pdfFile: saved.filePath,
    })
    const result: PdfDownloadResult = {
      paperId,
      status: 'downloaded',
      bytes: resolution.buffer.length,
      filename: saved.filename,
      path: saved.filePath,
    }
    if (resolution.url !== undefined) result.url = resolution.url
    return result
  }

  /** Europe PMC 全文（JATS → 只含安全标签的 HTML）。 */
  async fullText(id: string, paperId: string): Promise<string> {
    const task = await this.get(id)
    const paper = findPaper(task, paperId)
    const settings = getSettings()
    if (!settings.enableEpmcFulltext) {
      throw new SearchError('not_found', 'Europe PMC 全文兜底已在设置中关闭')
    }
    const url = epmcXmlUrl(paper)
    if (url === null) throw new SearchError('not_found', '这篇文献没有 Europe PMC 全文')
    // EPMC 的 JATS 全文经常 10s+，通用搜索超时对单篇阅读过紧。
    const xml = await fetchEpmcXml(url, Math.max(settings.requestTimeoutMs, 30_000))
    const html = fullTextHtml(paper, jatsToHtml(xml), 'Europe PMC')
    const recorded = task.states[paperId]?.pdfStatus
    if (paper.pdfUrl === '' && (recorded === undefined || recorded === 'unknown' || recorded === 'failed')) {
      await this.setPdfState(task, paperId, { pdfStatus: 'html-only' }).catch(() => undefined)
    }
    return html
  }

  /** 单篇论文详情：独立论文页使用，含任务标题与分组。 */
  async paperDetail(id: string, paperId: string, workspace?: string): Promise<PaperDetail> {
    const task = await this.get(id)
    if (await reconcilePdfFiles(task)) await this.store.save(task)
    const paper = findPaper(task, paperId)
    const target = normalizeWorkspace(workspace) ?? normalizeWorkspace(task.workspace)
    const detail: PaperDetail = {
      taskId: task.id,
      taskTitle: task.title,
      rev: task.rev,
      paper,
      groups: task.groups,
      downloadDir: resolvePdfRoot(target),
    }
    const state = task.states[paperId]
    if (state !== undefined) detail.state = state
    return detail
  }

  /** PubTator3 实体标注；无 PMID 时明确告知不可标注。 */
  async entities(id: string, paperId: string, signal?: AbortSignal): Promise<PaperEntities> {
    const task = await this.get(id)
    const paper = findPaper(task, paperId)
    const pmid = paper.ids.pmid
    if (pmid === '') {
      throw new SearchError('not_found', '这篇文献没有 PMID，PubTator 无法标注')
    }
    const settings = getSettings()
    // 全文标注的 BioC JSON 可能较大，沿用全文的 30s 下限。
    const entities = await fetchPubtatorEntities(
      pmid,
      Math.max(settings.requestTimeoutMs, 30_000),
      signal,
    )
    return { paperId, pmid, entities, fetchedAt: new Date().toISOString() }
  }

  /** 测试 Zotero connector 是否可达，并返回当前选中的分类。 */
  async zoteroProbe(): Promise<ZoteroProbeResult> {
    const settings = getSettings()
    try {
      return await new ZoteroConnector(settings.zoteroBaseUrl).probe()
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 把选中论文同步到 Zotero（含本地 PDF 附件）。 */
  async zoteroSync(
    id: string,
    paperIds?: readonly string[],
    workspace?: string,
  ): Promise<ZoteroSyncResult> {
    const settings = getSettings()
    if (!settings.zoteroEnabled) throw new SearchError('bad_request', 'Zotero 同步已在设置中关闭')
    const task = await this.get(id)
    const target = normalizeWorkspace(workspace) ?? normalizeWorkspace(task.workspace)
    const wanted =
      paperIds === undefined || paperIds.length === 0
        ? task.result.papers.slice(0, 50)
        : paperIds.map((paperId) => findPaper(task, paperId))
    if (wanted.length === 0) throw new SearchError('bad_request', '没有可同步的文献')

    const connector = new ZoteroConnector(settings.zoteroBaseUrl)
    const probe = await connector.probe()
    if (!probe.ok) {
      throw new SearchError(
        'network_error',
        `Zotero 未运行或 connector 不可达：${probe.error ?? settings.zoteroBaseUrl}`,
      )
    }

    const readOnlyAttachments =
      settings.zoteroAttachPdf && probe.collection?.filesEditable === false
    const attachPdf = settings.zoteroAttachPdf && !readOnlyAttachments
    const inputs: { paper: Paper; tags: string[]; pdfPath?: string }[] = []
    for (const paper of wanted) {
      const state = task.states[paper.paperId]
      // 标签已移除，用任务内的分组名承载 Zotero 侧的分类信息。
      const group = task.groups.find((entry) => entry.id === state?.groupId)
      const tags = group === undefined ? [] : [group.name]
      const pdfPath = attachPdf
        ? await this.ensureLocalPdf(paper, target, state?.pdfFile)
        : undefined
      inputs.push({ paper, tags, ...(pdfPath === undefined ? {} : { pdfPath }) })
    }

    try {
      const result = await connector.sync(inputs, {
        baseUrl: settings.zoteroBaseUrl,
        attachPdf,
        tag: settings.zoteroTag,
      })
      if (probe.collection === undefined) {
        result.messages.unshift('Zotero 当前未选择分类，条目已保存到「我的文库」')
      } else if (readOnlyAttachments) {
        result.messages.unshift('当前分类不可写附件，已只保存条目；可在 Zotero 中换一个可写分类后重试')
      }
      return result
    } catch (error) {
      throw new SearchError(
        'upstream_error',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  /** 下载目录可写性测试（设置页）。 */
  async storageProbe(workspace?: string): Promise<StorageProbeResult> {
    const outcome = await probePdfRoot(workspace)
    if (outcome.writable) return { ok: true, root: outcome.root, writable: true }
    return {
      ok: false,
      root: outcome.root,
      writable: false,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    }
  }

  private async ensureLocalPdf(
    paper: Paper,
    workspace?: string,
    recordedPath?: string,
  ): Promise<string | undefined> {
    if (recordedPath !== undefined) {
      const recorded = await readSavedPdf(recordedPath)
      if (recorded !== null) return recordedPath
    }
    const localPath = join(resolvePdfRoot(workspace), readableFilename(paper))
    if ((await readSavedPdf(localPath)) !== null) return localPath
    const resolution = await resolvePdf(paper).catch(() => null)
    if (resolution === null || !resolution.ok || resolution.buffer === undefined) return undefined
    const saved = await persistPdf(resolution.buffer, this.store.root, paper, workspace)
    return saved.filePath
  }

  private async setPdfState(
    task: SearchTask,
    paperId: string,
    patch: { pdfStatus: PdfStatus; pdfError?: string; pdfFile?: string },
  ): Promise<void> {
    // 下载进行中任务被删除：不再写回，也不向客户端广播已删除的任务。
    if (this.store.summary(task.id) === undefined) return
    const current = task.states[paperId] ?? emptyState()
    const next: PaperState = { ...current, pdfStatus: patch.pdfStatus }
    if (patch.pdfError === undefined) delete next.pdfError
    else next.pdfError = patch.pdfError.slice(0, 300)
    if (patch.pdfFile === undefined) delete next.pdfFile
    else next.pdfFile = patch.pdfFile.slice(0, 1024)
    // 刚写入的文件立即视为存在，避免存在性缓存把状态又翻回 `missing`。
    if (patch.pdfStatus === 'downloaded' && next.pdfFile !== undefined) {
      pdfExistsCache.set(next.pdfFile, { exists: true, at: Date.now() })
    }
    task.states[paperId] = next
    task.rev += 1
    task.updatedAt = new Date().toISOString()
    await this.store.save(task)
    this.events.publish(toSummary(task))
  }

  /** 单源诊断：用固定短查询测一次连通性与延迟（不受冷却影响）。 */
  async probe(source: SourceId): Promise<ProbeResult> {
    if (!SOURCE_IDS.includes(source)) {
      throw new SearchError('bad_request', `未知数据源：${source}`)
    }
    const settings = getSettings()
    const started = Date.now()
    const result: ProbeResult = { target: source, ok: false, latencyMs: 0, count: 0 }
    try {
      const [outcome] = await searchSources({
        query: PROBE_QUERY,
        sources: [source],
        limit: 1,
        openAccessOnly: false,
        contactEmail: settings.contactEmail,
        timeoutMs: Math.min(settings.requestTimeoutMs, 20_000),
        bypassCooldown: true,
      })
      result.latencyMs = Date.now() - started
      if (outcome === undefined || !outcome.ok) {
        result.error = outcome?.error ?? '未返回结果'
      } else {
        result.ok = true
        result.count = outcome.records.length
      }
    } catch (error) {
      result.latencyMs = Date.now() - started
      result.error = error instanceof Error ? error.message : String(error)
    }
    const until = cooldownUntil(source)
    if (until > Date.now()) result.cooldownUntil = new Date(until).toISOString()
    return result
  }

  private async tryGet(id: string): Promise<SearchTask | undefined> {
    try {
      return await this.get(id)
    } catch {
      return undefined
    }
  }

  private async baseInfo(
    task: SearchTask,
  ): Promise<{ paperIds: ReadonlySet<string>; rev: number } | undefined> {
    if (task.fromTaskId === undefined) return undefined
    const base = await this.tryGet(task.fromTaskId)
    if (base === undefined) return undefined
    return { paperIds: new Set(base.result.papers.map((paper) => paper.paperId)), rev: base.rev }
  }

  /** `newOnly` 需要基准任务的论文集合；基准已删除时忽略该条件。 */
  private async withBaseFilter<T extends PaperFilter>(task: SearchTask, filter: T): Promise<T> {
    if (filter.newOnly !== true || task.fromTaskId === undefined) return filter
    const base = await this.tryGet(task.fromTaskId)
    if (base === undefined) return filter
    return {
      ...filter,
      newPaperIds: new Set(base.result.papers.map((paper) => paper.paperId)),
    }
  }

  dispose(): void {
    this.runner.cancelAll()
    void this.store.flush()
  }

  private begin(
    task: SearchTask,
    mode: 'new' | 'more',
    origin: TaskOrigin = task.origin,
    workspace?: string,
  ): Promise<SearchTask> {
    if (this.runner.isRunning(task.id)) {
      throw new SearchError('conflict', '任务正在运行')
    }
    const nextWorkspace = normalizeWorkspace(workspace)
    if (nextWorkspace !== undefined && nextWorkspace !== task.workspace) {
      task.workspace = nextWorkspace
      void this.store.save(task)
    }
    if (mode === 'more') {
      throw new SearchError('bad_request', '续页加载将在后续版本提供，请先重跑任务')
    }
    const queries = task.conditions.queries.filter(
      (query) => query.enabled && query.text.trim() !== '',
    )
    if (queries.length === 0) throw new SearchError('bad_request', '没有启用的检索式')

    const done = this.runner.start(
      task,
      {
        persist: (current) => this.store.save(current),
        publish: (current) => {
          // 删除后这一轮收尾仍会 publish，跳过已删除任务，避免客户端又去打开它。
          if (this.store.summary(current.id) !== undefined) {
            this.events.publish(toSummary(current))
          }
        },
      },
      origin,
    )
    return done.then(() => {
      if (getSettings().autoDownloadPdf) {
        void this.autoDownloadPdfs(task).catch((error: unknown) => {
          console.warn('[dsh-plugin-litsearch] 自动下载 PDF 失败：', error)
        })
      }
      return task
    })
  }

  /** 任务完成后按设置自动下载少量开放获取 PDF（上限 10 篇，避免长时间占用网络）。 */
  private async autoDownloadPdfs(task: SearchTask): Promise<void> {
    const targets = task.result.papers
      .filter((paper) => paper.pdfUrl !== '' || paper.ids.pmcid !== '' || paper.ids.arxivId !== '')
      .slice(0, 10)
    for (const paper of targets) {
      // 任务中途被删除时停止后续下载，避免继续往用户下载目录写文件。
      if (this.store.summary(task.id) === undefined) return
      if (task.states[paper.paperId]?.pdfStatus === 'downloaded') continue
      const resolution = await resolvePdf(paper).catch(() => null)
      if (resolution === null || !resolution.ok || resolution.buffer === undefined) {
        if (resolution !== null) {
          const fallback =
            getSettings().enableEpmcFulltext && epmcFullTextAvailable(paper)
              ? 'html-only'
              : resolution.status
          await this.setPdfState(task, paper.paperId, {
            pdfStatus: fallback,
            pdfError: resolution.error ?? '下载失败',
          }).catch(() => undefined)
        }
        continue
      }
      const saved = await persistPdf(resolution.buffer, this.store.root, paper, task.workspace)
      await this.setPdfState(task, paper.paperId, {
        pdfStatus: 'downloaded',
        pdfFile: saved.filePath,
      }).catch(() => undefined)
    }
  }

  private readConditions(
    input: CreateTaskInput,
    settings: ReturnType<typeof getSettings>,
  ): TaskConditions {
    const queries = normalizeQueries(input.query, input.queries)
    const sources = normalizeSources(input.sources, settings.defaultSources)
    const condition: TaskConditions = {
      queries,
      sources,
      openAccessOnly: input.openAccessOnly === true,
      language: input.language ?? settings.defaultLanguage,
      sort: input.sort ?? settings.defaultSort,
      pageSize: clampInt(input.pageSize ?? settings.defaultPageSize, 1, MAX_LIMIT),
    }
    if (input.yearFrom !== undefined) condition.yearFrom = input.yearFrom
    if (input.yearTo !== undefined) condition.yearTo = input.yearTo
    const types = normalizeTypes(input.types)
    if (types !== undefined) condition.types = types
    if (condition.yearFrom !== undefined && condition.yearTo !== undefined && condition.yearFrom > condition.yearTo) {
      throw new SearchError('bad_request', '起始年份不能晚于结束年份')
    }
    return condition
  }
}

function mergeConditions(
  current: TaskConditions,
  patch: NonNullable<TaskPatch['conditions']>,
): TaskConditions {
  const next: TaskConditions = {
    ...current,
    queries: patch.queries === undefined ? current.queries : normalizeQueries(undefined, patch.queries),
    sources: normalizeSources(patch.sources, current.sources),
    pageSize: clampInt(patch.pageSize ?? current.pageSize, 1, MAX_LIMIT),
    openAccessOnly: patch.openAccessOnly ?? current.openAccessOnly,
    language: patch.language ?? current.language,
    sort: patch.sort ?? current.sort,
  }
  if (patch.yearFrom === null) delete next.yearFrom
  else if (patch.yearFrom !== undefined) next.yearFrom = patch.yearFrom
  if (patch.yearTo === null) delete next.yearTo
  else if (patch.yearTo !== undefined) next.yearTo = patch.yearTo
  if (patch.types === null) delete next.types
  else if (patch.types !== undefined) {
    const types = normalizeTypes(patch.types)
    if (types === undefined) delete next.types
    else next.types = types
  }
  if (next.yearFrom !== undefined && next.yearTo !== undefined && next.yearFrom > next.yearTo) {
    throw new SearchError('bad_request', '起始年份不能晚于结束年份')
  }
  return next
}

function normalizeQueries(query: string | undefined, queries: QueryInput[] | undefined): QueryBlock[] {
  const raw: QueryInput[] = []
  if (queries !== undefined && queries.length > 0) raw.push(...queries)
  else if (query !== undefined && query.trim() !== '') raw.push({ text: query })
  if (raw.length === 0) throw new SearchError('bad_request', '请至少提供一条检索式')
  if (raw.length > MAX_QUERIES) {
    throw new SearchError('bad_request', `检索式最多 ${MAX_QUERIES} 条`)
  }

  return raw.map((input, index) => {
    const text = input.text.trim()
    if (text === '') throw new SearchError('bad_request', `第 ${index + 1} 条检索式为空`)
    const name = input.name?.trim() ?? ''
    return {
      id: `q${index + 1}`,
      name: name === '' ? `检索式 ${index + 1}` : name,
      text,
      enabled: input.enabled !== false,
      ...(input.perSource === undefined ? {} : { perSource: { ...input.perSource } }),
    }
  })
}

function normalizeSources(
  requested: readonly string[] | undefined,
  fallback: readonly SourceId[],
): SourceId[] {
  const wanted = requested === undefined || requested.length === 0 ? fallback : requested
  const valid = SOURCE_IDS.filter((id) => wanted.includes(id))
  return valid.length === 0 ? [...SOURCE_IDS] : valid
}

function normalizeTypes(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined
  const seen = new Set<string>()
  for (const raw of values) {
    const value = raw.trim().slice(0, 40)
    if (value !== '') seen.add(value)
    if (seen.size >= MAX_TYPES) break
  }
  return seen.size === 0 ? undefined : [...seen]
}

function readTitle(title: string | undefined, conditions: TaskConditions): string {
  const explicit = title?.trim() ?? ''
  if (explicit !== '') return explicit.slice(0, MAX_TITLE)
  const first = conditions.queries[0]?.text ?? '未命名检索'
  const suffix = conditions.queries.length > 1 ? ` 等 ${conditions.queries.length} 条` : ''
  const base = first.length > 60 ? `${first.slice(0, 60)}…` : first
  return `${base}${suffix}`.slice(0, MAX_TITLE)
}

function inheritStates(base: SearchTask): Record<string, PaperState> {
  const states: Record<string, PaperState> = {}
  for (const [paperId, state] of Object.entries(base.states)) {
    // 分组是任务内概念，继承时只带筛读状态。
    const next: PaperState = { screening: state.screening }
    states[paperId] = next
  }
  return states
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(Math.floor(value), min), max)
}

function findPaper(task: SearchTask, paperId: string): Paper {
  const paper = task.result.papers.find((entry) => entry.paperId === paperId)
  if (paper === undefined) throw new SearchError('not_found', `任务里没有这篇文献：${paperId}`)
  return paper
}

async function fetchEpmcXml(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(5_000, timeoutMs))
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5' },
    })
    if (!response.ok) {
      const code = response.status === 404 ? 'not_found' : 'upstream_error'
      throw new SearchError(code, `Europe PMC 返回 HTTP ${response.status}`)
    }
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > 6 * 1024 * 1024) {
      throw new SearchError('bad_request', 'Europe PMC 全文超过 6 MB，已跳过')
    }
    const text = await response.text()
    if (text.length > 6 * 1024 * 1024) {
      throw new SearchError('bad_request', 'Europe PMC 全文超过 6 MB，已跳过')
    }
    if (!text.includes('<body')) {
      throw new SearchError('not_found', 'Europe PMC 没有可用的全文 XML')
    }
    return text
  } catch (error) {
    if (error instanceof SearchError) throw error
    if (controller.signal.aborted) {
      throw new SearchError('timeout', 'Europe PMC 全文请求超时')
    }
    throw new SearchError(
      'network_error',
      error instanceof Error ? error.message : String(error),
    )
  } finally {
    clearTimeout(timer)
  }
}
