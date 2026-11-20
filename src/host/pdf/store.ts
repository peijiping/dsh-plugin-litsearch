/**
 * PDF 获取与落地。
 *
 * 安全约束：只允许 http/https、拒绝回环/私网/链路本地地址、最多 5 次重定向、
 * 单候选总预算可配（默认 60s）、体积上限可配；只有以 `%PDF-` 开头且尾部带
 * `%%EOF` 的内容才会被当成 PDF。同域限并发、429 按 `Retry-After` 冷却。
 */

import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'

import { getSettings } from '../../search/config.js'
import { parseRetryAfterMs } from '../../search/http.js'
import {
  epmcXmlUrl,
  landingLinks,
  mergeOaLocations,
  metadataLocations,
  pdfLinksOf,
  rankOaLocations,
} from '../../search/oa.js'
import { lookupOaLocations } from '../../search/oa-lookup.js'
import type { OaLocation, Paper, PdfAttempt, PdfFailureReason, PdfStatus } from '../../search/types.js'
import {
  classifyHtmlInterstitial,
  hasPdfTrailer,
  isLoginRedirect,
  looksLikePdf,
} from './guard.js'
import { resolvePdfRootPath } from './root.js'
import {
  defaultCooldownMs,
  hostCoolingMs,
  hostOf,
  recordHostCooldown,
  withHostSlot,
} from './throttle.js'

const MAX_REDIRECTS = 5
const FETCH_TIMEOUT_MS = 20_000
const MAX_PDF_BYTES_DEFAULT = 30 * 1024 * 1024
/** 重试退避（仅 5xx / 网络错误）。 */
const RETRY_DELAY_MS = 500

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
  /** 失败根因；成功时缺省。 */
  reason?: PdfFailureReason
  /** 可点击的全文位置（成功与失败都返回）。 */
  links: OaLocation[]
  /** 逐候选的失败记录。 */
  attempts: PdfAttempt[]
}

/** 分类对应的下一步指引：后台拿不到时明确告诉用户去浏览器手动保存。 */
const FAILURE_HINTS: Record<PdfFailureReason, string> = {
  'no-candidate': '请在浏览器打开原文或 PDF 链接手动保存（订阅文献无法自动下载）',
  blocked: '请在浏览器打开 PDF 链接手动保存（后台请求可能被要求登录、订阅或人机验证）',
  paywalled: '该文献需要订阅，请在浏览器登录后手动保存',
  'not-pdf': '请在浏览器打开 PDF 链接手动保存',
  failed: '可稍后重试，若持续失败请在浏览器打开原文手动保存',
}

/** 把技术错误整理成「发生了什么 + 下一步做什么」，供界面直接展示。 */
export function pdfFailureMessage(
  reason: PdfFailureReason,
  detail: string,
  attempted: number,
): string {
  const suffix = attempted > 1 ? `（已尝试 ${attempted} 个候选）` : ''
  return `${detail}${suffix}；${FAILURE_HINTS[reason]}`
}

/** 设置里的根目录；未配置时落在会话工作目录下的 dsh-litsearch/。 */
export function resolvePdfRoot(workspace?: string): string {
  return resolvePdfRootPath(getSettings().pdfRoot, workspace)
}

export function pdfCacheDir(storageRoot: string): string {
  return join(storageRoot, 'pdfs')
}

/** 尝试所有候选并返回第一个合法 PDF；失败时给出可展示的状态、链接与逐条原因。 */
export async function resolvePdf(
  paper: Paper,
  signal?: AbortSignal,
): Promise<PdfResolution> {
  const settings = getSettings()
  const maxBytes = settings.pdfMaxMb * 1024 * 1024
  let locations = metadataLocations(paper)

  // 只有「已确认开放获取的直链」才值得省掉反查；出版商规则只是猜测
  // （订阅文章也有 .pdf 地址），不能据此跳过 OpenAlex / EPMC / OpenAIRE。
  const hasDirectPdf = locations.some(
    (location) => location.kind === 'pdf' && location.oa && location.source !== 'publisher-rule',
  )
  if (settings.enableOaLookup && !hasDirectPdf) {
    const lookup = await lookupOaLocations(paper, {
      contactEmail: settings.contactEmail,
      timeoutMs: Math.min(settings.requestTimeoutMs, 12_000),
      signal,
    })
    locations = mergeOaLocations([locations, lookup.locations])
  }

  // 链接清单：排序后的 OA 位置（含网页全文）+ DOI/原文落地页，失败时也可点击。
  const links = mergeOaLocations([rankOaLocations(locations), landingLinks(paper)])
  const candidates = pdfLinksOf(locations)
  const attempts: PdfAttempt[] = []

  let last: PdfFetchError | null = null
  let sawBlocked = false
  let sawPaywalled = false
  for (const url of candidates) {
    const started = Date.now()
    try {
      const buffer = await fetchPdf(url, {
        maxBytes,
        signal,
        timeoutMs: settings.pdfTimeoutMs,
        retryCount: settings.pdfRetryCount,
      })
      return { ok: true, status: 'available', buffer, url, links, attempts }
    } catch (error) {
      if (signal?.aborted === true) throw error
      const failure =
        error instanceof PdfFetchError
          ? error
          : new PdfFetchError('failed', error instanceof Error ? error.message : String(error))
      last = failure
      attempts.push({
        url,
        host: hostOf(url),
        kind: failure.kind,
        detail: failure.message,
        ...(failure.status === undefined ? {} : { status: failure.status }),
        ms: Date.now() - started,
      })
      if (failure.kind === 'blocked') sawBlocked = true
      if (failure.kind === 'paywalled') sawPaywalled = true
    }
  }

  const status: PdfStatus = sawBlocked ? 'blocked' : sawPaywalled ? 'paywalled' : 'failed'
  const reason: PdfFailureReason =
    last === null
      ? 'no-candidate'
      : sawBlocked
        ? 'blocked'
        : sawPaywalled
          ? 'paywalled'
          : last.kind === 'not_pdf'
            ? 'not-pdf'
            : 'failed'
  const detail = last === null ? '未找到可后台下载的开放获取 PDF' : last.message
  const resolution: PdfResolution = {
    ok: false,
    status,
    reason,
    error: pdfFailureMessage(reason, detail, candidates.length),
    links,
    attempts,
  }
  return resolution
}

export interface FetchPdfOptions {
  maxBytes?: number
  signal?: AbortSignal
  timeoutMs?: number
  /** 5xx / 网络错误的重试次数；429、403、4xx 与校验失败不重试。 */
  retryCount?: number
}

/** 下载并校验单个 PDF：同域限并发，失败按需重试一次。 */
export async function fetchPdf(url: string, options: FetchPdfOptions = {}): Promise<Buffer> {
  const retries = Math.max(0, Math.round(options.retryCount ?? 0))
  const host = hostOf(url)
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS, options.signal)
    try {
      return await withHostSlot(host, options.signal, () => fetchPdfOnce(url, options))
    } catch (error) {
      if (options.signal?.aborted === true) throw error
      const failure =
        error instanceof PdfFetchError
          ? error
          : new PdfFetchError('failed', error instanceof Error ? error.message : String(error))
      if (attempt >= retries || !isRetryable(failure)) throw failure
    }
  }
}

/** 只有程序性失败值得重试；订阅墙、限流与内容校验失败重试也没用。 */
function isRetryable(error: PdfFetchError): boolean {
  return error.kind === 'failed' && (error.status === undefined || error.status >= 500)
}

/** 单次下载：内部处理重定向，每一步都重新校验目标地址。 */
async function fetchPdfOnce(url: string, options: FetchPdfOptions): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? MAX_PDF_BYTES_DEFAULT
  const deadline = Date.now() + (options.timeoutMs ?? FETCH_TIMEOUT_MS)
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicUrl(current)
    const currentHost = hostOf(current)
    const cooling = hostCoolingMs(currentHost)
    if (cooling > 0) {
      throw new PdfFetchError(
        'blocked',
        `该域名刚被限流（约 ${Math.ceil(cooling / 1000)} 秒后重试）`,
      )
    }
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
        const next = new URL(location, current)
        // 跳到登录/机构认证页：继续跟只会拿到 HTML，直接判订阅受限。
        if (isLoginRedirect(next)) {
          throw new PdfFetchError('paywalled', '跳转到登录或机构认证页（需要订阅/机构权限）')
        }
        current = next.toString()
        continue
      }
      if (response.status === 401 || response.status === 402) {
        throw new PdfFetchError('paywalled', `需要订阅或登录（HTTP ${response.status}）`, response.status)
      }
      if (response.status === 429) {
        recordHostCooldown(
          currentHost,
          parseRetryAfterMs(response.headers.get('retry-after')) ?? defaultCooldownMs(),
        )
        throw new PdfFetchError('blocked', '请求过于频繁（HTTP 429），请稍后重试', response.status)
      }
      if (response.status === 403) {
        throw new PdfFetchError('blocked', '出版商拒绝访问（HTTP 403）', response.status)
      }
      if (!response.ok) {
        throw new PdfFetchError('failed', `下载失败（HTTP ${response.status}）`, response.status)
      }
      const declared = Number(response.headers.get('content-length') ?? '0')
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new PdfFetchError('too_large', `文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB`)
      }
      const contentType = response.headers.get('content-type') ?? ''
      // 明确声明 HTML 时只读前 8KB 就够分类，省带宽也省等待。
      if (/text\/html/iu.test(contentType)) {
        const head = await readHead(response, 8_192)
        throw htmlFailure(head, contentType, response.headers)
      }
      const buffer = await readCapped(response, maxBytes)
      if (!looksLikePdf(buffer.subarray(0, 1_024))) {
        throw htmlFailure(buffer.subarray(0, 8_192), contentType, response.headers)
      }
      if (!hasPdfTrailer(buffer.subarray(Math.max(0, buffer.length - 2_048)))) {
        throw new PdfFetchError('not_pdf', 'PDF 文件不完整（缺少 %%EOF，可能被截断）')
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

/** 把「拿到了 HTML」翻译成可行动的错误类型。 */
function htmlFailure(head: Buffer, contentType: string, headers: Headers): PdfFetchError {
  const kind = classifyHtmlInterstitial(head.toString('latin1'), contentType, headers)
  if (kind === 'blocked') {
    return new PdfFetchError('blocked', '出版商启用了人机验证或拒绝后台访问')
  }
  if (kind === 'paywalled') {
    return new PdfFetchError('paywalled', '返回登录/订阅页（需要机构权限）')
  }
  return new PdfFetchError('not_pdf', '返回内容不是 PDF（可能是 HTML 摘要页）')
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new PdfFetchError('failed', '请求已取消'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(new PdfFetchError('failed', '请求已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 写入去重缓存与用户目录；已存在且校验通过的合法文件不覆盖。 */
export async function persistPdf(
  buffer: Buffer,
  storageRoot: string,
  paper: Paper,
  workspace?: string,
  /** 本次下载显式指定的目录；缺省时按设置 / 会话工作目录解析。 */
  targetDir?: string,
): Promise<{ cachePath: string; filePath: string; filename: string; reused: boolean; bytes: number }> {
  const hash = createHash('sha256').update(buffer).digest('hex')
  const cacheDir = pdfCacheDir(storageRoot)
  await mkdir(cacheDir, { recursive: true })
  const cachePath = join(cacheDir, `${hash}.pdf`)
  if (!(await isValidPdfFile(cachePath))) await writePdfAtomic(cachePath, buffer)

  const explicit = targetDir?.trim() ?? ''
  const root = explicit === '' ? resolvePdfRoot(workspace) : explicit
  await mkdir(root, { recursive: true })
  const filename = readableFilename(paper)
  const filePath = join(root, filename)
  // 同名文件已存在且是合法 PDF 时直接复用：坏文件才会被原子替换。
  const reused = await isValidPdfFile(filePath)
  if (!reused) await writePdfAtomic(filePath, buffer)
  const size = await stat(filePath).then((info) => info.size).catch(() => buffer.length)
  return { cachePath, filePath, filename, reused, bytes: size }
}

/** 原子写：同目录 `.part` 临时文件 → rename；任何失败都清理临时文件。 */
async function writePdfAtomic(path: string, buffer: Buffer): Promise<void> {
  const tmp = `${path}.part-${process.pid}-${Date.now()}`
  try {
    await writeFile(tmp, buffer)
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** 已存在的文件是否是可用的 PDF（magic + 尾部完整）。 */
async function isValidPdfFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size < 10) return false
    const buffer = await readFile(path)
    const tail = buffer.subarray(Math.max(0, buffer.length - 2_048))
    return looksLikePdf(buffer.subarray(0, 1_024)) && hasPdfTrailer(tail)
  } catch {
    return false
  }
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

/** 只读前 N 字节就取消，用于给 HTML 拦截页分类，避免白下载整页。 */
async function readHead(response: Response, limit: number): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
      if (total >= limit) break
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).subarray(0, limit)
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
