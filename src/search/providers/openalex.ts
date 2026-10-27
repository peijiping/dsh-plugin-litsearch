/**
 * OpenAlex provider —— 覆盖面最广的免费开放学术图谱。
 *
 * 文档：https://docs.openalex.org
 * 无需密钥；带 `mailto` 进入 polite pool，可获得更稳定的限流额度。
 */

import { fetchJson } from '../http.js'
import { asArray, asNumber, asRecord, asString, doiUrl, normalizeDoi } from '../normalize.js'
import type { Paper, Provider } from '../types.js'

const ENDPOINT = 'https://api.openalex.org/works'

function userAgent(contactEmail: string): string {
  return contactEmail === ''
    ? 'dsh-plugin-litsearch/0.1.0'
    : `dsh-plugin-litsearch/0.1.0 (mailto:${contactEmail})`
}

export const openalex: Provider = {
  info: {
    id: 'openalex',
    label: 'OpenAlex',
    homepage: 'https://openalex.org',
    capabilities: { abstract: true, citationCount: true, openAccess: true, pdf: true },
  },

  async search(query, options): Promise<Paper[]> {
    const params = new URLSearchParams({
      search: query,
      'per-page': String(options.limit),
      sort: 'relevance_score:desc',
    })

    const filters: string[] = []
    if (options.yearFrom !== undefined) filters.push(`from_publication_date:${options.yearFrom}-01-01`)
    if (options.yearTo !== undefined) filters.push(`to_publication_date:${options.yearTo}-12-31`)
    if (options.openAccessOnly) filters.push('is_oa:true')
    if (filters.length > 0) params.set('filter', filters.join(','))
    if (options.contactEmail !== '') params.set('mailto', options.contactEmail)

    const payload = await fetchJson(`${ENDPOINT}?${params.toString()}`, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      headers: {
        accept: 'application/json',
        'user-agent': userAgent(options.contactEmail),
      },
    })

    return asArray(asRecord(payload)['results'])
      .map(mapWork)
      .filter((paper) => paper.title !== '')
  },
}

function mapWork(raw: unknown): Paper {
  const work = asRecord(raw)
  const primary = asRecord(work['primary_location'])
  const host = asRecord(primary['source'])
  const bestOa = asRecord(work['best_oa_location'])
  const doi = normalizeDoi(work['doi'])
  const openAlexId = asString(work['id'])
  const landing = asString(primary['landing_page_url'])

  return {
    source: 'openalex',
    sourceId: openAlexId,
    title: asString(work['title']) || asString(work['display_name']),
    authors: asArray(work['authorships'])
      .map((entry) => asString(asRecord(asRecord(entry)['author'])['display_name']))
      .filter((name) => name !== ''),
    year: asNumber(work['publication_year']),
    venue: asString(host['display_name']),
    doi,
    url: landing || doiUrl(doi) || openAlexId,
    abstract: abstractFromInverted(work['abstract_inverted_index']),
    citedBy: asNumber(work['cited_by_count']),
    openAccess: asRecord(work['open_access'])['is_oa'] === true,
    pdfUrl: asString(bestOa['pdf_url']),
    type: asString(work['type']),
  }
}

/** OpenAlex 的摘要是「词 → 位置数组」，按位置还原成原文。 */
function abstractFromInverted(value: unknown): string {
  const index = asRecord(value)
  const entries: Array<[number, string]> = []
  for (const [word, positions] of Object.entries(index)) {
    for (const position of asArray(positions)) {
      if (typeof position === 'number') entries.push([position, word])
    }
  }
  return entries
    .sort((a, b) => a[0] - b[0])
    .map(([, word]) => word)
    .join(' ')
}
