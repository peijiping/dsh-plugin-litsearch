/**
 * Client 侧调 Host 端点（同源 fetch，前缀与 Host 的 ROUTE_PREFIX 对应）。
 *
 * 响应信封由 Host 产出：`{ok:true,data}` / `{ok:false,error}`。写操作必须带
 * 自定义标识头 + JSON content-type，Host 只认这种「非简单请求」。
 */

import { WRITE_HEADER } from '../search/config'
import type {
  EventsPage,
  HealthInfo,
  ProbeResult,
  ResultsPage,
  SortMode,
  SourceId,
  TaskDetail,
  TaskLanguage,
  TaskStatsReport,
  TaskSummary,
} from '../search/types'

const BASE = '/dsh-litsearch/api'

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
    res = await fetch(`${BASE}${path}`, init)
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

export interface TaskPatchBody {
  title?: string
  notes?: string
  pinned?: boolean
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
