/**
 * Host HTTP 路由：`/dsh-litsearch/api/*`。
 *
 * 面板与设置页都从这里取数；统一信封 `{ok:true,data}` / `{ok:false,error}`。
 * 信任栅栏：Host 头必须是回环地址（防 DNS rebinding），并拒绝
 * `sec-fetch-site: cross-site`。写端点额外要求自定义头 + JSON content-type，
 * 两者一起让浏览器必须预检，堵掉跨站表单与简单请求。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { MAX_LIMIT, ROUTE_PREFIX, WRITE_HEADER } from '../search/config.js'
import { SearchError } from '../search/errors.js'
import { asRecord } from '../search/normalize.js'
import { isSourceId } from '../search/providers/index.js'
import type {
  ApiEnvelope,
  ApiError,
  ApiErrorCode,
  Screening,
  SortMode,
  SourceId,
  TaskLanguage,
  TaskOrigin,
} from '../search/types.js'
import type {
  CreateTaskInput,
  QueryInput,
  ResultsFilter,
  TaskListFilter,
  TaskPatch,
  TaskService,
} from './tasks/service.js'

/** dsh `webServer` 的最小结构接口（类型不在已安装的 dsh 包里）。 */
export interface WebServerLike {
  register(options: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

const MAX_BODY_BYTES = 1_000_000

const SORT_MODES: readonly SortMode[] = ['relevance', 'citations', 'year']
const LANGUAGES: readonly TaskLanguage[] = ['any', 'eng', 'chi']
const ORIGINS: readonly TaskOrigin[] = ['model', 'panel', 'history', 'api']
const SCREENINGS: readonly Screening[] = ['unread', 'read', 'included', 'excluded']

function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false
  const host = hostHeader.replace(/:\d+$/u, '').toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
}

function isTrusted(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site.toLowerCase() === 'cross-site') return false
  return isLoopbackHost(req.headers.host)
}

/** 写端点要求自定义头 + JSON：跨站请求无法在不触发预检的情况下伪造。 */
function hasWriteIntent(req: IncomingMessage): boolean {
  if (req.headers[WRITE_HEADER] !== '1') return false
  const type = req.headers['content-type']
  return typeof type === 'string' && type.toLowerCase().includes('application/json')
}

function sendJson(res: ServerResponse, status: number, payload: ApiEnvelope<unknown>): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function fail(res: ServerResponse, status: number, code: ApiErrorCode, message: string): void {
  const error: ApiError = { code, message }
  sendJson(res, status, { ok: false, error })
}

function ok<T>(res: ServerResponse, data: T, status = 200): void {
  sendJson(res, status, { ok: true, data })
}

function statusFor(code: ApiErrorCode): number {
  switch (code) {
    case 'bad_request':
      return 400
    case 'not_found':
      return 404
    case 'conflict':
      return 409
    case 'timeout':
      return 504
    case 'network_error':
    case 'upstream_error':
      return 502
    default:
      return 500
  }
}

function toApiError(error: unknown): { status: number; error: ApiError } {
  if (error instanceof SearchError) {
    return { status: statusFor(error.code), error: { code: error.code, message: error.message } }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { status: 500, error: { code: 'internal_error', message } }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new SearchError('bad_request', '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req)
  if (raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new SearchError('bad_request', '请求体不是合法 JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SearchError('bad_request', '请求体必须是 JSON 对象')
  }
  return asRecord(parsed)
}

function readString(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new SearchError('bad_request', `${name} 必须是字符串`)
  return value.trim().slice(0, max)
}

function readInt(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new SearchError('bad_request', `${name} 必须是 ${min}..${max} 的整数`)
  }
  return value
}

function readSourcesValue(value: unknown): SourceId[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new SearchError('bad_request', 'sources 必须是字符串数组')
  }
  const invalid = value.filter((item) => !isSourceId(item))
  if (invalid.length > 0) {
    throw new SearchError('bad_request', `未知数据源：${invalid.join(', ')}`)
  }
  return value as SourceId[]
}

function readQueriesValue(value: unknown): QueryInput[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new SearchError('bad_request', 'queries 必须是数组')
  return value.map((entry, index) => {
    const record = asRecord(entry)
    const text = record['text']
    if (typeof text !== 'string' || text.trim() === '') {
      throw new SearchError('bad_request', `第 ${index + 1} 条检索式为空`)
    }
    const input: QueryInput = { text }
    const name = readString(record['name'], 'name', 80)
    if (name !== undefined) input.name = name
    if (record['enabled'] !== undefined) {
      if (typeof record['enabled'] !== 'boolean') {
        throw new SearchError('bad_request', 'enabled 必须是布尔值')
      }
      input.enabled = record['enabled']
    }
    const perSource = record['perSource']
    if (perSource !== undefined && perSource !== null) {
      const overrides: Partial<Record<SourceId, string>> = {}
      for (const [key, raw] of Object.entries(asRecord(perSource))) {
        if (!isSourceId(key)) throw new SearchError('bad_request', `未知数据源：${key}`)
        if (typeof raw !== 'string') {
          throw new SearchError('bad_request', `perSource.${key} 必须是字符串`)
        }
        overrides[key] = raw
      }
      input.perSource = overrides
    }
    return input
  })
}

function readEnum<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new SearchError('bad_request', `${name} 只能是 ${allowed.join(' / ')}`)
  }
  return value as T
}

function readCreateInput(body: Record<string, unknown>): Omit<CreateTaskInput, 'origin'> {
  const query = readString(body['query'], 'query', 500)
  const queries = readQueriesValue(body['queries'])
  if ((query === undefined || query === '') && queries === undefined) {
    throw new SearchError('bad_request', '缺少必填参数 query 或 queries')
  }
  const input: Omit<CreateTaskInput, 'origin'> = {}
  if (query !== undefined && query !== '') input.query = query
  if (queries !== undefined) input.queries = queries

  const title = readString(body['title'], 'title', 120)
  if (title !== undefined && title !== '') input.title = title
  const sources = readSourcesValue(body['sources'])
  if (sources !== undefined) input.sources = sources
  const pageSize = readInt(body['pageSize'], 'pageSize', 1, MAX_LIMIT)
  if (pageSize !== undefined) input.pageSize = pageSize
  const yearFrom = readInt(body['yearFrom'], 'yearFrom', 1, 9999)
  if (yearFrom !== undefined) input.yearFrom = yearFrom
  const yearTo = readInt(body['yearTo'], 'yearTo', 1, 9999)
  if (yearTo !== undefined) input.yearTo = yearTo
  if (body['openAccessOnly'] !== undefined) {
    if (typeof body['openAccessOnly'] !== 'boolean') {
      throw new SearchError('bad_request', 'openAccessOnly 必须是布尔值')
    }
    input.openAccessOnly = body['openAccessOnly']
  }
  const language = readEnum(body['language'], 'language', LANGUAGES)
  if (language !== undefined) input.language = language
  const sort = readEnum(body['sort'], 'sort', SORT_MODES)
  if (sort !== undefined) input.sort = sort
  if (body['runNow'] !== undefined) {
    if (typeof body['runNow'] !== 'boolean') {
      throw new SearchError('bad_request', 'runNow 必须是布尔值')
    }
    input.runNow = body['runNow']
  }
  return input
}

function readPatch(body: Record<string, unknown>): TaskPatch {
  const patch: TaskPatch = {}
  const title = readString(body['title'], 'title', 120)
  if (title !== undefined) patch.title = title
  if (body['notes'] !== undefined) {
    if (typeof body['notes'] !== 'string') {
      throw new SearchError('bad_request', 'notes 必须是字符串')
    }
    patch.notes = body['notes']
  }
  if (body['pinned'] !== undefined) {
    if (typeof body['pinned'] !== 'boolean') {
      throw new SearchError('bad_request', 'pinned 必须是布尔值')
    }
    patch.pinned = body['pinned']
  }

  const rawConditions = body['conditions']
  if (rawConditions !== undefined) {
    const record = asRecord(rawConditions)
    const conditions: NonNullable<TaskPatch['conditions']> = {}
    const queries = readQueriesValue(record['queries'])
    if (queries !== undefined) conditions.queries = queries
    const sources = readSourcesValue(record['sources'])
    if (sources !== undefined) conditions.sources = sources
    const pageSize = readInt(record['pageSize'], 'pageSize', 1, MAX_LIMIT)
    if (pageSize !== undefined) conditions.pageSize = pageSize
    if (record['yearFrom'] === null) conditions.yearFrom = null
    else {
      const yearFrom = readInt(record['yearFrom'], 'yearFrom', 1, 9999)
      if (yearFrom !== undefined) conditions.yearFrom = yearFrom
    }
    if (record['yearTo'] === null) conditions.yearTo = null
    else {
      const yearTo = readInt(record['yearTo'], 'yearTo', 1, 9999)
      if (yearTo !== undefined) conditions.yearTo = yearTo
    }
    if (record['openAccessOnly'] !== undefined) {
      if (typeof record['openAccessOnly'] !== 'boolean') {
        throw new SearchError('bad_request', 'openAccessOnly 必须是布尔值')
      }
      conditions.openAccessOnly = record['openAccessOnly']
    }
    const language = readEnum(record['language'], 'language', LANGUAGES)
    if (language !== undefined) conditions.language = language
    const sort = readEnum(record['sort'], 'sort', SORT_MODES)
    if (sort !== undefined) conditions.sort = sort
    patch.conditions = conditions
  }
  return patch
}

function readListFilter(params: URLSearchParams): TaskListFilter {
  const filter: TaskListFilter = {}
  const q = params.get('q')?.trim() ?? ''
  if (q !== '') filter.q = q
  const origin = readEnum(params.get('origin') ?? undefined, 'origin', ORIGINS)
  if (origin !== undefined) filter.origin = origin
  const pinned = params.get('pinned')
  if (pinned === '1' || pinned === 'true') filter.pinned = true
  else if (pinned === '0' || pinned === 'false') filter.pinned = false
  return filter
}

function readQueryInt(
  params: URLSearchParams,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const raw = params.get(name)
  if (raw === null || raw.trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new SearchError('bad_request', `${name} 必须是整数`)
  return readInt(value, name, min, max)
}

function readResultsFilter(params: URLSearchParams): ResultsFilter {
  const filter: ResultsFilter = {}
  const offset = readQueryInt(params, 'offset', 0, Number.MAX_SAFE_INTEGER)
  if (offset !== undefined) filter.offset = offset
  const limit = readQueryInt(params, 'limit', 1, 200)
  if (limit !== undefined) filter.limit = limit
  const sort = readEnum(params.get('sort') ?? undefined, 'sort', SORT_MODES)
  if (sort !== undefined) filter.sort = sort
  const source = params.get('source') ?? ''
  if (source !== '') {
    if (!isSourceId(source)) throw new SearchError('bad_request', `未知数据源：${source}`)
    filter.source = source
  }
  const yearFrom = readQueryInt(params, 'yearFrom', 1, 9999)
  if (yearFrom !== undefined) filter.yearFrom = yearFrom
  const yearTo = readQueryInt(params, 'yearTo', 1, 9999)
  if (yearTo !== undefined) filter.yearTo = yearTo
  if (params.get('openAccessOnly') === '1' || params.get('openAccessOnly') === 'true') {
    filter.openAccessOnly = true
  }
  const q = params.get('q')?.trim() ?? ''
  if (q !== '') filter.q = q
  const screening = readEnum(params.get('screening') ?? undefined, 'screening', SCREENINGS)
  if (screening !== undefined) filter.screening = screening
  return filter
}

function parseSegments(pathname: string): string[] {
  return pathname
    .slice(ROUTE_PREFIX.length)
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        throw new SearchError('bad_request', `路径段编码非法：${segment}`)
      }
    })
}

async function handleTasks(
  service: TaskService,
  req: IncomingMessage,
  res: ServerResponse,
  seg: string[],
  params: URLSearchParams,
): Promise<void> {
  const id = seg[1]
  if (id === undefined) {
    if (req.method === 'GET') {
      ok(res, await service.list(readListFilter(params)))
      return
    }
    if (req.method === 'POST') {
      const input = readCreateInput(await readJsonBody(req))
      const task = await service.create({ ...input, origin: 'panel' })
      ok(res, await service.getDetail(task.id), 201)
      return
    }
    fail(res, 405, 'bad_request', `任务集合不支持 ${req.method ?? '未知'} 方法`)
    return
  }

  const action = seg[2]
  if (action === undefined) {
    if (req.method === 'GET') {
      ok(res, await service.getDetail(id))
      return
    }
    if (req.method === 'PATCH') {
      const body = await readJsonBody(req)
      const expectedRev = readInt(body['rev'], 'rev', 1, Number.MAX_SAFE_INTEGER)
      const task = await service.update(id, readPatch(body), expectedRev)
      ok(res, await service.getDetail(task.id))
      return
    }
    if (req.method === 'DELETE') {
      await service.remove(id)
      ok(res, { id })
      return
    }
    fail(res, 405, 'bad_request', `任务不支持 ${req.method ?? '未知'} 方法`)
    return
  }

  if (action === 'results') {
    if (req.method !== 'GET') {
      fail(res, 405, 'bad_request', 'results 仅支持 GET')
      return
    }
    ok(res, await service.results(id, readResultsFilter(params)))
    return
  }

  if (action === 'run') {
    if (req.method !== 'POST') {
      fail(res, 405, 'bad_request', 'run 仅支持 POST')
      return
    }
    const body = await readJsonBody(req)
    const mode = readEnum(body['mode'], 'mode', ['new', 'more'] as const) ?? 'new'
    await service.get(id)
    if (service.isRunning(id)) throw new SearchError('conflict', '任务正在运行')
    void service.run(id, mode).catch((error: unknown) => {
      console.warn('[dsh-plugin-litsearch] 任务执行失败：', error)
    })
    ok(res, await service.getDetail(id), 202)
    return
  }

  if (action === 'cancel') {
    if (req.method !== 'POST') {
      fail(res, 405, 'bad_request', 'cancel 仅支持 POST')
      return
    }
    await service.cancel(id)
    ok(res, await service.getDetail(id), 202)
    return
  }

  fail(res, 404, 'not_found', `未知 action ${action}`)
}

/** 构造挂在 `webServer` 上的前缀路由处理器。 */
export function createHandler(
  service: TaskService,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      if (!isTrusted(req)) {
        fail(res, 403, 'bad_request', '拒绝非回环来源的请求')
        return
      }

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      if (!url.pathname.startsWith(ROUTE_PREFIX)) {
        fail(res, 404, 'not_found', `未知路由 ${url.pathname}`)
        return
      }

      if (req.method !== 'GET' && !hasWriteIntent(req)) {
        fail(res, 403, 'bad_request', '写请求缺少自定义标识头')
        return
      }

      const seg = parseSegments(url.pathname)
      const head = seg[0]

      if (head === 'health') {
        if (req.method !== 'GET') {
          fail(res, 405, 'bad_request', 'health 仅支持 GET')
          return
        }
        ok(res, service.health())
        return
      }

      if (head === 'events') {
        if (req.method !== 'GET') {
          fail(res, 405, 'bad_request', 'events 仅支持 GET')
          return
        }
        const raw = url.searchParams.get('sinceRev') ?? '0'
        const sinceRev = Number(raw)
        ok(res, await service.eventsSince(Number.isFinite(sinceRev) ? sinceRev : 0))
        return
      }

      if (head === 'tasks') {
        await handleTasks(service, req, res, seg, url.searchParams)
        return
      }

      fail(res, 404, 'not_found', `未知 action ${head ?? ''}`)
    } catch (error) {
      const { status, error: apiError } = toApiError(error)
      fail(res, status, apiError.code, apiError.message)
    }
  }
}
