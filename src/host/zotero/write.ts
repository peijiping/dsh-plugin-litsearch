import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { SearchError } from '../../search/errors.js'
import type { ZoteroWriteAuthorization } from '../../search/types.js'
import { localApiBase } from './local.js'

const APP_NAME = 'DSH 文献检索'
const PROBE_TIMEOUT_MS = 4_000
const AUTHORIZE_TIMEOUT_MS = 90_000
const WRITE_TIMEOUT_MS = 30_000
const KEY_PATTERN = /^[A-Za-z0-9]{32}$/u
const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/u

interface LocalApi {
  base: string
  serverId: string
}

/** 长期授权由 Host 按 Zotero 数据库保存，配置页只能查询其状态。 */
export class ZoteroWriteAccess {
  private readonly root: string
  private readonly authorizing = new Map<string, Promise<ZoteroWriteAuthorization>>()
  private credentialUpdates = Promise.resolve()

  constructor(root: string) {
    this.root = root
  }

  async serverId(baseUrl: string): Promise<string> {
    return (await connect(baseUrl)).serverId
  }

  async status(baseUrl: string): Promise<ZoteroWriteAuthorization> {
    const { serverId } = await connect(baseUrl)
    return { state: (await this.load(serverId)) === null ? 'required' : 'saved' }
  }

  async authorize(baseUrl: string): Promise<ZoteroWriteAuthorization> {
    const api = await connect(baseUrl)
    const pending = this.authorizing.get(api.serverId)
    if (pending !== undefined) return pending

    const authorization = this.authorizeOnce(api).finally(() => {
      this.authorizing.delete(api.serverId)
    })
    this.authorizing.set(api.serverId, authorization)
    return authorization
  }

  /** 已授权的写请求。调用方负责条目版本和业务结果，失效后由用户从设置页重新授权。 */
  async write(
    baseUrl: string,
    path: string,
    init: RequestInit & { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' },
    expectedServerId?: string,
  ): Promise<Response> {
    const api = await connect(baseUrl)
    if (expectedServerId !== undefined && expectedServerId !== api.serverId) {
      throw new SearchError('conflict', 'Zotero 资料库在操作中发生切换，请重新选择目标')
    }
    const url = new URL(path, api.base)
    if (!url.href.startsWith(api.base)) {
      throw new SearchError('bad_request', 'Zotero 写入地址必须位于本机 Local API 下')
    }
    const key = await this.load(api.serverId)
    if (key === null) throw needsAuthorization()
    const headers = new Headers(init.headers)
    headers.set('Zotero-Server-ID', api.serverId)
    headers.set('Zotero-API-Key', key)
    const response = await fetch(url, {
      ...init,
      headers,
      redirect: 'error',
      signal: init.signal ?? AbortSignal.timeout(WRITE_TIMEOUT_MS),
    })
    if (response.status === 401) {
      await response.body?.cancel()
      await this.updateCredential(async () => {
        if (await this.load(api.serverId) === key) {
          await rm(this.keyFile(api.serverId), { force: true })
        }
      })
      throw needsAuthorization()
    }
    return response
  }

  private async authorizeOnce(api: LocalApi): Promise<ZoteroWriteAuthorization> {
    if (await this.load(api.serverId) !== null) return { state: 'saved' }

    let response: Response
    try {
      response = await fetch(new URL('local/authorize', api.base), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Zotero-Server-ID': api.serverId },
        body: JSON.stringify({ appName: APP_NAME }),
        redirect: 'error',
        signal: AbortSignal.timeout(AUTHORIZE_TIMEOUT_MS),
      })
    } catch {
      throw new SearchError('network_error', '等待 Zotero 授权失败或已超时，请在 Zotero 桌面端确认弹窗后重试')
    }
    const data = await response.json().catch(() => null) as {
      denied?: unknown
      key?: unknown
      remember?: unknown
    } | null
    if (response.status === 403 && data?.denied === true) {
      throw new SearchError('bad_request', '已在 Zotero 中拒绝写入授权')
    }
    if (response.status === 429) {
      throw new SearchError('upstream_error', 'Zotero 授权请求过于频繁，请稍后再试')
    }
    if (!response.ok) {
      throw new SearchError('upstream_error', `Zotero 授权请求失败（HTTP ${response.status}）`)
    }

    const key = data?.key
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      throw new SearchError('upstream_error', 'Zotero 未返回有效的写入凭证')
    }
    if (data?.remember !== true) return { state: 'once' }

    await this.updateCredential(async () => {
      const file = this.keyFile(api.serverId)
      const temp = `${file}.${randomUUID()}.tmp`
      try {
        await mkdir(join(this.root, 'zotero-auth'), { recursive: true, mode: 0o700 })
        await writeFile(temp, JSON.stringify({ key }), { mode: 0o600, flag: 'wx' })
        await rename(temp, file)
      } catch {
        await rm(temp, { force: true }).catch(() => {})
        throw new SearchError('upstream_error', 'Zotero 已授权，但无法保存本机凭证，请检查插件数据目录权限')
      }
    })
    return { state: 'saved' }
  }

  private updateCredential(update: () => Promise<void>): Promise<void> {
    const pending = this.credentialUpdates.then(update)
    this.credentialUpdates = pending.catch(() => {})
    return pending
  }

  private keyFile(serverId: string): string {
    return join(this.root, 'zotero-auth', `${serverId}.json`)
  }

  private async load(serverId: string): Promise<string | null> {
    try {
      const parsed = JSON.parse(await readFile(this.keyFile(serverId), 'utf8')) as { key?: unknown } | null
      const key = parsed?.key
      return typeof key === 'string' && KEY_PATTERN.test(key) ? key : null
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new SearchError('upstream_error', '无法读取本机 Zotero 写入凭证，请检查插件数据目录权限')
    }
  }
}

async function connect(baseUrl: string): Promise<LocalApi> {
  const url = URL.parse(baseUrl)
  if (
    url === null ||
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
  ) {
    throw new SearchError('bad_request', 'Zotero 长期授权仅支持本机地址')
  }

  const base = `${localApiBase(url.href)}/`
  let response: Response
  try {
    response = await fetch(base, { redirect: 'error', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  } catch {
    throw new SearchError('network_error', '无法连接本机 Zotero，请先启动 Zotero')
  }
  await response.body?.cancel()
  if (response.status === 403) {
    throw new SearchError('bad_request', '请在 Zotero「设置 → 高级」中允许本机其他应用与 Zotero 通信')
  }
  const serverId = response.headers.get('Zotero-Server-ID')
  if (!response.ok || serverId === null || !SERVER_ID_PATTERN.test(serverId)) {
    throw new SearchError('upstream_error', 'Zotero 本地写权限需要 Zotero 10 或更高版本')
  }
  return { base, serverId }
}

function needsAuthorization(): SearchError {
  return new SearchError(
    'bad_request',
    '请在文献检索设置中授权 Zotero 写权限，并在 Zotero 弹窗选择「始终允许」',
  )
}
