/**
 * PDF 获取与落地。
 *
 * 安全约束：只允许 http/https、拒绝回环/私网/链路本地地址、最多 5 次重定向、
 * 20 秒超时、体积上限可配；只有以 `%PDF-` 开头的内容才会被当成 PDF。
 */

import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'

import { getSettings } from '../../search/config.js'
import { epmcXmlUrl, pdfCandidates, unpaywallPdfCandidates } from '../../search/oa.js'
import type { Paper, PdfStatus } from '../../search/types.js'
import { resolvePdfRootPath } from './root.js'

const MAX_REDIRECTS = 5
const FETCH_TIMEOUT_MS = 20_000
const MAX_PDF_BYTES_DEFAULT = 30 * 1024 * 1024

export type PdfFailure = 'paywalled' | 'blocked' | 'failed' | 'not_pdf' | 'too_large' | 'unsafe'

export class PdfFetchError extends Error {
  readonly kind: PdfFailure

  readonly status?: number

  constructor(kind: PdfFailure, message: string, status?: number) {
    super(message)
    this.name = 'PdfFetchError'
    this.kind = kind
    if (status !== undefined) this.status = status
  }
}

export interface PdfResolution {
  ok: boolean
  status: PdfStatus
  buffer?: Buffer
  url?: string
  error?: string
}

/** 设置里的根目录；未配置时落在会话工作目录下的 dsh-litsearch/。 */
export function resolvePdfRoot(workspace?: string): string {
  return resolvePdfRootPath(getSettings().pdfRoot, workspace)
}

export function pdfCacheDir(storageRoot: string): string {
  return join(storageRoot, 'pdfs')
}

/** 尝试所有候选并返回第一个合法 PDF；失败时给出可展示的状态与原因。 */
export async function resolvePdf(
  paper: Paper,
  signal?: AbortSignal,
): Promise<PdfResolution> {
  const settings = getSettings()
  const maxBytes = settings.pdfMaxMb * 1024 * 1024
  const candidates = pdfCandidates(paper)
  const extra = await unpaywallPdfCandidates(
    paper.doi,
    settings.contactEmail,
    Math.min(settings.requestTimeoutMs, 8_000),
    signal,
  )
  for (const url of extra) if (!candidates.includes(url)) candidates.push(url)

  let last: PdfFetchError | null = null
  let sawBlocked = false
  let sawPaywalled = false
  for (const url of candidates) {
    try {
      const buffer = await fetchPdf(url, { maxBytes, signal })
      return { ok: true, status: 'available', buffer, url }
    } catch (error) {
      if (signal?.aborted === true) throw error
      const failure =
        error instanceof PdfFetchError
          ? error
          : new PdfFetchError('failed', error instanceof Error ? error.message : String(error))
      last = failure
      if (failure.kind === 'blocked') sawBlocked = true
      if (failure.kind === 'paywalled') sawPaywalled = true
    }
  }

  const status: PdfStatus = sawBlocked ? 'blocked' : sawPaywalled ? 'paywalled' : 'failed'
  const error =
    last === null
      ? '没有可尝试的 PDF 地址'
      : `${last.message}${candidates.length > 1 ? `（已尝试 ${candidates.length} 个候选）` : ''}`
  return { ok: false, status, error }
}

export interface FetchPdfOptions {
  maxBytes?: number
  signal?: AbortSignal
  timeoutMs?: number
}

/** 下载并校验单个 PDF；内部处理重定向，每一步都重新校验目标地址。 */
export async function fetchPdf(url: string, options: FetchPdfOptions = {}): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? MAX_PDF_BYTES_DEFAULT
  const deadline = Date.now() + (options.timeoutMs ?? FETCH_TIMEOUT_MS)
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicUrl(current)
    const controller = new AbortController()
    const remaining = Math.max(1_000, deadline - Date.now())
    const timer = setTimeout(() => controller.abort(), remaining)
    const onAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', onAbort)
    try {
      const response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.5',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        },
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (location === null) throw new PdfFetchError('failed', `重定向缺少 Location：${current}`)
        current = new URL(location, current).toString()
        continue
      }
      if (response.status === 401 || response.status === 402) {
        throw new PdfFetchError('paywalled', `需要订阅或登录（HTTP ${response.status}）`, response.status)
      }
      if (response.status === 403 || response.status === 429) {
        throw new PdfFetchError('blocked', `出版商拒绝访问（HTTP ${response.status}）`, response.status)
      }
      if (!response.ok) {
        throw new PdfFetchError('failed', `下载失败（HTTP ${response.status}）`, response.status)
      }
      const declared = Number(response.headers.get('content-length') ?? '0')
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new PdfFetchError('too_large', `文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB`)
      }
      const buffer = await readCapped(response, maxBytes)
      if (buffer.length < 5 || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
        const head = buffer.subarray(0, 2048).toString('latin1')
        if (/Just a moment|cf-mitigated|Enable JavaScript and cookies/i.test(head)) {
          throw new PdfFetchError('blocked', '出版商启用了人机验证，后台无法直接下载')
        }
        throw new PdfFetchError('not_pdf', '返回内容不是 PDF（可能是 HTML 登录/摘要页）')
      }
      return buffer
    } catch (error) {
      if (options.signal?.aborted === true) throw error
      if (error instanceof PdfFetchError) throw error
      if (controller.signal.aborted) {
        throw new PdfFetchError('failed', '下载超时')
      }
      throw new PdfFetchError('failed', error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }
  throw new PdfFetchError('failed', `重定向超过 ${MAX_REDIRECTS} 次`)
}

/** 写入去重缓存与用户目录；返回两份路径。 */
export async function persistPdf(
  buffer: Buffer,
  storageRoot: string,
  paper: Paper,
  workspace?: string,
): Promise<{ cachePath: string; filePath: string; filename: string }> {
  const hash = createHash('sha256').update(buffer).digest('hex')
  const cacheDir = pdfCacheDir(storageRoot)
  await mkdir(cacheDir, { recursive: true })
  const cachePath = join(cacheDir, `${hash}.pdf`)
  await writeFile(cachePath, buffer)

  const root = resolvePdfRoot(workspace)
  await mkdir(root, { recursive: true })
  const filename = readableFilename(paper)
  const filePath = join(root, filename)
  await writeFile(filePath, buffer)
  return { cachePath, filePath, filename }
}

/** 已下载文件仍存在时直接读取，避免重复下载。 */
export async function readSavedPdf(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath)
  } catch {
    return null
  }
}

/** `<第一作者><年份>_<短标题>_<PMID|DOI>.pdf`，去掉路径分隔符。 */
export function readableFilename(paper: Paper): string {
  const first = paper.authors[0]?.trim() ?? ''
  const author = first === '' ? 'Anon' : first.split(/\s+/u).at(-1) ?? 'Anon'
  const year = paper.year === null ? 'nd' : String(paper.year)
  const title = paper.title
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\r\n]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 48)
    .trim()
  const id = paper.ids.pmid !== '' ? `PMID${paper.ids.pmid}` : paper.doi !== '' ? `DOI${paper.doi}` : paper.paperId
  const safeId = id.replace(/[^A-Za-z0-9._-]+/gu, '_').slice(0, 64)
  const base = `${author}${year}_${title === '' ? 'untitled' : title}_${safeId}`
  return `${base.slice(0, 120)}.pdf`
}

/** 清理 PDF 缓存目录。 */
export async function cleanupPdfCache(storageRoot: string): Promise<{ removed: number; freedBytes: number }> {
  const dir = pdfCacheDir(storageRoot)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return { removed: 0, freedBytes: 0 }
  }
  let removed = 0
  let freedBytes = 0
  for (const name of names) {
    const path = join(dir, name)
    try {
      freedBytes += (await stat(path)).size
      await rm(path, { force: true })
      removed += 1
    } catch {
      // 单个缓存文件删除失败不影响其余文件。
    }
  }
  return { removed, freedBytes }
}

/**
 * 按总量上限修剪去重缓存：超出时从最旧（mtime）开始删，直到不超过上限。
 * `maxBytes <= 0` 表示关闭自动清理。
 */
export async function prunePdfCache(
  storageRoot: string,
  maxBytes: number,
): Promise<{ removed: number; freedBytes: number }> {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return { removed: 0, freedBytes: 0 }
  const dir = pdfCacheDir(storageRoot)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return { removed: 0, freedBytes: 0 }
  }
  const files: { path: string; size: number; mtimeMs: number }[] = []
  let total = 0
  for (const name of names) {
    if (!name.endsWith('.pdf')) continue
    const path = join(dir, name)
    try {
      const info = await stat(path)
      if (!info.isFile()) continue
      files.push({ path, size: info.size, mtimeMs: info.mtimeMs })
      total += info.size
    } catch {
      // 单个缓存文件读不到元信息时跳过，不影响修剪其余文件。
    }
  }
  if (total <= maxBytes) return { removed: 0, freedBytes: 0 }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs)
  let removed = 0
  let freedBytes = 0
  for (const file of files) {
    if (total <= maxBytes) break
    try {
      await rm(file.path, { force: true })
      total -= file.size
      freedBytes += file.size
      removed += 1
    } catch {
      // 删除失败继续尝试更近的文件。
    }
  }
  return { removed, freedBytes }
}

/** 测试下载目录是否可写（设置页）。 */
export async function probePdfRoot(
  workspace?: string,
): Promise<{ root: string; writable: boolean; error?: string }> {
  const root = resolvePdfRoot(workspace)
  const probe = join(root, `.write-test-${process.pid}-${Date.now()}`)
  try {
    await mkdir(root, { recursive: true })
    await writeFile(probe, 'ok', 'utf8')
    await rm(probe, { force: true })
    return { root, writable: true }
  } catch (error) {
    return {
      root,
      writable: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 供路由/服务判断是否有 EPMC HTML 全文。 */
export function epmcFullTextAvailable(paper: Paper): boolean {
  return epmcXmlUrl(paper) !== null
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new PdfFetchError('too_large', `文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
}

async function assertPublicUrl(raw: string): Promise<void> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new PdfFetchError('unsafe', `非法地址：${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PdfFetchError('unsafe', `只允许 http/https：${url.protocol}`)
  }
  const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new PdfFetchError('unsafe', `拒绝访问本机/内网地址：${host}`)
  }
  const addresses = isIP(host) !== 0 ? [{ address: host }] : await lookup(host, { all: true }).catch(() => [])
  if (addresses.length === 0) throw new PdfFetchError('failed', `无法解析域名：${host}`)
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new PdfFetchError('unsafe', `拒绝访问内网地址：${entry.address}`)
    }
  }
}

function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase()
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true
  if (value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd')) return true
  const parts = value.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false
  const [a, b] = parts
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}
