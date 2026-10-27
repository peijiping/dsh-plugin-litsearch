/**
 * 带超时与取消的 JSON 请求。
 *
 * 所有 provider 共用这一条路径，保证错误码一致：超时 → `timeout`，
 * 非 2xx → `upstream_error`，网络异常 → `network_error`。
 */

import { SearchError } from './errors.js'

export interface JsonRequest {
  timeoutMs: number
  signal?: AbortSignal | undefined
  headers?: Record<string, string>
}

export async function fetchJson(url: string, request: JsonRequest): Promise<unknown> {
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
      throw new SearchError('upstream_error', `${host} 返回 HTTP ${response.status}`)
    }
    return (await response.json()) as unknown
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

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
