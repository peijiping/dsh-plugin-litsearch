/**
 * 带超时与取消的上游请求。
 *
 * 所有 provider 共用这一条路径，保证错误码一致：超时 → `timeout`，
 * 非 2xx → `upstream_error`（429 额外带 `retryAfterMs`），网络异常 → `network_error`。
 */

import { SearchError } from './errors.js'

export interface HttpRequest {
  timeoutMs: number
  signal?: AbortSignal | undefined
  headers?: Record<string, string>
}

export async function fetchJson(url: string, request: HttpRequest): Promise<unknown> {
  const text = await fetchText(url, {
    ...request,
    headers: { accept: 'application/json', ...request.headers },
  })
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new SearchError('upstream_error', `${safeHost(url)} 返回了无法解析的 JSON`)
  }
}

export async function fetchText(url: string, request: HttpRequest): Promise<string> {
  const controller = new AbortController()
  let timedOut = false
  const onAbort = (): void => controller.abort()
  if (request.signal?.aborted === true) controller.abort()
  else request.signal?.addEventListener('abort', onAbort, { once: true })

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, request.timeoutMs)

  const host = safeHost(url)
  try {
    const response = await fetch(url, { headers: request.headers, signal: controller.signal })
    if (!response.ok) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
      const detail =
        response.status === 429
          ? `${host} 触发限流（HTTP 429）`
          : `${host} 返回 HTTP ${response.status}`
      throw new SearchError('upstream_error', detail, {
        status: response.status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      })
    }
    return await response.text()
  } catch (error) {
    if (error instanceof SearchError) throw error
    if (timedOut) {
      throw new SearchError('timeout', `${host} 请求超时（${request.timeoutMs} ms）`)
    }
    if (controller.signal.aborted) {
      throw new SearchError('network_error', `${host} 请求已取消`)
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new SearchError('network_error', `无法访问 ${host}：${message}`)
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', onAbort)
  }
}

/** `Retry-After` 支持秒数与 HTTP 日期两种写法。 */
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
