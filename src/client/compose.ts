/**
 * 插入草稿的文本模板。
 *
 * 文本带数据源、DOI 与链接，方便模型接着用 `literature_search` 跟进。
 */

import type { Paper } from '../search/types'
import { tpl, type Translate } from './locales'

/** 插入时摘要最多保留多少字符，避免草稿过长。 */
const ABSTRACT_LIMIT = 800

export function paperText(t: Translate, paper: Paper): string {
  const lines = [
    tpl(t('cmp.paper.header'), {
      source: t(`source.${paper.source}`),
      title: paper.title,
    }),
  ]

  if (paper.authors.length > 0) {
    lines.push(tpl(t('cmp.paper.authors'), { value: paper.authors.slice(0, 8).join(', ') }))
  }
  if (paper.year !== null) lines.push(tpl(t('cmp.paper.year'), { value: String(paper.year) }))
  if (paper.venue !== '') lines.push(tpl(t('cmp.paper.venue'), { value: paper.venue }))
  if (paper.doi !== '') lines.push(tpl(t('cmp.paper.doi'), { value: paper.doi }))
  if (paper.url !== '') lines.push(tpl(t('cmp.paper.url'), { value: paper.url }))
  if (paper.pdfUrl !== '') lines.push(tpl(t('cmp.paper.pdf'), { value: paper.pdfUrl }))
  if (paper.abstract !== '') {
    lines.push(tpl(t('cmp.paper.abstract'), { value: truncate(paper.abstract, ABSTRACT_LIMIT) }))
  }
  return lines.join('\n')
}

/** 批量插入：一次捕获后按编号拼接，避免多篇文本重复占用草稿。 */
export function papersText(t: Translate, papers: readonly Paper[]): string {
  return papers.map((paper, index) => `${index + 1}. ${paperText(t, paper)}`).join('\n\n')
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}
