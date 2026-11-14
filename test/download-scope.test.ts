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
  describePages,
  mergeDownloadFilter,
  resolveDownloadScope,
  resolvePageWindow,
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

// ---- scope=pages：把「第 N 页」交给宿主换算 ---------------------------------

/** 45 篇、按结果原序；奇数下标的带 PDF 直链。 */
function pagedTask(): SearchTask {
  return task(
    Array.from({ length: 45 }, (_, index) =>
      paper(`p${index}`, index % 2 === 1 ? { pdfUrl: `https://example.org/p${index}.pdf` } : {}),
    ),
  )
}

const PAGE = 20

test('scope=pages 按每页 20 条与结果顺序切页', () => {
  const current = pagedTask()
  const result = resolve(current, {
    scope: 'pages',
    filter: {},
    pages: [2],
    pageSize: PAGE,
  })
  assert.deepEqual(
    result.paperIds,
    current.result.papers.slice(PAGE, PAGE * 2).map((item) => item.paperId),
  )
  assert.equal(result.pageCount, 3)
  assert.deepEqual(result.outOfRange, [])
  assert.match(result.scopeLabel, /第 2 页/)
  assert.match(result.scopeLabel, /共 20 篇/)
})

test('「第二页有 PDF 的文献」= 先切页再取交集，页面基准不因 hasPdf 前移', () => {
  const current = pagedTask()
  const viewMatched = filterPapers(current, {})
  const result = resolve(current, {
    scope: 'pages',
    filter: { hasPdf: true },
    pages: [2],
    pageBase: 'view',
    viewMatched,
    pageSize: PAGE,
  })
  const expected = current.result.papers
    .slice(PAGE, PAGE * 2)
    .filter((item) => item.pdfUrl !== '')
    .map((item) => item.paperId)
  assert.deepEqual(result.paperIds, expected)
  // 第 1 页里的 PDF 文献不能被算进来（那正是「筛后切页」才会出现的结果）。
  assert.equal(result.paperIds.includes('p1'), false)
})

test('pageBase=filtered 时先筛后切页：取「有 PDF 的第 2 页」', () => {
  const current = pagedTask()
  const pdfIds = current.result.papers
    .filter((item) => item.pdfUrl !== '')
    .map((item) => item.paperId)
  const result = resolve(current, {
    scope: 'pages',
    filter: { hasPdf: true },
    pages: [2],
    pageBase: 'filtered',
    pageSize: PAGE,
  })
  assert.deepEqual(result.paperIds, pdfIds.slice(PAGE, PAGE * 2))
})

test('跨页取数按页序拼接、去重，范围说明合并连续页码', () => {
  const current = task(
    Array.from({ length: 100 }, (_, index) => paper(`w${index}`)),
  )
  const result = resolve(current, {
    scope: 'pages',
    filter: {},
    pages: [5, 4],
    pageSize: PAGE,
  })
  assert.equal(result.paperIds.length, new Set(result.paperIds).size)
  assert.deepEqual(
    result.paperIds.slice(0, 3),
    current.result.papers.slice(PAGE * 3, PAGE * 3 + 3).map((item) => item.paperId),
  )
  assert.match(result.scopeLabel, /第 4–5 页/)
  assert.equal(result.paperIds.length, PAGE * 2)
})

test('页码越界记入 outOfRange，不产生任何清单条目', () => {
  const current = pagedTask()
  const result = resolve(current, {
    scope: 'pages',
    filter: {},
    pages: [4],
    pageSize: PAGE,
  })
  assert.deepEqual(result.paperIds, [])
  assert.deepEqual(result.outOfRange, [4])
  assert.equal(result.pageCount, 3)
})

test('未显式给每页篇数时按 20 兜底（与面板分页粒度一致）', () => {
  const current = pagedTask()
  const window = resolvePageWindow({
    pages: [2],
    pageBase: 'view',
    matched: current.result.papers,
    viewMatched: current.result.papers,
  })
  assert.equal(window.pageSize, 20)
  assert.deepEqual(
    window.paperIds,
    current.result.papers.slice(20, 40).map((item) => item.paperId),
  )
})

test('describePages 合并连续页码', () => {
  assert.equal(describePages([2]), '2')
  assert.equal(describePages([4, 5, 6]), '4–6')
  assert.equal(describePages([2, 5, 6]), '2、5–6')
  assert.equal(describePages([]), '')
})
