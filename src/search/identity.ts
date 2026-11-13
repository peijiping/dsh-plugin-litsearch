/**
 * 跨源论文身份与合并。
 *
 * 身份优先级：DOI > PMID > PMCID > arXiv id > 标题键。标题键在 NFKC 归一化后
 * 只保留字母数字，长度不足 12 个字符不参与合并（短标题误合并的代价太高）。
 *
 * 合并后按 RRF（reciprocal rank fusion）排序：Σ w_s / (60 + rank_s)，
 * 命中源数、最佳排位、被引数与年份依次作为并列决胜。
 */

import type { Paper, PaperHit, PaperIds, PaperRecord, SourceId } from './types.js'
import { SOURCE_IDS } from './types.js'

/** 各源权重（与方案一致）。 */
const RRF_WEIGHTS: Record<SourceId, number> = {
  pubmed: 1.1,
  europepmc: 1.0,
  openalex: 1.0,
  crossref: 0.95,
  semanticscholar: 0.9,
  arxiv: 0.85,
  pubtator: 0.7,
  googlescholar: 0.95,
}

/** RRF 平滑常数。 */
const RRF_K = 60

/** 标题键参与合并的最小长度（归一化后的字符数）。 */
const MIN_TITLE_KEY = 12

export interface RankedHit {
  record: PaperRecord
  source: SourceId
  /** 1-based 排位。 */
  rank: number
  queryId: string
}

export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** 单条记录的身份键；无法可靠识别时回落到「源 + 内部 id」，保证不误合并。 */
export function identityKey(record: PaperRecord): string {
  if (record.ids.doi !== '') return `doi:${record.ids.doi}`
  if (record.ids.pmid !== '') return `pmid:${record.ids.pmid}`
  if (record.ids.pmcid !== '') return `pmcid:${record.ids.pmcid}`
  if (record.ids.arxivId !== '') return `arxiv:${record.ids.arxivId}`
  const title = normalizeTitle(record.title)
  if (title.length >= MIN_TITLE_KEY) return `title:${title}:${record.year ?? ''}`
  return `src:${record.source}:${record.sourceId}`
}

/** 由身份键生成稳定、URL 安全的 paperId（双 FNV-1a，16 位十六进制）。 */
export function makePaperId(key: string): string {
  const a = fnv1a(key, 0x811c9dc5)
  const b = fnv1a(key, 0x01000193)
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

function fnv1a(text: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** 把一次检索的命中合并成去重后的论文列表，并按 RRF 排序。 */
export function mergeHits(hits: readonly RankedHit[]): Paper[] {
  const groups = new Map<string, { base: PaperRecord; hits: RankedHit[] }>()
  for (const hit of hits) {
    const key = identityKey(hit.record)
    const group = groups.get(key)
    if (group === undefined) {
      groups.set(key, { base: { ...hit.record }, hits: [hit] })
    } else {
      mergeRecord(group.base, hit.record)
      group.hits.push(hit)
    }
  }

  const papers = [...groups.entries()].map(([key, group]): Paper => {
    const hitSources: PaperHit[] = []
    const matchedQueries = new Set<string>()
    for (const hit of group.hits) {
      matchedQueries.add(hit.queryId)
      const existing = hitSources.find((entry) => entry.source === hit.source)
      if (existing === undefined) hitSources.push({ source: hit.source, rank: hit.rank })
      else existing.rank = Math.min(existing.rank, hit.rank)
    }
    hitSources.sort((a, b) => SOURCE_IDS.indexOf(a.source) - SOURCE_IDS.indexOf(b.source))
    return {
      ...group.base,
      paperId: makePaperId(key),
      hitSources,
      matchedQueries: [...matchedQueries],
    }
  })

  return papers.sort(comparePapers)
}

/** RRF 分数；供排序与调试使用。 */
export function rrfScore(paper: Paper): number {
  let score = 0
  for (const hit of paper.hitSources) {
    score += (RRF_WEIGHTS[hit.source] ?? 1) / (RRF_K + hit.rank)
  }
  return score
}

export function comparePapers(a: Paper, b: Paper): number {
  const score = rrfScore(b) - rrfScore(a)
  if (score !== 0) return score
  const sources = b.hitSources.length - a.hitSources.length
  if (sources !== 0) return sources
  const best = bestRank(a) - bestRank(b)
  if (best !== 0) return best
  const citations = (b.citedBy ?? -1) - (a.citedBy ?? -1)
  if (citations !== 0) return citations
  return (b.year ?? 0) - (a.year ?? 0)
}

function bestRank(paper: Paper): number {
  return paper.hitSources.reduce((min, hit) => Math.min(min, hit.rank), Number.POSITIVE_INFINITY)
}

function mergeRecord(base: PaperRecord, extra: PaperRecord): void {
  base.ids = mergeIds(base.ids, extra.ids)
  if (base.ids.doi !== '') base.doi = base.ids.doi
  if (extra.abstract.length > base.abstract.length) base.abstract = extra.abstract
  if (base.pdfUrl === '' && extra.pdfUrl !== '') base.pdfUrl = extra.pdfUrl
  if (extra.venue.length > base.venue.length) base.venue = extra.venue
  if (base.year === null) base.year = extra.year
  if (base.citedBy === null || (extra.citedBy !== null && extra.citedBy > base.citedBy)) {
    base.citedBy = extra.citedBy
  }
  if (extra.authors.length > base.authors.length) base.authors = [...extra.authors]
  if (base.language === undefined && extra.language !== undefined) base.language = extra.language
  if (base.type === '' && extra.type !== '') base.type = extra.type
  if (base.url === '' || base.url === base.sourceId) base.url = extra.url
  base.openAccess = base.openAccess || extra.openAccess
}

function mergeIds(base: PaperIds, extra: PaperIds): PaperIds {
  return {
    doi: base.doi !== '' ? base.doi : extra.doi,
    pmid: base.pmid !== '' ? base.pmid : extra.pmid,
    pmcid: base.pmcid !== '' ? base.pmcid : extra.pmcid,
    arxivId: base.arxivId !== '' ? base.arxivId : extra.arxivId,
  }
}
