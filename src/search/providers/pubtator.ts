/**
 * PubTator3 provider —— NCBI 生物医学实体标注检索。
 *
 * 文档：https://www.ncbi.nlm.nih.gov/research/pubtator3-api/
 * 只接受纯文本查询；返回标题、作者、期刊与 PMID/DOI，不含摘要与被引数。
 * 主要价值是与 PubMed/EPMC 交叉命中，并为后续实体标注预留入口。
 */

import { asArray, asNumber, asRecord, asString, normalizeDoi } from '../normalize.js'
import { limitedJson } from '../rate-limit.js'
import type { PaperRecord, Provider } from '../types.js'

const ENDPOINT = 'https://www.ncbi.nlm.nih.gov/research/pubtator3-api/search/'

export const pubtator: Provider = {
  info: {
    id: 'pubtator',
    label: 'PubTator3',
    homepage: 'https://www.ncbi.nlm.nih.gov/research/pubtator3/',
    capabilities: { abstract: false, citationCount: false, openAccess: false, pdf: false },
    rateLimit: '350ms 间隔（与 NCBI 共用限流策略）',
    syntax: '纯文本关键词；不支持字段标签与布尔语法',
    optionalKey: false,
  },

  async search(query, options): Promise<PaperRecord[]> {
    const params = new URLSearchParams({
      text: query,
      page: '1',
      size: String(options.limit),
    })

    const payload = await limitedJson('pubtator', `${ENDPOINT}?${params.toString()}`, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      bypassCooldown: options.bypassCooldown === true,
      headers: { accept: 'application/json' },
    })

    const papers = asArray(asRecord(payload)['results'])
      .map(mapResult)
      .filter((paper) => paper.title !== '')
    return filterByYear(papers, options)
  },
}

function mapResult(raw: unknown): PaperRecord {
  const result = asRecord(raw)
  const pmid = asString(result['pmid'])
  const id = pmid !== '' ? pmid : asString(result['_id'])
  const doi = normalizeDoi(result['doi'])
  const date = asString(result['date'])

  return {
    source: 'pubtator',
    sourceId: id,
    ids: { doi, pmid, pmcid: '', arxivId: '' },
    title: asString(result['title']),
    authors: asArray(result['authors'])
      .map((entry) => asString(entry))
      .filter((name) => name !== ''),
    year: readYear(date),
    venue: asString(result['journal']),
    doi,
    url: pmid === '' ? '' : `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    abstract: '',
    citedBy: null,
    openAccess: false,
    pdfUrl: '',
    type: '',
  }
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
