/**
 * 插入草稿的文本模板与引用胶囊摘要。
 *
 * 文本带数据源、DOI 与链接，方便模型接着用 `literature_search` 跟进；
 * 摘要只用于输入框里的胶囊展示，发送的消息仍携带完整文本。
 */

import type { QuoteSummary } from '@deepseek-ai/dsh-client-ui-primitives'

import type { Paper, TaskDetail } from '../search/types'
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

/** 单篇文献的胶囊摘要：标题 + 出处一行，悬浮卡展示摘要。 */
export function paperSummary(t: Translate, paper: Paper): QuoteSummary {
  const detail = [t(`source.${paper.source}`), paper.year === null ? '' : String(paper.year), paper.venue]
    .filter((part) => part !== '')
    .join(' · ')
  return {
    label: paper.title,
    title: paper.title,
    detail: detail === '' ? undefined : detail,
    body:
      paper.abstract === ''
        ? paper.doi === ''
          ? paper.url
          : tpl(t('cmp.paper.doi'), { value: paper.doi })
        : truncate(paper.abstract, ABSTRACT_LIMIT),
  }
}

/** 批量文献的胶囊摘要：标签给篇数，悬浮卡列出前几篇标题。 */
export function papersSummary(t: Translate, papers: readonly Paper[]): QuoteSummary {
  const label = tpl(t('cmp.papers.quoteLabel'), { n: papers.length })
  return {
    label,
    title: label,
    detail: papers
      .slice(0, 3)
      .map((paper) => paper.title)
      .join(' · '),
    body: papers.map((paper, index) => `${index + 1}. ${paper.title}`).join('\n'),
  }
}

/**
 * 把任务带到会话：写入任务 id 与当前条件，让新会话能明确续接同一任务。
 *
 * 模型侧只要收到带 taskId 的指令就不会新建任务，因此这里把「不要新建」和
 * 续接方式都写清楚。
 */
export function taskText(t: Translate, detail: TaskDetail): string {
  const queries = detail.conditions.queries
    .filter((query) => query.enabled && query.text.trim() !== '')
    .map((query) => `- ${query.name}: ${query.text}`)
  const lines = [
    t('cmp.task.header'),
    tpl(t('cmp.task.id'), { value: detail.id }),
    tpl(t('cmp.task.title'), { value: detail.title }),
    tpl(t('cmp.task.rounds'), {
      n: detail.roundCount ?? 0,
      loaded: detail.result.totalLoaded,
    }),
  ]
  if (queries.length > 0) lines.push(t('cmp.task.queries'), ...queries)
  lines.push(taskConditionsText(t, detail))
  lines.push('', tpl(t('cmp.task.continue'), { id: detail.id }))
  return lines.join('\n')
}

/** 任务的胶囊摘要：标题 + 轮次，悬浮卡展示检索条件。 */
export function taskSummary(t: Translate, detail: TaskDetail): QuoteSummary {
  return {
    label: detail.title,
    title: detail.title,
    detail: tpl(t('cmp.task.rounds'), {
      n: detail.roundCount ?? 0,
      loaded: detail.result.totalLoaded,
    }),
    body: taskConditionsText(t, detail),
  }
}

function taskConditionsText(t: Translate, detail: TaskDetail): string {
  const conditions = detail.conditions
  return tpl(t('cmp.task.conditions'), {
    sources: conditions.sources.map((id) => t(`source.${id}`)).join('、'),
    pageSize: conditions.pageSize,
    years: `${conditions.yearFrom ?? t('filter.any')}-${conditions.yearTo ?? t('filter.any')}`,
    access: conditions.openAccessOnly ? t('filter.openAccess') : t('cmp.task.anyAccess'),
    language: t(`lang.${conditions.language}`),
    sort: t(`sort.${conditions.sort}`),
  })
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}
