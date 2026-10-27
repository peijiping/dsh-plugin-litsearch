/**
 * Client 侧调 Host 只读端点（同源 fetch，前缀见 search/config.ROUTE_PREFIX）。
 *
 * 响应信封由 Host 产出：`{ok:true,data}` / `{ok:false,error}`。
 */

import type { SearchResult, SourceId } from '../search/types'

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

export interface SearchQuery {
  q: string
  sources?: SourceId[]
  limit?: number
  yearFrom?: number
  yearTo?: number
  openAccessOnly?: boolean
  signal?: AbortSignal
}

export async function search(query: SearchQuery): Promise<SearchResult> {
  const params = new URLSearchParams({ q: query.q })
  if (query.sources !== undefined && query.sources.length > 0) {
    params.set('sources', query.sources.join(','))
  }
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.yearFrom !== undefined) params.set('yearFrom', String(query.yearFrom))
  if (query.yearTo !== undefined) params.set('yearTo', String(query.yearTo))
  if (query.openAccessOnly === true) params.set('openAccessOnly', '1')

  let res: Response
  try {
    res = await fetch(`${BASE}/search?${params.toString()}`, { signal: query.signal })
  } catch (error) {
    if (query.signal?.aborted === true) throw new ApiFailure('network_error', '请求已取消')
    const message = error instanceof Error ? error.message : String(error)
    throw new ApiFailure('network_error', `无法访问 Host 端点：${message}`)
  }

  const payload = (await res.json().catch(() => null)) as
    | { ok: true; data: SearchResult }
    | { ok: false; error: { code: string; message: string } }
    | null
  if (payload === null) {
    throw new ApiFailure('internal_error', `Host 返回了非 JSON 响应（HTTP ${res.status}）`)
  }
  if (!payload.ok) throw new ApiFailure(payload.error.code, payload.error.message)
  return payload.data
}
