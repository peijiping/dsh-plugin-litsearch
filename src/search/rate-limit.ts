/**
 * 每源串行队列 + 最小间隔 + 429 冷却。
 *
 * 同一数据源的所有请求共享一条队列：既保证最小间隔，也让一个源触发限流时
 * 冷却状态对所有任务可见。遵守上游限制的原则是「放慢并等待」，而不是把冷却
 * 当成失败：
 *
 * - 冷却期内排队等待（有上限、可取消）；只有上游要求的冷却过长才优雅跳过。
 * - 真正收到 429 时记录冷却、自适应放大该源间隔，并退避重试一次；重试仍
 *   限流则抛 `SourceSkipped`，由聚合层标为 skipped，不计入失败。
 * - 连续成功若干次后间隔逐步回落；超时 / 临时网络故障也重试一次。
 * - 诊断探活（bypassCooldown）忽略冷却，429 仍按原始错误返回，便于定位。
 */

import {
  DEFAULT_ARXIV_INTERVAL_MS,
  DEFAULT_PUBMED_INTERVAL_MS,
  DEFAULT_S2_INTERVAL_MS,
  DEFAULT_SERPAPI_INTERVAL_MS,
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
  /** 429 后自适应的间隔倍数，1 表示未放大。 */
  boost: number
  consecutiveOk: number
}

const BASE_INTERVALS: Record<SourceId, number> = {
  pubmed: DEFAULT_PUBMED_INTERVAL_MS,
  europepmc: 200,
  openalex: 100,
  crossref: 1000,
  semanticscholar: DEFAULT_S2_INTERVAL_MS,
  arxiv: DEFAULT_ARXIV_INTERVAL_MS,
  pubtator: 350,
  googlescholar: DEFAULT_SERPAPI_INTERVAL_MS,
}

/** 429 未带 Retry-After 时的冷却时长（原为 30s，过久会拖垮多检索式任务）。 */
const COOLDOWN_FALLBACK_MS = 10_000
/** 单次请求愿意为遵守冷却等待的上限；超过则优雅跳过。 */
const MAX_COOLDOWN_WAIT_MS = 20_000
/** 429 / 临时故障的退避与重试次数。 */
const RATE_LIMIT_RETRY_MS = 2_000
const TRANSIENT_RETRY_MS = 1_000
const MAX_RETRIES = 1
/** 等待期间冷却被反复刷新时的循环上限，避免活锁。 */
const MAX_WAIT_ROUNDS = 4
/** 自适应间隔：放大步长、倍数上限、绝对上限、回落所需连续成功次数。 */
const BOOST_STEP = 1.5
const MAX_BOOST = 4
const MAX_INTERVAL_MS = 8_000
const RECOVER_AFTER_OK = 5

const MIN_INTERVAL_MS = 50

const queues = new Map<SourceId, QueueState>()

/**
 * 因遵守上游限流而跳过本次请求。
 *
 * 这不是故障：聚合层据此标 `skipped`，任务不计失败，面板只给中性提示。
 */
export class SourceSkipped extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceSkipped'
  }
}

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
  return Number.isFinite(configured)
    ? Math.max(MIN_INTERVAL_MS, Math.round(configured))
    : BASE_INTERVALS[source]
}

/** 叠加 429 自适应放大后的实际间隔。 */
function effectiveIntervalMs(source: SourceId, state: QueueState): number {
  return Math.min(minIntervalMs(source) * state.boost, MAX_INTERVAL_MS)
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

  const bypass = request.bypassCooldown === true
  let retries = 0
  // 本请求 429 后自己退避重试时不再被刚写入的冷却拦下；其它排队请求仍遵守。
  let ignoreCooldown = false
  let waitRounds = 0

  try {
    await previous
    for (;;) {
      throwIfAborted(request.signal)

      const cooling = coolingWait(source, bypass, ignoreCooldown)
      if (cooling > MAX_COOLDOWN_WAIT_MS) throw skippedTooLong(source, cooling)
      const spacing = Math.max(
        0,
        state.lastStart + effectiveIntervalMs(source, state) - Date.now(),
      )
      const wait = Math.max(cooling, spacing)
      if (wait > 0) await sleep(wait, request.signal)

      // 等待期间别的请求可能刚触发 429 并刷新冷却；补足等待，但有次数上限。
      const refreshed = coolingWait(source, bypass, ignoreCooldown)
      if (refreshed > 0) {
        if (refreshed > MAX_COOLDOWN_WAIT_MS || waitRounds >= MAX_WAIT_ROUNDS) {
          throw skippedTooLong(source, refreshed)
        }
        waitRounds += 1
        continue
      }
      throwIfAborted(request.signal)

      state.lastStart = Date.now()
      const started = Date.now()
      try {
        const result = await operation()
        recordSourceOk(source, Date.now() - started)
        relaxInterval(state)
        return result
      } catch (error) {
        // 取消必须立即透传，不能当成临时故障重试。
        if (request.signal?.aborted === true) throw error

        if (isRateLimited(error)) {
          // 上游给了 Retry-After 就完全按它来；没给才用本地兜底。
          const cooldown = error.retryAfterMs ?? COOLDOWN_FALLBACK_MS
          recordSourceCooldown(source, Date.now() + cooldown, errorMessage(error))
          boostInterval(state)
          if (bypass) throw error
          if (retries >= MAX_RETRIES) {
            throw new SourceSkipped(`${source} 触发上游限流，已放慢频率并重试，本次按限流跳过`)
          }
          retries += 1
          ignoreCooldown = true
          await sleep(Math.min(cooldown, RATE_LIMIT_RETRY_MS), request.signal)
          continue
        }
        if (isTransient(error) && retries < MAX_RETRIES) {
          retries += 1
          await sleep(TRANSIENT_RETRY_MS, request.signal)
          continue
        }
        recordSourceError(source, errorMessage(error))
        throw error
      }
    }
  } finally {
    release()
  }
}

function coolingWait(source: SourceId, bypass: boolean, ignoreCooldown: boolean): number {
  if (bypass || ignoreCooldown) return 0
  return Math.max(0, cooldownUntil(source) - Date.now())
}

function skippedTooLong(source: SourceId, remaining: number): SourceSkipped {
  return new SourceSkipped(
    `${source} 处于上游限流冷却（约 ${Math.ceil(remaining / 1000)} 秒后恢复），本次已按限流跳过`,
  )
}

function isRateLimited(error: unknown): error is SearchError {
  return error instanceof SearchError && error.status === 429
}

function isTransient(error: unknown): boolean {
  return (
    error instanceof SearchError &&
    (error.code === 'timeout' || error.code === 'network_error')
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function boostInterval(state: QueueState): void {
  state.boost = Math.min(state.boost * BOOST_STEP, MAX_BOOST)
  state.consecutiveOk = 0
}

function relaxInterval(state: QueueState): void {
  if (state.boost <= 1) return
  state.consecutiveOk += 1
  if (state.consecutiveOk < RECOVER_AFTER_OK) return
  state.boost = Math.max(1, state.boost / BOOST_STEP)
  state.consecutiveOk = 0
}

function queueState(source: SourceId): QueueState {
  let state = queues.get(source)
  if (state === undefined) {
    state = { chain: Promise.resolve(), lastStart: 0, boost: 1, consecutiveOk: 0 }
    queues.set(source, state)
  }
  return state
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
