/**
 * Semantic Scholar provider。
 *
 * 文档：https://api.semanticscholar.org/api-docs/graph
 * 无 key 时配额很小（约 100 次/5 分钟），队列默认 3s 间隔；429 会进入冷却，
 * 不会阻塞其它数据源。
 */

import { asArray, asNumber, asRecord, asString, doiUrl, normalizeDoi } from '../normalize.js'
import { limitedJson } from '../rate-limit.js'
import type { OaLocation, PaperRecord, Provider, ProviderSearchOptions } from '../types.js'

const ENDPOINT = 'https://api.semanticscholar.org/graph/v1/paper/search'

const FIELDS = [
  'title',
  'authors',
  'year',
  'venue',
  'abstract',
  'externalIds',
  'url',
  'citationCount',
  'openAccessPdf',
  'isOpenAccess',
  'publicationTypes',
  'journal',
].join(',')

export const semanticscholar: Provider = {
  info: {
    id: 'semanticscholar',
    label: 'Semantic Scholar',
    homepage: 'https://www.semanticscholar.org',
    capabilities: { abstract: true, citationCount: true, openAccess: true, pdf: true },
    rateLimit: '无 key 约 100 次/5 分钟（自限 3s 间隔），有 key 更高',
    syntax: '自然语言；按年份下推，OA 为后置筛选',
    optionalKey: true,
  },

  async search(query, options): Promise<PaperRecord[]> {
    const params = new URLSearchParams({
      query,
      limit: String(options.limit),
      fields: FIELDS,
    })
    const year = yearRange(options)
    if (year !== '') params.set('year', year)

    const headers: Record<string, string> = { accept: 'application/json' }
    const apiKey = options.s2ApiKey ?? ''
    const hasKey = apiKey !== ''
    if (hasKey) headers['x-api-key'] = apiKey

    const payload = await limitedJson(
      'semanticscholar',
      `${ENDPOINT}?${params.toString()}`,
      {
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        bypassCooldown: options.bypassCooldown === true,
        ...(hasKey
          ? {}
          : {
              // 匿名配额是全局共享池，退避 2 秒重试几乎必然再次 429，直接跳过。
              retryOnRateLimit: false,
              skipHint: '未配置 Key，匿名共享配额常被占满；可在设置中填写 Semantic Scholar Key',
            }),
        headers,
      },
    )

    const papers = asArray(asRecord(payload)['data'])
      .map(mapPaper)
      .filter((paper) => paper.title !== '')
    return options.openAccessOnly ? papers.filter((paper) => paper.openAccess) : papers
  },
}

function yearRange(options: ProviderSearchOptions): string {
  if (options.yearFrom === undefined && options.yearTo === undefined) return ''
  return `${options.yearFrom ?? ''}-${options.yearTo ?? ''}`
}

function mapPaper(raw: unknown): PaperRecord {
  const paper = asRecord(raw)
  const external = asRecord(paper['externalIds'])
  const doi = normalizeDoi(external['DOI'])
  const pmid = asString(external['PubMed'])
  const pmcid = normalizePmcid(asString(external['PubMedCentral']))
  const arxivId = normalizeArxiv(asString(external['ArXiv']))
  const oaPdf = asRecord(paper['openAccessPdf'])
  const journal = asRecord(paper['journal'])
  const url = asString(paper['url'])
  const pdfUrl = asString(oaPdf['url'])
  const status = asString(oaPdf['status']).toUpperCase()
  const oaLocations: OaLocation[] =
    pdfUrl === ''
      ? []
      : [
          {
            url: pdfUrl,
            kind: 'pdf',
            source: 'metadata',
            // `CLOSED` 表示上游确认非开放获取，其余状态视为 OA。
            oa: status !== 'CLOSED',
          },
        ]

  return {
    source: 'semanticscholar',
    sourceId: asString(paper['paperId']),
    ids: { doi, pmid, pmcid, arxivId },
    title: asString(paper['title']),
    authors: asArray(paper['authors'])
      .map((entry) => asString(asRecord(entry)['name']))
      .filter((name) => name !== ''),
    year: asNumber(paper['year']),
    venue: asString(journal['name']) || asString(paper['venue']),
    doi,
    url: url !== '' ? url : doiUrl(doi),
    abstract: asString(paper['abstract']),
    citedBy: asNumber(paper['citationCount']),
    openAccess: paper['isOpenAccess'] === true || pdfUrl !== '',
    pdfUrl,
    ...(oaLocations.length === 0 ? {} : { oaLocations }),
    type: asString(asArray(paper['publicationTypes'])[0]),
  }
}

function normalizePmcid(value: string): string {
  const trimmed = value.trim().toUpperCase()
  if (trimmed === '') return ''
  return trimmed.startsWith('PMC') ? trimmed : `PMC${trimmed}`
}

function normalizeArxiv(value: string): string {
  return value.trim().replace(/v\d+$/u, '')
}
