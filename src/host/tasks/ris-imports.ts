import { isDeepStrictEqual } from 'node:util'

import { identityKey, makePaperId, PAPER_ID_FIELDS } from '../../search/identity.js'
import type { Paper, PaperMetadata, RisImportBatch, RisImportMetadata, SearchTask } from '../../search/types.js'
import type { ParsedRis } from './ris-parser.js'
import { countScreening } from './states.js'

function keys(paper: PaperMetadata): string[] {
  const strong = PAPER_ID_FIELDS.flatMap((field) => paper.ids[field] ? [field + ':' + paper.ids[field]] : [])
  const fallback = identityKey(paper)
  return strong.length ? strong : fallback.startsWith('title:') ? [fallback] : []
}

function compatible(a: Paper, b: PaperMetadata & Pick<Paper, 'source'>): boolean {
  if (a.arxivVersionId && b.arxivVersionId && a.arxivVersionId !== b.arxivVersionId) return false
  const aPreprint = a.source === 'arxiv' || /preprint|posted-content/iu.test(a.type)
  const bPreprint = b.source === 'arxiv' || /preprint|posted-content/iu.test(b.type)
  const published = (type: string) => /journal.article|proceedings.article/iu.test(type)
  if ((aPreprint && published(b.type)) || (bPreprint && published(a.type))) return false
  return PAPER_ID_FIELDS.every((field) => !a.ids[field] || !b.ids[field] || a.ids[field] === b.ids[field])
}

export function sameRisIdentity(a: Paper, b: PaperMetadata & Pick<Paper, 'source'>): boolean {
  const lookingFor = keys(b)
  return keys(a).some((key) => lookingFor.includes(key)) && compatible(a, b)
}

class PaperIndex {
  private readonly papersByKey = new Map<string, Set<string>>()
  private readonly papers: Map<string, Paper>

  constructor(papers: Map<string, Paper>) {
    this.papers = papers
    for (const paper of papers.values()) this.index(paper)
  }

  set(paper: Paper): void {
    this.papers.set(paper.paperId, paper)
    this.index(paper)
  }

  matches(metadata: PaperMetadata & Pick<Paper, 'source'>): Paper[] {
    const lookingFor = keys(metadata)
    const candidates = new Set(lookingFor.flatMap((key) => [...(this.papersByKey.get(key) ?? [])]))
    return [...candidates].map((id) => this.papers.get(id)!).filter((paper) =>
      keys(paper).some((key) => lookingFor.includes(key)) && compatible(paper, metadata),
    )
  }

  private index(paper: Paper): void {
    for (const key of keys(paper)) {
      const ids = this.papersByKey.get(key) ?? new Set<string>()
      ids.add(paper.paperId)
      this.papersByKey.set(key, ids)
    }
  }
}

function makeImportedPaper(paperId: string, metadata: PaperMetadata): Paper {
  return { ...metadata, paperId, matchedQueries: [], hitSources: [] }
}

function fillMissing(paper: Paper, metadata: PaperMetadata): Paper {
  return {
    ...paper,
    ids: {
      doi: paper.ids.doi || metadata.ids.doi,
      pmid: paper.ids.pmid || metadata.ids.pmid,
      pmcid: paper.ids.pmcid || metadata.ids.pmcid,
      arxivId: paper.ids.arxivId || metadata.ids.arxivId,
    },
    doi: paper.doi || metadata.doi,
    authors: paper.authors.length ? paper.authors : metadata.authors,
    venue: paper.venue || metadata.venue,
    url: paper.url || metadata.url,
    abstract: paper.abstract || metadata.abstract,
    pdfUrl: paper.pdfUrl || metadata.pdfUrl,
    year: paper.year ?? metadata.year,
    type: paper.type || metadata.type,
    ...(paper.date === undefined && metadata.date !== undefined ? { date: metadata.date } : {}),
    ...(paper.volume === undefined && metadata.volume !== undefined ? { volume: metadata.volume } : {}),
    ...(paper.issue === undefined && metadata.issue !== undefined ? { issue: metadata.issue } : {}),
    ...(paper.pages === undefined && metadata.pages !== undefined ? { pages: metadata.pages } : {}),
    ...(paper.arxivVersionId === undefined && metadata.arxivVersionId !== undefined ? { arxivVersionId: metadata.arxivVersionId } : {}),
  }
}

export function planRisImport(
  task: SearchTask,
  parsed: ParsedRis,
  metadata: RisImportMetadata,
  importedAt: string,
  historicalPapers: readonly Paper[],
): RisImportBatch {
  const index = new PaperIndex(new Map(task.result.papers.map((paper) => [paper.paperId, paper])))
  const history = new PaperIndex(new Map(historicalPapers.map((paper) => [paper.paperId, paper])))
  let added = 0
  const rows = parsed.rows.map((row) => {
    const matches = index.matches(row.metadata)
    const known = matches.length === 1 ? matches[0] : undefined
    const older = matches.length === 0 ? history.matches(row.metadata) : []
    const paperId = known?.paperId ?? (older.length === 1 ? older[0].paperId : makePaperId('ris:' + parsed.fingerprint + ':' + row.line))
    if (!known) added += 1
    index.set(known ? fillMissing(known, row.metadata) : makeImportedPaper(paperId, row.metadata))
    return { ...row, paperId }
  })
  return {
    ...metadata,
    id: parsed.fingerprint,
    importedAt,
    total: rows.length + parsed.issues.length,
    added,
    matched: rows.length - added,
    failed: parsed.issues.length,
    rows,
    issues: parsed.issues,
  }
}

export function applyRisImports(task: SearchTask, roundPapers = task.result.roundPapers ?? task.result.papers): void {
  if (!task.risImports?.length) return
  const imported = new Map<string, Paper>()
  for (const batch of task.risImports) {
    for (const row of batch.rows) {
      const prior = imported.get(row.paperId)
      const paper = prior ? fillMissing(prior, row.metadata) : makeImportedPaper(row.paperId, row.metadata)
      paper.risBatchIds = [...new Set([...(paper.risBatchIds ?? []), batch.id])]
      imported.set(row.paperId, paper)
    }
  }

  const index = new PaperIndex(imported)
  const paired = new Map<string, Paper>()
  const ambiguous = new Set<string>()
  const roundIds = new Set(roundPapers.map((paper) => paper.paperId))
  for (const online of roundPapers) {
    const exact = imported.get(online.paperId)
    const matches = exact ? [exact] : index.matches(online).filter((paper) => !roundIds.has(paper.paperId))
    if (matches.length !== 1) continue
    const match = matches[0]
    if (paired.has(match.paperId)) ambiguous.add(match.paperId)
    else paired.set(match.paperId, online)
  }
  const onlineById = new Map<string, Paper>()
  const aliases: Record<string, string> = {}
  for (const [id, online] of paired) {
    const onlineState = task.states[online.paperId]
    const importedState = task.states[id]
    const exact = id === online.paperId
    if (!exact && (ambiguous.has(id) || (onlineState && importedState && !isDeepStrictEqual(onlineState, importedState)))) continue
    const entry = imported.get(id)!
    onlineById.set(online.paperId, { ...fillMissing(online, entry), paperId: id, risBatchIds: entry.risBatchIds })
    imported.delete(id)
    if (!exact) {
      aliases[online.paperId] = id
      if (onlineState && !importedState) task.states[id] = onlineState
    }
  }
  task.result.roundPapers = roundPapers
  task.result.risAliases = aliases
  task.result.papers = [...roundPapers.map((paper) => onlineById.get(paper.paperId) ?? paper), ...imported.values()]
  task.stats.screening = countScreening(task.result.papers, task.states)
}

export function risBatchSummary({ rows: _rows, issues: _issues, ...summary }: RisImportBatch) {
  return summary
}
