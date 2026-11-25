import { getSettings } from './config.js'
import { SearchError } from './errors.js'
import { makePaperId, mergeHits } from './identity.js'
import { normalizeDoi } from './normalize.js'
import { arxiv } from './providers/arxiv.js'
import { crossref } from './providers/crossref.js'
import { pubmed } from './providers/pubmed.js'
import type { Paper, PaperIdentifierKind, PaperRecord, PaperSupplementResult } from './types.js'

export interface PaperIdentifier {
  kind: PaperIdentifierKind
  id: string
}

const VERSION_SUFFIX = /v[1-9]\d*$/u

export function parseIdentifier(input: string): PaperIdentifier {
  const text = input.trim()
  const doiUrl = URL.parse(text)
  const path = doiUrl !== null && ['doi.org', 'dx.doi.org'].includes(doiUrl.hostname)
    ? doiUrl.pathname.slice(1)
    : undefined
  let doi = normalizeDoi(text)
  if (path !== undefined) {
    try {
      doi = normalizeDoi(decodeURIComponent(path))
    } catch {
      throw new SearchError('bad_request', 'DOI 链接包含无效的编码')
    }
  }
  if (/^10\.\d{4,9}\/[^\s]+$/u.test(doi)) return { kind: 'doi', id: doi }

  const pmid = /^(?:(?:pmid\s*:\s*)|(?:https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/))?([1-9]\d{0,11})\/?$/iu.exec(text)?.[1]
  if (pmid !== undefined) return { kind: 'pmid', id: pmid }

  const arxivId = text.toLowerCase().replace(
    /^(?:arxiv\s*:\s*|https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/)/u,
    '',
  ).replace(/(?:\.pdf|\/)$/u, '')
  if (/^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7})(?:v[1-9]\d*)?$/u.test(arxivId)) {
    return { kind: 'arxiv', id: arxivId }
  }
  throw new SearchError('bad_request', '请输入有效的 DOI、PMID 或 arXiv ID')
}

export function matchesIdentifier(paper: PaperRecord, identifier: PaperIdentifier): boolean {
  switch (identifier.kind) {
    case 'doi':
      // arXiv 条目的 DOI 可能指向期刊正式版，不能据此用预印本替代该 DOI 的注册题录。
      return paper.source !== 'arxiv' && normalizeDoi(paper.ids.doi || paper.doi) === identifier.id
    case 'pmid': return paper.ids.pmid === identifier.id
    case 'arxiv':
      return VERSION_SUFFIX.test(identifier.id)
        ? paper.arxivVersionId === identifier.id
        : paper.ids.arxivId === identifier.id
  }
}

export async function lookupPaper(identifier: PaperIdentifier): Promise<PaperSupplementResult> {
  const provider = { doi: crossref, pmid: pubmed, arxiv }[identifier.kind]
  const settings = getSettings()
  let records: PaperRecord[]
  try {
    const lookup = provider.lookup
    if (lookup === undefined) return { status: 'unavailable', error: '来源未提供精确查询' }
    records = await lookup(identifier.id, {
      limit: 1,
      openAccessOnly: false,
      contactEmail: settings.contactEmail,
      timeoutMs: settings.requestTimeoutMs,
      ncbiApiKey: settings.ncbiApiKey,
    })
  } catch (error) {
    if (error instanceof SearchError && error.status === 404) {
      return { status: 'not_found', error: `${provider.info.label} 未找到该标识的题录` }
    }
    return { status: 'unavailable', error: `${provider.info.label} 暂时无法查询该标识` }
  }
  const record = records.find((paper) => matchesIdentifier(paper, identifier))
  if (record === undefined) {
    const wrongVersion = identifier.kind === 'arxiv' && VERSION_SUFFIX.test(identifier.id) &&
      records.some((paper) => paper.ids.arxivId === identifier.id.replace(VERSION_SUFFIX, ''))
    return wrongVersion
      ? { status: 'version_mismatch', error: 'arXiv 返回了不同版本，请核对版本号' }
      : { status: 'not_found', error: `${provider.info.label} 未返回标识完全匹配的题录` }
  }
  const [paper] = mergeHits([{ record, source: record.source, rank: 1, queryId: '' }])
  paper.matchedQueries = []
  if (identifier.kind === 'arxiv' && VERSION_SUFFIX.test(identifier.id)) {
    paper.paperId = makePaperId(`arxiv:${identifier.id}`)
    paper.url = `https://arxiv.org/abs/${identifier.id}`
    paper.pdfUrl = `https://arxiv.org/pdf/${identifier.id}`
  }
  return { status: 'added', paper }
}
