/** RIS 导出（供 Zotero / EndNote 导入）。 */

import type { ExportContext } from './common.js'
import { groupName, paperNote } from './common.js'
import { stateOf } from '../tasks/states.js'

export function renderRis(context: ExportContext): string {
  const blocks = context.papers.map((paper) => {
    const state = stateOf(context.task, paper.paperId)
    const lines: string[] = ['TY  - JOUR']
    push(lines, 'TI', paper.title)
    for (const author of paper.authors) push(lines, 'AU', author)
    if (paper.year !== null) push(lines, 'PY', String(paper.year))
    push(lines, 'JO', paper.venue)
    push(lines, 'DO', paper.doi)
    push(lines, 'UR', paper.pdfUrl !== '' ? paper.pdfUrl : paper.url)
    push(lines, 'AB', paper.abstract)
    push(lines, 'AN', paper.paperId)
    const group = groupName(context.task, state.groupId)
    if (group !== '') push(lines, 'KW', group)
    push(lines, 'N1', paperNote(context.task, paper))
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
