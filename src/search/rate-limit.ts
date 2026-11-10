/**
 * 每源串行队列 + 最小间隔 + 429 冷却。
 *
 * 同一数据源的所有请求共享一条队列：既保证最小间隔，也让一个源触发限流时
 * 冷却状态对所有任务可见。冷却期内后续请求**快速失败**而不是排队等待，
 * 这样单个源被限流不会拖住整条多检索式任务。
 */

import {
  DEFAULT_ARXIV_INTERVAL_MS,
  DEFAULT_PUBMED_INTERVAL_MS,
  DEFAULT_S2_INTERVAL_MS,
  getSettings,
} from './config.js'
import { SearchError } from './errors.js'
import {
  cooldownUntil,
  recordSourceCooldown,
  recordSourceError,
  recordSourceOk,
} from './health.js'
import { fetchJson, fetchText, type HttpRequest } from './http.js'
import type { SourceId } from './types.js'

interface QueueState {
  chain: Promise<void>
  lastStart: number
}

const BASE_INTERVALS: Record<SourceId, number> = {
  pubmed: DEFAULT_PUBMED_INTERVAL_MS,
  europepmc: 200,
  openalex: 100,
  crossref: 1000,
  semanticscholar: DEFAULT_S2_INTERVAL_MS,
  arxiv: DEFAULT_ARXIV_INTERVAL_MS,
  pubtator: 350,
}

const COOLDOWN_FALLBACK_MS = 30_000
const MIN_INTERVAL_MS = 50

const queues = new Map<SourceId, QueueState>()

export interface LimitedRequest extends HttpRequest {
  /** 诊断测试可忽略冷却，但仍走队列与最小间隔。 */
  bypassCooldown?: boolean
}

/** 当前生效的最小间隔（设置覆盖 + 下限保护）。 */
export function minIntervalMs(source: SourceId): number {
  const settings = getSettings()
  const configured =
    source === 'pubmed'
      ? settings.pubmedIntervalMs
      : source === 'semanticscholar'
        ? settings.s2IntervalMs
        : source === 'arxiv'
          ? settings.arxivIntervalMs
          : BASE_INTERVALS[source]
  return Number.isFinite(configured) ? Math.max(MIN_INTERVAL_MS, Math.round(configured)) : BASE_INTERVALS[source]
}

export function limitedJson(
  source: SourceId,
  url: string,
  request: LimitedRequest,
): Promise<unknown> {
  return runLimited(source, request, () => fetchJson(url, request))
}

export function limitedText(
  source: SourceId,
  url: string,
  request: LimitedRequest,
): Promise<string> {
  return runLimited(source, request, () => fetchText(url, request))
}

async function runLimited<T>(
  source: SourceId,
  request: LimitedRequest,
  operation: () => Promise<T>,
): Promise<T> {
  const state = queueState(source)
  const previous = state.chain
  let release: () => void = () => undefined
  state.chain = new Promise<void>((resolve) => {
    release = resolve
  })

  try {
    await previous
    throwIfAborted(request.signal)
    assertNotCooling(source, request.bypassCooldown === true)

    const wait = state.lastStart + minIntervalMs(source) - Date.now()
    if (wait > 0) await sleep(wait, request.signal)
    // 等待期间别的请求可能刚触发 429，这里再确认一次。
    assertNotCooling(source, request.bypassCooldown === true)
    throwIfAborted(request.signal)

    state.lastStart = Date.now()
    const started = Date.now()
    try {
      const result = await operation()
      recordSourceOk(source, Date.now() - started)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      recordSourceError(source, message)
      if (error instanceof SearchError && error.status === 429) {
        const until = Date.now() + (error.retryAfterMs ?? COOLDOWN_FALLBACK_MS)
        recordSourceCooldown(source, until, message)
      }
      throw error
    }
  } finally {
    release()
  }
}

function queueState(source: SourceId): QueueState {
  let state = queues.get(source)
  if (state === undefined) {
    state = { chain: Promise.resolve(), lastStart: 0 }
    queues.set(source, state)
  }
  return state
}

function assertNotCooling(source: SourceId, bypass: boolean): void {
  if (bypass) return
  const until = cooldownUntil(source)
  if (until <= Date.now()) return
  const seconds = Math.max(1, Math.ceil((until - Date.now()) / 1000))
  throw new SearchError('upstream_error', `${source} 触发限流，冷却中（约 ${seconds} 秒后恢复）`)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new SearchError('network_error', '请求已取消')
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new SearchError('network_error', '请求已取消'))
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    function cleanup(): void {
      signal?.removeEventListener('abort', onAbort)
    }
    function onAbort(): void {
      if (timer !== undefined) clearTimeout(timer)
      cleanup()
      reject(new SearchError('network_error', '请求已取消'))
    }
    timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
