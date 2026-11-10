/**
 * 模型侧工具：直接注册进 dsh 工具表（不经过外部 MCP）。
 *
 * - `literature_search`：创建并执行一个检索任务（origin=model），等待最多
 *   25 秒后把任务头部与前若干条结果交给模型；任务本身持久化，右侧栏可继续看。
 * - `literature_sources`：列出已接入的数据源与能力，便于模型决定后续策略。
 *
 * 参数在边界做一次校验（模型输出不可信），服务层仍会再兜底。
 */

import { MAX_LIMIT } from '../search/config.js'
import { asRecord } from '../search/normalize.js'
import { PROVIDER_INFOS } from '../search/providers/index.js'
import type {
  ResultsPage,
  SortMode,
  SourceId,
  TaskDetail,
  TaskLanguage,
} from '../search/types.js'
import { SOURCE_IDS } from '../search/types.js'
import type { QueryInput, TaskService } from './tasks/service.js'

/** 模型侧最多等多久；超时后任务继续跑，只返回当前进度与已有结果。 */
const MODEL_WAIT_MS = 25_000

/** 交给模型的条数（UI 走分页端点，不受此限制）。 */
const TOOL_PAPER_LIMIT = 10

const SORT_MODES: readonly SortMode[] = ['relevance', 'citations', 'year']
const LANGUAGES: readonly TaskLanguage[] = ['any', 'eng', 'chi']

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
      description: '单条检索关键词，支持英文或中文；英文主题词召回更好。与 queries 至少给一个。',
    },
    queries: {
      type: 'array',
      maxItems: 20,
      description:
        '多条具名检索式：一次跑完、跨式去重，适合把主题拆成同义词/子问题。提供时忽略 query。',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '检索式文本。' },
          name: { type: 'string', description: '检索式名称，用于进度与贡献统计。' },
          enabled: { type: 'boolean', description: '是否启用，默认 true。' },
          perSource: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: '按数据源覆写检索式语法（key 为数据源 id）。',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    types: {
      type: 'array',
      maxItems: 20,
      items: { type: 'string' },
      description: '文献类型过滤（如 journal-article、review、preprint），精确匹配。',
    },
    sources: {
      type: 'array',
      items: { type: 'string', enum: [...SOURCE_IDS] },
      description: `要查询的数据源：${SOURCE_IDS.join(', ')}；省略表示全部。`,
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `每个来源取多少条，默认由插件配置决定，最大 ${MAX_LIMIT}。`,
    },
    yearFrom: { type: 'integer', minimum: 1, description: '起始出版年份（含）。' },
    yearTo: { type: 'integer', minimum: 1, description: '结束出版年份（含）。' },
    openAccessOnly: {
      type: 'boolean',
      description: '只返回开放获取文献。',
    },
    language: {
      type: 'string',
      enum: [...LANGUAGES],
      description: '语言筛选：any 不限、eng 英文、chi 中文。',
    },
    sort: {
      type: 'string',
      enum: [...SORT_MODES],
      description: '排序：relevance 相关度、citations 被引次数、year 出版年份。',
    },
  },
  additionalProperties: false,
}

interface SearchArgs {
  query: string
  queries?: QueryInput[]
  types?: string[]
  sources?: SourceId[]
  pageSize?: number
  yearFrom?: number
  yearTo?: number
  openAccessOnly?: boolean
  language?: TaskLanguage
  sort?: SortMode
}

/** 构造本插件注册的全部工具（每次注册都新造定义，便于整体替换）。 */
export function literatureTools(service: TaskService): ToolDefinition[] {
  return [
    {
      name: 'literature_search',
      description:
        '检索免费开放学术文献。并发查询 PubMed、Europe PMC、OpenAlex、Crossref、Semantic Scholar、arXiv、PubTator，跨源与跨检索式去重合并成一篇文献一条，返回标题、作者、年份、出处、DOI、被引次数、开放获取状态与摘要。支持一次提交多条检索式（queries）。每次检索会保存为可继续查看的任务（右侧栏「文献检索」），超过 25 秒仍在进行时会先返回当前进度。适合找论文、查某主题的代表作、补充参考文献。',
      parameters: SEARCH_PARAMETERS,
      output: TEXT_OUTPUT,
      async execute(args, exec): Promise<{ text: string }> {
        const input = readSearchArgs(args)
        const task = await service.create({ ...input, origin: 'model', runNow: false })
        const outcome = await runWithin(service, task.id, exec.signal)
        const detail = await service.getDetail(task.id)
        const page = await service.results(task.id, { limit: TOOL_PAPER_LIMIT })
        return { text: formatTaskResult(detail, page, outcome) }
      },
    },
    {
      name: 'literature_sources',
      description:
        '列出本插件已接入的免费文献数据源：能力（摘要、被引次数、开放获取、PDF 链接）、限流额度、检索式语法与是否需要可选 API Key。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT,
      async execute(): Promise<{ text: string }> {
        return { text: formatSources() }
      },
    },
  ]
}

/** 把模型给的参数收窄成建任务输入；非法输入抛错给模型看。 */
function readSearchArgs(args: unknown): SearchArgs {
  const record = asRecord(args)

  const queryRaw = record['query']
  if (queryRaw !== undefined && typeof queryRaw !== 'string') {
    throw new Error('query 必须是字符串')
  }
  const query = typeof queryRaw === 'string' ? queryRaw.trim() : ''
  const queries = readQueries(record['queries'])
  if (query === '' && queries === undefined) {
    throw new Error('query 与 queries 至少提供一项')
  }

  const input: SearchArgs = { query }
  if (queries !== undefined) input.queries = queries

  const types = readTypes(record['types'])
  if (types !== undefined) input.types = types

  const sourcesRaw = record['sources']
  if (sourcesRaw !== undefined) {
    if (!Array.isArray(sourcesRaw) || !sourcesRaw.every((item) => typeof item === 'string')) {
      throw new Error('sources 必须是字符串数组')
    }
    const invalid = sourcesRaw.filter((item) => !(SOURCE_IDS as readonly string[]).includes(item))
    if (invalid.length > 0) {
      throw new Error(`未知数据源：${invalid.join(', ')}；可选 ${SOURCE_IDS.join(', ')}`)
    }
    input.sources = sourcesRaw as SourceId[]
  }

  const limit = readInteger(record['limit'], 'limit', MAX_LIMIT)
  if (limit !== undefined) input.pageSize = limit
  const yearFrom = readInteger(record['yearFrom'], 'yearFrom')
  if (yearFrom !== undefined) input.yearFrom = yearFrom
  const yearTo = readInteger(record['yearTo'], 'yearTo')
  if (yearTo !== undefined) input.yearTo = yearTo
  if (record['openAccessOnly'] === true) input.openAccessOnly = true

  const language = record['language']
  if (language !== undefined) {
    if (typeof language !== 'string' || !(LANGUAGES as readonly string[]).includes(language)) {
      throw new Error(`language 只能是 ${LANGUAGES.join(' / ')}`)
    }
    input.language = language as TaskLanguage
  }
  const sort = record['sort']
  if (sort !== undefined) {
    if (typeof sort !== 'string' || !(SORT_MODES as readonly string[]).includes(sort)) {
      throw new Error(`sort 只能是 ${SORT_MODES.join(' / ')}`)
    }
    input.sort = sort as SortMode
  }

  return input
}

function readQueries(value: unknown): QueryInput[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('queries 必须是非空数组')
  }
  if (value.length > 20) throw new Error('queries 最多 20 条')
  return value.map((entry, index) => {
    const record = asRecord(entry)
    const text = record['text']
    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error(`第 ${index + 1} 条检索式缺少 text`)
    }
    const input: QueryInput = { text: text.trim() }
    const name = record['name']
    if (typeof name === 'string' && name.trim() !== '') input.name = name.trim().slice(0, 80)
    if (record['enabled'] !== undefined) {
      if (typeof record['enabled'] !== 'boolean') throw new Error('enabled 必须是布尔值')
      input.enabled = record['enabled']
    }
    const perSource = record['perSource']
    if (perSource !== undefined && perSource !== null) {
      const overrides: Partial<Record<SourceId, string>> = {}
      for (const [key, raw] of Object.entries(asRecord(perSource))) {
        if (!(SOURCE_IDS as readonly string[]).includes(key)) {
          throw new Error(`未知数据源：${key}；可选 ${SOURCE_IDS.join(', ')}`)
        }
        if (typeof raw !== 'string') throw new Error(`perSource.${key} 必须是字符串`)
        overrides[key as SourceId] = raw
      }
      input.perSource = overrides
    }
    return input
  })
}

function readTypes(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error('types 必须是字符串数组')
  }
  const types = value
    .map((item) => item.trim().slice(0, 40))
    .filter((item) => item !== '')
    .slice(0, 20)
  return types.length === 0 ? undefined : types
}

function readInteger(value: unknown, name: string, max?: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`)
  }
  if (max !== undefined && value > max) throw new Error(`${name} 不能超过 ${max}`)
  return value
}

/**
 * 启动任务并等待，最多 {@link MODEL_WAIT_MS}。
 *
 * 超时不取消任务：模型先拿到当前结果，右侧栏继续跑完。调用方中止则取消任务。
 */
async function runWithin(
  service: TaskService,
  id: string,
  signal: AbortSignal | undefined,
): Promise<'done' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), MODEL_WAIT_MS)
  })

  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal === undefined) return
    onAbort = (): void => {
      void service.cancel(id).catch(() => undefined)
      reject(new Error('检索调用被中断'))
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    return await Promise.race([service.run(id).then(() => 'done' as const), timeout, aborted])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

function formatSources(): string {
  const lines = ['已接入的免费文献数据源（无需付费；部分支持可选 Key 提高额度）：']
  for (const info of PROVIDER_INFOS) {
    const caps = [
      info.capabilities.abstract ? '摘要' : '',
      info.capabilities.citationCount ? '被引' : '',
      info.capabilities.openAccess ? '开放获取' : '',
      info.capabilities.pdf ? 'PDF' : '',
    ].filter((cap) => cap !== '')
    lines.push(`- ${info.id}（${info.label}）：${caps.join('、') || '仅题录'}`)
    lines.push(`  限流：${info.rateLimit}｜语法：${info.syntax}｜${info.optionalKey ? '可选 Key' : '无需 Key'}`)
    lines.push(`  首页：${info.homepage}`)
  }
  return lines.join('\n')
}

function formatTaskResult(
  detail: TaskDetail,
  page: ResultsPage,
  outcome: 'done' | 'timeout',
): string {
  const lines = [`任务：${detail.title}（id: ${detail.id}）`]

  if (outcome === 'timeout') {
    const progress = detail.progress
    const position =
      progress === undefined ? '' : `（检索式 ${progress.queryIndex}/${progress.queryTotal}）`
    lines.push(`状态：仍在检索中${position}，已先返回当前结果；任务会继续在右侧栏完成。`)
  } else {
    lines.push(`状态：${statusLabel(detail.status)}`)
    if (detail.error !== undefined) lines.push(`失败原因：${detail.error}`)
  }

  const okSources = detail.result.sources
    .filter((source) => source.ok)
    .map((source) => `${source.id} ${source.count} 条`)
    .join('，')
  const failed = detail.result.sources.filter((source) => !source.ok)
  lines.push(
    `命中：原始 ${detail.stats.rawHits} 条，去重后 ${detail.stats.deduped} 条，已加载 ${detail.result.totalLoaded} 篇${
      okSources === '' ? '' : `（${okSources}）`
    }`,
  )
  if (detail.conditions.queries.length > 1) {
    const contributions = detail.conditions.queries
      .map((query) => `${query.name} ${detail.stats.perQuery[query.id] ?? 0} 条`)
      .join('；')
    lines.push(`检索式原始命中：${contributions}`)
  }
  if (failed.length > 0) {
    lines.push(
      `失败的数据源：${failed
        .map((source) => `${source.id}（${source.error ?? '未知错误'}）`)
        .join('；')}`,
    )
  }

  if (detail.result.totalLoaded === 0) {
    if (outcome === 'timeout') {
      lines.push('当前还没有拿到结果；可在右侧栏查看任务进度，或稍后重跑。')
    } else {
      lines.push('没有检索到匹配文献。可尝试更短的关键词、英文主题词，或放宽年份与开放获取限制。')
    }
    return lines.join('\n')
  }

  page.papers.forEach((paper, index) => {
    lines.push('')
    lines.push(`${index + 1}. ${paper.title}`)
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
      `来源: ${paper.hitSources.map((hit) => hit.source).join('/')}`,
    ].filter((part) => part !== '')
    if (facts.length > 0) lines.push(`   ${facts.join(' | ')}`)
    if (paper.pdfUrl !== '') lines.push(`   PDF: ${paper.pdfUrl}`)
    else if (paper.url !== '') lines.push(`   链接: ${paper.url}`)
    if (paper.abstract !== '') lines.push(`   摘要: ${truncate(paper.abstract, 500)}`)
  })

  if (page.total > page.papers.length) {
    lines.push('', `仅列出前 ${page.papers.length} 篇；完整 ${page.total} 篇可在右侧栏任务里分页查看。`)
  }
  lines.push('', '提示：可用 DOI 或标题继续追问；需要全文时优先使用开放获取 PDF 链接。')
  return lines.join('\n')
}

function statusLabel(status: TaskDetail['status']): string {
  switch (status) {
    case 'draft':
      return '草稿'
    case 'queued':
      return '排队中'
    case 'running':
      return '进行中'
    case 'done':
      return '完成'
    case 'partial':
      return '部分完成（有数据源失败）'
    case 'canceled':
      return '已取消'
    default:
      return '失败'
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}
