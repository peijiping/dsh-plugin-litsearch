/**
 * Host 侧只读 HTTP 路由：`GET /dsh-litsearch/api/search`。
 *
 * 供右侧栏面板取数。统一信封 `{ok:true,data}` / `{ok:false,error}`；
 * 信任栅栏拒绝 `sec-fetch-site: cross-site`，且 Host 头必须是回环地址
 * （防御 DNS rebinding）。只读端点，无需会话 cookie。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { searchLiterature } from '../search/aggregate.js'
import { ROUTE_PREFIX } from '../search/config.js'
import { SearchError } from '../search/errors.js'
import { isSourceId } from '../search/providers/index.js'
import type {
  ApiEnvelope,
  ApiError,
  ApiErrorCode,
  SearchResult,
  SourceId,
} from '../search/types.js'

/** dsh `webServer` 的最小结构接口（类型不在已安装的 dsh 包里）。 */
export interface WebServerLike {
  register(options: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

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

function ok<T>(res: ServerResponse, data: T): void {
  sendJson(res, 200, { ok: true, data })
}

/** `undefined` 表示缺省，`null` 表示格式非法。 */
function parseSources(raw: string | null): SourceId[] | undefined {
  if (raw === null || raw.trim() === '') return []
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '')
  const ids = values.filter(isSourceId)
  return ids.length === values.length ? ids : undefined
}

/** `undefined` 表示缺省；非法值直接抛 400。 */
function parseIntParam(raw: string | null, name: string): number | undefined {
  if (raw === null || raw.trim() === '') return undefined
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new SearchError('bad_request', `${name} 必须是正整数`)
  }
  return parsed
}

function parseBoolean(raw: string | null): boolean {
  return raw === '1' || raw === 'true'
}

function toApiError(error: unknown): { status: number; error: ApiError } {
  if (error instanceof SearchError) {
    const status =
      error.code === 'bad_request'
        ? 400
        : error.code === 'timeout'
          ? 504
          : error.code === 'network_error' || error.code === 'upstream_error'
            ? 502
            : 500
    return { status, error: { code: error.code, message: error.message } }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { status: 500, error: { code: 'internal_error', message } }
}

async function handleSearch(res: ServerResponse, params: URLSearchParams): Promise<void> {
  const query = (params.get('q') ?? '').trim()
  if (query === '') {
    fail(res, 400, 'bad_request', '缺少必填参数 q')
    return
  }

  const sources = parseSources(params.get('sources'))
  if (sources === undefined) {
    fail(res, 400, 'bad_request', `未知数据源：${params.get('sources') ?? ''}`)
    return
  }

  const result: SearchResult = await searchLiterature({
    query,
    sources,
    limit: parseIntParam(params.get('limit'), 'limit'),
    yearFrom: parseIntParam(params.get('yearFrom'), 'yearFrom'),
    yearTo: parseIntParam(params.get('yearTo'), 'yearTo'),
    openAccessOnly: parseBoolean(params.get('openAccessOnly')),
  })
  ok(res, result)
}

/** 构造挂在 `webServer` 上的前缀路由处理器。 */
export function createHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      if (req.method !== 'GET') {
        fail(res, 405, 'bad_request', `仅支持 GET，收到 ${req.method ?? '未知'}`)
        return
      }
      if (!isTrusted(req)) {
        fail(res, 403, 'bad_request', '拒绝非回环来源的请求')
        return
      }

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      if (!url.pathname.startsWith(ROUTE_PREFIX)) {
        fail(res, 404, 'bad_request', `未知路由 ${url.pathname}`)
        return
      }

      const action = url.pathname.slice(ROUTE_PREFIX.length)
      if (action === 'search') {
        await handleSearch(res, url.searchParams)
        return
      }
      fail(res, 404, 'bad_request', `未知 action ${action}`)
    } catch (error) {
      const { status, error: apiError } = toApiError(error)
      fail(res, status, apiError.code, apiError.message)
    }
  }
}
