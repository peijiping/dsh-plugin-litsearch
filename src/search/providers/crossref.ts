/**
 * Crossref provider —— DOI 注册元数据，几乎覆盖全部正式出版物。
 *
 * 文档：https://www.crossref.org/documentation/retrieve-metadata/rest-api/
 * 无需密钥；带 `mailto` 可进入 polite pool。
 */

import { limitedJson } from '../rate-limit.js'
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  doiUrl,
  firstString,
  normalizeDoi,
  stripTags,
} from '../normalize.js'
import type { PaperRecord, Provider } from '../types.js'

const ENDPOINT = 'https://api.crossref.org/works'

const SELECT_FIELDS = [
  'DOI',
  'title',
  'author',
  'issued',
  'container-title',
  'publisher',
  'URL',
  'abstract',
  'is-referenced-by-count',
  'link',
  'license',
  'type',
].join(',')

function userAgent(contactEmail: string): string {
  return contactEmail === ''
    ? 'dsh-plugin-litsearch/0.1.0'
    : `dsh-plugin-litsearch/0.1.0 (mailto:${contactEmail})`
}

export const crossref: Provider = {
  info: {
    id: 'crossref',
    label: 'Crossref',
    homepage: 'https://www.crossref.org',
    capabilities: { abstract: true, citationCount: true, openAccess: false, pdf: true },
    rateLimit: '约 1 req/s（保守自限）；带邮箱进入 polite pool',
    syntax: '自然语言；按年份下推，OA 由许可证粗略判断',
    optionalKey: false,
  },

  async search(query, options): Promise<PaperRecord[]> {
    const params = new URLSearchParams({
      query,
      rows: String(options.limit),
      select: SELECT_FIELDS,
    })

    const filters: string[] = []
    if (options.yearFrom !== undefined) filters.push(`from-pub-date:${options.yearFrom}-01-01`)
    if (options.yearTo !== undefined) filters.push(`until-pub-date:${options.yearTo}-12-31`)
    if (filters.length > 0) params.set('filter', filters.join(','))
    if (options.contactEmail !== '') params.set('mailto', options.contactEmail)

    const payload = await limitedJson('crossref', `${ENDPOINT}?${params.toString()}`, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      bypassCooldown: options.bypassCooldown === true,
      headers: {
        accept: 'application/json',
        'user-agent': userAgent(options.contactEmail),
      },
    })

    const items = asArray(asRecord(asRecord(payload)['message'])['items'])
    const papers = items.map(mapItem).filter((paper) => paper.title !== '')
    return options.openAccessOnly ? papers.filter((paper) => paper.openAccess) : papers
  },
}

function mapItem(raw: unknown): PaperRecord {
  const item = asRecord(raw)
  const doi = normalizeDoi(item['DOI'])
  const links = asArray(item['link']).map(asRecord)
  const pdfLink = links.find((link) => asString(link['content-type']) === 'application/pdf')
  const licenseText = asArray(item['license'])
    .map((entry) => asString(asRecord(entry)['URL']))
    .join(' ')
  const issued = asArray(asRecord(item['issued'])['date-parts'])[0]
  const language = asString(item['language'])

  return {
    source: 'crossref',
    sourceId: doi,
    ids: { doi, pmid: '', pmcid: '', arxivId: '' },
    title: stripTags(firstString(item['title'])),
    authors: asArray(item['author'])
      .map(authorName)
      .filter((name) => name !== ''),
    year: asNumber(asArray(issued)[0]),
    venue: stripTags(firstString(item['container-title'])) || asString(item['publisher']),
    doi,
    url: asString(item['URL']) || doiUrl(doi),
    abstract: stripTags(item['abstract']),
    ...(language === '' ? {} : { language }),
    citedBy: asNumber(item['is-referenced-by-count']),
    // Crossref 没有统一的 OA 标志，这里按许可证 URL 粗略判断。
    openAccess: /creativecommons|open\s*access/iu.test(licenseText),
    pdfUrl: pdfLink === undefined ? '' : asString(pdfLink['URL']),
    type: asString(item['type']),
  }
}

function authorName(raw: unknown): string {
  const author = asRecord(raw)
  const name = asString(author['name'])
  if (name !== '') return name
  return [asString(author['given']), asString(author['family'])]
    .filter((part) => part !== '')
    .join(' ')
}
