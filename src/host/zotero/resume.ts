import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { asArray, asNumber, asRecord, asString } from '../../search/normalize.js'
import type { Paper, ZoteroStepStatus, ZoteroTransfer } from '../../search/types.js'
import { hasPdfTrailer, looksLikePdf } from '../pdf/guard.js'
import { toZoteroItem } from './connector.js'
import { indexFromItems, localApiBase, matchExisting } from './local.js'
import type { ZoteroWriteAccess } from './write.js'

type Checkpoint = (transfer: ZoteroTransfer) => Promise<void>
type Item = { key: string; version: number; data: Record<string, unknown> }

export class ZoteroResume {
  private readonly api: string
  private readonly access: ZoteroWriteAccess
  private readonly base: string
  private readonly server: string
  private readonly library: string

  constructor(access: ZoteroWriteAccess, base: string, server: string, library: string) {
    this.api = localApiBase(base)
    this.access = access
    this.base = base
    this.server = server
    this.library = library
  }

  async sync(
    transfer: ZoteroTransfer,
    paper: Paper,
    tags: string[],
    defaultTag: string,
    attachPdf: boolean,
    pdfPath: string | undefined,
    save: Checkpoint,
    expectedSha256?: string,
    attachmentOnly = false,
  ): Promise<ZoteroTransfer> {
    let stage: 'parent' | 'collection' | 'attachment' = 'parent'
    try {
      delete transfer.error
      const parent = await this.parent(transfer, paper, tags, defaultTag, save, attachmentOnly)
      stage = 'collection'
      if (!attachmentOnly) await this.collection(transfer, parent, save)
      else if (transfer.collectionKey !== undefined && !asArray(parent.data.collections).includes(transfer.collectionKey)) {
        throw new Error('既有条目不在指定分类，请先在 Zotero 核对')
      }
      stage = 'attachment'
      if (!attachPdf || pdfPath === undefined) {
        if (transfer.attachment.status !== 'done' || attachPdf) {
          transfer.attachment = { status: attachPdf ? 'pending' : 'skipped' }
        }
      } else {
        await this.attachment(transfer, parent, pdfPath, save, expectedSha256)
      }
    } catch (error) {
      const status: ZoteroStepStatus = error instanceof ZoteroResponseError ? 'failed' : 'check'
      if (stage === 'collection') transfer.collection = status
      else transfer[stage].status = status
      transfer.error = error instanceof Error ? error.message : String(error)
      if (stage === 'attachment' && pdfPath !== undefined) transfer.error += `（本地 PDF：${pdfPath}）`
    }
    await save(transfer)
    return transfer
  }

  private async parent(
    transfer: ZoteroTransfer, paper: Paper, tags: string[], defaultTag: string, save: Checkpoint,
    attachmentOnly = false,
  ): Promise<Item> {
    const previous = transfer.parent.key
    const expected = previous ?? objectKey(`paper:${paper.paperId}`)
    let item = await this.item(expected)
    if (attachmentOnly && (previous === undefined || item === null)) {
      throw new Error('找不到已记录的 Zotero 父条目，请先核对')
    }
    if (item === null) item = await this.findParent(paper)
    if (item === null) {
      if (transfer.legacy || (previous !== undefined && transfer.parent.status === 'done')) {
        throw new Error('无法定位此前转存的父条目，请在 Zotero 中核对题录和所在分类')
      }
      const key = expected
      transfer.parent = { key, status: 'check' }
      await save(transfer)
      const record = toZoteroItem(paper, tags, defaultTag)
      // Local API 使用各类型自己的字段名。
      delete record.id
      await this.create(key, record)
      item = await this.item(key)
      if (item === null) throw new Error('Zotero 已返回写入成功，暂时无法读回父条目')
    }
    if (['attachment', 'note', 'annotation'].includes(asString(item.data.itemType))) {
      throw new Error('记录指向的 Zotero 条目类型与论文不符，请人工核对')
    }
    const paperVersion = explicitVersion(paper)
    const match = matchExisting(paper, indexFromItems([item.data]))
    if (match === undefined || match === 'title' || (paperVersion !== '' && match !== 'id' &&
      !sameArxivVersion(item.data, paperVersion))) {
      throw new Error('Zotero 父条目标识与论文不符，请人工核对')
    }
    transfer.parent = { key: item.key, status: 'done' }
    await save(transfer)
    return item
  }

  private async findParent(paper: Paper): Promise<Item | null> {
    const raw = await this.read(`${this.library}/items/top?itemType=-attachment`)
    if (!Array.isArray(raw)) throw new Error('Zotero 未返回可核验的文库条目列表')
    const paperVersion = explicitVersion(paper)
    const exact: Item[] = []
    let possible = false
    for (const payload of raw) {
      const item = parseItem(payload)
      if (item === null) continue
      const match = matchExisting(paper, indexFromItems([item.data]))
      if (match === undefined) continue
      if (paperVersion !== '' && match !== 'id' && !sameArxivVersion(item.data, paperVersion)) {
        // 明确标有其他 arXiv 版本的条目可以并存。
        if (arxivVersion(item.data) === '') possible = true
        continue
      }
      if (match === 'title') possible = true
      else exact.push(item)
    }
    if (exact.length > 1 || (exact.length === 0 && possible)) {
      const keys = exact.map((item) => item.key).join('、')
      throw new Error(`Zotero 中有待核对的候选条目${keys ? `（${keys}）` : ''}，请按标题或标识核对后再同步`)
    }
    return exact[0] ?? null
  }

  private async collection(transfer: ZoteroTransfer, parent: Item, save: Checkpoint): Promise<void> {
    const key = transfer.collectionKey
    if (key !== undefined && !asArray(parent.data.collections).includes(key)) {
      transfer.collection = 'check'
      await save(transfer)
      let current: Item | null = parent
      // Zotero 或其他工具可能在题录创建后立即编辑它。遇到版本冲突时按最新分类合并。
      for (let attempt = 0; attempt < 3 && current !== null; attempt++) {
        const collections = asArray(current.data.collections)
        if (collections.includes(key)) break
        try {
          await this.write(`${this.library}/items/${parent.key}`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'If-Unmodified-Since-Version': String(current.version),
            },
            body: JSON.stringify({ collections: [...collections, key] }),
          })
        } catch (error) {
          if (!(error instanceof ZoteroResponseError && error.status === 412)) throw error
          current = await this.item(parent.key)
          if (attempt === 2 && current !== null && !asArray(current.data.collections).includes(key)) throw error
          continue
        }
        current = await this.item(parent.key)
        break
      }
      if (current === null || !asArray(current.data.collections).includes(key)) {
        throw new Error('暂时无法核验 Zotero 分类是否已写入')
      }
    }
    transfer.collection = 'done'
    await save(transfer)
  }

  private async attachment(
    transfer: ZoteroTransfer, parent: Item, path: string, save: Checkpoint, expectedSha256?: string,
  ): Promise<void> {
    const buffer = await readFile(path)
    if (!looksLikePdf(buffer.subarray(0, 1_024)) || !hasPdfTrailer(buffer.subarray(-2_048))) {
      throw new ZoteroResponseError('关联文件不是完整的 PDF')
    }
    const sha256 = digest('sha256', buffer)
    if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
      throw new ZoteroResponseError('本地 PDF 内容发生变化，请重新确认并关联文件')
    }
    const md5 = digest('md5', buffer)
    const children = await this.read(`${this.library}/items/${parent.key}/children`)
    if (!Array.isArray(children)) throw new Error('Zotero 未返回可核验的附件列表')
    const existing = children.map(parseItem).find((child) =>
      child?.data.parentItem === parent.key && child.data.itemType === 'attachment' && child.data.md5 === md5,
    )
    const key = existing?.key ?? objectKey(`pdf:${parent.key}:${sha256}`)
    transfer.attachment = { status: existing === undefined ? 'check' : 'done', path, sha256, key }
    await save(transfer)
    if (existing !== undefined) return

    const filename = `litsearch-${sha256.slice(0, 16)}.pdf`
    let child = await this.item(key)
    if (child === null) {
      await this.create(key, {
        itemType: 'attachment', parentItem: parent.key, title: 'PDF',
        linkMode: 'imported_file', contentType: 'application/pdf', filename,
      })
      child = await this.item(key)
    }
    if (child === null || child.data.parentItem !== parent.key || child.data.itemType !== 'attachment' ||
        (child.data.md5 && child.data.md5 !== md5)) {
      throw new Error('Zotero 附件与这份 PDF 不符，请核对已有附件')
    }

    const file = `${this.library}/items/${key}/file`
    const form = (fields: Record<string, string>) => ({
      method: 'POST' as const,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'If-None-Match': '*' },
      body: new URLSearchParams(fields),
    })
    const descriptor = asRecord(await (await this.write(file, form({
      md5, filename, filesize: String(buffer.length), mtime: String(Date.now()),
    }))).json())
    if (descriptor.exists !== 1) {
      const upload = new URL(asString(descriptor.url))
      const api = new URL(this.api)
      const uploadKey = asString(descriptor.uploadKey)
      if (upload.origin !== api.origin || upload.username || upload.password ||
          !/^[A-Za-z0-9_-]+$/u.test(uploadKey) ||
          upload.pathname !== `${api.pathname}/local/uploads/${uploadKey}`) {
        throw new Error('Zotero 返回了无法核验的本地上传地址')
      }
      const payload = Buffer.concat([
        Buffer.from(asString(descriptor.prefix)), buffer, Buffer.from(asString(descriptor.suffix)),
      ])
      const response = await fetch(upload, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': asString(descriptor.contentType) },
        body: Uint8Array.from(payload),
      })
      await checkResponse(response)
      await response.body?.cancel()
      await this.write(file, form({ upload: uploadKey }))
    }
    const verified = await this.item(key)
    if (verified?.data.md5 !== md5) throw new Error('暂时无法核验 Zotero 中的 PDF 指纹')
    transfer.attachment.status = 'done'
    await save(transfer)
  }

  private async create(key: string, record: Record<string, unknown>): Promise<void> {
    const response = await this.write(`${this.library}/items`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ ...record, key, version: 0 }]),
    })
    const result = asRecord(await response.json())
    if (asRecord(result.successful)['0'] === undefined) {
      const failure = asRecord(asRecord(result.failed)['0'])
      throw new ZoteroResponseError(`Zotero 未创建条目（${asString(failure.message) || '请核对条目版本和类型'}）`)
    }
  }

  private async item(key: string): Promise<Item | null> {
    const raw = await this.read(`${this.library}/items/${encodeURIComponent(key)}`, true)
    if (raw === null) return null
    const item = parseItem(raw)
    if (item?.key !== key) throw new Error('Zotero 返回了无法核验的条目')
    return item
  }

  private async read(path: string, allowMissing = false): Promise<unknown> {
    const response = await fetch(`${this.api}/${path}`, {
      headers: { 'Zotero-Server-ID': this.server },
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    })
    if (allowMissing && response.status === 404) {
      await response.body?.cancel()
      return null
    }
    await checkResponse(response)
    return response.json() as Promise<unknown>
  }

  private async write(path: string, init: RequestInit & { method: 'POST' | 'PATCH' }): Promise<Response> {
    const response = await this.access.write(this.base, path, init, this.server)
    await checkResponse(response)
    return response
  }
}

class ZoteroResponseError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

async function checkResponse(response: Response): Promise<void> {
  if (!response.ok) {
    await response.body?.cancel()
    const message = `Zotero 请求失败（HTTP ${response.status}）`
    if (response.status >= 500) throw new Error(message)
    throw new ZoteroResponseError(message, response.status)
  }
}

function parseItem(raw: unknown): Item | null {
  const record = asRecord(raw)
  const key = asString(record.key)
  const version = asNumber(record.version)
  return /^[A-Z0-9]{8}$/u.test(key) && version !== null ? { key, version, data: asRecord(record.data) } : null
}

function explicitVersion(paper: Paper): string {
  const supplement = paper.supplement
  return supplement?.kind === 'arxiv' && /v\d+$/u.test(supplement.id) ? supplement.id : ''
}

function arxivVersion(data: Record<string, unknown>): string {
  return /^arXiv:\s*(\S+v\d+)\s*$/imu.exec(asString(data.extra))?.[1]?.toLowerCase() ?? ''
}

function sameArxivVersion(data: Record<string, unknown>, id: string): boolean {
  return arxivVersion(data) === id
}

function objectKey(identity: string): string {
  const alphabet = '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ'
  const hash = createHash('sha256').update(identity).digest()
  return Array.from(hash.subarray(0, 8), (byte) => alphabet[byte & 31]).join('')
}

function digest(algorithm: string, buffer: Buffer): string {
  return createHash(algorithm).update(buffer).digest('hex')
}
