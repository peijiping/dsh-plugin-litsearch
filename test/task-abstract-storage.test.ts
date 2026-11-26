import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
const { europePmcTitle } = await import('../src/search/paper-title.ts')
const { identityKey, makePaperId } = await import('../src/search/identity.ts')
const { newEvidence, acceptPage } = await import('../src/host/tasks/page-evidence.ts')
const { rebuildRound } = await import('../src/host/tasks/paper-groups.ts')
const { startRound } = await import('../src/host/tasks/rounds.ts')
hooks.deregister()

const retention = { retentionDays: 90, retentionCount: 120 }

function makeTask(abstracts: string[]): SearchTask {
  const papers = abstracts.map(
    (abstract, index): Paper => ({
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
    }),
  )
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
  assert.deepEqual(
    result.result.papers.map((paper) => paper.abstract),
    [long, endsInEllipsis],
  )
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
  assert.deepEqual(
    result.result.papers.map((paper) => paper.abstract),
    abstracts,
  )
  assert.deepEqual(
    result.result.papers.map((paper) => paper.abstractCompleteness),
    ['unknown', undefined, undefined],
  )
})

test('Europe PMC 题名去除转义的排版标签，保留科学文本与符号', () => {
  assert.equal(europePmcTitle('&lt;i&gt;Drosophila&lt;/i&gt; &amp; p &lt; 0.05'), 'Drosophila & p < 0.05')
  assert.equal(europePmcTitle('<jats:italic>H</jats:italic><sub>2</sub>O &#x03B2;'), 'H2O β')
  assert.equal(europePmcTitle('expression x<y and z>w'), 'expression x<y and z>w')
})

test('v2 任务按需升级：首次打开只在内存迁移，首次保存备份原件，重新检索继续使用原 paperId', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'litsearch-v2-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const legacy = makeTask(['完整摘要', '手工补录'])
  const paper = legacy.result.papers[0]
  paper.source = 'europepmc'
  paper.sourceId = 'MED-1'
  paper.url = 'https://europepmc.org/article/MED/1'
  paper.title = '&lt;i&gt;Sleep&lt;/i&gt; and memory consolidation'
  const oldId = makePaperId(identityKey(paper))
  paper.paperId = oldId
  const supplement = legacy.result.papers[1]
  supplement.supplement = { kind: 'doi', id: '10.1234/supplement', addedAt: legacy.createdAt }
  supplement.ids.doi = supplement.supplement.id
  legacy.supplements = [structuredClone(supplement)]
  legacy.conditions.sources = ['europepmc']
  legacy.conditions.queries = [{ id: 'q1', name: '原式', text: 'sleep', enabled: true }]
  legacy.notes = '研究笔记'
  legacy.groups = [{ id: 'g1', name: '重点', order: 0 }]
  legacy.states[oldId] = {
    screening: 'included',
    groupId: 'g1',
    pdfFile: '/example/study.pdf',
    pdfStatus: 'downloaded',
    zoteroStatus: 'synced',
    zoteroTransfers: [
      {
        baseUrl: 'http://127.0.0.1:23119',
        targetId: 'c1',
        targetName: 'Sleep',
        parent: { status: 'done', key: 'ABCD1234' },
        collection: 'done',
        attachment: { status: 'done', key: 'PDF12345' },
      },
    ],
  }
  startRound(legacy, 'panel', 5)
  await openStore(root)
  const file = join(root, 'tasks', 't1.json')
  const backup = join(root, 'task-backups-v3', 't1.json')
  const original = JSON.stringify({ version: 2, task: legacy })
  // 模拟早期 index 写入成功但遗漏了任务正文条目的情况。
  await writeFile(file, original)
  const store = await openStore(root)
  await store.saveCurrent({ version: 1, current: { taskId: legacy.id, at: 123 } })
  const migrated = await store.loadTask(legacy.id)
  assert.ok(migrated)
  assert.equal(await readFile(file, 'utf8'), original)
  await assert.rejects(readFile(backup), { code: 'ENOENT' })
  assert.equal(migrated.result.papers[0].title, 'Sleep and memory consolidation')
  assert.equal(migrated.result.papers[0].paperId, oldId)
  assert.deepEqual(migrated.states, legacy.states)
  assert.equal(migrated.rounds[0].evidence, undefined)
  assert.equal(migrated.updatedAt, legacy.updatedAt)
  assert.deepEqual(migrated.supplements, legacy.supplements)
  await store.save(migrated, true)
  assert.equal(await readFile(backup, 'utf8'), original)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 3)

  const reopened = await openStore(root)
  const task = await reopened.loadTask(legacy.id)
  assert.ok(task)
  assert.equal((await reopened.loadCurrent())?.current?.taskId, legacy.id)
  assert.deepEqual(task.states, legacy.states)
  assert.equal(task.notes, legacy.notes)
  assert.deepEqual(task.groups, legacy.groups)
  const round = startRound(task, 'panel', 5)
  round.evidence = newEvidence(round.conditions)
  const run = round.evidence.runs[0]
  const attempt = {
    startedAt: task.updatedAt,
    endedAt: task.updatedAt,
    requests: [],
    outcome: 'started' as const,
  }
  const page = { pageNo: 1, input: null, attempts: [attempt] }
  run.pages.push(page)
  const record = {
    ...task.result.papers[0],
    doi: '10.1234/new-id',
    ids: { ...paper.ids, doi: '10.1234/new-id' },
  }
  acceptPage(task, round, run, page, attempt, {
    entries: [{ record }],
    returned: 1,
    normalized: 1,
    reportedTotal: 1,
    next: null,
  })
  rebuildRound(task, round)
  assert.equal(task.result.papers.find((p) => p.doi === record.doi)?.paperId, oldId)
  assert.equal(task.stats.screening.included, 1)
  assert.equal(task.stats.supplemented, 1)
  await reopened.save(task, true)
  assert.equal(await readFile(backup, 'utf8'), original)
})
