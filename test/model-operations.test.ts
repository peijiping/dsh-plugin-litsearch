import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

const source = new URL('../src/', import.meta.url).href
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return next(context.parentURL?.startsWith(source) && specifier.startsWith('.') && specifier.endsWith('.js')
      ? specifier.slice(0, -3) + '.ts' : specifier, context)
  },
})
const { TaskService } = await import('../src/host/tasks/service.ts')
const { createHandler } = await import('../src/host/router.ts')
const { literatureTools } = await import('../src/host/tools.ts')
const { getSettings, setSettingsReader, ROUTE_PREFIX, SESSION_HEADER, WRITE_HEADER } = await import('../src/search/config.ts')
hooks.deregister()

test('模型和面板使用同一会话、历史轮次、补录、PDF 与实际下载结果', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'litsearch-model-'))
  const oldHome = process.env.DSH_HOME
  const oldSettings = getSettings()
  const originalFetch = globalThis.fetch
  process.env.DSH_HOME = root
  const isolated = join(root, 'storages', 'dsh-plugin-litsearch', 'tasks')
  await mkdir(isolated, { recursive: true })
  await writeFile(join(isolated, 'isolated.json'), '{}')
  setSettingsReader(() => ({ ...oldSettings, pdfRoot: join(root, 'pdfs'), autoDownloadPdf: false, ncbiApiKey: 'fixture-key' }))
  const pdf = Buffer.from('%PDF-1.4\nstartxref\n0\n%%EOF\n')
  const fakeDoi = '10.5555/model-supplement'
  let upstream = 0
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.hostname === 'api.crossref.org') {
      upstream += 1
      return Promise.resolve(Response.json({
        message: url.pathname === '/works' ? { 'total-results': 1, items: [
          { DOI: '10.5555/result-' + upstream, title: ['Search record ' + upstream] },
        ] } : { DOI: fakeDoi, title: ['Supplemented paper'] },
      }))
    }
    return originalFetch(input, init)
  }
  const service = new TaskService()
  const handler = createHandler(service)
  const server = createServer((req, res) => void handler(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    service.dispose()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    globalThis.fetch = originalFetch
    setSettingsReader(() => oldSettings)
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(root, { recursive: true, force: true })
  })
  const addr = server.address()
  assert.ok(addr && typeof addr !== 'string')
  const base = 'http://127.0.0.1:' + addr.port + ROUTE_PREFIX
  const command = (verb: string, path: string, session: string, body?: unknown) => originalFetch(base + path, {
    method: verb,
    headers: { [SESSION_HEADER]: session, ...(body === undefined ? {} : {
      [WRITE_HEADER]: '1', 'content-type': 'application/json',
    }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, ...await res.json() }))
  let update: unknown
  let attachmentName: string | undefined
  const definitions = literatureTools(service, {
    updateSettings: async (patch, reset) => { update = { patch, reset } },
    sessionFiles: () => ({
      async open(id) {
        assert.equal(id, 'session-a')
        return {
          async close() {},
          async read() {
            return { events: ['old.pdf', 'latest.pdf'].map((name) => ({
              type: 'user/message',
              data: { source: { kind: 'user' }, content: [
                { type: 'file', attachment: { attachmentId: 'sha256:' + name, name, bytes: pdf.length } },
              ] },
            })) }
          },
        }
      },
    }),
    attachments: () => ({
      async *readFileStream(ref) {
        attachmentName = ref.name
        yield pdf.subarray(0, 5)
        yield pdf.subarray(5)
      },
    }),
  })
  const call = async (tool: string, args: Record<string, unknown>, session = 'session-a') => {
    const definition = definitions.find((entry) => entry.name === 'literature_' + tool)
    assert.ok(definition, tool)
    return (await definition.execute(args, { agent: { id: session } })).text
  }
  const a = await service.create({ query: 'First query', sources: ['crossref'], title: 'Task A', origin: 'panel', runNow: false })
  await service.run(a.id)
  await service.update(a.id, { conditions: { queries: [{ text: 'Second query' }], yearFrom: 2020 } })
  await service.run(a.id)
  const b = await service.create({ query: 'Other query', sources: ['crossref'], title: 'Task B', origin: 'panel', runNow: false })
  await command('POST', `tasks/${a.id}/activate`, 'session-a', {})
  await command('POST', `tasks/${b.id}/activate`, 'session-b', {})
  assert.match(await call('task', { action: 'current' }), /Task A/)
  assert.match(await call('task', { action: 'current' }, 'session-b'), /Task B/)

  const queriesBefore = upstream
  assert.match(await call('round', { action: 'switch', round: 1 }), /第 1 轮/)
  assert.match(await call('task', { action: 'get' }), /Search record 1/)
  assert.equal(upstream, queriesBefore)
  const report = JSON.parse(await call('round', { action: 'report', round: 1 }))
  assert.equal(report.conditions.queries[0].text, 'First query')
  assert.equal(report.runs[0].source, 'crossref')
  const switchedEvent = await command('GET', 'events?sinceRev=0', 'session-a')
  const switchView = switchedEvent.data.panel.find((entry: { action: string }) => entry.action === 'view')
  assert.equal(switchView.roundId, 'r1')
  assert.equal((await command('GET', 'events?sinceRev=0', 'session-b')).data.panel, undefined)

  assert.match(await call('task', { action: 'supplement', identifier: fakeDoi, round: 1 }), /补录成功/)
  assert.match(await call('task', { action: 'supplement', identifier: fakeDoi }), /无需补录/)
  await assert.rejects(call('task', { action: 'supplement', identifier: fakeDoi, round: 2 }), /不是当前轮/)
  const filtered = await call('task', { action: 'get', supplementedOnly: true })
  assert.match(filtered, /手工补录.*Supplemented paper/)
  assert.doesNotMatch(filtered, /Search record 1/)
  const detail = JSON.parse(await call('paper', { action: 'get', identifier: fakeDoi }))
  assert.equal(detail.taskId, a.id)
  const attachment = JSON.parse(await call('paper', { action: 'attachPdf', identifier: fakeDoi }))
  assert.equal(attachmentName, 'latest.pdf')
  assert.deepEqual(await readFile(attachment.path), pdf)

  assert.equal((await command('POST', 'view', 'session-a', {
    taskId: a.id, pageIndex: 0, pageSize: 20, total: 2, roundId: 'r1', selectedIds: [detail.paper.paperId], rev: a.rev,
  })).status, 200)
  assert.match(await call('scope', { scope: 'selected' }), /Supplemented paper/)
  const download = await call('download', { scope: 'selected', reason: '已勾选', dir: dirname(attachment.path) })
  const commandId = download.match(/commandId=([\w-]+)/)?.[1]
  assert.ok(commandId)
  const transfer = async () => JSON.parse(await call('transfer', { action: 'status', commandId }))
  assert.equal((await transfer()).counts.pending, 1)
  const dl = await command('POST', `tasks/${a.id}/papers/${detail.paper.paperId}/download`, 'session-a', { commandId, dir: dirname(attachment.path) })
  assert.equal(dl.data.skipped, true)
  assert.equal((await transfer()).counts.done, 1)
  await assert.rejects(call('transfer', { action: 'status', commandId }, 'session-b'), /没有这条/)
  assert.equal(JSON.parse(await call('paper', { action: 'detachPdf', identifier: fakeDoi })).associated, false)

  const beforeDraft = upstream
  assert.match(await call('round', { action: 'draft', round: 2 }), /第 3 轮草稿/)
  assert.equal(a.conditions.yearFrom, 2020)
  assert.equal(a.status, 'draft')
  assert.equal(a.result.papers.length, 0)
  assert.match(await call('round', { action: 'newTask', round: 2, title: 'Independent copy' }), /Independent copy/)
  assert.equal(upstream, beforeDraft)
  const copy = await service.currentTask('session-a')
  assert.notEqual(copy?.id, a.id)
  assert.deepEqual(copy?.conditions, a.conditions)

  assert.doesNotMatch(await call('settings', { action: 'get' }), /fixture-key/)
  await call('settings', { action: 'update', patch: { defaultPageSize: 24 }, reset: ['defaultSort'] })
  assert.deepEqual(update, { patch: { defaultPageSize: 24 }, reset: ['defaultSort'] })
  const deletion = await call('settings', { action: 'deleteTask', taskId: copy?.id })
  const deletionId = deletion.match(/commandId=([\w-]+)/)?.[1]
  assert.ok(deletionId)
  assert.equal((await command('POST', `panel/${deletionId}`, 'session-b', { accepted: true })).status, 404)
  assert.equal((await service.get(copy!.id)).title, 'Independent copy')
  assert.equal((await command('POST', `panel/${deletionId}`, 'session-a', { accepted: true })).data.status, 'done')
  assert.equal((await command('POST', `panel/${deletionId}`, 'session-a', { accepted: true })).data.status, 'done')
  await assert.rejects(service.get(copy!.id), /不存在/)
})
