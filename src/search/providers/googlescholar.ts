/**
 * Google Scholar provider —— 通过 SerpAPI 的 `google_scholar` 引擎检索。
 *
 * Google 不提供官方 Scholar API，且禁止程序化抓取；这里只走第三方 SerpAPI，
 * 由用户自备 Key。未配置 Key 时直接按「限流跳过」处理，不发起请求，也不计入
 * 失败。文档见 `docs/谷歌学术接入调研.md`。
 *
 * 限制：SerpAPI 单页最多 20 条，`limit > 20` 时按 `start` 翻页；结果普遍不带
 * DOI/PMID，跨源去重主要依赖规范化标题键。
 */

import { SearchError } from '../errors.js'
import { asArray, asNumber, asRecord, asString, normalizeDoi } from '../normalize.js'
import { limitedJson, SourceSkipped } from '../rate-limit.js'
import type { PaperRecord, Provider } from '../types.js'

const ENDPOINT = 'https://serpapi.com/search.json'
/** SerpAPI 允许的单页条数上限。 */
const PAGE_SIZE = 20

export const googlescholar: Provider = {
  info: {
    id: 'googlescholar',
    label: 'Google Scholar',
    homepage: 'https://scholar.google.com',
    capabilities: { abstract: true, citationCount: true, openAccess: true, pdf: true },
    rateLimit: '1 req/s 自限；受 SerpAPI 套餐配额约束（免费 250 次/月）',
    syntax: '自然语言；支持引号短语、author:/source:，不解析 PubMed 字段标签',
    optionalKey: true,
  },

  async search(query, options): Promise<PaperRecord[]> {
    const apiKey = options.serpApiKey?.trim() ?? ''
    if (apiKey === '') {
      throw new SourceSkipped('未配置 SerpAPI 密钥，Google Scholar 已跳过')
    }

    const records: PaperRecord[] = []
    const seen = new Set<string>()
    for (let start = 0; start < options.limit; start += PAGE_SIZE) {
      const num = Math.min(PAGE_SIZE, options.limit - start)
      const params = new URLSearchParams({
        engine: 'google_scholar',
        q: query,
        num: String(num),
        start: String(start),
        hl: 'en',
        api_key: apiKey,
      })
      if (options.yearFrom !== undefined) params.set('as_ylo', String(options.yearFrom))
      if (options.yearTo !== undefined) params.set('as_yhi', String(options.yearTo))

      const payload = await limitedJson('googlescholar', `${ENDPOINT}?${params.toString()}`, {
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        bypassCooldown: options.bypassCooldown === true,
        headers: { accept: 'application/json' },
      }).catch((error: unknown) => {
        if (error instanceof SearchError && (error.status === 401 || error.status === 403)) {
          throw new SearchError('upstream_error', 'SerpAPI 密钥无效或无权限，请在设置页检查')
        }
        throw error
      })

      const response = asRecord(payload)
      const error = asString(response['error']).trim()
      if (error !== '') {
        throw new SearchError('upstream_error', `SerpAPI：${error}`)
      }
      const items = asArray(response['organic_results'])
      for (const item of items) {
        const record = mapItem(item)
        if (record.title === '') continue
        const key = record.sourceId === '' ? record.title : record.sourceId
        if (seen.has(key)) continue
        seen.add(key)
        records.push(record)
      }
      // 上游返回不足一页，说明没有更多结果。
      if (items.length < num) break
    }
    return records
  },
}

function mapItem(raw: unknown): PaperRecord {
  const item = asRecord(raw)
  const publication = asRecord(item['publication_info'])
  const inline = asRecord(item['inline_links'])
  const versions = asRecord(inline['versions'])
  const citedBy = asRecord(inline['cited_by'])

  const title = asString(item['title']).trim()
  const link = asString(item['link']).trim()
  const summary = asString(publication['summary']).trim()
  const clusterId = asString(versions['cluster_id']).trim()
  const resultId = asString(item['result_id']).trim()
  const doi = readDoi(link)
  const pdfUrl = readPdfUrl(item['resources'])

  return {
    source: 'googlescholar',
    sourceId: clusterId !== '' ? clusterId : resultId !== '' ? resultId : link,
    ids: { doi, pmid: '', pmcid: '', arxivId: '' },
    title,
    authors: readAuthors(publication['authors'], summary),
    year: readYear(summary),
    venue: readVenue(summary),
    doi,
    url: link,
    abstract: asString(item['snippet']).trim(),
    citedBy: asNumber(citedBy['total']),
    openAccess: pdfUrl !== '',
    pdfUrl,
    type: '',
  }
}

/** 结果页不直接给 DOI；只有链接里出现 DOI 时才提取，避免误判普通 URL。 */
function readDoi(link: string): string {
  if (!/10\.\d{4,9}\//u.test(link)) return ''
  const match = /10\.\d{4,9}\/[^\s"<>]+/u.exec(link)
  return match === null ? '' : normalizeDoi(match[0])
}

function readPdfUrl(value: unknown): string {
  for (const entry of asArray(value)) {
    const resource = asRecord(entry)
    if (asString(resource['file_format']).toUpperCase() !== 'PDF') continue
    const link = asString(resource['link']).trim()
    if (link !== '') return link
  }
  return ''
}

function readAuthors(value: unknown, summary: string): string[] {
  const names = asArray(value)
    .map((entry) => asString(asRecord(entry)['name']).trim())
    .filter((name) => name !== '')
  if (names.length > 0) return names
  // 兜底：summary 形如「作者列表 - 标题, 年份 - 来源」。
  const head = summary.split(' - ')[0] ?? ''
  return head
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '' && name.length <= 80)
}

/** summary 中的最后一个四位年份即出版年（标题里的年份通常更早）。 */
function readYear(summary: string): number | null {
  const matches = [...summary.matchAll(/\b(?:19|20)\d{2}\b/gu)]
  if (matches.length === 0) return null
  return asNumber(Number(matches[matches.length - 1][0]))
}

/** summary 末段通常是来源站点（如 `cabdirect.org`）。 */
function readVenue(summary: string): string {
  const parts = summary.split(' - ')
  return parts.length < 2 ? '' : (parts[parts.length - 1] ?? '').trim()
}
