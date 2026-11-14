/**
 * 模型侧工具：直接注册进 dsh 工具表（不经过外部 MCP）。
 *
 * - `literature_search`：一个研究主题 = 一个任务 = 一个 tab。默认复用「当前
 *   任务」并在其中开新一轮（当前任务是持久化的最近使用任务，跨对话、宿主重启
 *   都有效）；只有用户明确要求新任务时才新建。等待最多 25 秒后把任务头部与前
 *   若干条结果交给模型，并明确要求本轮到此为止、只给完善建议、不发起下一轮。
 * - `literature_sources`：列出已接入的数据源与能力，便于模型决定后续策略。
 * - `literature_task`：读取/修改已保存任务（含轮次历史），写入筛读与分组，
 *   做新老对比与统计。
 * - `literature_export`：把任务（按筛选）导出为 CSV / RIS / BibTeX / Markdown 并落盘。
 * - `literature_download`：把自然语言下载请求解析成已校验的 paperId 清单，
 *   通过事件下发给右侧栏，由右侧栏复用批量下载弹窗执行并逐篇展示。
 *
 * 参数在边界做一次校验（模型输出不可信），服务层仍会再兜底。
 */

import { randomUUID } from 'node:crypto'

import { MAX_LIMIT } from '../search/config.js'
import { SearchError } from '../search/errors.js'
import { asRecord } from '../search/normalize.js'
import { PROVIDER_INFOS } from '../search/providers/index.js'
import type {
  AnnotationInput,
  CompareResult,
  DownloadCommand,
  DownloadScope,
  ExportFormat,
  PaperState,
  PdfStatus,
  ResultsPage,
  Screening,
  SearchRound,
  SearchTask,
  SortMode,
  SourceId,
  TaskDetail,
  TaskGroup,
  TaskLanguage,
  TaskStatsReport,
  TaskSummary,
} from '../search/types.js'
import { SOURCE_IDS, TASK_LANGUAGES } from '../search/types.js'
import { mergeDownloadFilter, resolveDownloadScope, toPaperFilter } from './tasks/download.js'
import { filterPapers, type PaperFilter } from './tasks/filter.js'
import type { QueryInput, TaskPatch, TaskService } from './tasks/service.js'
import { resolveSessionWorkspace } from './workspace.js'

/** 模型侧最多等多久；超时后任务继续跑，只返回当前进度与已有结果。 */
const MODEL_WAIT_MS = 25_000

/** 交给模型的条数（UI 走分页端点，不受此限制）。 */
const TOOL_PAPER_LIMIT = 10

/** 复用任务时，最多等多久让上一轮跑完；超时直接返回提示，绝不新建任务。 */
const WAIT_PREVIOUS_MS = 12_000

const SORT_MODES: readonly SortMode[] = ['relevance', 'citations', 'year']
const LANGUAGES = TASK_LANGUAGES
const SCREENINGS: readonly Screening[] = ['unread', 'read', 'included', 'excluded']
const EXPORT_FORMATS: readonly ExportFormat[] = ['csv', 'ris', 'bibtex', 'md']
const DOWNLOAD_SCOPES: readonly DownloadScope[] = [
  'ids',
  'currentPage',
  'currentView',
  'all',
  'group',
  'filters',
]
const PDF_STATUSES: readonly PdfStatus[] = [
  'unknown',
  'available',
  'downloaded',
  'missing',
  'html-only',
  'paywalled',
  'blocked',
  'failed',
]
const TASK_ACTIONS = [
  'current',
  'list',
  'get',
  'update',
  'run',
  'rounds',
  'annotate',
  'compare',
  'stats',
] as const

/**
 * 每轮检索结束后的强约束尾句。
 *
 * 这是「模型可以建议完善检索、但不许自己立刻进入下一轮」的工具契约：
 * 既写在工具 description 里，也附在每次返回末尾，覆盖 `literature_task run`
 * 这条可能的旁路。
 */
const NO_AUTO_NEXT_ROUND =
  '本轮到此结束：请基于上面的结果给用户一份「如何完善检索」的建议（例如收窄或扩展检索式、调整年份/类型/数据源），但【禁止】自行发起下一次检索，不要再次调用 literature_search，也不要用 literature_task run 绕过。只有当用户查看结果后明确要求调整（在对话框里说明，或在右侧栏改条件）时，才可在同一任务内发起下一轮，并保持 taskId 不变或省略以复用当前任务。'

/** `ctx.tools` 的最小结构接口（真实类型由 dsh 装配，不在本包类型面内）。 */
export interface ToolsService {
  register(definition: unknown): () => void
}

/** 执行时附带的上下文：取消信号 + 发起调用的会话。 */
interface ToolRunExec {
  signal?: AbortSignal
  /** 当前会话；用于把聚焦请求送回发起检索的那个对话。 */
  agent?: { id: string }
}

interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: { text: string }) => Array<{ type: 'text'; text: string }>
  }
  execute: (args: unknown, exec: ToolRunExec) => Promise<{ text: string }>
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
    title: {
      type: 'string',
      description:
        '任务名称。仅新建任务时有效，请用能概括研究主题的短句自己命名（如「口臭治疗方案文献」）。复用已有任务时忽略。',
    },
    taskId: {
      type: 'string',
      description:
        '要复用的已有任务 id。同一主题的后续检索必须复用同一个任务；通常省略即可复用「当前任务」（最近一次使用或打开的任务，跨对话持续有效），也可用 literature_task list 查到 id 后显式指定。指定后不会新建任务、不会新开 tab。',
    },
    newTask: {
      type: 'boolean',
      description:
        '仅当用户明确要求「新建一个查询任务」，或研究主题与当前任务明显不同时才设为 true（此时请同时给 title）。同一主题改检索式（如加宽年份、换同义词）时绝对不要设 true。',
    },
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
      description: `要查询的数据源：${SOURCE_IDS.join(', ')}；省略表示默认数据源（googlescholar 需配置 SerpAPI Key，默认关闭）。`,
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
        'current 读「当前任务」（推荐在执行检索/任务操作前先调用，确认这个对话正在用哪个任务，无需 id）；list 列任务；get 读条件与结果；update 改条件/标题/笔记/分组；run 重跑（仅在用户明确要求进入下一轮时使用）；rounds 读该任务的检索轮次历史；annotate 写筛读/分组；compare 与旧任务对比；stats 读语料统计。',
    },
    id: { type: 'string', description: '任务 id；除 current / list 外必填。' },
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
      description: 'annotate 时的逐篇写入（筛读 / 分组）。',
      items: {
        type: 'object',
        properties: {
          paperId: { type: 'string' },
          screening: { type: 'string', enum: [...SCREENINGS] },
          groupId: { type: ['string', 'null'] },
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

/**
 * 下载范围参数的字段名一律沿用 `ResultsQuery` / `PaperFilter`，让模型下载与
 * 界面筛选共用同一套口径；这里不引入任何新的条件表达式。
 */
const DOWNLOAD_PARAMETERS = {
  type: 'object',
  properties: {
    taskId: { type: 'string', description: '要下载的任务 id；省略则用当前任务。' },
    scope: {
      type: 'string',
      enum: [...DOWNLOAD_SCOPES],
      description:
        '下载范围，按用户话术选择：ids = 用户点名了具体文献且你已从工具结果看到确切 paperId；currentPage = 「当前页/这一页」；currentView = 「当前全部/当前筛选下全部」（含跨页，默认，不等于整个任务）；all = 用户明确说「整个任务/所有文献/不管筛选」；group = 「xx 分组」（必须同时给 groupId）；filters = 用户给了年份、开放获取、关键词、来源、筛读状态等条件。',
    },
    reason: {
      type: 'string',
      description: '一句话复述用户要下载的范围（会显示在右侧批量下载框里），必填。',
    },
    paperIds: {
      type: 'array',
      maxItems: 1500,
      items: { type: 'string' },
      description:
        'scope=ids 时的确切 paperId 列表。只能填你在工具返回的「paperId:」行里看到的 id，禁止编造或猜测；其余 id 会被忽略。',
    },
    q: { type: 'string', description: '标题/摘要关键词，用于「下载关于 xx 的文献」。' },
    groupId: { type: 'string', description: '任务内分组 id；scope=group 时必填。' },
    queryId: { type: 'string', description: '只下某条检索式命中的文献。' },
    source: { type: 'string', enum: [...SOURCE_IDS], description: '只下该数据源命中的文献。' },
    yearFrom: { type: 'integer', minimum: 1, maximum: 3000, description: '起始年份。' },
    yearTo: { type: 'integer', minimum: 1, maximum: 3000, description: '截止年份。' },
    openAccessOnly: {
      type: 'boolean',
      description: '仅上游标记为开放获取的文献；与 hasPdf 不等价，不要同时默认开启。',
    },
    hasPdf: {
      type: 'boolean',
      description:
        '仅有 PDF 直链或已下载的文献。「下载当前页的所有 pdf 文献」用这个；付费墙文献会被跳过。',
    },
    missingFullText: { type: 'boolean', description: '只下尚无可用全文的文献。' },
    pdfStatus: {
      type: 'string',
      enum: [...PDF_STATUSES],
      description: '按全文状态精确筛选（如只要 missing 或 failed 的重试）。',
    },
    screening: { type: 'string', enum: [...SCREENINGS], description: '按筛读状态过滤。' },
    type: { type: 'string', description: '文献类型（精确匹配）。' },
    language: { type: 'string', enum: [...TASK_LANGUAGES], description: '语言码。' },
    venue: { type: 'string', description: '期刊/出处（精确匹配）。' },
    author: { type: 'string', description: '作者全名（精确匹配）。' },
  },
  required: ['scope', 'reason'],
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

interface DownloadArgs {
  taskId?: string
  scope: DownloadScope
  reason: string
  paperIds?: string[]
  /** 模型显式给出的附加条件（视图筛选由服务层另行合并）。 */
  filter: PaperFilter
}

interface SearchArgs {
  query: string
  /** 新建任务时的名称；复用时可选（传了会顺手改名）。 */
  title?: string
  /** 显式指定要复用的任务 id。 */
  taskId?: string
  /** 主题变了，强制新建任务。 */
  newTask?: boolean
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
        '检索免费开放学术文献。并发查询 PubMed、Europe PMC、OpenAlex、Crossref、Semantic Scholar、arXiv、PubTator，跨源与跨检索式去重合并成一篇文献一条，返回标题、作者、年份、出处、DOI、被引次数、开放获取状态与摘要，支持一次提交多条检索式（queries）。' +
        '【任务模型】一个研究主题 = 一个任务 = 一个右侧栏 tab；一个对话只保留一个任务 tab，切换任务由用户在任务列表里完成。若不确定这个对话当前用哪个任务，先调用 literature_task（action=current）查清再执行。默认复用「当前任务」并在同一任务内开新一轮：任务 id 不变、tab 不变，结果替换为最新一轮，已有的已读/纳入/排除/备注按文献身份保留；绝不会新建任务或新开 tab。当前任务是持久化的「最近一次使用或打开的任务」，跨对话、宿主重启都有效；用户从右侧栏点开别的任务会切换当前任务。只有用户明确要求新建查询任务，或研究主题与当前任务明显不同时，才传 newTask=true 并用 title 给新任务起一个概括主题的名称；也可用 taskId 显式指定要复用的任务（先用 literature_task current/list 查 id，或让用户点右侧栏的「加入对话」把任务 id 带进对话）。每次调用请提交【完整】的新检索条件，缺省项回落到插件默认设置而非沿用旧条件。' +
        '【轮次约束】本轮检索结束后，只给用户一份「如何完善检索」的建议，禁止自行发起下一轮、禁止重复调用本工具；必须等用户查看结果后，在右侧栏调整条件、或在对话里明确要求调整，才可在同一任务里再搜一次。' +
        '超过 25 秒仍在进行时会先返回当前进度，任务会继续在右侧栏完成。适合找论文、查某主题的代表作、补充参考文献。',
      parameters: SEARCH_PARAMETERS,
      output: TEXT_OUTPUT,
      async execute(args, exec): Promise<{ text: string }> {
        const input = readSearchArgs(args)
        const { title, taskId, newTask, ...conditions } = input
        const workspace = await resolveSessionWorkspace(exec.agent?.id)
        const createInput = {
          ...conditions,
          origin: 'model' as const,
          runNow: false,
          ...(workspace === undefined ? {} : { workspace }),
        }
        let task: SearchTask | undefined
        let reused = false

        if (taskId !== undefined) {
          task = await service.get(taskId)
          reused = true
        } else if (newTask !== true) {
          task = await service.currentTask()
          reused = task !== undefined
        }

        if (task === undefined) {
          task = await service.create({
            ...createInput,
            ...(title === undefined ? {} : { title }),
          })
        } else {
          // 上一轮还在跑时先等，绝不「换一个任务重搜」——那正是多开 tab 的根因。
          const idle = await service.waitUntilIdle(task.id, WAIT_PREVIOUS_MS, exec.signal)
          if (!idle) {
            return {
              text: [
                `任务「${task.title}」（id: ${task.id}）的上一轮仍在检索中，本次调整未执行。`,
                '请勿新建任务、请勿重复检索；可用 literature_task get 查看进度，等用户查看结果并明确要求后，再在【同一个任务】里发起下一轮。',
                NO_AUTO_NEXT_ROUND,
              ].join('\n'),
            }
          }
        }

        // 让客户端把该任务 tab 打开/切到前台（右侧面板关着时重新打开）。
        service.focusTask(task.id, task.title, exec.agent?.id)

        // 复用时不带 title：命名只属于新建任务，避免误改已有任务名。
        const running = reused
          ? service.rerun(task.id, createInput, 'model')
          : service.run(task.id, 'new', 'model')
        let outcome: 'done' | 'timeout'
        try {
          outcome = await runWithin(service, task.id, exec.signal, running)
        } catch (error) {
          if (
            error instanceof SearchError &&
            (error.code === 'conflict' || error.code === 'not_found')
          ) {
            return {
              text: [
                `任务「${task.title}」（id: ${task.id}）无法开新一轮：${error.message}`,
                '请先用 literature_task list / get 确认任务状态；不要新建任务来绕过，也不要重复检索。',
                NO_AUTO_NEXT_ROUND,
              ].join('\n'),
            }
          }
          throw error
        }
        const detail = await service.getDetail(task.id)
        const page = await service.results(task.id, { limit: TOOL_PAPER_LIMIT })
        return { text: formatTaskResult(detail, page, outcome, reused) }
      },
    },
    {
      name: 'literature_sources',
      description:
        '列出本插件已接入的文献数据源：能力（摘要、被引次数、开放获取、PDF 链接）、限流额度、检索式语法与是否需要可选 API Key。默认数据源均免费；Google Scholar 需在设置页配置 SerpAPI Key（有免费额度，超出付费），未配置时不参与检索。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT,
      async execute(): Promise<{ text: string }> {
        return { text: formatSources() }
      },
    },
    {
      name: 'literature_task',
      description:
        '读取与推进已保存的检索任务。current 读「当前任务」（推荐在执行任何检索/任务操作前先调用，确认这个对话正在用哪个任务；无需 id）；list 列出任务；get 读条件、分组、笔记与结果（可按筛读/分组/检索式/关键词过滤）；update 改标题、条件、任务笔记与分组；rounds 读该任务的检索轮次历史（每轮时间、条件、发起方、命中数与状态）；annotate 批量写入筛读状态与分组；compare 与旧任务按论文身份对比新增/缺失；stats 读语料统计（年份、来源、期刊、作者、类型、语言）。' +
        '注意：一个对话只保留一个任务 tab，切换任务由用户在任务列表里完成；run 会在指定任务内开新一轮检索（并把它设为当前任务），与 literature_search 一样受「用户查看结果并明确要求后才能进入下一轮」约束，不能用它绕过该约束自行加搜；也不要用 update 改完条件就立刻 run。适合在检索之后做筛选、整理与汇报。用户要求批量下载 PDF 时改用 literature_download。',
      parameters: TASK_PARAMETERS,
      output: TEXT_OUTPUT,
      async execute(args, exec): Promise<{ text: string }> {
        return {
          text: await runTaskAction(service, readTaskArgs(args), exec.signal, exec.agent?.id),
        }
      },
    },
    {
      name: 'literature_export',
      description:
        '把检索任务导出为文件并返回落盘路径。csv 是全量筛读台账（含命中检索式、筛读状态、分组）；ris / bibtex 供 Zotero、EndNote 等文献管理器；md 是分层检索报告（漏斗、按分组的阅读清单、开放获取与 PDF 覆盖率、对比新增）。可按筛读状态、分组、检索式或指定 paperIds 限定范围。',
      parameters: EXPORT_PARAMETERS,
      output: TEXT_OUTPUT,
      async execute(args): Promise<{ text: string }> {
        return { text: await runExport(service, readExportArgs(args)) }
      },
    },
    {
      name: 'literature_download',
      description:
        '在用户要求「帮我下载 XX 文献 / 下载当前页的所有 pdf 文献 / 下载 xx 分组下的文献 / 下载 xx 条件的文献 / 帮我下载当前全部文献」时调用：把范围算成一份已校验的 paperId 清单，下发给右侧栏，右侧栏会自动弹出批量下载框并立即逐篇下载，用户能看到每篇标题、来源与实时状态，也能点「取消下载」中止。' +
        '【范围怎么选】用户点名具体文献且你已在工具结果的「paperId:」行看到确切 id → scope=ids 并给 paperIds；「当前页/这一页」→ scope=currentPage；「当前全部/当前筛选下全部」→ scope=currentView（含跨页，不等于整个任务）；明确说「整个任务/所有文献/不管筛选」→ scope=all；「xx 分组」→ scope=group + groupId；给了年份、OA、关键词、来源、筛读状态等条件 → scope=filters 并填对应字段。' +
        '【重要】你看不到右侧栏界面，「当前页」「当前筛选全部」由宿主用面板上报的视图快照 + 服务端筛选精确计算，不要自己猜页码或编造 paperId；scope=ids 时只能使用工具结果里出现过的 paperId，无效 id 会被忽略。hasPdf 表示「有 PDF 直链或已下载」，openAccessOnly 表示上游标记为开放获取，两者不等价，不要同时默认开启。' +
        '本工具只下发指令、不等待下载完成，也不要重复调用同一条指令或臆测下载结果；若范围为空会返回原因而不下发。需要检索后再下载时，先按检索工具的轮次约束完成检索，再由用户明确提出下载。',
      parameters: DOWNLOAD_PARAMETERS,
      output: TEXT_OUTPUT,
      async execute(args, exec): Promise<{ text: string }> {
        return { text: await runDownload(service, readDownloadArgs(args), exec.agent?.id) }
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

  const title = readText(record['title'], 'title')
  if (title !== undefined) input.title = title.slice(0, 120)
  const taskId = readText(record['taskId'], 'taskId')
  if (taskId !== undefined) input.taskId = taskId
  if (record['newTask'] !== undefined) {
    if (typeof record['newTask'] !== 'boolean') throw new Error('newTask 必须是布尔值')
    input.newTask = record['newTask']
  }
  if (input.newTask === true && input.taskId !== undefined) {
    throw new Error('taskId 与 newTask 不能同时使用；要复用请只给 taskId，要新建请只给 newTask')
  }

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
 * 等待一次已在跑的执行，最多 {@link MODEL_WAIT_MS}。
 *
 * `running` 由调用方启动（新建走 `service.run`，复用走 `service.rerun`）。
 * 超时不取消任务：模型先拿到当前结果，右侧栏继续跑完。调用方中止则取消任务。
 */
async function runWithin(
  service: TaskService,
  id: string,
  signal: AbortSignal | undefined,
  running: Promise<unknown>,
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
    return await Promise.race([running.then(() => 'done' as const), timeout, aborted])
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
  if (input.action !== 'list' && input.action !== 'current' && input.id === undefined) {
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

/** 下载参数边界校验：枚举白名单、严格布尔、paperIds 去空去重且保序。 */
function readDownloadArgs(args: unknown): DownloadArgs {
  const record = asRecord(args)
  const scope = record['scope']
  if (typeof scope !== 'string' || !(DOWNLOAD_SCOPES as readonly string[]).includes(scope)) {
    throw new Error(`scope 只能是 ${DOWNLOAD_SCOPES.join(' / ')}`)
  }
  const reason = readText(record['reason'], 'reason')
  if (reason === undefined) throw new Error('缺少 reason：请用一句话复述用户要下载的范围')
  const input: DownloadArgs = {
    scope: scope as DownloadScope,
    reason: reason.slice(0, 200),
    filter: {},
  }
  const taskId = readText(record['taskId'], 'taskId')
  if (taskId !== undefined) input.taskId = taskId

  if (record['paperIds'] !== undefined) {
    const papers = record['paperIds']
    if (!Array.isArray(papers) || !papers.every((item) => typeof item === 'string')) {
      throw new Error('paperIds 必须是字符串数组')
    }
    if (papers.length > 1500) throw new Error('paperIds 最多 1500 条')
    input.paperIds = [
      ...new Set((papers as string[]).map((id) => id.trim()).filter((id) => id !== '')),
    ]
  }
  if (input.scope === 'ids' && (input.paperIds ?? []).length === 0) {
    throw new Error('scope=ids 必须给出 paperIds，且只能使用工具结果里出现过的 paperId')
  }

  const filter: PaperFilter = {}
  const q = readText(record['q'], 'q')
  if (q !== undefined) filter.q = q.slice(0, 200)
  const groupId = readText(record['groupId'], 'groupId')
  if (groupId !== undefined) filter.groupId = groupId
  const queryId = readText(record['queryId'], 'queryId')
  if (queryId !== undefined) filter.queryId = queryId
  const type = readText(record['type'], 'type')
  if (type !== undefined) filter.type = type.slice(0, 100)
  const venue = readText(record['venue'], 'venue')
  if (venue !== undefined) filter.venue = venue.slice(0, 200)
  const author = readText(record['author'], 'author')
  if (author !== undefined) filter.author = author.slice(0, 200)

  const yearFrom = readInteger(record['yearFrom'], 'yearFrom', 3000)
  if (yearFrom !== undefined) filter.yearFrom = yearFrom
  const yearTo = readInteger(record['yearTo'], 'yearTo', 3000)
  if (yearTo !== undefined) filter.yearTo = yearTo
  if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) {
    throw new Error('yearFrom 不能大于 yearTo')
  }

  for (const key of ['openAccessOnly', 'hasPdf', 'missingFullText'] as const) {
    const value = record[key]
    if (value === undefined) continue
    if (typeof value !== 'boolean') throw new Error(`${key} 必须是布尔值`)
    if (value) filter[key] = true
  }

  const source = record['source']
  if (source !== undefined) {
    if (typeof source !== 'string' || !(SOURCE_IDS as readonly string[]).includes(source)) {
      throw new Error(`source 只能是 ${SOURCE_IDS.join(' / ')}`)
    }
    filter.source = source
  }
  const language = record['language']
  if (language !== undefined) {
    if (typeof language !== 'string' || !(LANGUAGES as readonly string[]).includes(language)) {
      throw new Error('language 不是支持的语言码')
    }
    filter.language = language as TaskLanguage
  }
  const screening = record['screening']
  if (screening !== undefined) {
    if (typeof screening !== 'string' || !(SCREENINGS as readonly string[]).includes(screening)) {
      throw new Error(`screening 只能是 ${SCREENINGS.join(' / ')}`)
    }
    filter.screening = screening as Screening
  }
  const pdfStatus = record['pdfStatus']
  if (pdfStatus !== undefined) {
    if (typeof pdfStatus !== 'string' || !(PDF_STATUSES as readonly string[]).includes(pdfStatus)) {
      throw new Error(`pdfStatus 只能是 ${PDF_STATUSES.join(' / ')}`)
    }
    filter.pdfStatus = pdfStatus as PdfStatus
  }

  if (input.scope === 'group' && filter.groupId === undefined) {
    throw new Error('scope=group 必须给出 groupId')
  }
  input.filter = filter
  return input
}

async function runTaskAction(
  service: TaskService,
  args: TaskArgs,
  signal: AbortSignal | undefined,
  sessionId: string | undefined,
): Promise<string> {
  switch (args.action) {
    case 'current': {
      const task = await service.currentTask()
      return formatCurrentTask(task)
    }
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
      const task = await service.get(id)
      const workspace = await resolveSessionWorkspace(sessionId)
      // 用户明确要求推进这个任务：它成为当前任务，并让客户端打开/聚焦对应 tab。
      service.setCurrentTask(id)
      service.focusTask(task.id, task.title, sessionId)
      const outcome = await runWithin(
        service,
        id,
        signal,
        service.run(id, 'new', 'model', workspace),
      )
      const latest = await service.get(id)
      const detail = await service.getDetail(id)
      const page = await service.results(id, {
        ...readFilterArgs(args),
        limit: args.limit ?? TOOL_PAPER_LIMIT,
        offset: args.offset ?? 0,
      })
      // 这条旁路同样附上「不自动下一轮」约束，避免模型绕过 literature_search。
      return `${formatTaskDetail(detail, page, latest.states, latest.groups, outcome)}\n\n${NO_AUTO_NEXT_ROUND}`
    }
    case 'rounds': {
      const id = requireId(args)
      const task = await service.get(id)
      return formatRounds(task.title, id, await service.getRounds(id), args.limit ?? 30)
    }
    case 'annotate': {
      const result = await service.annotate(requireId(args), args.papers ?? [])
      return `已写入 ${result.updated} 篇的筛读/分组（任务 id: ${result.taskId}，rev=${result.rev}）。`
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

/**
 * 把自然语言下载请求算成已校验的 paperId 清单并下发指令。
 *
 * 只等服务端把范围算完（毫秒级），不等右侧栏下载完成：下载由 Client 复用
 * 现有批量下载弹窗执行，模型拿到的只是「已受理」的说明。
 */
async function runDownload(
  service: TaskService,
  args: DownloadArgs,
  sessionId: string | undefined,
): Promise<string> {
  const task =
    args.taskId !== undefined ? await service.get(args.taskId) : await service.currentTask()
  if (task === undefined) {
    return '当前没有检索任务：请先检索文献，或让用户从右侧栏打开一个任务，再让我下载。'
  }
  const snapshot = await service.getViewSnapshot(sessionId, task.id)
  if ((args.scope === 'currentPage' || args.scope === 'currentView') && snapshot === undefined) {
    return [
      `任务「${task.title}」（id: ${task.id}）暂时读不到右侧栏的当前视图，无法准确判断「当前页 / 当前全部」。`,
      '请让用户先在右侧栏打开该任务的结果页、翻到要看的那一页，再重复这条指令；也可以改用 scope=all 下载整个任务、用 filters 给明确条件、用 ids 指定文献。',
      '本次没有下发任何下载指令。',
    ].join('\n')
  }

  // 「当前页 / 当前全部」以界面筛选打底；其余范围忽略界面筛选，避免用户说
  // 「下载全部」时却只下了筛出来的那批。
  const viewFilter =
    args.scope === 'currentPage' || args.scope === 'currentView'
      ? toPaperFilter(snapshot?.filters ?? {})
      : {}
  const filter = await service.resolveDownloadFilter(
    task.id,
    mergeDownloadFilter(viewFilter, args.filter),
  )

  // 当前页优先用面板直接上报的顺序；缺 paperIds 时按视图筛选与排序重算这一页。
  let pagePaperIds: readonly string[] | undefined
  if (args.scope === 'currentPage' && snapshot !== undefined) {
    if (snapshot.pagePaperIds.length > 0) {
      pagePaperIds = snapshot.pagePaperIds
    } else {
      const page = await service.results(task.id, {
        ...viewFilter,
        ...(snapshot.sort === undefined ? {} : { sort: snapshot.sort }),
        offset: snapshot.pageIndex * snapshot.pageSize,
        limit: snapshot.pageSize,
      })
      pagePaperIds = page.papers.map((paper) => paper.paperId)
    }
  }

  const groupName =
    args.scope === 'group' && args.filter.groupId !== undefined
      ? task.groups.find((group) => group.id === args.filter.groupId)?.name
      : undefined
  const resolved = resolveDownloadScope(task, {
    scope: args.scope,
    filter,
    matched: filterPapers(task, filter),
    ...(args.paperIds === undefined ? {} : { explicitIds: args.paperIds }),
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(pagePaperIds === undefined ? {} : { pagePaperIds }),
    ...(groupName === undefined ? {} : { groupName }),
  })

  if (resolved.paperIds.length === 0) {
    return [
      `没有匹配到可下载的文献（${resolved.scopeLabel}）。`,
      `任务「${task.title}」共 ${task.result.papers.length} 篇；本次没有下发任何下载指令。`,
      '请放宽条件、确认分组/年份是否正确，或改用 scope=all；不要重复下发同一条指令。',
    ].join('\n')
  }

  const command: DownloadCommand = {
    commandId: randomUUID(),
    taskId: task.id,
    ...(sessionId === undefined ? {} : { sessionId }),
    at: Date.now(),
    origin: 'model',
    reason: args.reason,
    scopeLabel: resolved.scopeLabel,
    paperIds: resolved.paperIds,
    items: resolved.items,
  }
  // 先请求打开任务 tab，再下发指令；两者在同一次 /events 增量里送到客户端，
  // 面板即使原本没挂载也能被拉起后再消费指令。
  service.focusTask(task.id, task.title, sessionId)
  service.publishDownloadCommand(command)

  const preview = resolved.items
    .slice(0, 5)
    .map((item, index) => `${index + 1}. ${item.title}（${item.source}）`)
    .join('\n')
  const lines = [
    `已向右侧栏下发批量下载指令：${resolved.scopeLabel}。`,
    `任务「${task.title}」（id: ${task.id}）；范围：${args.reason}`,
    `清单已逐个校验：${resolved.paperIds.length} 篇属于该任务且满足条件${
      resolved.ignored > 0
        ? `，另有 ${resolved.ignored} 个 id 被忽略（不属于该任务或不满足条件）`
        : ''
    }。`,
    '',
    '清单前几篇：',
    preview,
    '',
    '右侧栏会自动弹出批量下载框并立即开始，用户能看到每篇标题、来源与实时状态，也可点「取消下载」中止。本工具只下发指令、不等待下载完成；请勿重复调用，也不要替用户臆测下载结果。',
  ]
  if (resolved.paperIds.length > 200) {
    lines.push(
      '',
      `注意：本次 ${resolved.paperIds.length} 篇数量较大，可能耗时较长并触发上游限流；已下载的会跳过，建议提示用户必要时收窄范围。`,
    )
  }
  return lines.join('\n')
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

/** 「当前任务」的轻量快照：模型在执行检索/任务操作前先确认这个对话正在用哪个任务。 */
function formatCurrentTask(task: SearchTask | undefined): string {
  if (task === undefined) {
    return [
      '当前没有任务：这个对话还没有任何检索任务。',
      '若用户要求检索，请直接调用 literature_search（不要传 newTask）；若用户要继续某个已有任务，请让用户从右侧栏任务列表打开它，或点任务页的「加入对话」把任务 id 带进对话。',
    ].join('\n')
  }
  const conditions = task.conditions
  const queries = conditions.queries.map((query) => `${query.name}=「${query.text}」`).join('；')
  const last = task.rounds[task.rounds.length - 1]
  const screening = task.stats.screening
  const lines = [
    `当前任务：${task.title}（id: ${task.id}）`,
    `状态：${statusLabel(task.status)}${task.error === undefined ? '' : `（${task.error}）`}`,
    `检索轮次：共 ${task.rounds.length} 轮${
      last === undefined
        ? ''
        : `｜最近一轮 ${last.createdAt.slice(0, 19).replace('T', ' ')}（${
            last.origin === 'model' ? '模型' : '面板'
          }）`
    }`,
    `检索式：${queries === '' ? '（无）' : queries}`,
    `条件：数据源 ${conditions.sources.join('/')}｜每源 ${conditions.pageSize} 条｜年份 ${
      conditions.yearFrom ?? '不限'
    }-${conditions.yearTo ?? '不限'}｜${conditions.openAccessOnly ? '仅开放获取' : '不限获取方式'}｜语言 ${
      conditions.language
    }｜排序 ${conditions.sort}`,
    `漏斗：原始 ${task.stats.rawHits}｜去重 ${task.stats.deduped}｜已加载 ${task.result.papers.length}｜纳入 ${screening.included}、排除 ${screening.excluded}、待读 ${screening.unread}、已读 ${screening.read}`,
    '',
    '用法：同一主题继续检索时省略 taskId 即复用该任务；需要调整条件时直接在 literature_search 里提交【完整】的新条件；只有用户明确要求新建查询任务时才传 newTask=true。',
  ]
  return lines.join('\n')
}

function formatTaskList(tasks: readonly TaskSummary[], limit: number): string {  if (tasks.length === 0) return '还没有保存的检索任务。可先用 literature_search 检索。'
  const lines = [`共 ${tasks.length} 个任务${tasks.length > limit ? `，列出前 ${limit} 个` : ''}：`]
  for (const task of tasks.slice(0, limit)) {
    const screening = task.stats.screening
    lines.push(
      `- ${task.id}｜${task.title}｜${statusLabel(task.status)}｜${task.roundCount ?? 0} 轮｜${task.updatedAt.slice(0, 10)}｜已加载 ${
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

  lines.push(`检索轮次：共 ${detail.roundCount ?? 0} 轮（用 rounds 查看每轮条件与命中）`)
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
    ].filter((part) => part !== '')
    const meta = [
      paper.authors.slice(0, 4).join(', '),
      paper.year === null ? '' : String(paper.year),
      paper.venue,
      paper.doi === '' ? '' : `DOI: ${paper.doi}`,
      paper.citedBy === null ? '' : `被引 ${paper.citedBy}`,
    ].filter((part) => part !== '')
    lines.push(`${page.offset + index + 1}. [${marks.join('|')}] ${paper.title}`)
    // 供 literature_download 的 scope=ids 引用；模型不得编造这个 id。
    lines.push(`   paperId: ${paper.paperId}`)
    if (meta.length > 0) lines.push(`   ${meta.join(' | ')}`)
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
  const lines = [
    '已接入的文献数据源（默认均为免费；Google Scholar 需在设置页配置 SerpAPI Key，未配置时不参与检索）：',
  ]
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
  reused: boolean,
): string {
  const lines = [
    `任务：${detail.title}（id: ${detail.id}）`,
    `轮次：第 ${detail.roundCount ?? 0} 轮｜${
      reused ? '复用已有任务，未新建任务、未新开 tab' : '新建任务'
    }｜右侧栏历史图标可查看各轮条件与结果概览`,
  ]

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
    lines.push('', NO_AUTO_NEXT_ROUND)
    return lines.join('\n')
  }

  page.papers.forEach((paper, index) => {
    lines.push('')
    lines.push(`${index + 1}. ${paper.title}`)
    // 供 literature_download 的 scope=ids 引用；模型不得编造这个 id。
    lines.push(`   paperId: ${paper.paperId}`)
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
  lines.push('', NO_AUTO_NEXT_ROUND)
  return lines.join('\n')
}

/** 轮次历史：只给元数据，不回吐文献列表。 */
function formatRounds(
  title: string,
  id: string,
  rounds: readonly SearchRound[],
  limit: number,
): string {
  if (rounds.length === 0) {
    return `任务「${title}」（id: ${id}）还没有检索轮次。\n${NO_AUTO_NEXT_ROUND}`
  }
  const recent = rounds.slice(-Math.max(1, limit))
  const lines = [
    `任务「${title}」（id: ${id}）共 ${rounds.length} 轮检索${
      rounds.length > recent.length ? `，列出最近 ${recent.length} 轮` : ''
    }：`,
  ]
  for (const round of recent) {
    const queries = round.conditions.queries
      .map((query) => `「${query.text}」`)
      .join('、')
    const stats =
      round.stats === undefined
        ? '统计未回填'
        : `原始 ${round.stats.rawHits}｜去重 ${round.stats.deduped}｜已加载 ${round.stats.loaded} 篇`
    lines.push(
      `- 第 ${round.index} 轮｜${round.createdAt.slice(0, 19).replace('T', ' ')}｜${
        round.origin === 'model' ? '模型' : '面板'
      }｜${round.status === undefined ? '进行中' : statusLabel(round.status)}｜${stats}${
        round.error === undefined ? '' : `｜${round.error}`
      }`,
    )
    lines.push(`  条件：${truncate(queries, 300)}｜每源 ${round.conditions.pageSize} 条｜源 ${round.conditions.sources.join('/')}`)
  }
  lines.push('', '提示：右侧栏历史时间轴可查看同样内容，并可一键回填某轮条件重跑。')
  lines.push('', NO_AUTO_NEXT_ROUND)
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
