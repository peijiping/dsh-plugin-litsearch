/**
 * Europe PMC provider —— 生命科学文献聚合，覆盖 PubMed、PMC、预印本。
 *
 * 文档：https://europepmc.org/RestfulWebService
 * 无需密钥；自限约 5 req/s（队列里按 200ms 间隔）。
 */

import { asArray, asNumber, asRecord, asString, normalizeDoi } from '../normalize.js'
import { limitedJson } from '../rate-limit.js'
import type { PaperRecord, Provider, ProviderSearchOptions } from '../types.js'

const ENDPOINT = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search'

/**
 * `resultType=core` 加上较大的 pageSize 时响应明显偏慢，15s 会把正常请求
 * 误判成超时（全文接口本来就用 30s）。检索请求固定给 25s 下限，设置里
 * 调高全局超时仍然生效。
 */
const SEARCH_TIMEOUT_FLOOR_MS = 25_000

export const europepmc: Provider = {
  info: {
    id: 'europepmc',
    label: 'Europe PMC',
    homepage: 'https://europepmc.org',
    capabilities: { abstract: true, citationCount: true, openAccess: true, pdf: true },
    rateLimit: '约 5 req/s（自限）',
    syntax: '支持布尔语法，查询式与 PubMed 接近；可按 PUB_YEAR / OPEN_ACCESS 下推',
    optionalKey: false,
  },

  async search(query, options): Promise<PaperRecord[]> {
    const params = new URLSearchParams({
      query: buildQuery(query, options),
      format: 'json',
      pageSize: String(options.limit),
      resultType: 'core',
    })

    const payload = await limitedJson('europepmc', `${ENDPOINT}?${params.toString()}`, {
      timeoutMs: Math.max(options.timeoutMs, SEARCH_TIMEOUT_FLOOR_MS),
      signal: options.signal,
      bypassCooldown: options.bypassCooldown === true,
      headers: { accept: 'application/json' },
    })

    const results = asArray(asRecord(asRecord(payload)['resultList'])['result'])
    return results.map(mapResult).filter((paper) => paper.title !== '')
  },
}

function buildQuery(query: string, options: ProviderSearchOptions): string {
  const clauses: string[] = []
  if (options.yearFrom !== undefined || options.yearTo !== undefined) {
    clauses.push(`PUB_YEAR:[${options.yearFrom ?? 1800} TO ${options.yearTo ?? 3000}]`)
  }
  if (options.openAccessOnly) clauses.push('OPEN_ACCESS:y')
  if (clauses.length === 0) return query
  return `(${query}) AND ${clauses.join(' AND ')}`
}

function mapResult(raw: unknown): PaperRecord {
  const result = asRecord(raw)
  const id = asString(result['id'])
  const source = asString(result['source'])
  const pmid = asString(result['pmid'])
  const pmcid = normalizePmcid(asString(result['pmcid']))
  const doi = normalizeDoi(result['doi'])
  const language = asString(result['language'])
  const authors = asArray(asRecord(result['authorList'])['author'])
    .map((entry) => asString(asRecord(entry)['fullName']))
    .filter((name) => name !== '')
  const pdfUrl = pickPdfUrl(result['fullTextUrlList'])
  const journal = asRecord(asRecord(result['journalInfo'])['journal'])

  return {
    source: 'europepmc',
    sourceId: id,
    ids: { doi, pmid, pmcid, arxivId: '' },
    title: asString(result['title']),
    authors,
    year: readYear(result['pubYear']),
    venue: asString(journal['title']),
    doi,
    url: source === '' || id === '' ? '' : `https://europepmc.org/article/${source}/${id}`,
    abstract: asString(result['abstractText']),
    ...(language === '' ? {} : { language }),
    citedBy: asNumber(result['citedByCount']),
    openAccess: asString(result['isOpenAccess']).toUpperCase() === 'Y',
    pdfUrl,
    type: asArray(asRecord(result['pubTypeList'])['pubType']).map(asString)[0] ?? '',
  }
}

function pickPdfUrl(value: unknown): string {
  const urls = asArray(asRecord(value)['fullTextUrl']).map(asRecord)
  const pdf = urls.find((entry) => {
    const style = asString(entry['documentStyle']).toLowerCase()
    const url = asString(entry['url']).toLowerCase()
    const availability = asString(entry['availabilityCode']).toUpperCase()
    return (style === 'pdf' || url.endsWith('.pdf')) && (availability === 'OA' || availability === 'F')
  })
  return pdf === undefined ? '' : asString(pdf['url'])
}

function normalizePmcid(value: string): string {
  const trimmed = value.trim().toUpperCase()
  if (trimmed === '') return ''
  return trimmed.startsWith('PMC') ? trimmed : `PMC${trimmed}`
}

function readYear(value: unknown): number | null {
  const text = asString(value)
  const match = /(\d{4})/u.exec(text)
  return match === null ? null : asNumber(Number(match[1]))
}
