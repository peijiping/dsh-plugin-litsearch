import { createHash } from 'node:crypto'
import { SearchError } from '../../search/errors.js'
import { adaptQuery } from '../../search/query-adapter.js'
import { getSettings, MAX_LIMIT } from '../../search/config.js'
import { PROVIDERS, resolveSources } from '../../search/providers/index.js'
import type {
  Attempt,
  Evidence,
  Hit,
  Page,
  ProviderPage,
  ResumePosition,
  SourceRun,
} from '../../search/evidence.js'
import type {
  PaperRecord,
  QueryBlock,
  SearchRound,
  SearchTask,
  SourceId,
  TaskConditions,
} from '../../search/types.js'
import { matchesLanguage } from './filter.js'

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function makeRun(conditions: TaskConditions, query: QueryBlock, source: SourceId): SourceRun {
  const adaptedQuery = adaptQuery(source, query)
  const adaptation: SourceRun['adaptation'] = []
  if (query.perSource?.[source]?.trim()) {
    adaptation.push({ kind: 'sourceOverride', detail: '使用来源专用表达式' })
  } else if (adaptedQuery !== query.text.trim()) {
    if (/\[[^\]]+\]/u.test(query.text) && !/\[[^\]]+\]/u.test(adaptedQuery)) {
      adaptation.push({ kind: 'removedFieldTag', detail: '字段限制已移除' })
    }
    if (/\bNOT\b/iu.test(query.text) && !/\b(?:NOT|ANDNOT)\b/iu.test(adaptedQuery)) {
      adaptation.push({ kind: 'removedOperator', detail: '排除条件已失去 NOT 运算符' })
    }
    if (/\b(?:AND|OR)\b/iu.test(query.text) && !/\b(?:AND|OR)\b/iu.test(adaptedQuery)) {
      adaptation.push({ kind: 'removedOperator', detail: '布尔运算符已移除' })
    }
    if (query.text.includes('*') && !adaptedQuery.includes('*'))
      adaptation.push({ kind: 'other', detail: '通配符已移除' })
    if (!adaptation.length) adaptation.push({ kind: 'other', detail: '已转换为来源语法' })
  }
  const pageSize = Math.min(Math.max(conditions.pageSize * 2, 10), MAX_LIMIT)
  const conditionFingerprint = digest([
    1,
    source,
    query.id,
    query.text,
    adaptedQuery,
    pageSize,
    conditions.yearFrom,
    conditions.yearTo,
    conditions.openAccessOnly,
    conditions.language,
    conditions.types,
  ])
  return {
    queryId: query.id,
    source,
    conditionFingerprint,
    adaptedQuery,
    adaptation,
    pageSize,
    capability:
      PROVIDERS[source].searchPage && !PROVIDERS[source].firstPageOnly ? 'pageable' : 'firstPageOnly',
    rankBasis: PROVIDERS[source].searchPage ? 'upstream' : 'providerOutput',
    progress: { lastCommittedPage: 0, next: null, stopReason: 'ready' },
    pages: [],
  }
}

export function newEvidence(conditions: TaskConditions): Evidence {
  const queries = conditions.queries.filter((q) => q.enabled && q.text.trim())
  return {
    taskMaxPapers: getSettings().taskMaxPapers,
    mergePolicyVersion: 1,
    runs: queries.flatMap((q) => resolveSources(conditions.sources).map((s) => makeRun(conditions, q, s))),
    groups: [],
    reviews: [],
    savedPaperIds: [],
    counts: { merged: 0, afterMergeFilter: 0, savedFromSearch: 0 },
  }
}

export function sameConditions(round: SearchRound, task: SearchTask): boolean {
  const fingerprints = (runs: SourceRun[]) => runs.map((r) => r.conditionFingerprint).join(',')
  return fingerprints(newEvidence(task.conditions).runs) === fingerprints(round.evidence?.runs ?? [])
}

export function filterReasons(paper: Pick<PaperRecord, 'year' | 'openAccess' | 'type' | 'language'>, c: TaskConditions): string[] {
  const reasons: string[] = []
  if (c.yearFrom !== undefined && (paper.year ?? 0) < c.yearFrom) reasons.push('yearFrom')
  if (c.yearTo !== undefined && (paper.year ?? Infinity) > c.yearTo) reasons.push('yearTo')
  if (c.openAccessOnly && !paper.openAccess) reasons.push('openAccessOnly')
  if (!matchesLanguage(paper, c.language)) reasons.push('language')
  if (c.types?.length && !c.types.some((type) => type.toLowerCase() === paper.type.toLowerCase()))
    reasons.push('type')
  return reasons
}

export async function fetchPage(
  run: SourceRun,
  conditions: TaskConditions,
  input: ResumePosition | null,
  signal: AbortSignal,
): Promise<ProviderPage> {
  const settings = getSettings()
  const provider = PROVIDERS[run.source]
  const options = {
    limit: run.pageSize,
    yearFrom: conditions.yearFrom,
    yearTo: conditions.yearTo,
    openAccessOnly: conditions.openAccessOnly,
    contactEmail: settings.contactEmail,
    timeoutMs: settings.requestTimeoutMs,
    signal,
    ncbiApiKey: settings.ncbiApiKey,
    openalexApiKey: settings.openalexApiKey,
    s2ApiKey: settings.s2ApiKey,
    serpApiKey: settings.serpApiKey,
  }
  if (!run.adaptedQuery) throw new SearchError('bad_request', '检索式在来源适配后为空')
  if (provider.searchPage) return provider.searchPage(run.adaptedQuery, options, input)
  const records = await provider.search(run.adaptedQuery, options)
  return {
    entries: records.map((record) => ({ record })),
    returned: null,
    normalized: null,
    reportedTotal: null,
    next: null,
  }
}

export function acceptPage(
  task: SearchTask,
  round: SearchRound,
  run: SourceRun,
  page: Page,
  attempt: Attempt,
  result: ProviderPage,
): void {
  const previous = run.pages.flatMap((p) => (p.committed ? [p.committed] : []))
  // 游标偶尔变化但仍返回同一批记录，换序也不应重复计数。
  const identities = result.entries.map((entry) =>
    'record' in entry
      ? entry.record.sourceId
        ? entry.record.source +
          ':' +
          (entry.record.source === 'europepmc'
            ? entry.record.url || entry.record.sourceId
            : entry.record.sourceId)
        : digest(entry.record)
      : entry.sourceId + ':' + entry.reason,
  )
  const fingerprint = digest(identities.sort())
  if (result.entries.length && previous.some((p) => p.contentFingerprint === fingerprint)) {
    attempt.outcome = 'duplicatePage'
    run.progress.stopReason = 'duplicatePage'
    return
  }
  const offset = previous.reduce((n, p) => n + p.observedEntries, 0)
  let kept = 0
  const before = previous.reduce((n, p) => n + p.kept, 0)
  const records = (task.records ??= {})
  const hits = result.entries.map((entry, i): Hit => {
    const pos = { position: i + 1, sourceRank: offset + i + 1 }
    if (!('record' in entry)) return { ...pos, status: 'invalid', ...entry }
    const recordId = digest(entry.record)
    records[recordId] ??= entry.record
    const reasons = filterReasons(entry.record, round.conditions)
    if (reasons.length) return { ...pos, recordId, status: 'filtered', reasons }
    kept++
    return { ...pos, recordId, status: 'kept', rank: before + kept }
  })
  const stalled =
    result.next !== null && run.pages.some((p) => JSON.stringify(p.input) === JSON.stringify(result.next))
  const next = stalled ? null : result.next
  page.committed = {
    at: attempt.endedAt!,
    hits,
    kept,
    observedEntries: hits.length,
    reportedTotal: result.reportedTotal,
    returned: result.returned,
    normalized: result.normalized,
    contentFingerprint: fingerprint,
    next,
  }
  attempt.outcome = 'committed'
  run.progress = {
    lastCommittedPage: page.pageNo,
    next,
    stopReason: stalled
      ? 'duplicatePage'
      : run.capability === 'firstPageOnly'
        ? 'firstPageOnly'
        : next
          ? 'ready'
          : 'exhausted',
  }
}
