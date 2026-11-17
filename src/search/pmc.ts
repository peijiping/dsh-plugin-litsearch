/**
 * PubMed Central 通道：按 PMID 解析 PMCID，并按 PMCID 取全文 XML。
 *
 * 与 PubMed 共享 NCBI E-utilities 的限流队列与 tool/email/api_key，
 * 不新增密钥、不绕过配额。
 */

import {
  NCBI_EUTILS,
  eutilsParams,
  parseJsonObject,
  throwIfUpstreamError,
  type EutilsAuth,
} from './eutils.js'
import { SearchError } from './errors.js'
import { normalizePmcid, parsePmcidFromElink } from './pmc-parse.js'
import { limitedJson, limitedText } from './rate-limit.js'
import type { Paper } from './types.js'

const ELINK = `${NCBI_EUTILS}/elink.fcgi`
const EFETCH = `${NCBI_EUTILS}/efetch.fcgi`
const MAX_FULLTEXT_CHARS = 6 * 1024 * 1024
const CACHE_LIMIT = 500

export interface PmcOptions {
  contactEmail: string
  ncbiApiKey?: string | undefined
  timeoutMs: number
  signal?: AbortSignal | undefined
}

/** PMID → PMCID（空串表示确认没有）；跨下载与阅读复用，避免重复 ELink。 */
const pmcidCache = new Map<string, string>()

/** 记录自带 PMCID 时直接返回；否则用一次 ELink 按 PMID 反查。 */
export async function resolvePmcid(
  paper: Pick<Paper, 'ids'>,
  options: PmcOptions,
): Promise<string> {
  const known = normalizePmcid(paper.ids.pmcid)
  if (known !== '') return known
  const pmid = paper.ids.pmid.trim()
  if (pmid === '') return ''

  const cached = pmcidCache.get(pmid)
  if (cached !== undefined) return cached

  const params = eutilsParams(options)
  params.set('dbfrom', 'pubmed')
  params.set('db', 'pmc')
  params.set('id', pmid)
  params.set('retmode', 'json')
  const payload = await limitedJson('pubmed', `${ELINK}?${params.toString()}`, {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  })
  throwIfUpstreamError(payload, 'PubMed')
  const pmcid = parsePmcidFromElink(payload)
  remember(pmid, pmcid)
  return pmcid
}

/** PMC EFetch 全文 XML 地址（retmode=xml 返回 JATS 全文）。 */
export function pmcXmlUrl(pmcid: string, auth: EutilsAuth): string {
  const params = eutilsParams(auth)
  params.set('db', 'pmc')
  params.set('id', normalizePmcid(pmcid))
  params.set('retmode', 'xml')
  return `${EFETCH}?${params.toString()}`
}

/** 取 PMC 全文 XML；与检索共用 NCBI 限流，避免额外打上游。 */
export async function fetchPmcXml(pmcid: string, options: PmcOptions): Promise<string> {
  const text = await limitedText('pubmed', pmcXmlUrl(pmcid, options), {
    timeoutMs: Math.max(options.timeoutMs, 30_000),
    signal: options.signal,
    headers: { accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5' },
  })
  throwIfUpstreamError(parseJsonObject(text), 'PMC')
  // retmode=xml 时错误可能是 `<ERROR>...</ERROR>` 而不是 JSON。
  const xmlError = /<ERROR>([\s\S]*?)<\/ERROR>/iu.exec(text)?.[1]?.trim() ?? ''
  if (xmlError !== '') {
    throw new SearchError(
      'upstream_error',
      `PMC 返回错误：${xmlError}`,
      /rate limit/iu.test(xmlError) ? { status: 429 } : {},
    )
  }
  if (text.length > MAX_FULLTEXT_CHARS) {
    throw new SearchError('bad_request', 'PMC 全文超过 6 MB，已跳过')
  }
  if (!text.includes('<body')) {
    throw new SearchError('not_found', 'PMC 没有可用的全文 XML')
  }
  return text
}

function remember(pmid: string, pmcid: string): void {
  if (pmcidCache.size >= CACHE_LIMIT) {
    const oldest = pmcidCache.keys().next()
    if (!oldest.done) pmcidCache.delete(oldest.value)
  }
  pmcidCache.set(pmid, pmcid)
}
