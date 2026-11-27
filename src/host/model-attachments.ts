import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

import { SearchError } from '../search/errors.js'

interface FileRef {
  attachmentId: string
  name: string
  bytes: number
}

export interface AttachmentStoreLike {
  readFileStream(ref: FileRef, signal?: AbortSignal): AsyncIterable<Uint8Array>
}

export interface SessionFilesLike {
  open(id: string, access: 'read', options?: { signal: AbortSignal }): Promise<{
    read(offset?: number, length?: number, options?: { signal: AbortSignal }): Promise<{
      events: readonly { type: string; data: unknown }[]
    }>
    close(): Promise<void>
  }>
}

export async function sessionPdfs(
  store: SessionFilesLike, sessionId: string, signal?: AbortSignal, preferLatest = false,
): Promise<FileRef[]> {
  const options = signal === undefined ? undefined : { signal }
  const handle = await store.open(sessionId, 'read', options)
  try {
    const { events } = await handle.read(undefined, undefined, options)
    const refs = new Map<string, FileRef>()
    let latest: FileRef[] = []
    for (const event of events) {
      if (event.type !== 'user/message') continue
      const { content, source } = event.data as { content?: unknown; source?: { kind?: string } }
      if (!Array.isArray(content) || (source?.kind !== undefined && source.kind !== 'user')) continue
      latest = []
      for (const part of content) {
        const ref = part?.type === 'file' ? part.attachment as Partial<FileRef> | undefined : undefined
        if (typeof ref?.attachmentId === 'string' && typeof ref.name === 'string' &&
          /\.pdf$/i.test(ref.name) && typeof ref.bytes === 'number') {
          const file = { attachmentId: ref.attachmentId, name: ref.name, bytes: ref.bytes }
          refs.set(`${ref.attachmentId}:\u0000${ref.name}`, file)
          latest.push(file)
        }
      }
    }
    return preferLatest && latest.length > 0 ? [...new Map(latest.map((entry) => [entry.attachmentId, entry])).values()] : [...refs.values()]
  } finally {
    await handle.close()
  }
}

export async function readAttachmentPdf(
  store: AttachmentStoreLike,
  ref: FileRef,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (ref.bytes > maxBytes) throw new SearchError('bad_request', 'PDF 超过设置中的大小上限')
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of store.readFileStream(ref, signal)) {
    size += chunk.length
    if (size > maxBytes) throw new SearchError('bad_request', 'PDF 超过设置中的大小上限')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

export async function readLocalPdf(path: string, workspace: string | undefined, maxBytes: number): Promise<Buffer> {
  const expanded = path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path
  if (!isAbsolute(expanded) && workspace === undefined) {
    throw new SearchError('bad_request', '相对文件路径需要会话工作目录，请提供明确的本地 PDF 路径')
  }
  const file = await open(resolve(workspace ?? '/', expanded), constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new SearchError('bad_request', '文件不是普通文件，或超过设置中的 PDF 大小上限')
    }
    const bytes = Buffer.alloc(stat.size + 1)
    let size = 0
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size)
      if (bytesRead === 0) break
      size += bytesRead
    }
    if (size !== stat.size) throw new SearchError('conflict', '读取期间文件大小发生变化，请重试')
    return bytes.subarray(0, size)
  } finally {
    await file.close()
  }
}
