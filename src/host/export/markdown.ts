/**
 * Markdown 检索报告：检索式组（可复现）、规模漏斗、分组阅读清单、必读路线、
 * 对比差异与研究笔记。结构对齐两份真实产出。
 */

import type { Paper } from '../../search/types.js'
import { compareTasks } from '../tasks/compare.js'
import { sortGroupPapers, stateOf } from '../tasks/states.js'
import type { ExportContext } from './common.js'
import { groupName, isoDate } from './common.js'

const TOP_COMPARE = 30
const TOP_ROUTE = 30

export function renderMarkdown(context: ExportContext): string {
  const { task, papers, base, generatedAt } = context
  const lines: string[] = []

  lines.push(`# ${task.title}`, '')
  lines.push(`- 任务 id：${task.id}`)
  lines.push(`- 检索日期：${isoDate(new Date(task.result.fetchedAt ?? task.createdAt))}`)
  lines.push(`- 报告生成：${isoDate(generatedAt)}`)
  lines.push(`- 数据源：${task.conditions.sources.join('、')}`)
  lines.push(
    `- 规模：原始命中 ${task.stats.rawHits} 条，去重 ${task.stats.deduped} 篇，已加载 ${
      task.result.papers.length
    } 篇`,
  )
  const counts = countStates(context)
  lines.push(
    `- 筛读：纳入 ${counts.included} 篇，排除 ${counts.excluded} 篇，已读 ${counts.read} 篇，未读 ${counts.unread} 篇`,
  )
  if (base !== undefined) {
    const diff = compareTasks(task, base)
    lines.push(
      `- 对比「${base.title}」：新增 ${diff.counts.added} 篇，共有 ${diff.counts.common} 篇，缺失 ${diff.counts.missing} 篇`,
    )
  }
  lines.push('')

  lines.push('## 检索式组（可复现）', '')
  task.conditions.queries.forEach((query, index) => {
    lines.push(`${index + 1}. **${query.name}**：\`${query.text}\` — 原始命中 ${task.stats.perQuery[query.id] ?? 0} 条`)
    const overrides = Object.entries(query.perSource ?? {})
    if (overrides.length > 0) {
      lines.push(`   - 单源覆写：${overrides.map(([source, text]) => `${source}=\`${text}\``).join('；')}`)
    }
  })
  lines.push('')

  lines.push('## 分组阅读清单', '')
  for (const group of task.groups) {
    const items = papers.filter((paper) => stateOf(task, paper.paperId).groupId === group.id)
    lines.push(`### ${group.name}（${items.length} 篇）`, '')
    if (group.description !== undefined && group.description !== '') {
      lines.push(group.description, '')
    }
    if (items.length === 0) {
      lines.push('_（暂无文献）_', '')
    } else {
      lines.push('| # | 文献 | 年份 / 出处 | 为什么读 | 状态 |')
      lines.push('|---:|---|---|---|---|')
      sortGroupPapers(task, items).forEach((paper, index) => {
        lines.push(
          `| ${index + 1} | ${paperLabel(paper)} | ${metaLabel(paper)} | ${cell(
            stateOf(task, paper.paperId).note ?? '',
          )} | ${stateOf(task, paper.paperId).screening} |`,
        )
      })
      lines.push('')
    }
  }

  const ungrouped = papers.filter((paper) => stateOf(task, paper.paperId).groupId === undefined)
  if (ungrouped.length > 0) {
    lines.push(`### 未分组（${ungrouped.length} 篇）`, '')
    lines.push('| # | 文献 | 年份 / 出处 | 为什么读 | 状态 |')
    lines.push('|---:|---|---|---|---|')
    ungrouped.slice(0, 120).forEach((paper, index) => {
      lines.push(
        `| ${index + 1} | ${paperLabel(paper)} | ${metaLabel(paper)} | ${cell(
          stateOf(task, paper.paperId).note ?? '',
        )} | ${stateOf(task, paper.paperId).screening} |`,
      )
    })
    if (ungrouped.length > 120) lines.push('', `_（仅列出前 120 篇，完整清单见 CSV）_`)
    lines.push('')
  }

  const route = papers
    .filter((paper) => stateOf(task, paper.paperId).shortlistOrder !== undefined)
    .sort(
      (a, b) =>
        (stateOf(task, a.paperId).shortlistOrder ?? 0) -
        (stateOf(task, b.paperId).shortlistOrder ?? 0),
    )
    .slice(0, TOP_ROUTE)
  lines.push('## 必读阅读路线', '')
  if (route.length === 0) {
    lines.push('_（尚未标记必读顺序）_', '')
  } else {
    route.forEach((paper, index) => {
      const note = stateOf(task, paper.paperId).note
      lines.push(`${index + 1}. ${paperLabel(paper)}${note === undefined ? '' : ` — ${note}`}`)
    })
    lines.push('')
  }

  lines.push('## 全文获取情况', '')
  const oa = papers.filter((paper) => paper.openAccess).length
  const pdf = papers.filter((paper) => paper.pdfUrl !== '').length
  lines.push(`- 开放获取 ${oa} 篇，PDF 直链 ${pdf} 篇，其余 ${papers.length - oa} 篇需自行获取。`)
  lines.push('')

  if (base !== undefined) {
    const diff = compareTasks(task, base)
    lines.push(`## 与对比任务差异`, '')
    lines.push(
      `基准任务：${base.title}（${diff.counts.baseTotal} 篇）。新增 ${diff.counts.added} 篇，共有 ${diff.counts.common} 篇，缺失 ${diff.counts.missing} 篇。`,
      '',
    )
    diff.added.slice(0, TOP_COMPARE).forEach((paper, index) => {
      lines.push(`${index + 1}. ${paper.title}${paper.year === null ? '' : `（${paper.year}）`}`)
    })
    if (diff.added.length > TOP_COMPARE) {
      lines.push('', `_（仅列出前 ${TOP_COMPARE} 篇新增）_`)
    }
    lines.push('')
  }

  lines.push('## 研究笔记', '')
  lines.push(task.notes.trim() === '' ? '_（暂无）_' : task.notes.trim(), '')

  return lines.join('\n')
}

function countStates(context: ExportContext): {
  unread: number
  read: number
  included: number
  excluded: number
} {
  const counts = { unread: 0, read: 0, included: 0, excluded: 0 }
  for (const paper of context.papers) {
    counts[stateOf(context.task, paper.paperId).screening] += 1
  }
  return counts
}

function paperLabel(paper: Paper): string {
  const text = cell(paper.title)
  return paper.doi === '' ? text : `[${text}](https://doi.org/${paper.doi})`
}

function metaLabel(paper: Paper): string {
  const year = paper.year === null ? '' : String(paper.year)
  return cell([year, paper.venue].filter((part) => part !== '').join(' / '))
}

function cell(value: string): string {
  return value.trim().replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ')
}
