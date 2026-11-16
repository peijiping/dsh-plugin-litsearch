/**
 * OpenReview provider —— AI/ML 会议的公开投稿与评审平台。
 *
 * 文档：https://docs.openreview.net/reference/api-v2
 * v2 公开读无需登录；每篇 forum 都有稳定 PDF 直链 `pdf?id=<noteId>`。
 *
 * 注意：搜索结果会混入 DBLP 镜像的 CoRR（arXiv）条目，这类记录与 arXiv 源
 * 重复，这里直接丢弃，避免同一篇论文被计两次 RRF。
 */

import { asArray, asRecord, asString } from '../normalize.js'
import { limitedJson } from '../rate-limit.js'
import type { PaperRecord, Provider } from '../types.js'

const ENDPOINT = 'https://api2.openreview.net/notes/search'

const TIMEOUT_CAP_MS = 15_000

export const openreview: Provider = {
  info: {
    id: 'openreview',
    label: 'OpenReview',
    homepage: 'https://openreview.net',
    capabilities: { abstract: true, citationCount: false, openAccess: true, pdf: true },
    rateLimit: '自限 1 req/s；公开读接口无需登录',
    syntax: '自然语言关键词（Elasticsearch 全文匹配），不支持字段标签',
    optionalKey: false,
  },

  async search(query, options): Promise<PaperRecord[]> {
    const params = new URLSearchParams({
      term: query,
      source: 'forum',
      type: 'terms',
      content: 'all',
      group: 'all',
      // 多取几条：CoRR 镜像会被过滤掉。
      limit: String(Math.max(1, options.limit + 3)),
    })

    const payload = await limitedJson('openreview', `${ENDPOINT}?${params.toString()}`, {
      timeoutMs: Math.min(options.timeoutMs, TIMEOUT_CAP_MS),
      signal: options.signal,
      bypassCooldown: options.bypassCooldown === true,
      headers: { accept: 'application/json' },
    })

    return asArray(asRecord(payload)['notes'])
      .map(mapNote)
      .filter((paper) => paper.title !== '' && !isArxivMirror(paper))
      .slice(0, options.limit)
  },
}

/** DBLP 镜像条目（CoRR/arXiv）与本插件的 arXiv 源重复，丢弃。 */
function isArxivMirror(paper: PaperRecord): boolean {
  const venue = paper.venue.toLowerCase()
  return venue.includes('corr') || venue.includes('arxiv')
}

function mapNote(raw: unknown): PaperRecord {
  const note = asRecord(raw)
  const id = asString(note['id'])
  const title = value(note, 'title')
  const abstract = value(note, 'abstract')
  const venue = value(note, 'venue')
  const venueId = value(note, 'venueid')
  const authors = arrayValue(note, 'authors')
  const year = readYear(note)
  const forumId = asString(note['forum']) || id
  const license = asString(note['license'])

  return {
    source: 'openreview',
    sourceId: id,
    ids: { doi: '', pmid: '', pmcid: '', arxivId: '' },
    title,
    authors,
    year,
    venue: venue !== '' ? venue : venueId,
    doi: '',
    url: id === '' ? '' : `https://openreview.net/forum?id=${encodeURIComponent(forumId)}`,
    abstract,
    citedBy: null,
    // OpenReview 的投稿 PDF 公开可读，但没有统一许可证，故 license 留空。
    openAccess: true,
    pdfUrl: id === '' ? '' : `https://openreview.net/pdf?id=${encodeURIComponent(id)}`,
    ...(id === ''
      ? {}
      : {
          oaLocations: [
            {
              url: `https://openreview.net/pdf?id=${encodeURIComponent(id)}`,
              kind: 'pdf' as const,
              source: 'metadata' as const,
              oa: true,
              ...(license === '' ? {} : { license }),
            },
            {
              url: `https://openreview.net/forum?id=${encodeURIComponent(forumId)}`,
              kind: 'landing' as const,
              source: 'metadata' as const,
              oa: false,
            },
          ],
        }),
    type: venueId === '' ? 'preprint' : venueId,
  }
}

/** v2 的字段被包成 `{ value: ... }`；v1 是裸值，两种都兼容。 */
function value(note: Record<string, unknown>, key: string): string {
  const content = asRecord(note['content'])
  const entry = asRecord(content[key])
  if ('value' in entry) return asString(entry['value'])
  return asString(content[key])
}

function arrayValue(note: Record<string, unknown>, key: string): string[] {
  const content = asRecord(note['content'])
  const entry = asRecord(content[key])
  const raw = 'value' in entry ? entry['value'] : content[key]
  return asArray(raw).map(asString).filter((name) => name !== '')
}

function readYear(note: Record<string, unknown>): number | null {
  for (const key of ['pdate', 'cdate', 'tcdate']) {
    const raw = note[key]
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue
    const date = new Date(raw)
    if (Number.isNaN(date.getTime())) continue
    return date.getUTCFullYear()
  }
  return null
}
