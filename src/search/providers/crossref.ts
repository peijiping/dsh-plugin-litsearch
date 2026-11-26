/**
 * Crossref provider —— DOI 注册元数据，几乎覆盖全部正式出版物。
 *
 * 文档：https://www.crossref.org/documentation/retrieve-metadata/rest-api/
 * 无需密钥；带 `mailto` 可进入 polite pool。
 */

import type { ProviderPage } from '../evidence.js'
import { SearchError } from '../errors.js'
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
import { bestPdfUrl, mergeOaLocations } from '../oa.js'
import type { OaLocation, PaperRecord, Provider, ProviderSearchOptions } from '../types.js'

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

  async lookup(id, options) {
    const params = new URLSearchParams()
    if (options.contactEmail !== '') params.set('mailto', options.contactEmail)
    const payload = await limitedJson('crossref', `${ENDPOINT}/${encodeURIComponent(id)}?${params}`, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      headers: { accept: 'application/json', 'user-agent': userAgent(options.contactEmail) },
    })
    const paper = mapItem(asRecord(payload)['message'])
    return paper.title === '' ? [] : [paper]
  },

  async search(query, options): Promise<PaperRecord[]> {
    const page = await searchPage(query, options)
    return page.entries.flatMap((entry) =>
      'record' in entry && (!options.openAccessOnly || entry.record.openAccess) ? [entry.record] : [],
    )
  },
  firstPageOnly: true,
  searchPage,
}

async function searchPage(query: string, options: ProviderSearchOptions): Promise<ProviderPage> {
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

  const message = asRecord(asRecord(payload).message)
  if (!Array.isArray(message.items))
    throw new SearchError('upstream_error', 'Crossref 返回了无法识别的检索结果')
  const entries = message.items.map((item) => {
    const record = mapItem(item)
    return record.title ? { record } : { sourceId: record.sourceId, reason: 'missingTitle' }
  })
  return {
    entries,
    reportedTotal: asNumber(message['total-results']),
    returned: entries.length,
    normalized: entries.filter((e) => 'record' in e).length,
    next: null,
  }
}

function mapItem(raw: unknown): PaperRecord {
  const item = asRecord(raw)
  const doi = normalizeDoi(item['DOI'])
  const licenseText = asArray(item['license'])
    .map((entry) => asString(asRecord(entry)['URL']))
    .join(' ')
  // Crossref 没有统一的 OA 标志，这里按许可证 URL 粗略判断。
  const openAccess = /creativecommons|open\s*access/iu.test(licenseText)
  const oaLocations = readLinks(item['link'], openAccess, licenseText)
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
    openAccess,
    pdfUrl: bestPdfUrl(oaLocations),
    ...(oaLocations.length === 0 ? {} : { oaLocations }),
    type: asString(item['type']),
  }
}

/**
 * `link[]` 里 `content-type` 常带 charset，必须前缀匹配；`text-mining` 专用
 * 链接只作信息保留，不作为自动下载候选（合规）。
 */
function readLinks(value: unknown, openAccess: boolean, licenseText: string): OaLocation[] {
  const locations: OaLocation[] = []
  for (const entry of asArray(value)) {
    const link = asRecord(entry)
    const url = asString(link['URL'])
    if (url === '') continue
    const type = asString(link['content-type']).toLowerCase()
    if (!type.startsWith('application/pdf')) continue
    const intended = asString(link['intended-application']).toLowerCase()
    const textMining = intended === 'text-mining'
    const license = licenseText === '' ? undefined : licenseText
    locations.push({
      url,
      kind: 'pdf',
      source: 'metadata',
      oa: openAccess && !textMining,
      ...(license === undefined ? {} : { license }),
      ...(textMining ? { textMining: true } : {}),
    })
  }
  return mergeOaLocations([locations])
}

function authorName(raw: unknown): string {
  const author = asRecord(raw)
  const name = asString(author['name'])
  if (name !== '') return name
  return [asString(author['given']), asString(author['family'])].filter((part) => part !== '').join(' ')
}
