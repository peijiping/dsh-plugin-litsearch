import test from 'node:test'
import assert from 'node:assert/strict'

import type { Paper, PaperState, SearchTask, ViewSnapshot } from '../src/search/types.ts'
import { filterPapers } from '../src/host/tasks/filter.ts'
import type {
  DownloadScopeResult,
  ResolveDownloadOptions,
} from '../src/host/tasks/download.ts'
import {
  buildScopeLabel,
  mergeDownloadFilter,
  resolveDownloadScope,
  toPaperFilter,
} from '../src/host/tasks/download.ts'

/** 与工具层一致：先由 filterPapers 算出命中集合，再交给范围解析。 */
function resolve(
  current: SearchTask,
  options: Omit<ResolveDownloadOptions, 'matched'>,
): DownloadScopeResult {
  return resolveDownloadScope(current, {
    ...options,
    matched: filterPapers(current, options.filter),
  })
}

function paper(paperId: string, overrides: Partial<Paper> = {}): Paper {
  return {
    source: 'openalex',
    sourceId: paperId,
    ids: { doi: '', pmid: '', pmcid: '', arxivId: '' },
    title: `Title ${paperId}`,
    authors: ['Ada Lovelace'],
    year: 2020,
    venue: 'Journal',
    doi: '',
    url: 'https://example.org',
    abstract: '',
    citedBy: null,
    openAccess: false,
    pdfUrl: '',
    type: 'journal-article',
    paperId,
    hitSources: [{ source: 'openalex', rank: 1 }],
    matchedQueries: ['q1'],
    ...overrides,
  }
}

function task(papers: Paper[], states: Record<string, PaperState> = {}): SearchTask {
  return {
    id: 't1',
    title: 'task',
    conditions: {
      queries: [],
      sources: ['openalex'],
      openAccessOnly: false,
      language: 'any',
      sort: 'relevance',
      pageSize: 20,
    },
    status: 'done',
    origin: 'panel',
    rev: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    pinned: false,
    notes: '',
    groups: [],
    rounds: [],
    stats: {
      perQuery: {},
      rawHits: papers.length,
      deduped: papers.length,
      screening: { unread: 0, read: 0, included: 0, excluded: 0 },
    },
    result: { papers, sources: [] },
    states,
  }
}

function snapshot(overrides: Partial<ViewSnapshot> = {}): ViewSnapshot {
  return {
    sessionId: 's1',
    taskId: 't1',
    at: Date.now(),
    pageIndex: 0,
    pageSize: 20,
    filters: {},
    pagePaperIds: [],
    selectedIds: [],
    rev: 1,
    ...overrides,
  }
}

test('scope=ids 保序去重、过滤无效 id，并生成展示元数据', () => {
  const current = task([paper('p1'), paper('p2')])
  const result = resolve(current, {
    scope: 'ids',
    filter: {},
    explicitIds: ['p2', 'p1', 'p2', 'ghost', ''],
  })
  assert.deepEqual(result.paperIds, ['p2', 'p1'])
  assert.equal(result.ignored, 1)
  assert.deepEqual(
    result.items.map((item) => item.paperId),
    ['p2', 'p1'],
  )
  assert.equal(result.items[0].source, 'openalex')
  assert.equal(result.items[0].meta, 'Journal · 2020')
})

test('scope=currentPage 保持用户当前页顺序，并叠加 hasPdf 条件', () => {
  const current = task([
    paper('a', { pdfUrl: 'https://example.org/a.pdf' }),
    paper('b'),
    paper('c', { pdfUrl: 'https://example.org/c.pdf' }),
  ])
  const result = resolve(current, {
    scope: 'currentPage',
    filter: { hasPdf: true },
    snapshot: snapshot({ pageIndex: 1, pagePaperIds: ['c', 'b', 'a'] }),
  })
  assert.deepEqual(result.paperIds, ['c', 'a'])
  assert.match(result.scopeLabel, /当前页（第 2 页）/)
  assert.match(result.scopeLabel, /仅含 PDF/)
  assert.match(result.scopeLabel, /共 2 篇/)
})

test('全量范围不受 /results 的 200 条分页上限约束', () => {
  const papers = Array.from({ length: 250 }, (_, index) => paper(`p${index}`))
  const result = resolve(task(papers), { scope: 'all', filter: {} })
  assert.equal(result.paperIds.length, 250)
  assert.equal(result.items.length, 250)
  assert.equal(result.ignored, 0)
})

test('scope=group 只下该分组的文献，范围说明带分组名', () => {
  const current = task([paper('g1'), paper('g2')], {
    g1: { screening: 'unread', groupId: 'grp' },
  })
  const result = resolve(current, {
    scope: 'group',
    filter: { groupId: 'grp' },
    groupName: '综述',
  })
  assert.deepEqual(result.paperIds, ['g1'])
  assert.match(result.scopeLabel, /分组「综述」/)
})

test('视图筛选打底、显式条件覆盖同名项，其余 base 字段保留', () => {
  const base = toPaperFilter({ yearFrom: 2020, q: 'base' })
  const merged = mergeDownloadFilter(base, { q: 'explicit', yearFrom: undefined, hasPdf: true })
  assert.equal(merged.q, 'explicit')
  assert.equal(merged.yearFrom, 2020)
  assert.equal(merged.hasPdf, true)
})

test('toPaperFilter 只按白名单取值，非法枚举与未知键被丢弃', () => {
  const filter = toPaperFilter({
    yearFrom: 2021,
    screening: 'included',
    pdfStatus: 'bogus',
    hasPdf: true,
    q: '',
    whatever: 'ignored',
  })
  assert.equal(filter.yearFrom, 2021)
  assert.equal(filter.screening, 'included')
  assert.equal(filter.pdfStatus, undefined)
  assert.equal(filter.hasPdf, true)
  assert.equal(filter.q, undefined)
  assert.equal(Object.keys(filter).includes('whatever'), false)
})

test('范围为空时返回 0 篇、不产生任何待下载条目', () => {
  const result = resolve(task([paper('p1', { year: 2010 })]), {
    scope: 'filters',
    filter: { yearFrom: 3000 },
  })
  assert.deepEqual(result.paperIds, [])
  assert.deepEqual(result.items, [])
  assert.match(result.scopeLabel, /共 0 篇/)
})

test('buildScopeLabel 拼出可读的中文范围说明', () => {
  const label = buildScopeLabel('filters', 37, {
    filter: { yearFrom: 2023, openAccessOnly: true, q: 'CRISPR' },
  })
  assert.match(label, /按条件筛选/)
  assert.match(label, /仅开放获取/)
  assert.match(label, /关键词「CRISPR」/)
  assert.match(label, /2023–不限 年/)
  assert.match(label, /共 37 篇/)
})
