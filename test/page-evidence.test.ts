import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const sourceRoot = new URL('../src/', import.meta.url).href
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return next(specifier.slice(0, -3) + '.ts', context)
    }
    return next(specifier, context)
  },
})
const { TaskStore } = await import('../src/host/tasks/store.ts')
const { TaskService } = await import('../src/host/tasks/service.ts')
const { createHandler } = await import('../src/host/router.ts')
const { getSettings, setSettingsReader, ROUTE_PREFIX, WRITE_HEADER } = await import('../src/search/config.ts')
const { SearchError } = await import('../src/search/errors.ts')
const { PROVIDERS } = await import('../src/search/providers/index.ts')
const { resetSourceHealth } = await import('../src/search/health.ts')
const { makePaperId } = await import('../src/search/identity.ts')
const { rebuildRound } = await import('../src/host/tasks/paper-groups.ts')
const { acceptPage, newEvidence } = await import('../src/host/tasks/page-evidence.ts')
hook.deregister()

test('检索页可复算，重启后续取同页，复核与版本迁移经真实 HTTP 入口', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'litsearch-pages-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const tasksDir = join(root, 'storages', 'dsh-plugin-litsearch', 'tasks')
  await mkdir(tasksDir, { recursive: true })
  await writeFile(join(tasksDir, 'isolated.json'), '{}')
  const settings = getSettings()
  setSettingsReader(() => ({
    ...settings,
    autoDownloadPdf: false,
    taskMaxPapers: 100,
    contactEmail: 'private@example.test',
    openalexApiKey: 'private-key',
  }))
  const original = globalThis.fetch
  const epmc = PROVIDERS.europepmc.searchPage!
  let service = new TaskService()
  const server = createServer((req, res) => void handler(req, res))
  let handler = createHandler(service)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  assert.ok(addr && typeof addr !== 'string')
  const base = 'http://127.0.0.1:' + addr.port + ROUTE_PREFIX
  t.after(async () => {
    globalThis.fetch = original
    PROVIDERS.europepmc.searchPage = epmc
    setSettingsReader(() => settings)
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    service.dispose()
    server.close()
    await rm(root, { recursive: true, force: true })
  })
  const sourceCalls: string[] = []
  const paper = (n: number) => ({
    source: 'MED',
    id: String(n),
    pmid: String(n),
    doi: '10.1234/demo' + n,
    title: n === 4 ? 'Same title with different DOI' : '&lt;i&gt;Sleep&lt;/i&gt; memory study ' + n,
    pubYear: '2023',
    isOpenAccess: 'Y',
    pubTypeList: { pubType: [n <= 15 ? 'Journal Article' : 'Review'] },
  })
  const first = [
    ...Array.from({ length: 12 }, (_, i) => paper(i + 1)),
    ...Array.from({ length: 27 }, (_, i) => paper(i + 16)),
    { id: '999' },
  ]
  const second = [paper(12), paper(13), paper(14), paper(15)]
  const crossref = Array.from({ length: 8 }, (_, i) => ({
    DOI: '10.1234/demo' + (i < 3 ? i + 1 : i + 101),
    title: [i === 3 ? 'Same title with different DOI' : 'Crossref study ' + i],
    issued: { 'date-parts': [[2023]] },
    license: [{ URL: 'https://creativecommons.org/licenses/by/4.0/' }],
    type: 'journal-article',
  }))
  const supplementalDoi = '10.1234/manual-round-2'
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input))
    if (url.hostname === 'www.ebi.ac.uk') {
      const cursor = url.searchParams.get('cursorMark')
      sourceCalls.push('epmc:' + cursor)
      const query = url.searchParams.get('query')
      if (query?.includes('zero')) return Promise.resolve(Response.json({ hitCount: 0 }))
      if (query?.includes('limited') && cursor !== '*') {
        return Promise.resolve(new Response(null, { status: 429, headers: { 'retry-after': '120' } }))
      }
      if (query?.includes('expired') && cursor !== '*') {
        return Promise.resolve(new Response(null, { status: 400 }))
      }
      if (query?.includes('duplicate') && cursor !== '*') {
        return Promise.resolve(
          Response.json({ hitCount: 44, nextCursorMark: 'third', resultList: { result: first } }),
        )
      }
      return Promise.resolve(
        Response.json(
          cursor === '*'
            ? { hitCount: 44, nextCursorMark: 'private-cursor', resultList: { result: first } }
            : { hitCount: 44, resultList: { result: second } },
        ),
      )
    }
    if (url.hostname === 'api.crossref.org') {
      sourceCalls.push('crossref')
      if (url.pathname !== '/works') {
        return Promise.resolve(Response.json({
          message: { DOI: supplementalDoi, title: ['Manual round 2'], type: 'journal-article' },
        }))
      }
      return Promise.resolve(Response.json({ message: { 'total-results': 71, items: crossref } }))
    }
    return original(input, init)
  }
  const route = async (path: string, body?: Record<string, unknown>, expected = 200) => {
    const response = await fetch(
      base + path,
      body && {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', [WRITE_HEADER]: '1' },
      },
    )
    const envelope = await response.json()
    assert.equal(response.status, expected, JSON.stringify(envelope))
    return envelope.data
  }
  const create = (query = 'sleep[tiab] AND memory[tiab]', both = true) =>
    service.create({
      origin: 'panel',
      query,
      sources: both ? ['europepmc', 'crossref'] : ['europepmc'],
      runNow: false,
      pageSize: 20,
      yearFrom: 2020,
      yearTo: 2025,
      openAccessOnly: true,
      types: ['Journal Article', 'journal-article'],
    })
  const task = await create()
  await service.run(task.id)
  const endpoint = '/tasks/' + task.id + '/rounds/r1'
  const next = { source: 'europepmc', queryId: 'q1', pageNo: 2 }
  assert.equal((await route('/tasks/' + task.id + '/results')).total, 17)
  assert.equal(sourceCalls.length, 2)
  const before = await route(endpoint)
  const run = before.round.evidence.runs.find((r) => r.source === 'europepmc')
  assert.match(
    run.pages[0].attempts[0].requests[0].params.query,
    /PUB_YEAR:\[2020 TO 2025\] AND OPEN_ACCESS:y/,
  )
  assert.deepEqual(
    [run.pages[0].committed.returned, run.pages[0].committed.normalized, run.pages[0].committed.kept],
    [40, 39, 12],
  )
  assert.ok(Object.values(before.records).some((record) => record.title === 'Sleep memory study 1'))
  assert.doesNotMatch(JSON.stringify(before), /private-cursor|private@example.test|private-key/)
  assert.match(await readFile(join(tasksDir, task.id + '.json'), 'utf8'), /private-cursor/)
  let failOnce = true
  PROVIDERS.europepmc.searchPage = async (query, options, position) => {
    if (position && failOnce) {
      failOnce = false
      throw new SearchError('timeout', '固定样例第 2 页超时')
    }
    return epmc(query, options, position)
  }
  let report = await route(endpoint + '/next', next)
  assert.equal(report.round.status, 'partial')
  assert.equal(report.round.evidence.counts.savedFromSearch, 17)
  service.dispose()
  service = new TaskService()
  handler = createHandler(service)
  assert.equal((await route('/tasks/' + task.id + '/results')).total, 17)
  report = await route(endpoint + '/next', next)
  const ev = report.round.evidence
  assert.deepEqual(
    ev.runs.find((r) => r.source === 'europepmc').pages[1].attempts.map((a) => a.outcome),
    ['timeout', 'committed'],
  )
  assert.equal(report.round.stats.rawHits, 24)
  assert.deepEqual(ev.counts, { merged: 20, afterMergeFilter: 20, savedFromSearch: 20 })
  assert.equal(Object.keys(report.records).length, 50)
  await route(endpoint + '/next', next, 409)
  assert.equal(sourceCalls.length, 3)
  assert.equal((await route('/tasks/' + task.id + '/rounds'))[0].evidence, undefined)

  const continuous = await create()
  await service.run(continuous.id)
  const comparison = await route('/tasks/' + continuous.id + '/rounds/r1/next', next)
  assert.deepEqual(comparison.round.evidence.savedPaperIds, ev.savedPaperIds)
  assert.deepEqual(comparison.round.stats, report.round.stats)
  // 把已存在的任务文件临时换为目录，确保原子替换失败且内存没有推进。
  const store = new TaskStore(join(root, 'storages', 'dsh-plugin-litsearch'))
  await store.load({ retentionCount: 100, retentionDays: 7 })
  const snapshot = await store.loadTask(task.id)
  assert.ok(snapshot)
  const originalFile = join(tasksDir, task.id + '.json')
  const backup = originalFile + '.backup'
  const snapshotRev = snapshot.rev
  await rename(originalFile, backup)
  await mkdir(originalFile)
  try {
    await assert.rejects(
      store.checkpoint(snapshot, (draft) => {
        draft.rounds[0].evidence!.runs[0].progress.lastCommittedPage = 99
      }),
      /EISDIR|ENOTDIR/,
    )
    assert.equal(snapshot.rev, snapshotRev)
    assert.equal(snapshot.rounds[0].evidence!.runs[0].progress.lastCommittedPage, 2)
  } finally {
    await rm(originalFile, { recursive: true })
    await rename(backup, originalFile)
  }
  const sameTitle = ev.reviews.find((r) => r.reason === 'sameTitleDifferentDoi')
  report = await route(endpoint + '/review', {
    rev: report.rev,
    subject: sameTitle.id,
    action: 'linkVersions',
  })
  assert.equal(
    report.round.evidence.reviews.find((r) => r.id === sameTitle.id).decisions[0].action,
    'linkVersions',
  )
  report = await route(endpoint + '/review', {
    rev: report.rev,
    subject: makePaperId('doi:10.1234/demo1'),
    action: 'split',
  })
  assert.equal(report.round.evidence.counts.savedFromSearch, 21)

  const zero = await create('zero', false)
  await service.run(zero.id)
  assert.equal(zero.status, 'done')
  assert.equal(zero.rounds[0].evidence?.runs[0].pages[0].committed?.returned, 0)
  const duplicate = await create('duplicate', false)
  await service.run(duplicate.id)
  const repeated = await route('/tasks/' + duplicate.id + '/rounds/r1/next', next)
  assert.equal(repeated.round.evidence.runs[0].progress.stopReason, 'duplicatePage')
  assert.equal(repeated.round.stats.rawHits, 12)
  setSettingsReader(() => ({ ...settings, taskMaxPapers: 5, autoDownloadPdf: false }))
  const capped = await create('limit', false)
  await service.run(capped.id)
  assert.equal(capped.result.papers.length, 5)
  assert.equal(capped.rounds[0].evidence?.runs[0].progress.stopReason, 'taskLimit')

  setSettingsReader(() => ({ ...settings, taskMaxPapers: 100, autoDownloadPdf: false }))
  const expired = await create('expired', false)
  await service.run(expired.id)
  const expiredReport = await route('/tasks/' + expired.id + '/rounds/r1/next', next)
  assert.equal(expiredReport.round.evidence.runs[0].progress.stopReason, 'cursorExpired')
  await route('/tasks/' + expired.id + '/rounds/r1/next', next, 409)
  const limited = await create('limited', false)
  await service.run(limited.id)
  const limitedEndpoint = '/tasks/' + limited.id + '/rounds/r1'
  const limitedReport = await route(limitedEndpoint + '/next', next)
  assert.equal(limitedReport.round.evidence.runs[0].progress.stopReason, 'rateLimited')
  assert.ok(Date.parse(limitedReport.round.evidence.runs[0].progress.retryAfter) > Date.now())
  assert.equal(limitedReport.round.stats.loaded, 12)
  await route(limitedEndpoint + '/next', next, 409)
  resetSourceHealth()

  const interrupted = await create('interrupted', false)
  await service.run(interrupted.id)
  let started!: () => void
  const pending = new Promise<void>((resolve) => {
    started = resolve
  })
  PROVIDERS.europepmc.searchPage = (query, opts, position) =>
    position
      ? new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => reject(new Error('fixture canceled')), { once: true })
          started()
        })
      : epmc(query, opts, position)
  const continueInterrupted = service.continuePage(interrupted.id, { ...next, roundId: 'r1' })
  await pending
  await service.cancel(interrupted.id)
  await continueInterrupted
  assert.equal(interrupted.status, 'canceled')
  assert.equal(interrupted.result.papers.length, 12)
  PROVIDERS.europepmc.searchPage = epmc
  await service.continuePage(interrupted.id, { ...next, roundId: 'r1' })
  assert.equal(interrupted.result.papers.length, 15)

  const switchable = await create()
  await service.run(switchable.id)
  const taskPath = '/tasks/' + switchable.id
  const firstResults = await route(taskPath + '/results')
  const firstConditions = switchable.conditions
  const firstPaperId = firstResults.papers[0].paperId
  await service.annotate(switchable.id, [{ paperId: firstPaperId, screening: 'included' }])
  await service.rerun(switchable.id, { origin: 'panel', query: 'zero', sources: ['europepmc'] }, 'panel')
  assert.equal((await route(taskPath + '/results')).total, 0)
  const supplement = await route(taskPath + '/supplement', { identifier: supplementalDoi })
  assert.equal(supplement.status, 'added')

  const callsBeforeSwitch = sourceCalls.length
  const restored = await route(taskPath + '/rounds/r1/switch', {})
  assert.equal(restored.activeRoundId, 'r1')
  assert.equal(restored.roundCount, 2)
  assert.deepEqual(restored.conditions, firstConditions)
  assert.equal(restored.stats.rawHits, 20)
  assert.equal(restored.result.totalLoaded, firstResults.total)
  assert.deepEqual((await route(taskPath + '/results')).papers, firstResults.papers)
  const included = await route(taskPath + '/results?screening=included&limit=1')
  assert.equal(included.total, 1)
  assert.equal(included.papers[0].paperId, firstPaperId)
  assert.equal((await route(taskPath + '/rounds/r1')).isCurrent, true)
  assert.equal((await route(taskPath + '/rounds/r2')).isCurrent, false)

  const draft = await route('/tasks', { ...restored.conditions, runNow: false }, 201)
  assert.notEqual(draft.id, switchable.id)
  assert.equal(draft.status, 'draft')
  assert.deepEqual(draft.conditions, firstConditions)
  assert.equal(draft.roundCount, 0)
  assert.equal((await route('/tasks/' + draft.id + '/results')).total, 0)
  assert.equal(sourceCalls.length, callsBeforeSwitch)

  service.dispose()
  service = new TaskService()
  handler = createHandler(service)
  assert.equal((await route(taskPath)).activeRoundId, 'r1')
  assert.equal((await route(taskPath + '/results')).total, firstResults.total)
  assert.equal((await route(taskPath + '/rounds/r2/switch', {})).result.totalLoaded, 1)
  assert.equal((await route(taskPath + '/results?supplementedOnly=1')).papers[0].doi, supplementalDoi)
  await route(taskPath + '/rounds/r1/switch', {})
  const continued = await route(taskPath + '/rounds/r1/next', next)
  assert.equal(continued.round.stats.loaded, 20)
  assert.equal((await route(taskPath + '/rounds/r2')).round.stats.loaded, 1)
  await route(taskPath + '/run', {}, 202)
  assert.equal(await service.waitUntilIdle(switchable.id, 5000), true)
  const rerun = await route(taskPath)
  assert.equal(rerun.activeRoundId, 'r3')
  assert.deepEqual(rerun.conditions, firstConditions)
  assert.equal(rerun.roundCount, 3)

  const switchableFile = join(tasksDir, switchable.id + '.json')
  const oldEvidence = JSON.parse(await readFile(switchableFile, 'utf8'))
  const oldestRound = oldEvidence.task.rounds[0]
  delete oldestRound.resultSnapshot
  await writeFile(switchableFile, JSON.stringify(oldEvidence))
  service.dispose()
  service = new TaskService()
  handler = createHandler(service)
  assert.equal((await route(taskPath + '/rounds/r1/switch', {})).result.totalLoaded, 20)

  delete oldestRound.evidence
  await writeFile(switchableFile, JSON.stringify(oldEvidence))
  service.dispose()
  service = new TaskService()
  handler = createHandler(service)
  assert.equal((await route(taskPath + '/rounds'))[0].hasResults, false)
  await route(taskPath + '/rounds/r1/switch', {}, 409)
  assert.equal((await route(taskPath)).activeRoundId, 'r3')

  // 老版本最后一轮仍有当前题录，离开后也能切回来。
  delete oldEvidence.task.activeRoundId
  delete oldEvidence.task.rounds[2].evidence
  await writeFile(switchableFile, JSON.stringify(oldEvidence))
  service.dispose()
  service = new TaskService()
  handler = createHandler(service)
  const legacyResults = await route(taskPath + '/results')
  assert.equal((await route(taskPath + '/rounds/r2/switch', {})).activeRoundId, 'r2')
  assert.equal((await route(taskPath + '/rounds/r3/switch', {})).activeRoundId, 'r3')
  assert.deepEqual((await route(taskPath + '/results')).papers, legacyResults.papers)

  await service.update(switchable.id, {
    notes: '同一个研究问题的笔记',
    groups: [{ id: 'g1', name: '待读', order: 0 }],
  })
  const callsBeforeDraft = sourceCalls.length
  const roundDraft = await route(taskPath + '/rounds/r1/draft', {}, 201)
  assert.equal(roundDraft.id, switchable.id)
  assert.equal(roundDraft.activeRoundId, 'r4')
  assert.equal(roundDraft.status, 'draft')
  assert.equal(roundDraft.roundCount, 4)
  assert.deepEqual(roundDraft.conditions, firstConditions)
  assert.equal(roundDraft.notes, '同一个研究问题的笔记')
  assert.equal(roundDraft.groups[0].name, '待读')
  assert.equal((await route(taskPath + '/results')).total, 0)
  assert.equal((await route(taskPath + '/rounds/r4')).round.status, 'draft')
  assert.equal(sourceCalls.length, callsBeforeDraft)

  await service.update(switchable.id, {
    conditions: { queries: [{ text: 'zero' }], sources: ['europepmc'] },
  }, roundDraft.rev)
  assert.equal((await route(taskPath + '/rounds/r4')).round.conditions.queries[0].text, 'zero')
  assert.deepEqual((await route(taskPath + '/rounds/r1')).round.conditions, firstConditions)
  await route(taskPath + '/rounds/r3/switch', {})
  assert.deepEqual((await route(taskPath + '/results')).papers, legacyResults.papers)
  service.dispose()
  service = new TaskService()
  handler = createHandler(service)
  const savedDraft = await route(taskPath + '/rounds/r4/switch', {})
  assert.equal(savedDraft.status, 'draft')
  assert.equal(savedDraft.conditions.queries[0].text, 'zero')
  assert.equal(sourceCalls.length, callsBeforeDraft)

  await route(taskPath + '/run', {}, 202)
  assert.equal(await service.waitUntilIdle(switchable.id, 5000), true)
  const executedDraft = await route(taskPath)
  assert.equal(executedDraft.status, 'done')
  assert.equal(executedDraft.activeRoundId, 'r4')
  assert.equal(executedDraft.roundCount, 4)
  assert.equal(executedDraft.rounds[3].status, 'done')
  assert.ok(executedDraft.rounds[3].startedAt)
  assert.equal(executedDraft.notes, savedDraft.notes)
  assert.equal(sourceCalls.length, callsBeforeDraft + 1)

  // 模拟 v2 文件，旧论文状态可读取，旧轮次不虚构执行明细。
  const taskFile = join(tasksDir, zero.id + '.json')
  const legacy = JSON.parse(await readFile(taskFile, 'utf8'))
  legacy.version = 2
  delete legacy.task.rounds[0].evidence
  await writeFile(taskFile, JSON.stringify(legacy))
  service.dispose()
  service = new TaskService()
  handler = createHandler(service)
  assert.equal((await route('/tasks/' + zero.id + '/rounds/r1')).round.evidence, undefined)
})

test('强标识桥接冲突不因返回顺序而误合并', () => {
  const conditions = {
    queries: [{ id: 'q1', name: 'x', text: 'x', enabled: true }],
    sources: ['europepmc'],
    openAccessOnly: false,
    language: 'any',
    sort: 'relevance',
    pageSize: 20,
  } as const
  const variants = [
    ['10.1234/a', ''],
    ['10.1234/a', '7'],
    ['10.1234/b', '7'],
  ]
  const run = (sequence: number[]) => {
    const round = { id: 'r1', conditions, evidence: newEvidence(conditions) }
    const task = { rounds: [round], result: { papers: [], sources: [] }, stats: {}, states: {} }
    const source = round.evidence.runs[0]
    const attempt = { startedAt: '', endedAt: '2026-11-26T00:00:00Z', outcome: 'started', requests: [] }
    const page = { pageNo: 1, input: null, attempts: [attempt] }
    source.pages.push(page)
    const entries = sequence.map((i) => ({
      record: {
        source: 'europepmc',
        sourceId: String(i),
        ids: { doi: variants[i][0], pmid: variants[i][1], pmcid: '', arxivId: '' },
        doi: variants[i][0],
        title: 'Study ' + i,
        authors: [],
        year: 2023,
        venue: '',
        url: '',
        abstract: '',
        citedBy: null,
        openAccess: true,
        pdfUrl: '',
        type: 'Journal Article',
      },
    }))
    acceptPage(task, round, source, page, attempt, {
      entries,
      returned: 3,
      normalized: 3,
      reportedTotal: 3,
      next: null,
    })
    rebuildRound(task, round)
    assert.equal(round.evidence.reviews[0].reason, 'strongIdConflict')
    assert.ok(round.evidence.groups.every((g) => g.members.length === 1))
    return [...round.evidence.savedPaperIds].sort()
  }
  assert.deepEqual(run([0, 1, 2]), run([2, 1, 0]))
})
