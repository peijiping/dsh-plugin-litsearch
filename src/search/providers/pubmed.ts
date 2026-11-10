/**
 * PubMed / NCBI E-utilities provider。
 *
 * 两次请求：ESearch 拿 PMID 列表 → EFetch 取 XML 详情。ESearch/EFetch 各自
 * 走 PubMed 限流队列（默认 350ms，带 key 可在设置里调低）。
 *
 * 文档：docs/eutilities（使用规范、ESearch、EFetch）
 */

import { asArray, asNumber, asRecord, asString, normalizeDoi } from '../normalize.js'
import { limitedJson, limitedText } from '../rate-limit.js'
import type { PaperRecord, Provider, ProviderSearchOptions } from '../types.js'
import {
  stripXmlTags,
  xmlAttr,
  xmlBlocks,
  xmlText,
  xmlTexts,
} from '../xml.js'

const ESEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi'
const EFETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi'

const TOOL = 'dsh-plugin-litsearch'

/** ESearch 最多一次取多少 PMID（远小于上限，避免 EFetch 响应过大）。 */
const MAX_PMIDS = 100

export const pubmed: Provider = {
  info: {
    id: 'pubmed',
    label: 'PubMed',
    homepage: 'https://pubmed.ncbi.nlm.nih.gov',
    capabilities: { abstract: true, citationCount: false, openAccess: true, pdf: false },
    rateLimit: '无 key 3 req/s，有 key 10 req/s',
    syntax: '支持 [tiab]/[MeSH]/[dp]/[pt] 等 PubMed 字段标签与布尔语法',
    optionalKey: true,
  },

  async search(query, options): Promise<PaperRecord[]> {
    const term = buildTerm(query, options)
    const ids = await searchIds(term, options)
    if (ids.length === 0) return []
    const xml = await fetchArticles(ids, options)
    return xmlBlocks(xml, 'PubmedArticle')
      .map(mapArticle)
      .filter((paper) => paper.title !== '')
  },
}

function buildTerm(query: string, options: ProviderSearchOptions): string {
  if (!options.openAccessOnly) return query
  return `(${query}) AND "free full text"[sb]`
}

function baseParams(options: ProviderSearchOptions): URLSearchParams {
  const params = new URLSearchParams({ tool: TOOL, db: 'pubmed' })
  if (options.contactEmail !== '') params.set('email', options.contactEmail)
  if (options.ncbiApiKey !== undefined && options.ncbiApiKey !== '') {
    params.set('api_key', options.ncbiApiKey)
  }
  return params
}

async function searchIds(term: string, options: ProviderSearchOptions): Promise<string[]> {
  const params = baseParams(options)
  params.set('term', term)
  params.set('retmax', String(Math.min(options.limit, MAX_PMIDS)))
  params.set('retmode', 'json')
  params.set('sort', 'relevance')
  params.set('datetype', 'pdat')
  params.set('mindate', String(options.yearFrom ?? 1800))
  params.set('maxdate', String(options.yearTo ?? 3000))

  const payload = await limitedJson('pubmed', `${ESEARCH}?${params.toString()}`, {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    bypassCooldown: options.bypassCooldown === true,
  })
  return asArray(asRecord(asRecord(payload)['esearchresult'])['idlist'])
    .map((value) => asString(value))
    .filter((value) => value !== '')
}

async function fetchArticles(ids: string[], options: ProviderSearchOptions): Promise<string> {
  const params = baseParams(options)
  params.set('id', ids.join(','))
  params.set('retmode', 'xml')
  return limitedText('pubmed', `${EFETCH}?${params.toString()}`, {
    timeoutMs: Math.max(options.timeoutMs, 30_000),
    signal: options.signal,
    bypassCooldown: options.bypassCooldown === true,
  })
}

function mapArticle(block: string): PaperRecord {
  const pmid = xmlText(block, 'PMID')
  const doi = findDoi(block)
  const pmcid = normalizePmcid(findArticleId(block, 'pmc'))
  const year = readYear(xmlText(block, 'PubDate'))
  const language = xmlText(block, 'Language')
  const authors = xmlBlocks(block, 'Author')
    .map(authorName)
    .filter((name) => name !== '')

  return {
    source: 'pubmed',
    sourceId: pmid,
    ids: { doi, pmid, pmcid, arxivId: '' },
    title: xmlText(block, 'ArticleTitle'),
    authors,
    year,
    venue: xmlText(block, 'Title'),
    doi,
    url: pmid === '' ? '' : `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    abstract: xmlTexts(block, 'AbstractText').join(' '),
    ...(language === '' ? {} : { language }),
    citedBy: null,
    openAccess: pmcid !== '' || /free full text/iu.test(block),
    pdfUrl: '',
    type: xmlText(block, 'PublicationType'),
  }
}

function authorName(block: string): string {
  const collective = xmlText(block, 'CollectiveName')
  if (collective !== '') return collective
  const last = xmlText(block, 'LastName')
  const fore = xmlText(block, 'ForeName') || xmlText(block, 'Initials')
  return [fore, last].filter((part) => part !== '').join(' ')
}

function findArticleId(block: string, type: string): string {
  for (const match of block.matchAll(/<ArticleId\b[^>]*>[^<]*<\/ArticleId>/gu)) {
    const tag = match[0]
    if (xmlAttr(tag, 'IdType').toLowerCase() === type) return stripXmlTags(tag)
  }
  return ''
}

function findDoi(block: string): string {
  const fromList = findArticleId(block, 'doi')
  if (fromList !== '') return normalizeDoi(fromList)
  for (const match of block.matchAll(/<ELocationID\b[^>]*>[^<]*<\/ELocationID>/gu)) {
    const tag = match[0]
    if (xmlAttr(tag, 'EIdType').toLowerCase() === 'doi') return normalizeDoi(stripXmlTags(tag))
  }
  return ''
}

function normalizePmcid(value: string): string {
  const trimmed = value.trim().toUpperCase()
  if (trimmed === '') return ''
  return trimmed.startsWith('PMC') ? trimmed : `PMC${trimmed}`
}

function readYear(value: string): number | null {
  const match = /(\d{4})/u.exec(value)
  return match === null ? null : asNumber(Number(match[1]))
}
