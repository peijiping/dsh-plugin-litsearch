import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const sourceRoot = new URL('../src/', import.meta.url).href
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return next(specifier.slice(0, -3) + '.ts', context)
    }
    return next(specifier, context)
  },
})
const { parseIdentifier } = await import('../src/search/lookup.ts')
const { TaskService } = await import('../src/host/tasks/service.ts')
const { createHandler } = await import('../src/host/router.ts')
const { literatureTools } = await import('../src/host/tools.ts')
const { getSettings, setSettingsReader, ROUTE_PREFIX, WRITE_HEADER } = await import('../src/search/config.ts')
hooks.deregister()

const DOI = '10.5555/test'
const SEARCHED_DOI = '10.5555/already-in-results'
const COLLECTION = 'AAAA2222'
const PDF = Buffer.from('%PDF-1.4\nstartxref\n0\n%%EOF\n')

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

test('精确补录保留 arXiv 版本，拒绝泛检索语句', () => {
  assert.deepEqual(parseIdentifier('https://doi.org/10.1234/Ab%28CD%29'), { kind: 'doi', id: '10.1234/ab(cd)' })
  assert.deepEqual(parseIdentifier('https://pubmed.ncbi.nlm.nih.gov/123456/'), { kind: 'pmid', id: '123456' })
  assert.deepEqual(parseIdentifier('https://arxiv.org/pdf/hep-th/9901001v2.pdf'), {
    kind: 'arxiv', id: 'hep-th/9901001v2',
  })
  assert.throws(() => parseIdentifier('brain development AND children'), /标识|DOI/u)
})

test('补录重跑后仍在，本地 PDF 可重新关联，Zotero 部分写入失败和重启后只补缺项', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'litsearch-handoff-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const oldDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  // 预建隔离目录，避免 TaskStore 从当前机器的历史数据目录迁移内容。
  const tasksDir = join(root, 'storages', 'dsh-plugin-litsearch', 'tasks')
  await mkdir(tasksDir, { recursive: true })
  await writeFile(join(tasksDir, 'isolated.json'), '{}')
  const oldSettings = getSettings()
  const originalFetch = globalThis.fetch
  let arxivVersion = '2401.00123v2'
  let doiResponse = DOI
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.hostname === 'api.crossref.org') {
      return Promise.resolve(Response.json({
        message: url.pathname === '/works' ? { items: [
          { DOI: SEARCHED_DOI, title: ['Ordinary search result'], type: 'journal-article' },
        ] } : {
          DOI: doiResponse, title: ['Synthetic test record'], type: 'journal-article',
        },
      }))
    }
    if (url.hostname === 'eutils.ncbi.nlm.nih.gov') {
      const pmid = url.searchParams.get('id')
      const doi = pmid === '234567' ? `<ArticleId IdType="doi">${SEARCHED_DOI}</ArticleId>` : ''
      return Promise.resolve(new Response(
        `<PubmedArticle><PMID>${pmid}</PMID><ArticleTitle>Synthetic PubMed record</ArticleTitle>${doi}</PubmedArticle>`,
      ))
    }
    if (url.hostname === 'export.arxiv.org') {
      return Promise.resolve(new Response(
        `<feed><entry><id>https://arxiv.org/abs/${arxivVersion}</id><title>Synthetic preprint</title></entry></feed>`,
      ))
    }
    return originalFetch(input, init)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
    setSettingsReader(() => oldSettings)
    if (oldDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldDshHome
  })

  type Item = { key: string; version: number; data: Record<string, unknown> }
  const items = new Map<string, Item>()
  let failCollection = true
  let failUpload = true
  let loseRegisterResponse = true
  let authorizeCount = 0
  let parentCreates = 0
  let childCreates = 0
  let sentMd5 = ''
  let uploaded: Buffer | undefined
  let zoteroBase = ''
  const zotero = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
    }
    if (path === '/connector/getSelectedCollection') {
      json({ id: 'C2', name: 'Reading', libraryID: 1, targets: [
        { id: 'L1', name: 'Library', level: 0 }, { id: 'C2', name: 'Reading', level: 1 },
      ] })
      return
    }
    if (path === '/api/') {
      res.setHeader('Zotero-Server-ID', 'TESTINSTANCE').end()
      return
    }
    if (path === '/api/local/authorize') {
      authorizeCount += 1
      json({ key: 'a'.repeat(32), remember: true })
      return
    }
    if (path === '/api/local/uploads/UPLOAD') {
      const pdf = await body(req)
      if (failUpload) {
        failUpload = false
        res.writeHead(500).end()
      } else {
        uploaded = pdf
        res.writeHead(201).end()
      }
      return
    }
    if (path === '/api/users/0/collections') {
      json([{ data: { key: COLLECTION, name: 'Reading' } }])
      return
    }
    if (path === '/api/users/0/items/top') {
      json([...items.values()].filter((item) => item.data.itemType !== 'attachment'))
      return
    }
    if (req.method !== 'GET' && req.headers['zotero-api-key'] !== 'a'.repeat(32)) {
      res.writeHead(401).end()
      return
    }
    if (path === '/api/users/0/items' && req.method === 'POST') {
      const [incoming] = JSON.parse((await body(req)).toString()) as Record<string, unknown>[]
      const key = String(incoming.key)
      if (items.has(key)) {
        json({ successful: {}, failed: { 0: { code: 412 } } })
        return
      }
      const data = { collections: [], ...incoming }
      const item = { key, version: 1, data }
      items.set(key, item)
      if (incoming.itemType === 'attachment') childCreates += 1
      else parentCreates += 1
      json({ successful: { 0: item } })
      return
    }
    const match = /^\/api\/users\/0\/items\/([A-Z0-9]{8})(?:\/(children|file))?$/u.exec(path)
    const item = match === null ? undefined : items.get(match[1])
    if (item === undefined) {
      res.writeHead(404).end()
      return
    }
    if (match?.[2] === 'children') {
      json([...items.values()].filter((child) => child.data.parentItem === item.key))
    } else if (match?.[2] === 'file') {
      const form = new URLSearchParams((await body(req)).toString())
      if (form.has('md5')) {
        sentMd5 = form.get('md5') ?? ''
        json({ url: `${zoteroBase}/api/local/uploads/UPLOAD`, uploadKey: 'UPLOAD',
          contentType: 'application/octet-stream', prefix: '', suffix: '' })
      } else if (form.get('upload') === 'UPLOAD' &&
          uploaded !== undefined && createHash('md5').update(uploaded).digest('hex') === sentMd5) {
        item.data.md5 = sentMd5
        if (loseRegisterResponse) {
          loseRegisterResponse = false
          req.socket.destroy()
        } else {
          res.writeHead(204).end()
        }
      } else res.writeHead(400).end()
    } else if (req.method === 'PATCH') {
      const change = JSON.parse((await body(req)).toString())
      if (failCollection) {
        failCollection = false
        res.writeHead(500).end()
      } else {
        Object.assign(item.data, change)
        item.version += 1
        res.writeHead(204).end()
      }
    } else json(item)
  })
  zoteroBase = await listen(zotero)
  t.after(() => { zotero.close() })
  setSettingsReader(() => ({
    ...oldSettings, zoteroBaseUrl: zoteroBase, zoteroEnabled: true, zoteroAttachPdf: true,
    pdfRoot: join(root, 'pdf'), enableOaLookup: false, defaultSources: ['crossref'],
  }))

  let service = new TaskService()
  const host = createServer((req, res) => void handler(req, res))
  let handler = createHandler(service)
  const hostBase = await listen(host)
  t.after(() => { host.close(); service.dispose() })
  async function route(path: string, method: string, payload?: unknown) {
    const pdf = Buffer.isBuffer(payload)
    const response = await fetch(`${hostBase}${ROUTE_PREFIX}${path}`, {
      method,
      ...(method === 'GET' ? {} : {
        headers: { [WRITE_HEADER]: '1', 'Content-Type': pdf ? 'application/pdf' : 'application/json' },
        body: pdf ? Uint8Array.from(payload) : JSON.stringify(payload ?? {}),
      }),
    })
    const output = await response.json()
    assert.equal(output.ok, true, JSON.stringify(output))
    return output.data
  }
  async function restart() {
    service.dispose()
    service = new TaskService()
    await service.ready
    handler = createHandler(service)
  }

  const task = await service.create({ origin: 'panel', title: 'handoff test', query: 'test', sources: ['crossref'], runNow: false })
  const path = `tasks/${task.id}`
  await service.run(task.id)
  const searched = (await route(`${path}/results`, 'GET')).papers[0]
  assert.equal(searched.ids.doi, SEARCHED_DOI)
  const before = await service.getDetail(task.id)
  const existingDoi = await route(`${path}/supplement`, 'POST', { identifier: SEARCHED_DOI })
  const existingPmid = await route(`${path}/supplement`, 'POST', { identifier: 'PMID:234567' })
  for (const result of [existingDoi, existingPmid]) {
    assert.equal(result.status, 'existing')
    assert.equal(result.paper.paperId, searched.paperId)
    assert.equal(result.paper.supplement, undefined)
  }
  assert.equal((await service.getDetail(task.id)).rev, before.rev)
  assert.equal((await route(`${path}/results?supplementedOnly=1`, 'GET')).total, 0)

  assert.equal((await route(`${path}/supplement`, 'POST', { identifier: 'arXiv:2401.00123v1' })).status, 'version_mismatch')
  arxivVersion = '2401.00123v1'
  assert.equal((await route(`${path}/supplement`, 'POST', { identifier: 'arXiv:2401.00123v1' })).paper.arxivVersionId, arxivVersion)
  assert.equal((await route(`${path}/supplement`, 'POST', { identifier: 'PMID:123456' })).paper.ids.pmid, '123456')
  doiResponse = '10.5555/mismatch'
  assert.equal((await route(`${path}/supplement`, 'POST', { identifier: DOI })).status, 'not_found')
  doiResponse = DOI
  const added = await route(`${path}/supplement`, 'POST', { identifier: DOI })
  assert.equal(added.status, 'added')
  assert.equal(added.paper.supplement.id, DOI)
  const paperId = added.paper.paperId
  const paperPath = `${path}/papers/${paperId}`
  assert.equal((await route(`${path}/supplement`, 'POST', { identifier: DOI })).status, 'existing')
  await restart()
  await service.run(task.id)
  const rerun = await service.get(task.id)
  assert.equal(rerun.result.papers.length, 4)
  assert.equal(rerun.stats.rawHits, 1)
  assert.equal(rerun.stats.supplemented, 3)
  assert.equal(rerun.steps?.find((step) => step.source === 'crossref')?.received, 1)
  const filtered = await route(`${path}/results?supplementedOnly=1`, 'GET')
  assert.equal(filtered.total, 3)
  assert.equal(filtered.papers[0].paperId, paperId)
  assert.ok(filtered.papers.every((paper) => paper.supplement !== undefined))
  assert.equal((await route(`${path}/results?supplementedOnly=1&q=Ordinary`, 'GET')).total, 0)
  const statsPath = `${path}/stats?scope=filtered`
  assert.equal((await route(statsPath, 'GET')).loaded, 4)
  assert.equal((await route(`${statsPath}&supplementedOnly=1`, 'GET')).loaded, 3)

  // 模拟旧版把普通命中写进了补录快照。恢复后仅清除错误标签，保留原结果。
  const taskFile = join(tasksDir, `${task.id}.json`)
  const old = JSON.parse(await readFile(taskFile, 'utf8'))
  const marked = old.task.result.papers.find((paper) => paper.paperId === searched.paperId)
  assert.ok(marked.matchedQueries.length > 0)
  marked.supplement = { kind: 'doi', id: SEARCHED_DOI, addedAt: new Date().toISOString() }
  old.task.supplements.push(marked)
  old.task.stats.supplemented += 1
  await writeFile(taskFile, JSON.stringify(old))
  await restart()
  assert.equal((await service.getDetail(task.id)).stats.supplemented, 3)
  assert.equal((await route(`${path}/papers/${searched.paperId}`, 'GET')).paper.supplement, undefined)
  assert.equal((await route(`${path}/results?supplementedOnly=1`, 'GET')).total, 3)

  assert.equal((await route('settings/zotero/write', 'POST')).state, 'saved')
  const sync = () => route(`${path}/zotero`, 'POST', { paperIds: [paperId], targetId: 'C2' })
  assert.equal((await sync()).items[0].transfer.collection, 'check')
  await restart()
  const afterCollection = (await sync()).items[0].transfer
  assert.equal(afterCollection.parent.status, 'done')
  assert.equal(afterCollection.collection, 'done')
  assert.equal(afterCollection.attachment.status, 'pending')

  const first = await route(`${paperPath}/material`, 'POST', PDF)
  const repeated = await route(`${paperPath}/material`, 'POST', PDF)
  assert.deepEqual(first.state.pdfMaterial, repeated.state.pdfMaterial)
  const detached = await route(`${paperPath}/material`, 'DELETE')
  assert.equal(detached.state.pdfMaterial, undefined)
  assert.deepEqual(await readFile(first.state.pdfFile), PDF)
  await route(`${paperPath}/material`, 'POST', PDF)
  assert.equal((await sync()).items[0].transfer.attachment.status, 'check')
  await restart()
  const transferTool = literatureTools(service).find((tool) => tool.name === 'literature_transfer')
  assert.ok(transferTool)
  const retryAttachment = await transferTool.execute({
    action: 'resumeAttachments', taskId: task.id, paperId, collection: 'Reading',
  }, {})
  assert.equal(JSON.parse(retryAttachment.text).items[0].transfer.attachment.status, 'check')
  await restart()
  const results = await Promise.all([sync(), sync()])
  for (const result of results) {
    assert.equal(result.items[0].ok, true)
    assert.equal(result.items[0].transfer.attachment.status, 'done')
  }
  assert.equal(parentCreates, 1)
  assert.equal(childCreates, 1)
  assert.equal(authorizeCount, 1)
  assert.deepEqual(uploaded, PDF)
})
