import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
const { createHandler } = await import('../src/host/router.ts')
const { TaskService } = await import('../src/host/tasks/service.ts')
const { parseRis } = await import('../src/host/tasks/ris-parser.ts')
const { toZoteroItem } = await import('../src/host/zotero/connector.ts')
const { getSettings, setSettingsReader, ROUTE_PREFIX, WRITE_HEADER } = await import('../src/search/config.ts')
hook.deregister()

const journalDoi = '10.5555/sleep-journal'
const conferenceDoi = '10.5555/sleep-conference'
const content = [
  'TY  - JOUR', 'TI  - 跑步训练与大学生睡眠质量', 'AU  - Lin, Alice', 'DO  - ' + journalDoi, 'ER  - ',
  'TY  - CPAPER', 'T1  - Sleep quality after student exercise', 'A1  - Doe, Jane', 'A1  - 王, 小明',
  'T2  - Sleep Research Conference', 'PY  - 2024/07/01', 'DO  - https://doi.org/' + conferenceDoi,
  'AB  - First line', '  second line', 'SP  - 101', 'EP  - 108', 'ER  - ',
  'TY  - UNPB', 'TI  - Student Exercise Preprint', 'M3  - Preprint', 'T2  - Example Archive',
  'UR  - https://arxiv.org/abs/2401.01234v2', 'ER  - ',
  'TY  - JOUR', 'AU  - Missing, Title', 'ER  - ',
  'TY  - JOUR', 'TI  - Duplicate conference', 'DO  - ' + conferenceDoi, 'ER  - ',
].join('\r\n')

test('RIS 文件保留作者、载体和原始文献类型，定位坏记录', () => {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')])
  const parsed = parseRis(bytes)
  assert.equal(parsed.rows.length, 4)
  assert.deepEqual(parsed.issues, [{ record: 4, line: 24, code: 'missingTitle' }])
  assert.deepEqual(parsed.rows[1].metadata.authors, ['Doe, Jane', '王, 小明'])
  assert.equal(parsed.rows[1].metadata.venue, 'Sleep Research Conference')
  assert.equal(parsed.rows[1].metadata.abstract, 'First line\nsecond line')
  assert.equal(parsed.rows[1].rawType, 'CPAPER')
  assert.equal(parsed.rows[2].metadata.type, 'preprint')
  assert.equal(parsed.rows[2].metadata.arxivVersionId, '2401.01234v2')
  assert.throws(() => parseRis(Buffer.from([0xff, 0x83])), /编码/u)
})

test('真实 HTTP 入口导入 RIS，任务跨轮次、归档和重启保留题录、筛读和来源', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'litsearch-ris-'))
  const dir = join(root, 'storages', 'dsh-plugin-litsearch', 'tasks')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'isolated.json'), '{}')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const originalFetch = globalThis.fetch
  const settings = getSettings()
  setSettingsReader(() => ({ ...settings, autoDownloadPdf: false }))
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input))
    if (url.hostname !== 'api.crossref.org') return originalFetch(input, init)
    const items = url.searchParams.toString().includes('zero') ? [] : [
      { DOI: journalDoi, title: ['Running and sleep'], type: 'journal-article' },
    ]
    return Promise.resolve(Response.json({ message: { 'total-results': items.length, items } }))
  }
  let service = new TaskService()
  let handler = createHandler(service)
  const server = createServer((req, res) => void handler(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    service.dispose()
    server.close()
    globalThis.fetch = originalFetch
    setSettingsReader(() => settings)
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}${ROUTE_PREFIX}`
  const task = await service.create({ query: 'sleep', sources: ['crossref'], origin: 'panel', runNow: false })
  const taskPath = '/tasks/' + task.id
  async function route(path: string, payload?: object, expected = 200) {
    const response = await fetch(base + taskPath + path, payload && {
      method: 'POST',
      headers: { 'content-type': 'application/json', [WRITE_HEADER]: '1' },
      body: JSON.stringify(payload),
    })
    const envelope = await response.json()
    assert.equal(response.status, expected, JSON.stringify(envelope))
    return envelope.data
  }

  await service.run(task.id)
  const initial = await route('/results')
  assert.equal(initial.total, 1)
  const journalId = initial.papers[0].paperId
  await route('/annotate', { papers: [{ paperId: journalId, screening: 'included' }] })
  await service.update(task.id, { conditions: { queries: [{ text: 'zero' }] } })
  await service.run(task.id)
  assert.equal((await route('/results')).total, 0)

  const file = { content: Buffer.from(content).toString('base64'), database: '学校数据库', fileName: 'test.ris',
    query: '(students) AND (sleep quality)', searchedAt: '2026-11-27' }
  const before = await route('')
  const preview = await route('/ris/preview', file)
  assert.deepEqual([preview.total, preview.added, preview.matched, preview.issues.length], [5, 3, 1, 1])
  assert.equal((await route('')).rev, before.rev)
  const operations = await Promise.all(Array.from({ length: 2 }, () =>
    route('/ris/commit', { ...file, fingerprint: preview.fingerprint }),
  ))
  assert.deepEqual(operations.map((result) => result.alreadyImported).sort(), [false, true])
  assert.equal((await route('')).rev, before.rev + 1)
  assert.equal((await route('/ris')).length, 1)
  assert.equal((await route('/rounds/r2')).round.stats.loaded, 0)
  const afterImport = await route('/results')
  assert.equal(afterImport.total, 3)
  const journal = afterImport.papers.find((paper: { doi: string }) => paper.doi === journalDoi)
  const conference = afterImport.papers.find((paper: { doi: string }) => paper.doi === conferenceDoi)
  const preprint = afterImport.papers.find((paper: { type: string }) => paper.type === 'preprint')
  assert.equal(journal.paperId, journalId)
  assert.deepEqual(journal.hitSources, [])
  assert.equal((await route('/papers/' + journalId)).state.screening, 'included')
  assert.equal((await route('/papers/' + journalId)).searchOrigins[0].roundId, 'r1')
  assert.equal((await route('/papers/' + conference.paperId)).risOrigins[0].rawType, 'CPAPER')
  await route('/annotate', { papers: [{ paperId: conference.paperId, screening: 'excluded' }] })

  await route('/rounds/r1/switch', {})
  assert.equal((await route('/results')).total, 3)
  assert.equal((await route('/rounds/r1')).round.stats.loaded, 1)
  assert.deepEqual((await route('/papers/' + journalId)).paper.hitSources, initial.papers[0].hitSources)
  assert.equal((await route('/papers/' + journalId)).risOrigins[0].query, file.query)
  await route('/rounds/r2/switch', {})
  await route('/rounds/r1/draft', {}, 201)
  assert.equal((await route('/results')).total, 3)
  await service.run(task.id)
  assert.equal((await route('/rounds/r3')).round.stats.loaded, 1)
  assert.equal((await route('/results')).total, 3)
  const disk = JSON.parse(await readFile(join(dir, task.id + '.json'), 'utf8')).task
  assert.equal(disk.result.papers.length, 1)
  assert.equal(disk.risImports.length, 1)

  service.dispose()
  service = new TaskService()
  handler = createHandler(service)
  assert.equal((await route('/papers/' + conference.paperId)).state.screening, 'excluded')
  assert.equal((await route('/ris'))[0].issues[0].line, 24)
  const exportedRis = await fetch(base + '/export?format=ris&taskId=' + task.id).then((response) => response.text())
  const exportedRows = parseRis(Buffer.from(exportedRis)).rows
  assert.deepEqual(exportedRows.map((entry) => entry.metadata.type).sort(), ['journal-article', 'preprint', 'proceedings-article'])
  assert.equal(exportedRows.find((entry) => entry.metadata.doi === conferenceDoi)?.metadata.venue, 'Sleep Research Conference')
  const bibtex = await fetch(base + '/export?format=bibtex&taskId=' + task.id).then((response) => response.text())
  assert.match(bibtex, /@inproceedings\{[\s\S]*?author = \{Doe, Jane and 王, 小明\}[\s\S]*?booktitle = \{Sleep Research Conference\}/u)
  assert.match(bibtex, /@unpublished\{/u)
  const zotero = toZoteroItem(conference, [], '')
  assert.equal(zotero.itemType, 'conferencePaper')
  assert.equal(zotero.proceedingsTitle, 'Sleep Research Conference')
  assert.deepEqual((zotero.creators as unknown[])[0], { creatorType: 'author', lastName: 'Doe', firstName: 'Jane' })
  assert.equal(toZoteroItem(preprint, [], '').itemType, 'preprint')
})
