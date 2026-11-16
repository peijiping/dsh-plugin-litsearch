/**
 * DOAJ provider —— 只收录审核通过的完全开放获取期刊。
 *
 * 文档：https://doaj.org/api/v3/docs
 * 无需密钥；无公布限流，自限 1 req/s。注意：`total: 0` 只表示不在 DOAJ
 * 收录范围内（混合期刊/订阅期刊本就不收），不代表文献不存在。
 */

import { asArray, asNumber, asRecord, asString, doiUrl, normalizeDoi } from '../normalize.js'
import { limitedJson } from '../rate-limit.js'
import type { OaLocation, PaperRecord, Provider } from '../types.js'

const ENDPOINT = 'https://doaj.org/api/v3/search/articles'

/** 单源超时上限：DOAJ 偶发慢响应，不能拖住整轮检索。 */
const TIMEOUT_CAP_MS = 12_000
const MAX_PAGE_SIZE = 100

export const doaj: Provider = {
  info: {
    id: 'doaj',
    label: 'DOAJ',
    homepage: 'https://doaj.org',
    capabilities: { abstract: true, citationCount: false, openAccess: true, pdf: true },
    rateLimit: '无公布限流（自限 1 req/s）',
    syntax: '自然语言关键词；仅覆盖 DOAJ 收录的开放获取期刊，不支持字段标签',
    optionalKey: false,
  },

  async search(query, options): Promise<PaperRecord[]> {
    // 多取几条：年份过滤与去噪会淘汰部分记录，避免返回条数明显少于 limit。
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, options.limit + 3))
    const params = new URLSearchParams({ pageSize: String(pageSize), page: '1' })
    const url = `${ENDPOINT}/${encodeURIComponent(query)}?${params.toString()}`

    const payload = await limitedJson('doaj', url, {
      timeoutMs: Math.min(options.timeoutMs, TIMEOUT_CAP_MS),
      signal: options.signal,
      bypassCooldown: options.bypassCooldown === true,
      headers: { accept: 'application/json' },
    })

    const papers = asArray(asRecord(payload)['results'])
      .map(mapResult)
      .filter((paper) => paper.title !== '')
    // DOAJ 不支持年份下推，只能本地过滤；因此返回条数可能少于 limit。
    return papers.filter((paper) => inYearRange(paper.year, options)).slice(0, options.limit)
  },
}

function inYearRange(
  year: number | null,
  options: { yearFrom?: number | undefined; yearTo?: number | undefined },
): boolean {
  if (year === null) return options.yearFrom === undefined && options.yearTo === undefined
  if (options.yearFrom !== undefined && year < options.yearFrom) return false
  if (options.yearTo !== undefined && year > options.yearTo) return false
  return true
}

function mapResult(raw: unknown): PaperRecord {
  const result = asRecord(raw)
  const bib = asRecord(result['bibjson'])
  const doi = readDoi(bib['identifier'])
  const journal = asRecord(bib['journal'])
  const links = readLinks(bib['link'])
  const pdfUrl = links.find((link) => link.kind === 'pdf')?.url ?? ''

  return {
    source: 'doaj',
    sourceId: asString(result['id']) || doi,
    ids: { doi, pmid: '', pmcid: '', arxivId: '' },
    title: asString(bib['title']),
    authors: asArray(bib['author'])
      .map((entry) => asString(asRecord(entry)['name']))
      .filter((name) => name !== ''),
    year: readYear(bib['year']),
    venue: asString(journal['title']),
    doi,
    url: pdfUrl !== '' ? pdfUrl : doiUrl(doi),
    abstract: asString(bib['abstract']),
    citedBy: null,
    // DOAJ 只收完全开放获取期刊，收录即 OA。
    openAccess: true,
    pdfUrl,
    ...(links.length === 0 ? {} : { oaLocations: links }),
    type: 'journal-article',
  }
}

function readDoi(value: unknown): string {
  for (const entry of asArray(value)) {
    const identifier = asRecord(entry)
    if (asString(identifier['type']).toLowerCase() === 'doi') {
      return normalizeDoi(identifier['id'])
    }
  }
  return ''
}

/** DOAJ 的 year 是字符串（偶尔是数字），统一取四位年份。 */
function readYear(value: unknown): number | null {
  const text = typeof value === 'number' ? String(value) : asString(value)
  const match = /\d{4}/u.exec(text)
  return match === null ? null : Number(match[0])
}

/** `link[]` 里 `type=fulltext` 才是全文；PDF 直链另按后缀判断。 */
function readLinks(value: unknown): OaLocation[] {
  const links: OaLocation[] = []
  for (const entry of asArray(value)) {
    const link = asRecord(entry)
    const url = asString(link['url'])
    if (url === '') continue
    const type = asString(link['type']).toLowerCase()
    if (type !== '' && type !== 'fulltext') continue
    const contentType = asString(link['content_type']).toUpperCase()
    const kind =
      contentType === 'PDF' || /\.pdf(?:[?#]|$)/iu.test(url) ? 'pdf' : 'landing'
    links.push({ url, kind, source: 'metadata', oa: true })
  }
  return links
}
