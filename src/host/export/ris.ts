/** RIS 导出（供 Zotero / EndNote 导入）。 */

import type { ExportContext } from './common.js'
import { groupName } from './common.js'
import { stateOf } from '../tasks/states.js'
import { publicationFormat } from '../../search/publication-type.js'

export function renderRis(context: ExportContext): string {
  const blocks = context.papers.map((paper) => {
    const state = stateOf(context.task, paper.paperId)
    const format = publicationFormat(paper.type)
    const lines: string[] = [`TY  - ${format.ris}`]
    push(lines, 'TI', paper.title)
    for (const author of paper.authors) push(lines, 'AU', author)
    if (paper.year !== null) push(lines, 'PY', String(paper.year))
    if (paper.date) push(lines, 'DA', paper.date)
    const venueTag = format.ris === 'JOUR' ? 'JO' : format.ris === 'BOOK' ? 'PB' : 'T2'
    push(lines, venueTag, paper.venue)
    if (paper.type === 'preprint' || format.zotero === 'preprint') push(lines, 'M3', 'Preprint')
    if (paper.volume) push(lines, 'VL', paper.volume)
    if (paper.issue) push(lines, 'IS', paper.issue)
    if (paper.pages) push(lines, 'SP', paper.pages)
    push(lines, 'DO', paper.doi)
    push(lines, 'UR', paper.url || paper.pdfUrl)
    push(lines, 'L1', paper.pdfUrl)
    push(lines, 'AB', paper.abstract)
    push(lines, 'AN', [paper.ids.pmid && `PMID: ${paper.ids.pmid}`, paper.ids.pmcid].filter(Boolean).join(' ') || paper.paperId)
    const group = groupName(context.task, state.groupId)
    if (group !== '') push(lines, 'KW', group)
    if (state.screening !== 'unread') push(lines, 'N1', `screening: ${state.screening}`)
    lines.push('ER  - ')
    return lines.join('\r\n')
  })
  return `${blocks.join('\r\n\r\n')}\r\n`
}

function push(lines: string[], tag: string, value: string): void {
  if (value.trim() === '') return
  lines.push(`${tag}  - ${value.replace(/\r?\n/gu, ' ')}`)
}
