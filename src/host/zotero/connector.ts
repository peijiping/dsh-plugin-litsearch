/**
 * Zotero Connector 协议封装（本机 `http://127.0.0.1:23119`）。
 *
 * 只允许回环地址：connector 是桌面端本地服务，绝不把用户数据发到外部主机。
 * 任何失败都转成可读的一句话，由调用方汇总成「未运行 / 条目保存失败 / 附件失败」。
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'

import type { Paper, ZoteroProbeResult, ZoteroSyncResult } from '../../search/types.js'

const PING_TIMEOUT_MS = 3_000
const SAVE_TIMEOUT_MS = 20_000
const ATTACH_TIMEOUT_MS = 60_000
const MAX_SYNC_ITEMS = 50

export interface ZoteroConnectorOptions {
  baseUrl: string
  attachPdf: boolean
  tag: string
}

export interface ZoteroSyncInput {
  paper: Paper
  tags: readonly string[]
  /** 已下载的本地 PDF；缺省表示没有。 */
  pdfPath?: string
}

export class ZoteroConnector {
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    // 允许 http://127.0.0.1:23119 / http://localhost:23119 / [::1]。
    const trimmed = baseUrl.trim().replace(/\/+$/u, '')
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      throw new Error(`Zotero 地址不合法：${baseUrl}`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Zotero 地址只支持 http/https')
    }
    const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
    const loopback =
      host === 'localhost' ||
      host === '::1' ||
      (isIP(host) === 4 && host.split('.')[0] === '127')
    if (!loopback) throw new Error('Zotero connector 只监听本机，地址必须是 127.0.0.1 或 localhost')
    this.baseUrl = trimmed
  }

  async probe(): Promise<ZoteroProbeResult> {
    try {
      const response = await this.request('/connector/ping', {
        method: 'GET',
        timeoutMs: PING_TIMEOUT_MS,
      })
      if (!response.ok) {
        return { ok: false, error: `connector 返回 HTTP ${response.status}` }
      }
      const version = response.headers.get('x-zotero-version') ?? undefined
      const collection = await this.selectedCollection().catch(() => null)
      const result: ZoteroProbeResult = { ok: true }
      if (version !== undefined) result.version = version
      if (collection !== null) {
        result.collection = {
          id: collection.id,
          name: collection.name,
          ...(collection.libraryID === undefined ? {} : { libraryID: collection.libraryID }),
          ...(collection.filesEditable === undefined
            ? {}
            : { filesEditable: collection.filesEditable }),
        }
      }
      return result
    } catch (error) {
      return { ok: false, error: describe(error) }
    }
  }

  /** 当前 Zotero 里选中的分类；未选中时返回 null。 */
  async selectedCollection(): Promise<SelectedCollection | null> {
    const response = await this.request('/connector/getSelectedCollection', {
      method: 'GET',
      timeoutMs: PING_TIMEOUT_MS,
    })
    if (!response.ok) return null
    const body = (await response.json().catch(() => null)) as unknown
    if (body === null || body === false || typeof body !== 'object') return null
    const record = body as Record<string, unknown>
    const id = record['id']
    const name = record['name']
    if ((typeof id !== 'number' && typeof id !== 'string') || typeof name !== 'string') return null
    const collection: SelectedCollection = { id, name }
    if (typeof record['libraryID'] === 'number') collection.libraryID = record['libraryID']
    if (typeof record['filesEditable'] === 'boolean') {
      collection.filesEditable = record['filesEditable']
    }
    return collection
  }

  /**
   * 保存条目并可选上传本地 PDF。
   *
   * 逐篇处理：单篇条目失败只记入 failed，不中断其余篇；附件失败单独计入
   * messages，条目仍算保存成功。
   */
  async sync(inputs: readonly ZoteroSyncInput[], options: ZoteroConnectorOptions): Promise<ZoteroSyncResult> {
    if (inputs.length === 0) return { ok: true, saved: 0, attached: 0, failed: 0, messages: [] }
    if (inputs.length > MAX_SYNC_ITEMS) {
      throw new Error(`一次最多同步 ${MAX_SYNC_ITEMS} 篇`)
    }
    const result: ZoteroSyncResult = {
      ok: true,
      saved: 0,
      attached: 0,
      failed: 0,
      messages: [],
    }

    for (const input of inputs) {
      const sessionID = newSessionID()
      const item = toZoteroItem(input.paper, input.tags, options.tag)
      try {
        await this.saveItem(item, sessionID)
        result.saved += 1
      } catch (error) {
        result.failed += 1
        result.messages.push(`${shortTitle(input.paper.title)}：条目保存失败（${describe(error)}）`)
        continue
      }

      if (!options.attachPdf || input.pdfPath === undefined) continue
      const parentId = typeof item['id'] === 'string' ? item['id'] : null
      if (parentId === null) {
        result.messages.push(`${shortTitle(input.paper.title)}：条目已保存，但缺少条目 id，未上传 PDF`)
        continue
      }
      try {
        const buffer = await readFile(input.pdfPath)
        await this.saveAttachment(parentId, sessionID, input.paper, buffer)
        result.attached += 1
      } catch (error) {
        result.messages.push(`${shortTitle(input.paper.title)}：PDF 附件失败（${describe(error)}）`)
      }
    }

    result.ok = result.failed === 0
    return result
  }

  /**
   * 保存条目。Zotero 返回 201 空响应，条目 id 由请求里的 `id` 字段决定，
   * 后续 `saveAttachment` 用它作为 parentItemID，并复用同一 sessionID。
   */
  private async saveItem(item: Record<string, unknown>, sessionID: string): Promise<void> {
    const response = await this.request('/connector/saveItems', {
      method: 'POST',
      timeoutMs: SAVE_TIMEOUT_MS,
      headers: {
        'content-type': 'application/json',
        'x-zotero-connector-api-version': '3',
      },
      body: JSON.stringify({
        sessionID,
        uri: `https://www.zotero.org/connector/${sessionID}`,
        items: [item],
      }),
    })
    if (!response.ok) throw new Error(`connector 返回 HTTP ${response.status}`)
  }

  private async saveAttachment(
    parentId: string,
    sessionID: string,
    paper: Paper,
    buffer: Buffer,
  ): Promise<void> {
    const metadata = JSON.stringify({
      sessionID,
      parentItemID: parentId,
      title: attachmentFilename(paper),
      url: paper.pdfUrl !== '' ? paper.pdfUrl : paper.url,
    })
    const response = await this.request('/connector/saveAttachment', {
      method: 'POST',
      timeoutMs: ATTACH_TIMEOUT_MS,
      headers: {
        'content-type': 'application/pdf',
        'content-length': String(buffer.length),
        'x-metadata': metadata,
      },
      body: Uint8Array.from(buffer),
    })
    if (!response.ok) throw new Error(`connector 返回 HTTP ${response.status}`)
  }

  private async request(
    path: string,
    init: {
      method: 'GET' | 'POST'
      timeoutMs: number
      headers?: Record<string, string>
      body?: BodyInit
    },
  ): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), init.timeoutMs)
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method: init.method,
        ...(init.headers === undefined ? {} : { headers: init.headers }),
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error('连接超时；请确认 Zotero 正在运行且已开启 connector 服务')
      }
      throw new Error(
        `无法连接 Zotero（${this.baseUrl}）；请确认 Zotero 桌面端已启动并允许 connector`,
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

interface SelectedCollection {
  id: number | string
  name: string
  libraryID?: number
  filesEditable?: boolean
}

function toZoteroItem(
  paper: Paper,
  tags: readonly string[],
  defaultTag: string,
): Record<string, unknown> {
  const item: Record<string, unknown> = {
    id: paper.paperId,
    itemType: paper.type === '' ? 'journalArticle' : mapItemType(paper.type),
    title: paper.title,
    creators: paper.authors.map((name) => {
      const parts = name.trim().split(/\s+/u)
      const lastName = parts.length > 1 ? parts.at(-1) ?? name : name
      const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : ''
      return { creatorType: 'author', firstName, lastName }
    }),
    date: paper.year === null ? '' : String(paper.year),
    publicationTitle: paper.venue,
    DOI: paper.doi,
    url: paper.url,
    abstractNote: paper.abstract,
    extra: `dsh-litsearch:${paper.paperId}`,
  }
  const merged = new Set<string>()
  for (const tag of [...tags, defaultTag]) {
    const value = tag.trim()
    if (value !== '') merged.add(value)
  }
  if (merged.size > 0) item['tags'] = [...merged].map((tag) => ({ tag }))
  return item
}

function mapItemType(type: string): string {
  const value = type.toLowerCase()
  if (value.includes('review')) return 'journalArticle'
  if (value.includes('preprint') || value.includes('arxiv')) return 'preprint'
  if (value.includes('conference') || value.includes('proceedings')) return 'conferencePaper'
  if (value.includes('book')) return 'book'
  if (value.includes('dataset')) return 'dataset'
  return 'journalArticle'
}

function newSessionID(): string {
  return randomUUID().replace(/-/gu, '').slice(0, 16)
}

function attachmentFilename(paper: Paper): string {
  const base = paper.title
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\r\n]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80)
  return `${base === '' ? paper.paperId : base}.pdf`
}

function shortTitle(title: string): string {
  return title.length > 40 ? `${title.slice(0, 40)}…` : title
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
