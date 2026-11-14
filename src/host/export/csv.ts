/**
 * 全量筛读台账 CSV。
 *
 * 列顺序与第一版方案一致，后续全文能力只需填 `pdfStatus` / `pdfError`，不改列。
 * 带 UTF-8 BOM，方便 Excel 直接打开中文。
 */

import type { ExportContext } from './common.js'
import { groupName, queryName } from './common.js'
import { pdfStatusOf } from '../tasks/filter.js'
import { stateOf } from '../tasks/states.js'

const COLUMNS = [
  'paperId',
  'title',
  'authors',
  'year',
  'venue',
  'doi',
  'pmid',
  'pmcid',
  'arxivId',
  'sources',
  'matchedQueries',
  'citedBy',
  'openAccess',
  'language',
  'screening',
  'group',
  'pdfStatus',
  'pdfError',
]

export function renderCsv(context: ExportContext): string {
  const { task, papers } = context
  const lines = [COLUMNS.join(',')]
  for (const paper of papers) {
    const state = stateOf(task, paper.paperId)
    lines.push(
      [
        paper.paperId,
        paper.title,
        paper.authors.join('; '),
        paper.year === null ? '' : String(paper.year),
        paper.venue,
        paper.doi,
        paper.ids.pmid,
        paper.ids.pmcid,
        paper.ids.arxivId,
        paper.hitSources.map((hit) => hit.source).join(';'),
        paper.matchedQueries.map((id) => queryName(task, id)).join(';'),
        paper.citedBy === null ? '' : String(paper.citedBy),
        paper.openAccess ? '1' : '0',
        paper.language ?? '',
        state.screening,
        groupName(task, state.groupId),
        pdfStatusOf(task, paper),
        state.pdfError ?? '',
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

function csvCell(value: string): string {
  if (!/[",\r\n]/u.test(value)) return value
  return `"${value.replace(/"/gu, '""')}"`
}
