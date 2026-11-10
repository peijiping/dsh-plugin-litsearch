/**
 * 检索错误：只区分调用方可处理的几类。
 *
 * - `bad_request`：参数不合法（关键词为空、年份区间倒置等）。
 * - `not_found` / `conflict`：任务不存在、或与运行中/版本号冲突。
 * - `upstream_error`：上游返回非 2xx 或响应不可解析。
 * - `timeout` / `network_error`：请求超时或网络不可达。
 *
 * `status` / `retryAfterMs` 只用于限流判断，不进入对外错误信封。
 */

import type { ApiErrorCode } from './types.js'

export type SearchErrorCode = Exclude<ApiErrorCode, 'internal_error'>

export interface SearchErrorExtra {
  status?: number
  retryAfterMs?: number
}

export class SearchError extends Error {
  readonly code: SearchErrorCode

  readonly status?: number

  readonly retryAfterMs?: number

  constructor(code: SearchErrorCode, message: string, extra: SearchErrorExtra = {}) {
    super(message)
    this.name = 'SearchError'
    this.code = code
    if (extra.status !== undefined) this.status = extra.status
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs
  }
}
