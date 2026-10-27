/**
 * 模型侧工具：直接注册进 dsh 工具表（不经过外部 MCP）。
 *
 * - `literature_search`：多源检索，返回模型可读的排序文本。
 * - `literature_sources`：列出已接入的数据源与能力，便于模型决定后续策略。
 *
 * 参数在边界做一次校验（模型输出不可信），检索层仍会再兜底。
 */

import { MAX_LIMIT } from '../search/config.js'
import { asRecord } from '../search/normalize.js'
import { PROVIDER_INFOS } from '../search/providers/index.js'
import { searchLiterature } from '../search/aggregate.js'
import type { SearchOptions, SearchResult, SourceId } from '../search/types.js'
import { SOURCE_IDS } from '../search/types.js'

/** `ctx.tools` 的最小结构接口（真实类型由 dsh 装配，不在本包类型面内）。 */
export interface ToolsService {
  register(definition: unknown): () => void
}

interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: { text: string }) => Array<{ type: 'text'; text: string }>
  }
  execute: (args: unknown, exec: { signal?: AbortSignal }) => Promise<{ text: string }>
}

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  render: (_args: unknown, value: { text: string }): Array<{ type: 'text'; text: string }> => [
    { type: 'text', text: value.text },
  ],
}

const SEARCH_PARAMETERS = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: '检索关键词，支持英文或中文；英文主题词召回更好。',
    },
    sources: {
      type: 'array',
      items: { type: 'string', enum: [...SOURCE_IDS] },
      description: '要查询的数据源；省略表示全部。',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `返回条数，默认由插件配置决定，最大 ${MAX_LIMIT}。`,
    },
    yearFrom: { type: 'integer', minimum: 1, description: '起始出版年份（含）。' },
    yearTo: { type: 'integer', minimum: 1, description: '结束出版年份（含）。' },
    openAccessOnly: {
      type: 'boolean',
      description: '只返回开放获取文献。',
    },
  },
  required: ['query'],
  additionalProperties: false,
}

/** 构造本插件注册的全部工具（每次注册都新造定义，便于整体替换）。 */
export function literatureTools(): ToolDefinition[] {
  return [
    {
      name: 'literature_search',
      description:
        '检索免费开放学术文献。并发查询 OpenAlex、Crossref 并合并去重，返回标题、作者、年份、出处、DOI、被引次数、开放获取状态与摘要。适合找论文、查某主题的代表作、补充参考文献。',
      parameters: SEARCH_PARAMETERS,
      output: TEXT_OUTPUT,
      async execute(args, exec): Promise<{ text: string }> {
        const result = await searchLiterature(readSearchOptions(args, exec.signal))
        return { text: formatSearchResult(result) }
      },
    },
    {
      name: 'literature_sources',
      description: '列出本插件已接入的免费文献数据源及其能力（摘要、被引次数、开放获取、PDF 链接）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT,
      async execute(): Promise<{ text: string }> {
        return { text: formatSources() }
      },
    },
  ]
}

/** 把模型给的参数收窄成 {@link SearchOptions}；非法输入抛错给模型看。 */
function readSearchOptions(args: unknown, signal: AbortSignal | undefined): SearchOptions {
  const record = asRecord(args)

  const query = record['query']
  if (typeof query !== 'string' || query.trim() === '') {
    throw new Error('query 必须是非空字符串')
  }

  const sourcesRaw = record['sources']
  let sources: SourceId[] | undefined
  if (sourcesRaw !== undefined) {
    if (!Array.isArray(sourcesRaw) || !sourcesRaw.every((item) => typeof item === 'string')) {
      throw new Error('sources 必须是字符串数组')
    }
    const invalid = sourcesRaw.filter((item) => !(SOURCE_IDS as readonly string[]).includes(item))
    if (invalid.length > 0) {
      throw new Error(`未知数据源：${invalid.join(', ')}；可选 ${SOURCE_IDS.join(', ')}`)
    }
    sources = sourcesRaw as SourceId[]
  }

  return {
    query,
    sources,
    limit: readInteger(record['limit'], 'limit'),
    yearFrom: readInteger(record['yearFrom'], 'yearFrom'),
    yearTo: readInteger(record['yearTo'], 'yearTo'),
    openAccessOnly: record['openAccessOnly'] === true,
    signal,
  }
}

function readInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`)
  }
  return value
}

function formatSources(): string {
  const lines = ['已接入的免费文献数据源（无需 API Key）：']
  for (const info of PROVIDER_INFOS) {
    const caps = [
      info.capabilities.abstract ? '摘要' : '',
      info.capabilities.citationCount ? '被引' : '',
      info.capabilities.openAccess ? '开放获取' : '',
      info.capabilities.pdf ? 'PDF' : '',
    ].filter((cap) => cap !== '')
    lines.push(`- ${info.id}（${info.label}）：${caps.join('、')}｜${info.homepage}`)
  }
  return lines.join('\n')
}

function formatSearchResult(result: SearchResult): string {
  const okSources = result.sources
    .filter((source) => source.ok)
    .map((source) => `${source.id} ${source.count} 篇`)
    .join('，')
  const failed = result.sources.filter((source) => !source.ok)

  const lines = [
    `检索词「${result.query}」，返回 ${result.papers.length} 篇${okSources === '' ? '' : `（${okSources}）`}`,
  ]
  if (failed.length > 0) {
    lines.push(
      `失败的数据源：${failed.map((source) => `${source.id}（${source.error ?? '未知错误'}）`).join('；')}`,
    )
  }
  if (result.papers.length === 0) {
    lines.push('没有检索到匹配文献。可尝试更短的关键词、英文主题词，或放宽年份与开放获取限制。')
    return lines.join('\n')
  }

  result.papers.forEach((paper, index) => {
    lines.push('')
    lines.push(`${index + 1}. [${paper.source}] ${paper.title}`)
    const meta = [
      paper.authors.slice(0, 6).join(', '),
      paper.year === null ? '' : String(paper.year),
      paper.venue,
    ]
      .filter((part) => part !== '')
      .join(' | ')
    if (meta !== '') lines.push(`   ${meta}`)
    const facts = [
      paper.doi === '' ? '' : `DOI: ${paper.doi}`,
      paper.citedBy === null ? '' : `被引 ${paper.citedBy}`,
      paper.openAccess ? '开放获取' : '',
    ].filter((part) => part !== '')
    if (facts.length > 0) lines.push(`   ${facts.join(' | ')}`)
    if (paper.pdfUrl !== '') lines.push(`   PDF: ${paper.pdfUrl}`)
    else if (paper.url !== '') lines.push(`   链接: ${paper.url}`)
    if (paper.abstract !== '') lines.push(`   摘要: ${truncate(paper.abstract, 700)}`)
  })

  lines.push('', '提示：可用 DOI 或标题继续追问；需要全文时优先使用开放获取 PDF 链接。')
  return lines.join('\n')
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}
