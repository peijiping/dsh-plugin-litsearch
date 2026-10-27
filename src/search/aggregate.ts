/**
 * 多源聚合检索。
 *
 * 并发调用全部选中数据源，用 `allSettled` 隔离单源故障；按 DOI（无 DOI 时
 * 标题 + 年份）去重并补齐缺失字段，最后按请求条数截断。单源失败不会拖垮
 * 整次检索，只有全部失败时才抛错。
 */

import { DEFAULT_LIMIT, MAX_LIMIT, getSettings } from './config.js'
import { SearchError } from './errors.js'
import { PROVIDERS, resolveSources } from './providers/index.js'
import type { Paper, SearchOptions, SearchResult, SourceStatus } from './types.js'

export async function searchLiterature(options: SearchOptions): Promise<SearchResult> {
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
  const limit = clampLimit(options.limit ?? settings.defaultLimit)
  const sources = resolveSources(options.sources)

  // 每个源多取一些，给跨源去重留出余量。
  const perSourceLimit = Math.min(Math.max(limit * 2, 10), MAX_LIMIT)

  const settled = await Promise.allSettled(
    sources.map((id) =>
      PROVIDERS[id].search(query, {
        limit: perSourceLimit,
        yearFrom: options.yearFrom,
        yearTo: options.yearTo,
        openAccessOnly: options.openAccessOnly === true,
        contactEmail: settings.contactEmail,
        timeoutMs: settings.requestTimeoutMs,
        signal: options.signal,
      }),
    ),
  )

  const statuses: SourceStatus[] = []
  const merged: Paper[] = []
  settled.forEach((outcome, index) => {
    const id = sources[index]
    if (outcome.status === 'fulfilled') {
      merged.push(...outcome.value)
      statuses.push({ id, ok: true, count: outcome.value.length })
    } else {
      statuses.push({
        id,
        ok: false,
        count: 0,
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      })
    }
  })

  const papers = dedupe(merged).slice(0, limit)
  if (papers.length === 0 && statuses.length > 0 && statuses.every((status) => !status.ok)) {
    const detail = statuses.map((status) => `${status.id}: ${status.error ?? '未知错误'}`).join('；')
    throw new SearchError('upstream_error', `所有数据源均检索失败（${detail}）`)
  }

  return { query, limit, papers, sources: statuses }
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT
  return Math.min(Math.max(Math.floor(value), 1), MAX_LIMIT)
}

function paperKey(paper: Paper): string {
  if (paper.doi !== '') return `doi:${paper.doi}`
  const title = paper.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return `title:${title}:${paper.year ?? ''}`
}

function dedupe(papers: readonly Paper[]): Paper[] {
  const byKey = new Map<string, Paper>()
  for (const paper of papers) {
    const key = paperKey(paper)
    const existing = byKey.get(key)
    if (existing === undefined) byKey.set(key, paper)
    else mergeInto(existing, paper)
  }
  return [...byKey.values()]
}

function mergeInto(base: Paper, extra: Paper): void {
  if (base.doi === '') base.doi = extra.doi
  if (base.abstract === '') base.abstract = extra.abstract
  if (base.pdfUrl === '') base.pdfUrl = extra.pdfUrl
  if (base.venue === '') base.venue = extra.venue
  if (base.url === '' || base.url === base.sourceId) base.url = extra.url
  if (base.year === null) base.year = extra.year
  if (base.citedBy === null) base.citedBy = extra.citedBy
  if (base.authors.length === 0) base.authors = [...extra.authors]
  base.openAccess = base.openAccess || extra.openAccess
}
