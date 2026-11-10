/**
 * TaskService：任务工作台的唯一事实源。
 *
 * 负责校验/规范化任务条件、维护内存与磁盘状态、串行化执行并广播 rev。
 * 模型工具与面板 HTTP 路由都只调用这里，保证两边操作同一份状态。
 */

import { randomUUID } from 'node:crypto'

import { MAX_LIMIT, PLUGIN_VERSION, getSettings } from '../../search/config.js'
import { SearchError } from '../../search/errors.js'
import { cooldownUntil, sourceHealthList } from '../../search/health.js'
import { PROVIDER_INFOS } from '../../search/providers/index.js'
import { searchSources } from '../../search/aggregate.js'
import type {
  EventsPage,
  HealthInfo,
  ProbeResult,
  QueryBlock,
  ResultsPage,
  SearchTask,
  SortMode,
  SourceId,
  TaskConditions,
  TaskDetail,
  TaskLanguage,
  TaskOrigin,
  TaskStatsReport,
  TaskSummary,
} from '../../search/types.js'
import { SOURCE_IDS } from '../../search/types.js'
import { TaskEvents } from '../events.js'
import { filterPapers, type PaperFilter } from './filter.js'
import { TaskRunner } from './runner.js'
import { computeStats } from './stats.js'
import { TaskStore } from './store.js'
import { toDetail, toSummary } from './summary.js'

const MAX_QUERIES = 20
const MAX_TITLE = 120
const MAX_PAGE_LIMIT = 200
const MAX_TYPES = 20
const PROBE_QUERY = 'machine learning'

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
  sessionId?: string
  fromTaskId?: string
  runNow?: boolean
}

export interface TaskPatch {
  title?: string
  notes?: string
  pinned?: boolean
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

  constructor() {
    this.ready = this.store
      .load({
        retentionDays: getSettings().taskRetentionDays,
        retentionCount: getSettings().taskRetentionCount,
      })
      .catch((error: unknown) => {
        console.warn('[dsh-plugin-litsearch] 任务目录加载失败：', error)
      })
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
      keys: { ncbi: settings.ncbiApiKey !== '', s2: settings.s2ApiKey !== '' },
      settings: {
        defaultSources: [...settings.defaultSources],
        defaultPageSize: settings.defaultPageSize,
        defaultSort: settings.defaultSort,
        defaultLanguage: settings.defaultLanguage,
        autoOpenTaskTab: settings.autoOpenTaskTab,
        maxTaskTabs: settings.maxTaskTabs,
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
    return task
  }

  async getDetail(id: string): Promise<TaskDetail> {
    return toDetail(await this.get(id))
  }

  async create(input: CreateTaskInput): Promise<SearchTask> {
    await this.ready
    const settings = getSettings()
    const conditions = this.readConditions(input, settings)
    const title = readTitle(input.title, conditions)
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
      states: {},
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.fromTaskId === undefined ? {} : { fromTaskId: input.fromTaskId }),
    }

    this.store.put(task)
    await this.store.save(task)
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
    this.runner.cancel(id)
    await this.store.remove(task.id)
    this.events.remove(task.id)
  }

  /** 启动一次执行；返回的 Promise 在运行结束后 resolve 为最新任务。 */
  async run(id: string, mode: 'new' | 'more' = 'new'): Promise<SearchTask> {
    const task = await this.get(id)
    return this.begin(task, mode)
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
    const papers = filterPapers(task, filter)

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
    return computeStats(await this.get(id), filter, scope)
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

  dispose(): void {
    this.runner.cancelAll()
    void this.store.flush()
  }

  private begin(task: SearchTask, mode: 'new' | 'more'): Promise<SearchTask> {
    if (this.runner.isRunning(task.id)) {
      throw new SearchError('conflict', '任务正在运行')
    }
    if (mode === 'more') {
      throw new SearchError('bad_request', '续页加载将在后续版本提供，请先重跑任务')
    }
    const queries = task.conditions.queries.filter(
      (query) => query.enabled && query.text.trim() !== '',
    )
    if (queries.length === 0) throw new SearchError('bad_request', '没有启用的检索式')

    const done = this.runner.start(task, {
      persist: (current) => this.store.save(current),
      publish: (current) => this.events.publish(toSummary(current)),
    })
    return done.then(() => task)
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

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(Math.floor(value), min), max)
}
