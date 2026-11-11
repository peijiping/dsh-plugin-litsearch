import test from 'node:test'
import assert from 'node:assert/strict'

import type { Paper, PaperState, SearchTask, Screening } from '../src/search/types.ts'
import {
  filterKey,
  filterPapers,
  matchesLanguage,
  pdfStatusOf,
  screeningOf,
} from '../src/host/tasks/filter.ts'

function paper(paperId: string, overrides: Partial<Paper> = {}): Paper {
  return {
    source: 'openalex',
    sourceId: paperId,
    ids: { doi: '', pmid: '', pmcid: '', arxivId: '' },
    title: 'Default title',
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

test('screening defaults to unread and reads recorded state', () => {
  const papers = [paper('p1'), paper('p2')]
  const current = task(papers, { p2: { screening: 'included' } })
  assert.equal(screeningOf(current, papers[0]), 'unread')
  assert.equal(screeningOf(current, papers[1]), 'included')
})

test('pdfStatusOf prefers the recorded state, then the PDF link', () => {
  const linked = paper('p1', { pdfUrl: 'https://example.org/a.pdf' })
  const unknown = paper('p2')
  const downloaded = paper('p3')
  const current = task([linked, unknown, downloaded], { p3: { screening: 'read', pdfStatus: 'downloaded' } })
  assert.equal(pdfStatusOf(current, linked), 'available')
  assert.equal(pdfStatusOf(current, unknown), 'unknown')
  assert.equal(pdfStatusOf(current, downloaded), 'downloaded')
})

test('filterPapers combines keyword, year, source, access and screening filters', () => {
  const papers = [
    paper('p1', {
      title: 'CRISPR screening',
      abstract: 'gene editing',
      year: 2021,
      openAccess: true,
      matchedQueries: ['q1'],
      hitSources: [{ source: 'pubmed', rank: 1 }],
    }),
    paper('p2', {
      title: 'Other topic',
      year: 2015,
      matchedQueries: ['q2'],
    }),
  ]
  const current = task(papers, { p2: { screening: 'excluded' } })

  assert.deepEqual(
    filterPapers(current, { q: 'crispr' }).map((p) => p.paperId),
    ['p1'],
  )
  assert.deepEqual(
    filterPapers(current, { yearFrom: 2020 }).map((p) => p.paperId),
    ['p1'],
  )
  assert.deepEqual(
    filterPapers(current, { source: 'pubmed' }).map((p) => p.paperId),
    ['p1'],
  )
  assert.deepEqual(
    filterPapers(current, { openAccessOnly: true }).map((p) => p.paperId),
    ['p1'],
  )
  assert.deepEqual(
    filterPapers(current, { queryId: 'q2' }).map((p) => p.paperId),
    ['p2'],
  )
  assert.deepEqual(
    filterPapers(current, { screening: 'excluded' }).map((p) => p.paperId),
    ['p2'],
  )
})

test('missingFullText keeps only states without a full text', () => {
  const papers = [paper('unknown'), paper('available'), paper('html'), paper('downloaded'), paper('paywalled')]
  const current = task(papers, {
    available: { screening: 'unread', pdfStatus: 'available' },
    html: { screening: 'unread', pdfStatus: 'html-only' },
    downloaded: { screening: 'unread', pdfStatus: 'downloaded' },
    paywalled: { screening: 'unread', pdfStatus: 'paywalled' },
  })
  assert.deepEqual(
    filterPapers(current, { missingFullText: true }).map((p) => p.paperId),
    ['unknown', 'paywalled'],
  )
})

test('pdfStatus filters by the effective full-text state', () => {
  const papers = [paper('unknown'), paper('available'), paper('downloaded'), paper('failed')]
  const current = task(papers, {
    available: { screening: 'unread', pdfStatus: 'available' },
    downloaded: { screening: 'unread', pdfStatus: 'downloaded' },
    failed: { screening: 'unread', pdfStatus: 'failed' },
  })
  assert.deepEqual(
    filterPapers(current, { pdfStatus: 'available' }).map((p) => p.paperId),
    ['available'],
  )
  assert.deepEqual(
    filterPapers(current, { pdfStatus: 'unknown' }).map((p) => p.paperId),
    ['unknown'],
  )
  assert.deepEqual(
    filterPapers(current, { pdfStatus: 'failed' }).map((p) => p.paperId),
    ['failed'],
  )
})

test('newOnly excludes papers already present in the base task', () => {
  const papers = [paper('p1'), paper('p2')]
  const current = task(papers)
  assert.deepEqual(
    filterPapers(current, { newOnly: true, newPaperIds: new Set(['p1']) }).map((p) => p.paperId),
    ['p2'],
  )
})

test('matchesLanguage accepts prefixes', () => {
  assert.equal(matchesLanguage(paper('p1', { language: 'eng' }), 'eng'), true)
  assert.equal(matchesLanguage(paper('p1', { language: 'en-US' }), 'eng'), true)
  assert.equal(matchesLanguage(paper('p1', { language: 'chi' }), 'chi'), true)
  assert.equal(matchesLanguage(paper('p1', { language: 'zh-CN' }), 'chi'), true)
  assert.equal(matchesLanguage(paper('p1', { language: 'fre' }), 'eng'), false)
  assert.equal(matchesLanguage(paper('p1'), 'any'), true)
})

test('filterKey is stable and distinguishes meaningful filters', () => {
  const base = filterKey({ screening: 'included' as Screening })
  assert.equal(base, filterKey({ screening: 'included' }))
  assert.notEqual(base, filterKey({ screening: 'excluded' }))
  assert.notEqual(base, filterKey({}))
  assert.notEqual(filterKey({}), filterKey({ pdfStatus: 'failed' }))
  assert.notEqual(filterKey({ pdfStatus: 'failed' }), filterKey({ pdfStatus: 'unknown' }))
})
