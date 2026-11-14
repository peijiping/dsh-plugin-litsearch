/**
 * 任务概览统计。
 *
 * 只统计**已加载**的结果（任务最多 1500 篇，内存聚合毫秒级），并复用
 * `filter.ts` 的筛选口径，保证列表与统计一致。结果按 `rev + 口径 + 筛选指纹`
 * 缓存 30 秒，追加/重跑后 rev 变化自动失效。
 */

import type {
  CountEntry,
  FullTextCoverage,
  Paper,
  QueryContribution,
  SearchTask,
  SourceId,
  SourceStat,
  TaskStatsReport,
  YearStat,
} from '../../search/types.js'
import { filterKey, filterPapers, pdfStatusOf, screeningOf, type PaperFilter } from './filter.js'

const CACHE_TTL_MS = 30_000
const CACHE_MAX = 16
const TOP_LIST = 15
const TOP_PAPERS = 10
/** 出处 / 作者候选值的上限：筛选下拉直接用这份清单，按命中数取前 500。 */
const FACET_LIST = 500

interface CacheEntry {
  at: number
  report: TaskStatsReport
}

const cache = new Map<string, CacheEntry>()

export function computeStats(
  task: SearchTask,
  filter: PaperFilter,
  scope: 'task' | 'filtered',
  base?: { paperIds: ReadonlySet<string>; rev: number },
): TaskStatsReport {
  const key = `${task.id}:${task.rev}:${scope}:${filterKey(filter)}:${base?.rev ?? ''}`
  const cached = cache.get(key)
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) return cached.report

  const report = buildReport(task, filter, scope, base)
  cache.set(key, { at: Date.now(), report })
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return report
}

function buildReport(
  task: SearchTask,
  filter: PaperFilter,
  scope: 'task' | 'filtered',
  base?: { paperIds: ReadonlySet<string>; rev: number },
): TaskStatsReport {
  const all = task.result.papers
  const papers = scope === 'filtered' ? filterPapers(task, filter) : all

  const included = papers.filter((paper) => screeningOf(task, paper) === 'included').length
  const excluded = papers.filter((paper) => screeningOf(task, paper) === 'excluded').length
  const read = papers.filter((paper) => screeningOf(task, paper) === 'read').length
  const unread = papers.length - included - excluded - read
  const fullText = countFullText(task, papers)

  return {
    taskId: task.id,
    rev: task.rev,
    scope,
    loaded: papers.length,
    totalHint: all.length,
    funnel: {
      rawHits: task.stats.rawHits,
      deduped: task.stats.deduped,
      filtered: papers.length,
      included,
      excluded,
      unread,
      read,
    },
    bySource: buildSourceStats(task, papers),
    byQuery: buildQueryStats(task, papers),
    byYear: buildYearStats(task, papers),
    byType: countBy(task, papers, (paper) => paper.type),
    byLanguage: countBy(task, papers, (paper) => paper.language ?? ''),
    topVenues: topBy(
      task,
      papers,
      (paper) => (paper.venue === '' ? [] : [paper.venue]),
      FACET_LIST,
    ),
    topAuthors: topBy(task, papers, (paper) => paper.authors, FACET_LIST),
    metrics: buildMetrics(papers, base),
    screeningProgress: { included, excluded, pending: unread },
    unavailableFullText: {
      paywalled: fullText.paywalled,
      blocked: fullText.blocked,
      failed: fullText.failed,
    },
    fullText,
  }
}

function countFullText(task: SearchTask, papers: readonly Paper[]): FullTextCoverage {
  const coverage: FullTextCoverage = {
    unknown: 0,
    available: 0,
    downloaded: 0,
    missing: 0,
    htmlOnly: 0,
    paywalled: 0,
    blocked: 0,
    failed: 0,
  }
  for (const paper of papers) {
    const status = pdfStatusOf(task, paper)
    if (status === 'html-only') coverage.htmlOnly += 1
    else if (status === 'available') coverage.available += 1
    else if (status === 'downloaded') coverage.downloaded += 1
    else if (status === 'missing') coverage.missing += 1
    else if (status === 'paywalled') coverage.paywalled += 1
    else if (status === 'blocked') coverage.blocked += 1
    else if (status === 'failed') coverage.failed += 1
    else coverage.unknown += 1
  }
  return coverage
}

function buildSourceStats(task: SearchTask, papers: Paper[]): SourceStat[] {
  const ids = new Set<SourceId>(task.conditions.sources)
  for (const paper of papers) {
    for (const hit of paper.hitSources) ids.add(hit.source)
  }
  return task.conditions.sources
    .filter((id) => ids.has(id))
    .map((id): SourceStat => {
      const hits = papers.filter((paper) => paper.hitSources.some((hit) => hit.source === id))
      return {
        id,
        hits: hits.length,
        uniqueOnly: hits.filter((paper) => paper.hitSources.length === 1).length,
        oa: hits.filter((paper) => paper.openAccess).length,
        withPdf: hits.filter((paper) => paper.pdfUrl !== '').length,
      }
    })
}

function buildQueryStats(task: SearchTask, papers: Paper[]): QueryContribution[] {
  const queryIds = task.conditions.queries.map((query) => query.id)
  const overlap = new Map<string, Map<string, number>>()
  for (const id of queryIds) {
    overlap.set(id, new Map(queryIds.filter((other) => other !== id).map((other) => [other, 0])))
  }
  for (const paper of papers) {
    const matched = paper.matchedQueries.filter((id) => overlap.has(id))
    for (const left of matched) {
      for (const right of matched) {
        if (left === right) continue
        const row = overlap.get(left)
        if (row === undefined) continue
        row.set(right, (row.get(right) ?? 0) + 1)
      }
    }
  }

  return task.conditions.queries.map((query): QueryContribution => {
    const uniqueOnly = papers.filter(
      (paper) => paper.matchedQueries.length === 1 && paper.matchedQueries[0] === query.id,
    ).length
    const row = overlap.get(query.id)
    return {
      queryId: query.id,
      name: query.name,
      hits: task.stats.perQuery[query.id] ?? 0,
      uniqueOnly,
      overlap: row === undefined ? {} : Object.fromEntries(row),
    }
  })
}

function buildYearStats(task: SearchTask, papers: Paper[]): YearStat[] {
  const years = new Map<number, { count: number; included: number }>()
  for (const paper of papers) {
    if (paper.year === null) continue
    const entry = years.get(paper.year) ?? { count: 0, included: 0 }
    entry.count += 1
    if (screeningOf(task, paper) === 'included') entry.included += 1
    years.set(paper.year, entry)
  }
  return [...years.entries()]
    .map(([year, entry]) => ({ year, ...entry }))
    .sort((a, b) => a.year - b.year)
}

function countBy(
  task: SearchTask,
  papers: Paper[],
  keyOf: (paper: Paper) => string,
): CountEntry[] {
  const counts = new Map<string, { count: number; included: number }>()
  for (const paper of papers) {
    const key = keyOf(paper).trim()
    if (key === '') continue
    const entry = counts.get(key) ?? { count: 0, included: 0 }
    entry.count += 1
    if (screeningOf(task, paper) === 'included') entry.included += 1
    counts.set(key, entry)
  }
  return [...counts.entries()]
    .map(([key, entry]) => ({ key, ...entry }))
    .sort((a, b) => b.count - a.count)
}

function topBy(
  task: SearchTask,
  papers: Paper[],
  keysOf: (paper: Paper) => string[],
  limit: number,
): CountEntry[] {
  const counts = new Map<string, { count: number; included: number }>()
  for (const paper of papers) {
    const included = screeningOf(task, paper) === 'included'
    for (const value of keysOf(paper)) {
      const key = value.trim()
      if (key === '') continue
      const entry = counts.get(key) ?? { count: 0, included: 0 }
      entry.count += 1
      if (included) entry.included += 1
      counts.set(key, entry)
    }
  }
  return [...counts.entries()]
    .map(([key, entry]) => ({ key, ...entry }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
}

function buildMetrics(
  papers: Paper[],
  base?: { paperIds: ReadonlySet<string>; rev: number },
): TaskStatsReport['metrics'] {
  const total = papers.length
  const oa = papers.filter((paper) => paper.openAccess).length
  const pdf = papers.filter((paper) => paper.pdfUrl !== '').length
  const htmlOnly = papers.filter((paper) => paper.openAccess && paper.pdfUrl === '').length
  const citations = papers
    .map((paper) => paper.citedBy)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b)
  const median =
    citations.length === 0
      ? 0
      : citations.length % 2 === 1
        ? citations[(citations.length - 1) / 2]
        : Math.round(
            (citations[citations.length / 2 - 1] + citations[citations.length / 2]) / 2,
          )

  return {
    oaRate: total === 0 ? 0 : round(oa / total),
    pdfRate: total === 0 ? 0 : round(pdf / total),
    htmlOnlyRate: total === 0 ? 0 : round(htmlOnly / total),
    medianCitations: median,
    topCited: [...papers]
      .filter((paper) => paper.citedBy !== null)
      .sort((a, b) => (b.citedBy ?? 0) - (a.citedBy ?? 0))
      .slice(0, TOP_PAPERS)
      .map((paper) => paper.paperId),
    latest: [...papers]
      .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
      .slice(0, TOP_PAPERS)
      .map((paper) => paper.paperId),
    ...(base === undefined
      ? {}
      : { newVsBase: papers.filter((paper) => !base.paperIds.has(paper.paperId)).length }),
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
