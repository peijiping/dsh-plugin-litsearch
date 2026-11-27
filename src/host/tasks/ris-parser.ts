import { createHash } from 'node:crypto'

import { SearchError } from '../../search/errors.js'
import { normalizeDoi } from '../../search/normalize.js'
import { risPublicationType } from '../../search/publication-type.js'
import type { PaperMetadata, RisImportBatch, RisImportIssue } from '../../search/types.js'

export const MAX_RIS_BYTES = 5 * 1024 * 1024
type ParsedRow = Omit<RisImportBatch['rows'][number], 'paperId'>

export interface ParsedRis {
  fingerprint: string
  rows: ParsedRow[]
  issues: RisImportIssue[]
}

function decode(bytes: Buffer): string {
  const bom = bytes.subarray(0, 2).toString('hex')
  try {
    const encoding = bom === 'fffe' ? 'utf-16le' : bom === 'feff' ? 'utf-16be' : 'utf-8'
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
    if (text.includes('\0')) throw new Error('unexpected NUL')
    return text
  } catch {
    throw new SearchError('bad_request', 'RIS 文件编码无效，请将文件另存为 UTF-8 或带 BOM 的 UTF-16')
  }
}

export function parseRis(bytes: Buffer): ParsedRis {
  if (bytes.length === 0 || bytes.length > MAX_RIS_BYTES) {
    throw new SearchError('bad_request', 'RIS 文件为空或超过 5 MiB')
  }
  const rows: ParsedRow[] = []
  const issues: RisImportIssue[] = []
  const lines = decode(bytes).split(/\r\n|\n|\r/u)
  let fields = new Map<string, string[]>()
  let lastTag = ''
  let start = 0

  function finish(end: boolean): void {
    const record = rows.length + issues.length + 1
    const rawType = first(fields, 'TY')
    const title = first(fields, 'TI', 'T1', 'CT')
    const code = !rawType ? 'missingType' : !end ? 'missingEnd' : !title ? 'missingTitle' : undefined
    if (code !== undefined) issues.push({ record, line: start, code })
    else rows.push({ line: start, rawType, metadata: readMetadata(fields, rawType, title) })
    fields = new Map()
    lastTag = ''
    start = 0
  }

  for (const [index, line] of lines.entries()) {
    const field = /^\s*([A-Z][A-Z0-9])\s+-\s?(.*)$/u.exec(line)
    if (field) {
      const [, tag, value] = field
      if (tag === 'TY' && start) finish(false)
      if (!start) start = index + 1
      if (tag === 'ER') {
        finish(true)
        continue
      }
      const values = fields.get(tag) ?? []
      values.push(value.trim())
      fields.set(tag, values)
      lastTag = tag
      continue
    }
    const values = fields.get(lastTag)
    if (values && line.trim()) values[values.length - 1] += '\n' + line.trim()
  }
  if (start) finish(false)
  if (rows.length === 0 && issues.length === 0) throw new SearchError('bad_request', '未识别到 RIS 题录')
  return { fingerprint: createHash('sha256').update(bytes).digest('hex'), rows, issues }
}

function first(fields: Map<string, string[]>, ...tags: string[]): string {
  for (const tag of tags) {
    const value = fields.get(tag)?.find(Boolean)
    if (value) return value
  }
  return ''
}

function webUrl(raw: string): string {
  try {
    const url = new URL(raw)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''
  } catch {
    return ''
  }
}

function readMetadata(fields: Map<string, string[]>, rawType: string, title: string): PaperMetadata {
  const links = ['UR', 'L2'].flatMap((tag) => fields.get(tag) ?? []).map(webUrl).filter(Boolean)
  const url = links[0] ?? ''
  const doiText = normalizeDoi(first(fields, 'DO') || links.find((link) => /^https?:\/\/(?:dx\.)?doi\.org\//iu.test(link)))
  const doi = /^10\.\d{4,9}\/\S+$/u.test(doiText) ? doiText : ''
  const accession = first(fields, 'AN')
  const pmid = /\bPMID\s*:?\s*(\d+)\b/iu.exec(accession)?.[1]
    ?? (/^(?:PubMed|MEDLINE)$/iu.test(first(fields, 'DB')) && /^\d+$/u.test(accession) ? accession : undefined)
    ?? links.map((link) => /^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)\/?(?:[?#].*)?$/iu.exec(link)?.[1]).find(Boolean)
    ?? ''
  const pmcid = /\bPMC\d+\b/iu.exec([accession, ...links].join(' '))?.[0].toUpperCase() ?? ''
  const arxivVersionId = links.map((link) =>
    /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/((?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})(?:v\d+)?)(?:\.pdf)?(?:[?#].*)?$/iu.exec(link)?.[1]?.toLowerCase(),
  ).find(Boolean)
  const type = risPublicationType(rawType, arxivVersionId ? 'preprint' : first(fields, 'M3'))
  const venueTags = {
    'journal-article': ['JF', 'JO', 'T2', 'JA', 'J2'],
    'proceedings-article': ['T2', 'BT', 'JF', 'JO'],
    'book-chapter': ['T2', 'BT'],
  }[type as 'journal-article' | 'proceedings-article' | 'book-chapter'] ?? ['T2', 'PB', 'BT', 'JO']
  const date = first(fields, 'DA', 'Y1', 'PY')
  const year = /^(\d{4})(?:\b|$)/u.exec(first(fields, 'PY', 'Y1', 'DA'))?.[1]
  const volume = first(fields, 'VL')
  const issue = first(fields, 'IS')
  const startPage = first(fields, 'SP')
  const endPage = first(fields, 'EP')
  const pages = startPage && endPage ? startPage + '-' + endPage : startPage || endPage
  const pdfUrl = (fields.get('L1') ?? []).map(webUrl).find(Boolean) ?? ''
  return {
    sourceId: '',
    ids: { doi, pmid, pmcid, arxivId: arxivVersionId?.replace(/v\d+$/u, '') ?? '' },
    title: title.replace(/\s+/gu, ' '),
    authors: (fields.get('AU')?.filter(Boolean).length ? fields.get('AU')! : fields.get('A1') ?? [])
      .map((author) => author.replace(/\s+/gu, ' ').trim()).filter(Boolean),
    year: year ? Number(year) : null,
    venue: first(fields, ...venueTags).replace(/\s+/gu, ' '),
    doi, url, abstract: first(fields, 'AB', 'N2'), citedBy: null, openAccess: false, pdfUrl, type,
    ...(arxivVersionId ? { arxivVersionId } : {}),
    ...(date ? { date } : {}),
    ...(volume ? { volume } : {}),
    ...(issue ? { issue } : {}),
    ...(pages ? { pages } : {}),
  }
}
