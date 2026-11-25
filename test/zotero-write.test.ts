import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// 加载使用 NodeNext .js 导入的 Host TypeScript 源码。
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
const { ZoteroWriteAccess } = await import('../src/host/zotero/write.ts')
hooks.deregister()

test('长期凭证跨请求和重启复用，按 Zotero 实例隔离，撤销后无需后台弹窗', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'litsearch-write-'))
  t.after(() => rm(root, { force: true, recursive: true }))

  const key = 'k'.repeat(32)
  let serverId = 'firstInstance'
  let remember = false
  let revoked = false
  let prompts = 0
  let writes = 0
  const requests: { appName: string; serverId: string | string[] | undefined }[] = []
  const server = createServer(async (req, res) => {
    if (req.url === '/api/') {
      res.setHeader('Zotero-Server-ID', serverId).end()
      return
    }
    if (req.url === '/api/local/authorize') {
      prompts += 1
      let raw = ''
      for await (const chunk of req) raw += chunk
      requests.push({
        appName: JSON.parse(raw).appName,
        serverId: req.headers['zotero-server-id'],
      })
      res.setHeader('Content-Type', 'application/json').end(JSON.stringify({ key, remember }))
      return
    }
    if (req.url === '/api/users/0/items') {
      if (revoked || req.headers['zotero-api-key'] !== key || req.headers['zotero-server-id'] !== serverId) {
        res.writeHead(401).end()
        return
      }
      writes += 1
      res.writeHead(204).end()
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.close() })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const access = new ZoteroWriteAccess(root)
  assert.deepEqual(await access.status(base), { state: 'required' })
  assert.deepEqual(await access.authorize(base), { state: 'once' })
  assert.deepEqual(await readdir(root), [])
  assert.deepEqual(await access.status(base), { state: 'required' })

  remember = true
  assert.deepEqual(await Promise.all([access.authorize(base), access.authorize(base)]), [
    { state: 'saved' },
    { state: 'saved' },
  ])
  assert.equal(prompts, 2)
  assert.deepEqual(requests[1], { appName: 'DSH 文献检索', serverId })

  const file = join(root, 'zotero-auth', `${serverId}.json`)
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
  const restarted = new ZoteroWriteAccess(root)
  assert.deepEqual(await restarted.status(base), { state: 'saved' })
  assert.deepEqual(await restarted.authorize(base), { state: 'saved' })
  const write = { method: 'POST' as const, body: '[]' }
  assert.equal((await restarted.write(base, 'users/0/items', write)).status, 204)
  assert.equal((await restarted.write(base, 'users/0/items', write)).status, 204)
  assert.equal(writes, 2)
  assert.equal(prompts, 2)

  serverId = 'otherInstance'
  await assert.rejects(restarted.write(base, 'users/0/items', write), /始终允许/u)
  await assert.rejects(restarted.authorize('http://example.org'), /本机地址/u)
  assert.equal(writes, 2)
  assert.equal(prompts, 2)

  serverId = 'firstInstance'
  await assert.rejects(restarted.write(base, '/connector/saveItems', write), /Local API/u)
  revoked = true
  await assert.rejects(restarted.write(base, 'users/0/items', write), /始终允许/u)
  assert.deepEqual(await restarted.status(base), { state: 'required' })
  assert.equal(prompts, 2)
})
