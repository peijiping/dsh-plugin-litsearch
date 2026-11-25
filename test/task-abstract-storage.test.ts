import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { abstractPreview } from '../src/client/text.ts'
import type { Paper, SearchTask } from '../src/search/types.ts'

// Host 源码按 NodeNext 使用 .js 导入，测试直接加载对应的 TypeScript 文件。
const hostSources = new URL('../src/', import.meta.url).href
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (
      context.parentURL?.startsWith(hostSources) &&
      specifier.startsWith('.') &&
      specifier.endsWith('.js')
    ) {
      return next(specifier.slice(0, -3) + '.ts', context)
    }
    return next(specifier, context)
  },
})
const { TaskStore } = await import('../src/host/tasks/store.ts')
hooks.deregister()

const retention = { retentionDays: 90, retentionCount: 120 }

function makeTask(abstracts: string[]): SearchTask {
  const papers = abstracts.map((abstract, index): Paper => ({
    paperId: `p${index}`,
    sourceId: `p${index}`,
    source: 'pubmed',
    ids: { doi: '', pmid: '', pmcid: '', arxivId: '' },
    title: 'Test paper',
    authors: [],
    year: null,
    venue: '',
    doi: '',
    url: '',
    abstract,
    citedBy: null,
    openAccess: false,
    pdfUrl: '',
    type: '',
    hitSources: [],
    matchedQueries: [],
  }))
  const now = new Date().toISOString()
  return {
    id: 't1',
    title: 'Test task',
    conditions: {
      queries: [],
      sources: ['pubmed'],
      openAccessOnly: false,
      language: 'any',
      sort: 'relevance',
      pageSize: 20,
    },
    status: 'done',
    origin: 'panel',
    rev: 1,
    createdAt: now,
    updatedAt: now,
    pinned: false,
    notes: '',
    groups: [],
    rounds: [],
    stats: {
      perQuery: {},
      rawHits: papers.length,
      deduped: papers.length,
      screening: { unread: papers.length, read: 0, included: 0, excluded: 0 },
    },
    result: { papers, sources: [] },
    states: {},
  }
}

async function openStore(root: string) {
  const store = new TaskStore(root)
  await store.load(retention)
  return store
}

test('长摘要重启后仍可展开，且新摘要以省略号结尾不会被标成旧截断', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'litsearch-abstract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const long = 'a'.repeat(805) + 'Key inclusion criterion.'
  const endsInEllipsis = 'b'.repeat(800) + '…'
  const task = makeTask([long, endsInEllipsis])
  const before = await openStore(root)
  before.put(task)
  await before.save(task)

  const reopened = await openStore(root)
  const result = await reopened.loadTask(task.id)
  assert.ok(result)
  assert.deepEqual(result.result.papers.map((paper) => paper.abstract), [long, endsInEllipsis])
  assert.equal(result.result.papers[1]?.abstractCompleteness, undefined)
  const text = result.result.papers[0]?.abstract ?? ''
  const preview = { shown: text, source: text, previewChars: 260 }
  assert.equal(abstractPreview({ ...preview, expanded: false }).text, 'a'.repeat(260) + '…')
  assert.equal(abstractPreview({ ...preview, expanded: true }).text, long)
})

test('旧任务只标记符合历史截断特征的摘要，另存再重开后保留标记', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'litsearch-legacy-abstract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const abstracts = ['a'.repeat(800) + '…', '', 'Short…']
  const task = makeTask(abstracts)
  await openStore(root)
  await writeFile(join(root, 'tasks', 't1.json'), JSON.stringify({ version: 1, task }))
  await rm(join(root, 'tasks', 'index.json'))

  const store = await openStore(root)
  const loaded = await store.loadTask(task.id)
  assert.ok(loaded)
  await store.save(loaded)

  const reopened = await openStore(root)
  const result = await reopened.loadTask(task.id)
  assert.ok(result)
  assert.deepEqual(result.result.papers.map((paper) => paper.abstract), abstracts)
  assert.deepEqual(
    result.result.papers.map((paper) => paper.abstractCompleteness),
    ['unknown', undefined, undefined],
  )
})
