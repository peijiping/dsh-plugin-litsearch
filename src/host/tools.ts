/**
 * 模型侧工具：直接注册进 dsh 工具表（不经过外部 MCP）。
 *
 * - `literature_search`：创建并执行一个检索任务（origin=model），等待最多
 *   25 秒后把任务头部与前若干条结果交给模型；任务本身持久化，右侧栏可继续看。
 * - `literature_sources`：列出已接入的数据源与能力，便于模型决定后续策略。
 * - `literature_task`：读取/修改已保存任务，写入筛读、分组与备注，做新老对比与统计。
 * - `literature_export`：把任务（按筛选）导出为 CSV / RIS / BibTeX / Markdown 并落盘。
 *
 * 参数在边界做一次校验（模型输出不可信），服务层仍会再兜底。
 */

import { MAX_LIMIT } from '../search/config.js'
import { asRecord } from '../search/normalize.js'
import { PROVIDER_INFOS } from '../search/providers/index.js'
import type {
  AnnotationInput,
  CompareResult,
  ExportFormat,
  PaperState,
  ResultsPage,
  Screening,
  SortMode,
  SourceId,
  TaskDetail,
  TaskGroup,
  TaskLanguage,
  TaskStatsReport,
  TaskSummary,
} from '../search/types.js'
import { SOURCE_IDS } from '../search/types.js'
import type { PaperFilter } from './tasks/filter.js'
import type { QueryInput, TaskPatch, TaskService } from './tasks/service.js'

/** 模型侧最多等多久；超时后任务继续跑，只返回当前进度与已有结果。 */
const MODEL_WAIT_MS = 25_000

/** 交给模型的条数（UI 走分页端点，不受此限制）。 */
const TOOL_PAPER_LIMIT = 10

const SORT_MODES: readonly SortMode[] = ['relevance', 'citations', 'year']
const LANGUAGES: readonly TaskLanguage[] = ['any', 'eng', 'chi']
const SCREENINGS: readonly Screening[] = ['unread', 'read', 'included', 'excluded']
const EXPORT_FORMATS: readonly ExportFormat[] = ['csv', 'ris', 'bibtex', 'md']
const TASK_ACTIONS = [
  'list',
  'get',
  'update',
  'run',
  'annotate',
  'compare',
  'stats',
] as const

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

const TASK_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [...TASK_ACTIONS],
      description:
        'list 列任务；get 读条件与结果；update 改条件/笔记/分组；run 重跑；annotate 写筛读/备注；compare 与旧任务对比；stats 读语料统计。',
    },
    id: { type: 'string', description: '任务 id；除 list 外必填。' },
    withTaskId: { type: 'string', description: 'compare 时的基准任务 id。' },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 200,
      description: 'get / list 返回条数，默认 30。',
    },
    offset: { type: 'integer', minimum: 0, description: '结果分页偏移。' },
    screening: { type: 'string', enum: [...SCREENINGS], description: '按筛读状态过滤。' },
    groupId: { type: 'string', description: '按任务内分组过滤。' },
    queryId: { type: 'string', description: '按检索式 id 过滤命中文献。' },
    q: { type: 'string', description: '标题/摘要关键词。' },
    scope: {
      type: 'string',
      enum: ['task', 'filtered'],
      description: 'stats 的口径：task 全任务、filtered 当前筛选。',
    },
    patch: {
      type: 'object',
      description: 'update 时的修改内容。',
      properties: {
        title: { type: 'string' },
        notes: { type: 'string', description: '任务级研究笔记，覆盖写入。' },
        pinned: { type: 'boolean' },
        groups: {
          type: 'array',
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['id', 'name'],
            additionalProperties: false,
          },
        },
        conditions: {
          type: 'object',
          properties: {
            queries: SEARCH_PARAMETERS.properties.queries,
            sources: SEARCH_PARAMETERS.properties.sources,
            pageSize: SEARCH_PARAMETERS.properties.limit,
            yearFrom: SEARCH_PARAMETERS.properties.yearFrom,
            yearTo: SEARCH_PARAMETERS.properties.yearTo,
            openAccessOnly: SEARCH_PARAMETERS.properties.openAccessOnly,
            language: SEARCH_PARAMETERS.properties.language,
            types: SEARCH_PARAMETERS.properties.types,
            sort: SEARCH_PARAMETERS.properties.sort,
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    papers: {
      type: 'array',
      maxItems: 50,
      description: 'annotate 时的逐篇写入（筛读 / 分组 / 必读顺序 / 备注 / 标签）。',
      items: {
        type: 'object',
        properties: {
          paperId: { type: 'string' },
          screening: { type: 'string', enum: [...SCREENINGS] },
          groupId: { type: ['string', 'null'] },
          shortlistOrder: { type: ['integer', 'null'] },
          note: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['paperId'],
        additionalProperties: false,
      },
    },
  },
  required: ['action'],
  additionalProperties: false,
}

const EXPORT_PARAMETERS = {
  type: 'object',
  properties: {
    taskId: { type: 'string', description: '要导出的任务 id。' },
    format: {
      type: 'string',
      enum: [...EXPORT_FORMATS],
      description: 'csv 全量台账；ris / bibtex 供文献管理器；md 为分层检索报告。',
    },
    paperIds: {
      type: 'array',
      maxItems: 1500,
      items: { type: 'string' },
      description: '只导出指定论文；省略则按筛选导出。',
    },
    screening: { type: 'string', enum: [...SCREENINGS] },
    groupId: { type: 'string' },
    queryId: { type: 'string' },
  },
  required: ['taskId', 'format'],
  additionalProperties: false,
}

interface TaskArgs {
  action: (typeof TASK_ACTIONS)[number]
  id?: string
  withTaskId?: string
  limit?: number
  offset?: number
  screening?: Screening
  groupId?: string
  queryId?: string
  q?: string
  scope?: 'task' | 'filtered'
  patch?: TaskPatch
  papers?: AnnotationInput[]
}

interface ExportArgs {
  taskId: string
  format: ExportFormat
  paperIds?: string[]
  screening?: Screening
  groupId?: string
  queryId?: string
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
    {
      name: 'literature_task',
      description:
        '读取与推进已保存的检索任务。list 列出任务；get 读条件、分组、笔记与结果（可按筛读/分组/检索式/关键词过滤）；update 改标题、条件、任务笔记与分组；run 重跑；annotate 批量写入筛读状态、分组、必读顺序、备注与标签；compare 与旧任务按论文身份对比新增/缺失；stats 读语料统计（年份、来源、期刊、作者、类型、语言）。适合在检索之后做筛选、整理与汇报。',
      parameters: TASK_PARAMETERS,
      output: TEXT_OUTPUT,
      async execute(args, exec): Promise<{ text: string }> {
        return { text: await runTaskAction(service, readTaskArgs(args), exec.signal) }
      },
    },
    {
      name: 'literature_export',
      description:
        '把检索任务导出为文件并返回落盘路径。csv 是全量筛读台账（含命中检索式、筛读状态、分组、备注）；ris / bibtex 供 Zotero、EndNote 等文献管理器；md 是分层检索报告（漏斗、按分组的「为什么读」、必读清单、开放获取与 PDF 覆盖率、对比新增）。可按筛读状态、分组、检索式或指定 paperIds 限定范围。',
      parameters: EXPORT_PARAMETERS,
      output: TEXT_OUTPUT,
      async execute(args): Promise<{ text: string }> {
        return { text: await runExport(service, readExportArgs(args)) }
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

function readTaskArgs(args: unknown): TaskArgs {
  const record = asRecord(args)
  const action = record['action']
  if (typeof action !== 'string' || !(TASK_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`action 只能是 ${TASK_ACTIONS.join(' / ')}`)
  }
  const input: TaskArgs = { action: action as TaskArgs['action'] }

  const id = readText(record['id'], 'id')
  if (id !== undefined) input.id = id
  if (input.action !== 'list' && input.id === undefined) {
    throw new Error(`action=${input.action} 需要 id`)
  }

  const withTaskId = readText(record['withTaskId'], 'withTaskId')
  if (withTaskId !== undefined) input.withTaskId = withTaskId
  if (input.action === 'compare' && input.withTaskId === undefined) {
    throw new Error('compare 需要 withTaskId')
  }

  const limit = readInteger(record['limit'], 'limit', 200)
  if (limit !== undefined) input.limit = limit

  const offset = record['offset']
  if (offset !== undefined) {
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
      throw new Error('offset 必须是非负整数')
    }
    input.offset = offset
  }

  const screening = record['screening']
  if (screening !== undefined) {
    if (typeof screening !== 'string' || !(SCREENINGS as readonly string[]).includes(screening)) {
      throw new Error(`screening 只能是 ${SCREENINGS.join(' / ')}`)
    }
    input.screening = screening as Screening
  }
  const groupId = readText(record['groupId'], 'groupId')
  if (groupId !== undefined) input.groupId = groupId
  const queryId = readText(record['queryId'], 'queryId')
  if (queryId !== undefined) input.queryId = queryId
  const q = readText(record['q'], 'q')
  if (q !== undefined) input.q = q

  const scope = record['scope']
  if (scope !== undefined) {
    if (scope !== 'task' && scope !== 'filtered') {
      throw new Error('scope 只能是 task / filtered')
    }
    input.scope = scope
  }

  if (record['patch'] !== undefined) input.patch = readPatchArgs(record['patch'])
  if (input.action === 'update' && input.patch === undefined) {
    throw new Error('update 需要 patch')
  }

  if (record['papers'] !== undefined) input.papers = readAnnotations(record['papers'])
  if (input.action === 'annotate' && (input.papers === undefined || input.papers.length === 0)) {
    throw new Error('annotate 需要 papers')
  }

  return input
}

function readPatchArgs(value: unknown): TaskPatch {
  const record = asRecord(value)
  const patch: TaskPatch = {}
  const title = readText(record['title'], 'patch.title')
  if (title !== undefined) patch.title = title
  const notes = readText(record['notes'], 'patch.notes', true)
  if (notes !== undefined) patch.notes = notes
  if (record['pinned'] !== undefined) {
    if (typeof record['pinned'] !== 'boolean') throw new Error('patch.pinned 必须是布尔值')
    patch.pinned = record['pinned']
  }
  if (record['groups'] !== undefined) patch.groups = readGroups(record['groups'])

  if (record['conditions'] !== undefined) {
    const conditions = asRecord(record['conditions'])
    const next: NonNullable<TaskPatch['conditions']> = {}
    const queries = readQueries(conditions['queries'])
    if (queries !== undefined) next.queries = queries
    if (conditions['sources'] !== undefined) {
      const sources = conditions['sources']
      if (!Array.isArray(sources) || !sources.every((item) => typeof item === 'string')) {
        throw new Error('conditions.sources 必须是字符串数组')
      }
      const invalid = sources.filter((item) => !(SOURCE_IDS as readonly string[]).includes(item))
      if (invalid.length > 0) {
        throw new Error(`未知数据源：${invalid.join(', ')}；可选 ${SOURCE_IDS.join(', ')}`)
      }
      next.sources = sources as SourceId[]
    }
    const pageSize = readInteger(conditions['pageSize'], 'conditions.pageSize', MAX_LIMIT)
    if (pageSize !== undefined) next.pageSize = pageSize
    const yearFrom = readInteger(conditions['yearFrom'], 'conditions.yearFrom')
    if (yearFrom !== undefined) next.yearFrom = yearFrom
    const yearTo = readInteger(conditions['yearTo'], 'conditions.yearTo')
    if (yearTo !== undefined) next.yearTo = yearTo
    if (conditions['openAccessOnly'] !== undefined) {
      if (typeof conditions['openAccessOnly'] !== 'boolean') {
        throw new Error('conditions.openAccessOnly 必须是布尔值')
      }
      next.openAccessOnly = conditions['openAccessOnly']
    }
    const language = conditions['language']
    if (language !== undefined) {
      if (typeof language !== 'string' || !(LANGUAGES as readonly string[]).includes(language)) {
        throw new Error(`conditions.language 只能是 ${LANGUAGES.join(' / ')}`)
      }
      next.language = language as TaskLanguage
    }
    const types = readTypes(conditions['types'])
    if (types !== undefined) next.types = types
    const sort = conditions['sort']
    if (sort !== undefined) {
      if (typeof sort !== 'string' || !(SORT_MODES as readonly string[]).includes(sort)) {
        throw new Error(`conditions.sort 只能是 ${SORT_MODES.join(' / ')}`)
      }
      next.sort = sort as SortMode
    }
    patch.conditions = next
  }
  return patch
}

function readGroups(value: unknown): TaskGroup[] {
  if (!Array.isArray(value)) throw new Error('patch.groups 必须是数组')
  if (value.length > 50) throw new Error('分组最多 50 个')
  return value.map((entry, index) => {
    const record = asRecord(entry)
    const id = readText(record['id'], `分组 ${index + 1} 的 id`)
    const name = readText(record['name'], `分组 ${index + 1} 的 name`)
    if (id === undefined || name === undefined) throw new Error('分组需要 id 与 name')
    const group: TaskGroup = { id, name, order: index }
    const description = readText(record['description'], `分组 ${index + 1} 的 description`)
    if (description !== undefined) group.description = description
    return group
  })
}

function readAnnotations(value: unknown): AnnotationInput[] {
  if (!Array.isArray(value)) throw new Error('papers 必须是数组')
  if (value.length > 50) throw new Error('papers 最多 50 条')
  return value.map((entry, index) => {
    const record = asRecord(entry)
    const paperId = readText(record['paperId'], `papers[${index}].paperId`)
    if (paperId === undefined) throw new Error(`papers[${index}] 缺少 paperId`)
    const input: AnnotationInput = { paperId }
    const screening = record['screening']
    if (screening !== undefined) {
      if (typeof screening !== 'string' || !(SCREENINGS as readonly string[]).includes(screening)) {
        throw new Error(`papers[${index}].screening 只能是 ${SCREENINGS.join(' / ')}`)
      }
      input.screening = screening as Screening
    }
    if (record['groupId'] !== undefined) {
      const groupId = record['groupId']
      if (groupId !== null && typeof groupId !== 'string') {
        throw new Error(`papers[${index}].groupId 必须是字符串或 null`)
      }
      input.groupId = groupId
    }
    if (record['shortlistOrder'] !== undefined) {
      const order = record['shortlistOrder']
      if (order !== null && (typeof order !== 'number' || !Number.isFinite(order))) {
        throw new Error(`papers[${index}].shortlistOrder 必须是数字或 null`)
      }
      input.shortlistOrder = order
    }
    const note = readText(record['note'], `papers[${index}].note`, true)
    if (note !== undefined) input.note = note
    if (record['tags'] !== undefined) {
      const tags = record['tags']
      if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) {
        throw new Error(`papers[${index}].tags 必须是字符串数组`)
      }
      input.tags = tags
    }
    return input
  })
}

function readExportArgs(args: unknown): ExportArgs {
  const record = asRecord(args)
  const taskId = readText(record['taskId'], 'taskId')
  if (taskId === undefined) throw new Error('缺少 taskId')
  const format = record['format']
  if (typeof format !== 'string' || !(EXPORT_FORMATS as readonly string[]).includes(format)) {
    throw new Error(`format 只能是 ${EXPORT_FORMATS.join(' / ')}`)
  }
  const input: ExportArgs = { taskId, format: format as ExportFormat }
  if (record['paperIds'] !== undefined) {
    const papers = record['paperIds']
    if (!Array.isArray(papers) || !papers.every((item) => typeof item === 'string')) {
      throw new Error('paperIds 必须是字符串数组')
    }
    if (papers.length > 1500) throw new Error('paperIds 最多 1500 条')
    input.paperIds = papers as string[]
  }
  const screening = record['screening']
  if (screening !== undefined) {
    if (typeof screening !== 'string' || !(SCREENINGS as readonly string[]).includes(screening)) {
      throw new Error(`screening 只能是 ${SCREENINGS.join(' / ')}`)
    }
    input.screening = screening as Screening
  }
  const groupId = readText(record['groupId'], 'groupId')
  if (groupId !== undefined) input.groupId = groupId
  const queryId = readText(record['queryId'], 'queryId')
  if (queryId !== undefined) input.queryId = queryId
  return input
}

async function runTaskAction(
  service: TaskService,
  args: TaskArgs,
  signal: AbortSignal | undefined,
): Promise<string> {
  switch (args.action) {
    case 'list': {
      const tasks = await service.list()
      return formatTaskList(tasks, args.limit ?? 30)
    }
    case 'get': {
      const id = requireId(args)
      const task = await service.get(id)
      const detail = await service.getDetail(id)
      const page = await service.results(id, {
        ...readFilterArgs(args),
        limit: args.limit ?? 30,
        offset: args.offset ?? 0,
      })
      return formatTaskDetail(detail, page, task.states, task.groups)
    }
    case 'update': {
      const task = await service.update(requireId(args), args.patch ?? {})
      return `已更新任务「${task.title}」（id: ${task.id}，rev=${task.rev}）。分组 ${
        task.groups.length
      } 个，任务笔记 ${task.notes === '' ? '为空' : `${task.notes.length} 字`}。`
    }
    case 'run': {
      const id = requireId(args)
      const outcome = await runWithin(service, id, signal)
      const task = await service.get(id)
      const detail = await service.getDetail(id)
      const page = await service.results(id, {
        ...readFilterArgs(args),
        limit: args.limit ?? TOOL_PAPER_LIMIT,
        offset: args.offset ?? 0,
      })
      return formatTaskDetail(detail, page, task.states, task.groups, outcome)
    }
    case 'annotate': {
      const result = await service.annotate(requireId(args), args.papers ?? [])
      return `已写入 ${result.updated} 篇的筛读/备注（任务 id: ${result.taskId}，rev=${result.rev}）。`
    }
    case 'compare': {
      const report = await service.compare(requireId(args), args.withTaskId ?? '')
      return formatCompare(report)
    }
    case 'stats': {
      const report = await service.stats(
        requireId(args),
        readFilterArgs(args),
        args.scope ?? 'task',
      )
      return formatStatsReport(report)
    }
    default:
      throw new Error(`未知 action：${String(args.action)}`)
  }
}

async function runExport(service: TaskService, args: ExportArgs): Promise<string> {
  const filter: PaperFilter = {}
  if (args.screening !== undefined) filter.screening = args.screening
  if (args.groupId !== undefined) filter.groupId = args.groupId
  if (args.queryId !== undefined) filter.queryId = args.queryId
  const outcome = await service.exportToDisk(args.taskId, args.format, filter, args.paperIds)
  const preview = truncate(outcome.file.content, 600)
  return [
    `已导出 ${outcome.count} 篇：${outcome.path}`,
    `文件名：${outcome.file.filename}（${outcome.file.mime}）`,
    '',
    '内容开头：',
    preview,
  ].join('\n')
}

function readFilterArgs(args: TaskArgs): PaperFilter {
  const filter: PaperFilter = {}
  if (args.screening !== undefined) filter.screening = args.screening
  if (args.groupId !== undefined) filter.groupId = args.groupId
  if (args.queryId !== undefined) filter.queryId = args.queryId
  if (args.q !== undefined && args.q.trim() !== '') filter.q = args.q.trim()
  return filter
}

function requireId(args: TaskArgs): string {
  if (args.id === undefined || args.id === '') throw new Error('缺少任务 id')
  return args.id
}

function readText(value: unknown, name: string, allowEmpty = false): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${name} 必须是字符串`)
  if (!allowEmpty && value.trim() === '') return undefined
  return allowEmpty ? value : value.trim()
}

function formatTaskList(tasks: readonly TaskSummary[], limit: number): string {
  if (tasks.length === 0) return '还没有保存的检索任务。可先用 literature_search 检索。'
  const lines = [`共 ${tasks.length} 个任务${tasks.length > limit ? `，列出前 ${limit} 个` : ''}：`]
  for (const task of tasks.slice(0, limit)) {
    const screening = task.stats.screening
    lines.push(
      `- ${task.id}｜${task.title}｜${statusLabel(task.status)}｜${task.updatedAt.slice(0, 10)}｜已加载 ${
        task.stats.deduped
      } 篇｜纳入 ${screening.included}、排除 ${screening.excluded}、待读 ${screening.unread}`,
    )
  }
  return lines.join('\n')
}

function formatTaskDetail(
  detail: TaskDetail,
  page: ResultsPage,
  states: Record<string, PaperState>,
  groups: readonly TaskGroup[],
  outcome?: 'done' | 'timeout',
): string {
  const lines = [`任务：${detail.title}（id: ${detail.id}，rev=${detail.rev}）`]
  lines.push(
    outcome === 'timeout'
      ? '状态：仍在检索中，已先返回当前结果；任务会继续在右侧栏完成。'
      : `状态：${statusLabel(detail.status)}${detail.error === undefined ? '' : `（${detail.error}）`}`,
  )

  const conditions = detail.conditions
  const queries = conditions.queries.map((query) => `${query.name}=「${query.text}」`).join('；')
  lines.push(`检索式：${queries}`)
  lines.push(
    `条件：数据源 ${conditions.sources.join('/')}｜每源 ${conditions.pageSize} 条｜年份 ${
      conditions.yearFrom ?? '不限'
    }-${conditions.yearTo ?? '不限'}｜${conditions.openAccessOnly ? '仅开放获取' : '不限获取方式'}｜语言 ${
      conditions.language
    }｜排序 ${conditions.sort}`,
  )
  if (detail.fromTaskId !== undefined) {
    lines.push(`基准任务：${detail.fromTaskId}（筛读状态已继承，新增篇数见 stats）`)
  }

  const screening = detail.stats.screening
  lines.push(
    `漏斗：原始 ${detail.stats.rawHits}｜去重 ${detail.stats.deduped}｜已加载 ${detail.result.totalLoaded}｜纳入 ${screening.included}、排除 ${screening.excluded}、待读 ${screening.unread}、已读 ${screening.read}`,
  )

  if (groups.length > 0) {
    const usage = new Map<string, number>()
    for (const state of Object.values(states)) {
      if (state.groupId !== undefined) usage.set(state.groupId, (usage.get(state.groupId) ?? 0) + 1)
    }
    lines.push(
      `分组：${groups
        .map(
          (group) =>
            `${group.name}(${group.id}) ${usage.get(group.id) ?? 0} 篇${
              group.description === undefined ? '' : `：${group.description}`
            }`,
        )
        .join('；')}`,
    )
  }
  if (detail.notes.trim() !== '') lines.push(`任务笔记：${truncate(detail.notes, 500)}`)

  const groupNames = new Map(groups.map((group) => [group.id, group.name]))
  lines.push('', `结果：筛选后 ${page.total} 篇，以下第 ${page.offset + 1}–${page.offset + page.papers.length} 篇：`)
  page.papers.forEach((paper, index) => {
    const state = states[paper.paperId]
    const marks = [
      state?.screening ?? 'unread',
      state?.groupId === undefined ? '' : groupNames.get(state.groupId) ?? state.groupId,
      state?.shortlistOrder === undefined ? '' : `必读#${state.shortlistOrder}`,
    ].filter((part) => part !== '')
    const meta = [
      paper.authors.slice(0, 4).join(', '),
      paper.year === null ? '' : String(paper.year),
      paper.venue,
      paper.doi === '' ? '' : `DOI: ${paper.doi}`,
      paper.citedBy === null ? '' : `被引 ${paper.citedBy}`,
    ].filter((part) => part !== '')
    lines.push(`${page.offset + index + 1}. [${marks.join('|')}] ${paper.title}`)
    if (meta.length > 0) lines.push(`   ${meta.join(' | ')}`)
    if (state?.note !== undefined && state.note !== '') lines.push(`   备注：${state.note}`)
    if (paper.abstract !== '') lines.push(`   摘要：${truncate(paper.abstract, 300)}`)
  })
  if (page.total > page.offset + page.papers.length) {
    lines.push('', `还有 ${page.total - page.offset - page.papers.length} 篇；可用 offset 继续读。`)
  }
  return lines.join('\n')
}

function formatCompare(report: CompareResult): string {
  const { counts } = report
  const lines = [
    `与「${report.withTitle}」对比（当前任务 id: ${report.taskId}，基准 id: ${report.withTaskId}）：`,
    `当前 ${counts.total} 篇，基准 ${counts.baseTotal} 篇；新增 ${counts.added}、共有 ${counts.common}、缺失 ${counts.missing}。`,
  ]
  if (counts.added > 0) {
    lines.push('', '新增：')
    report.added.slice(0, 20).forEach((paper, index) => {
      lines.push(`${index + 1}. ${paper.title}${describePaper(paper)}`)
    })
    if (counts.added > 20) lines.push(`… 另有 ${counts.added - 20} 篇新增，可在右侧栏对比页查看。`)
  }
  if (counts.missing > 0) {
    lines.push('', '基准有、当前缺失：')
    report.missing.slice(0, 10).forEach((paper, index) => {
      lines.push(`${index + 1}. ${paper.title}${describePaper(paper)}`)
    })
    if (counts.missing > 10) lines.push(`… 另有 ${counts.missing - 10} 篇缺失。`)
  }
  return lines.join('\n')
}

function describePaper(paper: CompareResult['added'][number]): string {
  const meta = [
    paper.authors.slice(0, 3).join(', '),
    paper.year === null ? '' : String(paper.year),
    paper.venue,
    paper.doi === '' ? '' : `DOI: ${paper.doi}`,
  ].filter((part) => part !== '')
  return meta.length === 0 ? '' : `\n   ${meta.join(' | ')}`
}

function formatStatsReport(report: TaskStatsReport): string {
  const lines = [
    `统计口径：${report.scope === 'task' ? '全任务' : '当前筛选'}｜参与统计 ${report.loaded} 篇（任务共 ${report.totalHint} 篇）`,
    `漏斗：原始 ${report.funnel.rawHits}｜去重 ${report.funnel.deduped}｜筛选后 ${report.funnel.filtered}｜纳入 ${report.funnel.included}、排除 ${report.funnel.excluded}、待读 ${report.funnel.unread}、已读 ${report.funnel.read}`,
    `指标：开放获取率 ${percent(report.metrics.oaRate)}｜PDF 覆盖率 ${percent(
      report.metrics.pdfRate,
    )}｜被引中位数 ${report.metrics.medianCitations}${
      report.metrics.newVsBase === undefined ? '' : `｜相对基准新增 ${report.metrics.newVsBase} 篇`
    }`,
  ]
  lines.push('', '年份分布：', ...report.byYear.slice(-12).map((year) => `- ${year.year}: ${year.count} 篇（纳入 ${year.included}）`))
  lines.push('', '来源：', ...report.bySource.map((source) => `- ${source.id}: 命中 ${source.hits}｜独有 ${source.uniqueOnly}｜OA ${source.oa}｜PDF ${source.withPdf}`))
  if (report.byQuery.length > 1) {
    lines.push('', '检索式贡献：', ...report.byQuery.map((query) => `- ${query.name}: 命中 ${query.hits}｜独有 ${query.uniqueOnly}`))
  }
  if (report.byType.length > 0) {
    lines.push('', '类型：', ...report.byType.slice(0, 10).map((entry) => `- ${entry.key}: ${entry.count}`))
  }
  if (report.byLanguage.length > 0) {
    lines.push('', '语言：', ...report.byLanguage.slice(0, 10).map((entry) => `- ${entry.key}: ${entry.count}`))
  }
  if (report.topVenues.length > 0) {
    lines.push('', '期刊/出处：', ...report.topVenues.slice(0, 10).map((entry) => `- ${entry.key}: ${entry.count}`))
  }
  if (report.topAuthors.length > 0) {
    lines.push('', '作者：', ...report.topAuthors.slice(0, 10).map((entry) => `- ${entry.key}: ${entry.count}`))
  }
  return lines.join('\n')
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
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
