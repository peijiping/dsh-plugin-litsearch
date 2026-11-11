/**
 * Client 侧调 Host 端点（同源 fetch，前缀与 Host 的 ROUTE_PREFIX 对应）。
 *
 * 响应信封由 Host 产出：`{ok:true,data}` / `{ok:false,error}`。写操作必须带
 * 自定义标识头 + JSON content-type，Host 只认这种「非简单请求」。
 */

import { SESSION_HEADER, WRITE_HEADER } from '../search/config'
import type {
  AnnotationInput,
  AnnotationResult,
  CleanupResult,
  CleanupScope,
  CompareResult,
  EventsPage,
  ExportFormat,
  HealthInfo,
  PaperDetail,
  PaperEntities,
  PdfDownloadResult,
  PdfStatus,
  ProbeResult,
  ResultsPage,
  SearchRound,
  SortMode,
  SourceId,
  StorageProbeResult,
  TaskDetail,
  TaskGroup,
  TaskLanguage,
  TaskStatsReport,
  TaskSummary,
  ZoteroProbeResult,
  ZoteroSyncResult,
} from '../search/types'

const BASE = '/dsh-litsearch/api'

/** 当前挂载的会话 id；Host 用它把任务关联到会话工作目录。 */
let sessionIdProvider: () => string | undefined = () => undefined

export function setSessionIdProvider(provider: () => string | undefined): void {
  sessionIdProvider = provider
}

function currentSessionId(): string {
  return sessionIdProvider()?.trim() ?? ''
}

/** 给请求带上会话 id；iframe 等发不了头部的场景改用查询参数。 */
function withSession(init?: RequestInit): RequestInit {
  const id = currentSessionId()
  if (id === '') return init ?? {}
  const headers = new Headers(init?.headers)
  headers.set(SESSION_HEADER, id)
  return { ...init, headers }
}

/** Host 返回的错误，携带错误码。 */
export class ApiFailure extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ApiFailure'
    this.code = code
  }
}

type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, withSession(init))
  } catch (error) {
    if (init?.signal?.aborted === true) throw new ApiFailure('network_error', '请求已取消')
    const message = error instanceof Error ? error.message : String(error)
    throw new ApiFailure('network_error', `无法访问 Host 端点：${message}`)
  }

  const payload = (await res.json().catch(() => null)) as Envelope<T> | null
  if (payload === null) {
    throw new ApiFailure('internal_error', `Host 返回了非 JSON 响应（HTTP ${res.status}）`)
  }
  if (!payload.ok) throw new ApiFailure(payload.error.code, payload.error.message)
  return payload.data
}

function writeInit(method: 'POST' | 'PATCH' | 'DELETE', body?: unknown): RequestInit {
  return {
    method,
    headers: {
      'content-type': 'application/json',
      [WRITE_HEADER]: '1',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
}

function taskPath(id: string, suffix = ''): string {
  return `/tasks/${encodeURIComponent(id)}${suffix}`
}

export interface QueryBody {
  name?: string
  text: string
  enabled?: boolean
  perSource?: Partial<Record<SourceId, string>>
}

export interface CreateTaskBody {
  query?: string
  queries?: QueryBody[]
  title?: string
  sources?: SourceId[]
  pageSize?: number
  yearFrom?: number
  yearTo?: number
  openAccessOnly?: boolean
  language?: TaskLanguage
  types?: string[]
  sort?: SortMode
}

export interface TaskConditionsPatch {
  queries?: QueryBody[]
  sources?: SourceId[]
  pageSize?: number
  yearFrom?: number | null
  yearTo?: number | null
  openAccessOnly?: boolean
  language?: TaskLanguage
  types?: string[]
  sort?: SortMode
}

export interface TaskPatchBody {
  title?: string
  notes?: string
  pinned?: boolean
  groups?: TaskGroup[]
  conditions?: TaskConditionsPatch
  rev?: number
}

export interface ResultsQuery {
  offset?: number
  limit?: number
  sort?: SortMode
  source?: SourceId
  yearFrom?: number
  yearTo?: number
  openAccessOnly?: boolean
  q?: string
  screening?: 'unread' | 'read' | 'included' | 'excluded'
  queryId?: string
  type?: string
  language?: TaskLanguage
  hasPdf?: boolean
  missingFullText?: boolean
  pdfStatus?: PdfStatus
  groupId?: string
  venue?: string
  author?: string
  newOnly?: boolean
}

export function fetchHealth(signal?: AbortSignal): Promise<HealthInfo> {
  return request<HealthInfo>('/health', { signal })
}

export function fetchEvents(sinceRev: number, signal?: AbortSignal): Promise<EventsPage> {
  return request<EventsPage>(`/events?sinceRev=${encodeURIComponent(String(sinceRev))}`, { signal })
}

export function listTasks(signal?: AbortSignal): Promise<TaskSummary[]> {
  return request<TaskSummary[]>('/tasks', { signal })
}

export function fetchTask(id: string, signal?: AbortSignal): Promise<TaskDetail> {
  return request<TaskDetail>(taskPath(id), { signal })
}

export function createTask(body: CreateTaskBody, signal?: AbortSignal): Promise<TaskDetail> {
  return request<TaskDetail>('/tasks', { ...writeInit('POST', body), signal })
}

export function updateTask(
  id: string,
  patch: TaskPatchBody,
  signal?: AbortSignal,
): Promise<TaskDetail> {
  return request<TaskDetail>(taskPath(id), { ...writeInit('PATCH', patch), signal })
}

export function deleteTask(id: string): Promise<{ id: string }> {
  return request<{ id: string }>(taskPath(id), writeInit('DELETE'))
}

/** 打开历史时间轴时刷新轮次（详情里也带 rounds，这里用于弹窗内独立刷新）。 */
export function fetchRounds(id: string, signal?: AbortSignal): Promise<SearchRound[]> {
  return request<SearchRound[]>(taskPath(id, '/rounds'), { signal })
}

/** 用户从任务列表点开某任务 = 进入该任务，之后的模型检索默认落在这里。 */
export function activateTask(id: string): Promise<TaskDetail> {
  return request<TaskDetail>(taskPath(id, '/activate'), writeInit('POST', {}))
}

export function runTask(id: string): Promise<TaskDetail> {
  return request<TaskDetail>(taskPath(id, '/run'), writeInit('POST', {}))
}

export function cancelTask(id: string): Promise<TaskDetail> {
  return request<TaskDetail>(taskPath(id, '/cancel'), writeInit('POST', {}))
}

function resultParams(query: ResultsQuery): URLSearchParams {
  const params = new URLSearchParams()
  if (query.offset !== undefined) params.set('offset', String(query.offset))
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.sort !== undefined) params.set('sort', query.sort)
  if (query.source !== undefined) params.set('source', query.source)
  if (query.yearFrom !== undefined) params.set('yearFrom', String(query.yearFrom))
  if (query.yearTo !== undefined) params.set('yearTo', String(query.yearTo))
  if (query.openAccessOnly === true) params.set('openAccessOnly', '1')
  if (query.q !== undefined && query.q !== '') params.set('q', query.q)
  if (query.screening !== undefined) params.set('screening', query.screening)
  if (query.queryId !== undefined && query.queryId !== '') params.set('queryId', query.queryId)
  if (query.type !== undefined && query.type !== '') params.set('type', query.type)
  if (query.language !== undefined) params.set('language', query.language)
  if (query.hasPdf === true) params.set('hasPdf', '1')
  if (query.missingFullText === true) params.set('missingFullText', '1')
  if (query.pdfStatus !== undefined) params.set('pdfStatus', query.pdfStatus)
  if (query.groupId !== undefined && query.groupId !== '') params.set('groupId', query.groupId)
  if (query.venue !== undefined && query.venue !== '') params.set('venue', query.venue)
  if (query.author !== undefined && query.author !== '') params.set('author', query.author)
  if (query.newOnly === true) params.set('new', '1')
  return params
}

export function fetchResults(
  id: string,
  query: ResultsQuery = {},
  signal?: AbortSignal,
): Promise<ResultsPage> {
  const suffix = resultParams(query).toString()
  return request<ResultsPage>(taskPath(id, `/results${suffix === '' ? '' : `?${suffix}`}`), {
    signal,
  })
}

export function fetchStats(
  id: string,
  query: ResultsQuery = {},
  scope: 'task' | 'filtered' = 'task',
  signal?: AbortSignal,
): Promise<TaskStatsReport> {
  const params = resultParams(query)
  params.set('scope', scope)
  return request<TaskStatsReport>(taskPath(id, `/stats?${params.toString()}`), { signal })
}

/** 设置页「逐源测试」：固定短查询探测连通性与延迟。 */
export function probeSource(source: SourceId, signal?: AbortSignal): Promise<ProbeResult> {
  return request<ProbeResult>('/settings/probe', {
    ...writeInit('POST', { source }),
    signal,
  })
}

/** 批量写入筛读 / 分组 / 必读顺序 / 备注 / 标签。 */
export function annotateTask(
  id: string,
  papers: readonly AnnotationInput[],
  rev?: number,
  signal?: AbortSignal,
): Promise<AnnotationResult> {
  const body: { papers: readonly AnnotationInput[]; rev?: number } = { papers }
  if (rev !== undefined) body.rev = rev
  return request<AnnotationResult>(taskPath(id, '/annotate'), {
    ...writeInit('POST', body),
    signal,
  })
}

/** 单篇论文详情（独立论文页）。 */
export function fetchPaper(
  taskId: string,
  paperId: string,
  signal?: AbortSignal,
): Promise<PaperDetail> {
  return request<PaperDetail>(
    taskPath(taskId, `/papers/${encodeURIComponent(paperId)}`),
    { signal },
  )
}

/** PubTator3 实体标注。 */
export function fetchPaperEntities(
  taskId: string,
  paperId: string,
  signal?: AbortSignal,
): Promise<PaperEntities> {
  return request<PaperEntities>(
    taskPath(taskId, `/papers/${encodeURIComponent(paperId)}/entities`),
    { signal },
  )
}

export function fetchCompare(
  id: string,
  withTaskId: string,
  signal?: AbortSignal,
): Promise<CompareResult> {
  const params = new URLSearchParams({ with: withTaskId })
  return request<CompareResult>(taskPath(id, `/compare?${params.toString()}`), { signal })
}

export function cleanupSettings(scope: CleanupScope): Promise<CleanupResult> {
  return request<CleanupResult>('/settings/cleanup', writeInit('POST', { scope }))
}

/** 测试下载目录是否可写。 */
export function probeStorage(): Promise<StorageProbeResult> {
  return request<StorageProbeResult>('/settings/storage', writeInit('POST', {}))
}

/** 测试 Zotero connector 连通性。 */
export function probeZotero(): Promise<ZoteroProbeResult> {
  return request<ZoteroProbeResult>('/settings/zotero', writeInit('POST', {}))
}

/** 下载单篇 PDF 到用户目录。 */
export function downloadPaperPdf(
  taskId: string,
  paperId: string,
  signal?: AbortSignal,
): Promise<PdfDownloadResult> {
  return request<PdfDownloadResult>(
    taskPath(taskId, `/papers/${encodeURIComponent(paperId)}/download`),
    { ...writeInit('POST', {}), signal },
  )
}

export function syncZotero(
  taskId: string,
  paperIds: readonly string[],
): Promise<ZoteroSyncResult> {
  return request<ZoteroSyncResult>(taskPath(taskId, '/zotero'), writeInit('POST', { paperIds }))
}

/** 内联 PDF 预览地址（支持 Range）；查询参数让 Host 找到会话工作目录。 */
export function paperPdfUrl(taskId: string, paperId: string): string {
  const params = new URLSearchParams()
  const sessionId = currentSessionId()
  if (sessionId !== '') params.set('session', sessionId)
  const suffix = params.toString()
  return `${BASE}/tasks/${encodeURIComponent(taskId)}/papers/${encodeURIComponent(paperId)}/pdf${
    suffix === '' ? '' : `?${suffix}`
  }`
}

/** Europe PMC 全文 HTML 地址（用于 iframe）。 */
export function paperFullTextUrl(taskId: string, paperId: string): string {
  return `${BASE}/tasks/${encodeURIComponent(taskId)}/papers/${encodeURIComponent(paperId)}/fulltext`
}

/** 导出下载地址（GET，浏览器直接保存文件）。 */
export function exportUrl(
  id: string,
  format: ExportFormat,
  query: ResultsQuery = {},
  ids?: readonly string[],
): string {
  const params = resultParams({ ...query, offset: undefined, limit: undefined })
  params.set('taskId', id)
  params.set('format', format)
  if (ids !== undefined && ids.length > 0) params.set('ids', ids.join(','))
  const suffix = params.toString()
  return `${BASE}/export${suffix === '' ? '' : `?${suffix}`}`
}
