/** BibTeX 导出。 */

import type { ExportContext } from './common.js'
import { groupName } from './common.js'
import { stateOf } from '../tasks/states.js'

export function renderBibtex(context: ExportContext): string {
  return `${context.papers
    .map((paper) => {
      const state = stateOf(context.task, paper.paperId)
      const fields: Array<[string, string]> = []
      fields.push(['title', paper.title])
      if (paper.authors.length > 0) fields.push(['author', paper.authors.join(' and ')])
      if (paper.year !== null) fields.push(['year', String(paper.year)])
      if (paper.venue !== '') fields.push(['journal', paper.venue])
      if (paper.doi !== '') fields.push(['doi', paper.doi])
      if (paper.url !== '') fields.push(['url', paper.url])
      if (paper.abstract !== '') fields.push(['abstract', paper.abstract])
      const group = groupName(context.task, state.groupId)
      if (group !== '') fields.push(['keywords', group])

      const body = fields
        .map(([name, value]) => `  ${name} = {${escapeBibtex(value)}}`)
        .join(',\n')
      return `@article{${paper.paperId},\n${body}\n}`
    })
    .join('\n\n')}\n`
}

function escapeBibtex(value: string): string {
  return value
    .replace(/\\/gu, '\\\\')
    .replace(/[{}]/gu, (match) => `\\${match}`)
    .replace(/[&%$#_]/gu, (match) => `\\${match}`)
    .replace(/~/gu, '\\textasciitilde{}')
    .replace(/\^/gu, '\\textasciicircum{}')
}
