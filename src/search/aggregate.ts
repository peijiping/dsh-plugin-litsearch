/**
 * 多源检索扇出。
 *
 * 一次调用只跑一条检索式：并发请求选中的数据源，用 `allSettled` 隔离单源
 * 故障，返回逐源的命中记录与状态。跨源去重、身份合并与排序交给 `identity.ts`，
 * 任务执行器负责把多条检索式的结果拼在一起。
 */

import { MAX_LIMIT, getSettings } from './config.js'
import { SearchError } from './errors.js'
import { PROVIDERS, resolveSources } from './providers/index.js'
import type { PaperRecord, SearchOptions, SourceId } from './types.js'

export interface SourceRunResult {
  source: SourceId
  ok: boolean
  records: PaperRecord[]
  error?: string
}

export async function searchSources(options: SearchOptions): Promise<SourceRunResult[]> {
  const query = options.query.trim()
  if (query === '') throw new SearchError('bad_request', '检索关键词不能为空')

  if (
    options.yearFrom !== undefined &&
    options.yearTo !== undefined &&
    options.yearFrom > options.yearTo
  ) {
    throw new SearchError('bad_request', '起始年份不能晚于结束年份')
  }

  const settings = getSettings()
  const limit = clampLimit(options.limit, settings.defaultPageSize)
  const sources = resolveSources(options.sources)
  const contactEmail = options.contactEmail !== '' ? options.contactEmail : settings.contactEmail
  const timeoutMs = options.timeoutMs > 0 ? options.timeoutMs : settings.requestTimeoutMs

  const settled = await Promise.allSettled(
    sources.map((id) =>
      PROVIDERS[id].search(query, {
        limit,
        yearFrom: options.yearFrom,
        yearTo: options.yearTo,
        openAccessOnly: options.openAccessOnly,
        contactEmail,
        timeoutMs,
        signal: options.signal,
      }),
    ),
  )

  return settled.map((outcome, index): SourceRunResult => {
    const source = sources[index]
    if (outcome.status === 'fulfilled') {
      return { source, ok: true, records: outcome.value }
    }
    return {
      source,
      ok: false,
      records: [],
      error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
    }
  })
}

function clampLimit(value: number, fallback: number): number {
  const base = Number.isFinite(value) ? value : fallback
  return Math.min(Math.max(Math.floor(base), 1), MAX_LIMIT)
}
