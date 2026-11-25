/**
 * arXiv provider —— 预印本检索。
 *
 * 文档：https://info.arxiv.org/help/api/user-manual.html
 * 检索式需带 `all:` 等字段前缀（由 query-adapter 处理）；API 要求 3s 间隔。
 * 年份与 OA 只能后置过滤（arXiv 全部开放获取）。
 */

import { asNumber, asString, normalizeDoi } from '../normalize.js'
import { limitedText } from '../rate-limit.js'
import type { PaperRecord, Provider, ProviderSearchOptions } from '../types.js'
import { xmlAttr, xmlBlocks, xmlTag, xmlText, xmlTexts } from '../xml.js'

const ENDPOINT = 'https://export.arxiv.org/api/query'

export const arxiv: Provider = {
  info: {
    id: 'arxiv',
    label: 'arXiv',
    homepage: 'https://arxiv.org',
    capabilities: { abstract: true, citationCount: false, openAccess: true, pdf: true },
    rateLimit: '3s 间隔（自限）',
    syntax: '需要 all:/ti:/abs: 等前缀；通用关键词会自动转换，年份为后置筛选',
    optionalKey: false,
  },

  lookup(id, options) {
    return fetchEntries(new URLSearchParams({ id_list: id, max_results: '1' }), options)
  },

  async search(query, options): Promise<PaperRecord[]> {
    const params = new URLSearchParams({
      search_query: query,
      start: '0',
      max_results: String(options.limit),
      sortBy: 'relevance',
      sortOrder: 'descending',
    })

    return filterByYear(await fetchEntries(params, options), options)
  },
}

async function fetchEntries(params: URLSearchParams, options: ProviderSearchOptions): Promise<PaperRecord[]> {
  const xml = await limitedText('arxiv', `${ENDPOINT}?${params}`, {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    bypassCooldown: options.bypassCooldown === true,
    headers: { accept: 'application/atom+xml' },
  })
  return xmlBlocks(xml, 'entry')
    .filter((entry) => normalizeArxiv(xmlText(entry, 'id')) !== '')
    .map(mapEntry)
    .filter((paper) => paper.title !== '')
}

function mapEntry(entry: string): PaperRecord {
  const entryId = normalizeArxiv(xmlText(entry, 'id'))
  const arxivId = entryId.replace(/v\d+$/u, '')
  const doi = normalizeDoi(xmlText(entry, 'arxiv:doi'))
  const published = xmlText(entry, 'published')
  const pdfUrl = findPdfUrl(entry)
  const categoryTag = xmlTag(entry, 'category')
  const category = xmlAttr(categoryTag, 'term')

  return {
    source: 'arxiv',
    sourceId: arxivId,
    ids: { doi, pmid: '', pmcid: '', arxivId },
    ...(arxivId === entryId ? {} : { arxivVersionId: entryId }),
    title: xmlText(entry, 'title'),
    authors: xmlTexts(entry, 'name').filter((name) => name !== ''),
    year: readYear(published),
    venue: xmlText(entry, 'arxiv:journal_ref') || 'arXiv',
    doi,
    url: arxivId === '' ? '' : `https://arxiv.org/abs/${arxivId}`,
    abstract: xmlText(entry, 'summary'),
    citedBy: null,
    openAccess: true,
    pdfUrl,
    type: category === '' ? 'preprint' : `preprint/${category}`,
  }
}

function findPdfUrl(entry: string): string {
  for (const match of entry.matchAll(/<link\b[^>]*>/gu)) {
    const tag = match[0]
    const title = xmlAttr(tag, 'title').toLowerCase()
    const type = xmlAttr(tag, 'type').toLowerCase()
    if (title === 'pdf' || type === 'application/pdf') {
      return xmlAttr(tag, 'href').replace(/^http:/u, 'https:')
    }
  }
  return ''
}

function normalizeArxiv(value: string): string {
  const trimmed = asString(value).trim().replace(/\/+$/u, '')
  if (trimmed === '') return ''
  return (trimmed.includes('/abs/') ? trimmed.split('/abs/')[1] ?? '' : trimmed).toLowerCase()
}

function readYear(value: string): number | null {
  const match = /(\d{4})/u.exec(value)
  return match === null ? null : asNumber(Number(match[1]))
}

function filterByYear(
  papers: PaperRecord[],
  options: { yearFrom?: number | undefined; yearTo?: number | undefined },
): PaperRecord[] {
  if (options.yearFrom === undefined && options.yearTo === undefined) return papers
  return papers.filter((paper) => {
    if (options.yearFrom !== undefined && (paper.year ?? 0) < options.yearFrom) return false
    if (options.yearTo !== undefined && (paper.year ?? Number.MAX_SAFE_INTEGER) > options.yearTo) {
      return false
    }
    return true
  })
}
