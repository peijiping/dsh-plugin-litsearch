import { getSettings } from '../search/config.js'
import { SearchError } from '../search/errors.js'
import { matchesIdentifier, parseIdentifier } from '../search/lookup.js'
import { asRecord, stripTags } from '../search/normalize.js'
import {
  RESULT_PAGE_SIZE, SOURCE_IDS, TASK_LANGUAGES, TRANSLATE_ENGINES, TRANSLATE_TARGETS,
  type PanelOperation, type Paper, type SearchTask,
} from '../search/types.js'
import { readAttachmentPdf, readLocalPdf, sessionPdfs, type AttachmentStoreLike, type SessionFilesLike } from './model-attachments.js'
import { toPaperFilter } from './tasks/download.js'
import { pdfStatusOf } from './tasks/filter.js'
import { resolvePaperId } from './tasks/paper-groups.js'
import { activeRoundOf, hasRoundResults } from './tasks/rounds.js'
import type { TaskService } from './tasks/service.js'
import type { TranslateFn } from './translate.js'
import { resolveSessionWorkspace } from './workspace.js'
import { matchZoteroTarget } from './zotero/match.js'

export interface ModelOperationDeps {
  translate?: TranslateFn
  attachments?: () => AttachmentStoreLike | undefined
  sessionFiles?: () => SessionFilesLike | undefined
  updateSettings?: (patch: Record<string, unknown>, reset: string[]) => Promise<void>
}

const TABS = ['results', 'fulltext', 'overview', 'groups', 'notes', 'compare'] as const
const ROUND_POSITIONS = ['previous', 'next', 'latest'] as const
const REVIEWS = ['split', 'keepSeparate', 'linkVersions', 'resolveScreening'] as const
const CLEANUP = ['tasks', 'pdf', 'all'] as const
const SECRETS = ['ncbiApiKey', 'openalexApiKey', 's2ApiKey', 'serpApiKey'] as const

const baseFilters = {
  q: { type: 'string' }, yearFrom: { type: 'integer' }, yearTo: { type: 'integer' },
  source: { type: 'string', enum: SOURCE_IDS }, queryId: { type: 'string' },
  screening: { type: 'string', enum: ['unread', 'read', 'included', 'excluded'] },
  language: { type: 'string', enum: TASK_LANGUAGES }, groupId: { type: 'string' },
  type: { type: 'string' }, venue: { type: 'string' }, author: { type: 'string' },
  pdfStatus: { type: 'string', enum: ['unknown', 'available', 'downloaded', 'missing', 'html-only', 'paywalled', 'blocked', 'failed'] },
  openAccessOnly: { type: 'boolean' }, hasPdf: { type: 'boolean' },
  hasFullText: { type: 'boolean' }, missingFullText: { type: 'boolean' },
  newOnly: { type: 'boolean' }, supplementedOnly: { type: 'boolean' },
} as const
const panelFilters = { ...baseFilters, sort: { type: 'string', enum: ['relevance', 'citations', 'year'] } } as const

const taskId = { type: 'string', description: '任务 ID。省略时以本会话右侧栏任务为准。' }
const round = { type: 'integer', minimum: 1, description: '面板显示的轮号（如第 10 轮传 10），省略时用当前轮。' }
const paperId = { type: 'string', description: '插件返回的 paperId。' }
const identifier = { type: 'string', description: '完整 DOI、PMID、arXiv ID 或论文标题。' }
const limit = { type: 'integer', minimum: 1, description: '单次返回条数。' }
const offset = { type: 'integer', minimum: 0, description: '分页起始位置，从 0 开始。' }
const text = (description: string) => ({ type: 'string', description })
const oneOf = <T extends string>(values: readonly T[]) => ({ type: 'string', enum: values })

type Args = Record<string, unknown>
type Operation = {
  name: string
  description: string
  parameters: Record<string, unknown>
  run(args: Args, sessionId?: string, signal?: AbortSignal): Promise<string>
}

function tool(
  name: string, description: string, actions: readonly string[], properties: Record<string, unknown>,
  run: Operation['run'],
): Operation {
  return {
    name, description,
    parameters: { type: 'object', properties: { action: oneOf(actions), ...properties }, required: ['action'], additionalProperties: false },
    async run(args, sessionId, signal) {
      choice(args, 'action', actions)
      return run(args, sessionId, signal)
    },
  }
}

function string(args: Args, key: string, required = false): string | undefined {
  const value = args[key]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || value.trim() === '' || value.length > 4096) {
    throw new SearchError('bad_request', `${key} 需要有效文本`)
  }
  return value.trim()
}

function integer(args: Args, key: string, min = 1, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new SearchError('bad_request', `${key} 需要 ${min} 至 ${max} 之间的整数`)
  }
  return value
}

function choice<T extends string>(args: Args, key: string, values: readonly T[]): T | undefined {
  const value = string(args, key, key === 'action')
  if (value === undefined) return undefined
  if (!values.includes(value as T)) throw new SearchError('bad_request', `${key} 支持 ${values.join('、')}`)
  return value as T
}

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

export async function modelTask(
  service: TaskService, sessionId?: string, taskId?: string,
): Promise<SearchTask> {
  const task = taskId === undefined ? await service.currentTask(sessionId) : await service.get(taskId)
  if (task === undefined) throw new SearchError('not_found', '当前会话没有可用的检索任务，请先打开任务')
  return task
}

function requestedRound(task: SearchTask, args: Args) {
  const number = integer(args, 'round')
  const position = choice(args, 'position', ROUND_POSITIONS)
  const active = activeRoundOf(task)
  if (number !== undefined && position !== undefined) throw new SearchError('bad_request', '请只指定轮号或相对位置')
  if (number !== undefined) {
    const selected = task.rounds.find((entry) => entry.index === number)
    if (!selected) throw new SearchError('not_found', `未找到第 ${number} 轮`)
    return selected
  }
  if (active === undefined) throw new SearchError('not_found', '任务没有检索轮次')
  const available = task.rounds.filter((entry) => entry.id === active.id || hasRoundResults(entry))
  const candidates = args['action'] === 'switch' ? available : task.rounds
  if (position !== undefined) {
    const selected = position === 'latest' ? candidates.at(-1) :
      position === 'previous' ? candidates.filter((entry) => entry.index < active.index).at(-1) :
      candidates.find((entry) => entry.index > active.index)
    if (selected === undefined) throw new SearchError('not_found', '该方向没有可选轮次')
    return selected
  }
  if (args['action'] !== 'switch') return active
  const alternatives = available.filter((entry) => entry.id !== active.id)
  if (alternatives.length === 1) return alternatives[0]!
  throw new SearchError('bad_request', alternatives.length === 0 ? '没有其他可切换的轮次' :
    `当前第 ${active.index} 轮，可切换到 ${alternatives.map((entry) => `第 ${entry.index} 轮`).join('、')}。请指定轮号。`)
}

function choosePaper(task: SearchTask, args: Args): Paper {
  const id = string(args, 'paperId')
  const key = string(args, 'identifier')
  if ((id === undefined) === (key === undefined)) throw new SearchError('bad_request', '请提供 paperId 或 DOI、PMID、arXiv ID、标题之一')
  const wanted = id === undefined ? undefined : resolvePaperId(task, id)
  let parsed: ReturnType<typeof parseIdentifier> | undefined
  if (key !== undefined) {
    try { parsed = parseIdentifier(key) } catch { /* 无有效标识时按标题匹配。 */ }
  }
  const normalizedTitle = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
  const matches = task.result.papers.filter((paper) =>
    wanted !== undefined ? paper.paperId === wanted :
      parsed !== undefined ? matchesIdentifier(paper, parsed) : normalizedTitle(paper.title) === normalizedTitle(key!),
  )
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) throw new SearchError('not_found', '当前轮次未找到这篇论文，可先查看结果或按标识补录')
  throw new SearchError('conflict', `匹配到多篇论文，请选择：\n${matches.slice(0, 12)
    .map((paper) => `${paper.title}｜${paper.year ?? ''}｜${paper.doi || '无 DOI'}｜paperId=${paper.paperId}`).join('\n')}`)
}

function queued(service: TaskService, sessionId: string | undefined, command: PanelOperation, execute?: () => Promise<string>): string {
  const commandId = service.requestPanel(sessionId, command, execute)
  return `已通知本会话右侧栏。commandId=${commandId}，可用 literature_panel status 查看实际处理结果。`
}

export function modelOperations(service: TaskService, deps: ModelOperationDeps): Operation[] {
  return [
    tool('literature_round',
      '操作检索轮次。switch 切到第 N 轮并恢复面板保存的结果；draft 从某轮条件创建待执行的同任务新轮次；newTask 从某轮创建指定名称的独立任务草稿；report 查实际发送的检索式、逐页命中及过滤原因；export 导出完整明细；next 仅在用户要求时对指定来源和检索式取下一页或重试；review 处理文献身份和筛读冲突；cancel 取消运行中的检索。',
      ['switch', 'draft', 'newTask', 'report', 'export', 'next', 'review', 'cancel'], {
        taskId, round, position: oneOf(ROUND_POSITIONS), title: text('newTask 的新任务名称。'),
        source: oneOf(SOURCE_IDS), queryId: text('来自 report 的检索式 ID。'),
        page: { type: 'integer', minimum: 1, description: '来源结果的下一页，省略时从已提交进度推算。' },
        decision: oneOf(REVIEWS), subject: text('report 返回的待复核 ID，或误合并论文的 paperId。'),
        choice: text('resolveScreening 时选中的 originalPaperId。'),
        rev: { type: 'integer', minimum: 1, description: 'review 必须传实际阅读的 report 版本。' },
        offset, limit,
      }, async (args, sessionId) => {
        const task = await modelTask(service, sessionId, string(args, 'taskId'))
        const action = args['action']
        if (action === 'cancel') {
          await service.cancel(task.id)
          return `已请求停止「${task.title}」的检索，可用 literature_task get 核对状态。`
        }
        const selected = requestedRound(task, args)
        if (action === 'switch' || action === 'draft') {
          await service.selectRound(task.id, selected.id, action, 'model')
          service.setCurrentTask(task.id, sessionId)
          const active = activeRoundOf(await service.get(task.id))
          service.focusTask(task.id, task.title, sessionId, true)
          if (sessionId) service.requestPanel(sessionId, {
            action: 'view', taskId: task.id, tab: 'results', roundId: active?.id, reset: true,
          })
          return action === 'switch'
            ? `已切到「${task.title}」第 ${active?.index} 轮，已恢复 ${task.result.papers.length} 篇保存的结果。`
            : `已复制第 ${selected.index} 轮的条件，创建第 ${active?.index} 轮草稿，等待执行。`
        }
        if (action === 'newTask') {
          const title = string(args, 'title', true)
          const draft = await service.create({
            ...structuredClone(selected.conditions), title, runNow: false, origin: 'model',
            workspace: await resolveSessionWorkspace(sessionId),
          })
          service.setCurrentTask(draft.id, sessionId)
          service.focusTask(draft.id, draft.title, sessionId, true)
          return `已从「${task.title}」第 ${selected.index} 轮创建任务草稿「${draft.title}」，id=${draft.id}，等待执行。`
        }
        if (action === 'export') return `检索明细已导出：${await service.exportRoundReport(task.id, selected.id)}`
        if (action === 'review') {
          const decision = choice(args, 'decision', REVIEWS)
          const rev = integer(args, 'rev')
          if (decision === undefined || rev === undefined) throw new SearchError('bad_request', '请先读取 report，传 decision、subject 和 rev')
          await service.reviewIdentity(task.id, selected.id, string(args, 'subject', true)!, decision, rev, string(args, 'choice'))
          return `第 ${selected.index} 轮复核已保存。decision=${decision}，rev=${task.rev}。`
        }
        if (action === 'next') {
          const source = choice(args, 'source', SOURCE_IDS)
          const queryId = string(args, 'queryId')
          const runs = selected.evidence?.runs.filter((run) =>
            (source === undefined || run.source === source) && (queryId === undefined || run.queryId === queryId)) ?? []
          if (runs.length !== 1) throw new SearchError('bad_request', '请先查看 report 并唯一指定数据源和检索式')
          const run = runs[0]!
          const pageNo = integer(args, 'page') ?? run.progress.lastCommittedPage + 1
          const result = await service.roundReport(task.id, selected.id)
          if (!result.canContinue) throw new SearchError('conflict', '这轮当前不可续检，请检查活动轮次、检索条件和运行状态')
          service.focusTask(task.id, task.title, sessionId, true)
          const operation = service.continuePage(task.id, { roundId: selected.id, source: run.source, queryId: run.queryId, pageNo }, 'model')
          const completed = await waitForPage(operation)
          if (!completed) return `第 ${selected.index} 轮 ${run.source} 第 ${pageNo} 页仍在执行，可用 report 查询结果。`
          const latest = await service.roundReport(task.id, selected.id)
          const updated = latest.round.evidence?.runs.find((entry) => entry.source === run.source && entry.queryId === run.queryId)
          const page = updated?.pages.find((entry) => entry.pageNo === pageNo)
          return toJson({
            round: selected.index, source: run.source, queryId: run.queryId, page: pageNo,
            committed: page?.committed !== undefined, kept: page?.committed?.kept,
            lastAttempt: page?.attempts.at(-1)?.outcome, progress: updated?.progress,
          })
        }
        const report = await service.roundReport(task.id, selected.id)
        const evidence = report.round.evidence
        const source = choice(args, 'source', SOURCE_IDS)
        const queryId = string(args, 'queryId')
        const page = integer(args, 'page')
        const from = integer(args, 'offset', 0) ?? 0
        const size = integer(args, 'limit', 1, 50) ?? 10
        const runs = evidence?.runs.filter((run) =>
          (source === undefined || run.source === source) && (queryId === undefined || run.queryId === queryId)) ?? []
        const pages = runs.flatMap((run) => run.pages.filter((entry) => page === undefined || entry.pageNo === page)
          .map((entry) => ({ source: run.source, queryId: run.queryId, ...entry })))
        return toJson({
          taskId: report.taskId, rev: report.rev, roundId: report.round.id, round: report.round.index,
          conditions: report.round.conditions, stats: report.round.stats, status: report.round.status,
          current: report.isCurrent, hasResults: hasRoundResults(selected), canContinue: report.canContinue,
          evidenceAvailable: evidence !== undefined, counts: evidence?.counts,
          runs: runs.map(({ pages: _pages, ...run }) => run),
          totalPages: pages.length,
          pages: pages.slice(from, from + size).map(({ committed, ...entry }) => ({
            ...entry, committed: committed && {
              ...committed, hits: committed.hits.slice(0, 15).map((hit) => ({
                ...hit, title: hit.status === 'invalid' ? undefined : report.records[hit.recordId]?.title,
              })), totalHits: committed.hits.length,
            },
          })),
          totalReviews: evidence?.reviews.length ?? 0,
          reviews: evidence?.reviews.slice(from, from + size).map((review) => ({
            ...review, records: review.recordIds.map((id) => report.records[id]).filter(Boolean),
          })),
          groups: evidence?.groups.filter((group) => group.members.length > 1).slice(from, from + size),
        })
      }),
    tool('literature_paper',
      '读取和操作单篇文献。get 返回完整摘要与 PDF/Zotero 状态；fulltext 读网页全文文本；entities 查 PubTator 实体；translate 用插件引擎翻译标题和摘要；open 在右侧栏打开；attachments 列出本会话上传的 PDF；attachPdf 把唯一匹配的聊天附件或用户指定的本地 PDF 关联为正文，可替换；detachPdf 解除关联；recheckPdf 查本地 PDF 是否仍存在。',
      ['get', 'fulltext', 'entities', 'translate', 'open', 'attachments', 'attachPdf', 'detachPdf', 'recheckPdf'], {
        taskId, paperId, identifier, offset,
        attachment: text('本会话上传的 PDF 文件名或 sha256 标识。未指定时优先用用户最新消息中的唯一 PDF，否则用会话中唯一的 PDF。'),
        path: text('用户明确提供的本机 PDF 路径，仅在使用本机文件时传入。'),
        provider: oneOf(TRANSLATE_ENGINES), target: oneOf(TRANSLATE_TARGETS),
      }, async (args, sessionId, signal) => {
        const action = args['action']
        if (action === 'attachments') {
          const store = deps.sessionFiles?.()
          if (!store || !sessionId) throw new SearchError('bad_request', '当前宿主未提供聊天附件读取')
          return toJson(await sessionPdfs(store, sessionId, signal))
        }
        const task = await modelTask(service, sessionId, string(args, 'taskId'))
        const paper = choosePaper(task, args)
        if (action === 'open') {
          const response = queued(service, sessionId, { action: 'paper', taskId: task.id, paperId: paper.paperId, title: paper.title })
          return `已请求打开「${paper.title}」。${response}`
        }
        const workspace = await resolveSessionWorkspace(sessionId)
        if (action === 'get') return toJson(await service.paperDetail(task.id, paper.paperId, workspace))
        if (action === 'entities') return toJson(await service.entities(task.id, paper.paperId, signal))
        if (action === 'recheckPdf') return toJson(await service.recheckPdf(task.id, paper.paperId))
        if (action === 'fulltext') {
          const html = await service.fullText(task.id, paper.paperId)
          const full = stripTags(html.slice(html.indexOf('<body>') + '<body>'.length))
          const from = integer(args, 'offset', 0) ?? 0
          return toJson({
            title: paper.title, offset: from, length: full.length, text: full.slice(from, from + 14000),
            nextOffset: from + 14000 < full.length ? from + 14000 : null,
          })
        }
        if (action === 'translate') {
          if (deps.translate === undefined) throw new SearchError('bad_request', '当前宿主没有翻译服务')
          return toJson(await deps.translate({
            texts: [paper.title, paper.abstractCompleteness === 'unknown'
              ? stripTags(paper.abstract).replace(/\s*…$/u, '') : stripTags(paper.abstract)], provider: choice(args, 'provider', TRANSLATE_ENGINES),
            target: choice(args, 'target', TRANSLATE_TARGETS),
          }, signal))
        }
        if (action === 'detachPdf') {
          const detail = await service.detachPdf(task.id, paper.paperId, workspace)
          return toJson({ title: paper.title, associated: false, pdfStatus: detail.state?.pdfStatus, path: detail.state?.pdfFile })
        }
        const roundBefore = activeRoundOf(task)?.id ?? null
        const maxBytes = getSettings().pdfMaxMb * 1024 * 1024
        const path = string(args, 'path')
        const selector = string(args, 'attachment')
        if (path !== undefined && selector !== undefined) throw new SearchError('bad_request', '请只选聊天附件或本机路径之一')
        let bytes: Buffer
        let fileName = path
        if (path !== undefined) {
          bytes = await readLocalPdf(path, workspace, maxBytes)
        } else {
          const store = deps.sessionFiles?.()
          const attachments = deps.attachments?.()
          if (!store || !attachments || !sessionId) throw new SearchError('bad_request', '此宿主没有聊天附件读取，请提供本机 PDF 路径')
          const refs = await sessionPdfs(store, sessionId, signal, selector === undefined)
          const digest = selector?.replace(/^sha256:/, '')
          const candidates = selector === undefined ? refs : refs.filter((entry) =>
            entry.name === selector || (digest !== undefined && /^[a-f0-9]{8,64}$/i.test(digest) &&
              entry.attachmentId.replace(/^sha256:/, '').startsWith(digest.toLowerCase())),
          )
          if (candidates.length !== 1) throw new SearchError(
            candidates.length === 0 ? 'not_found' : 'conflict',
            candidates.length === 0 ? '当前会话没有匹配的 PDF 附件' :
              `请指定 PDF 附件：${candidates.map(({ name, attachmentId }) => `${name} (${attachmentId})`).join('、')}`,
          )
          fileName = candidates[0]!.name
          bytes = await readAttachmentPdf(attachments, candidates[0]!, maxBytes, signal)
        }
        const detail = await service.associatePdf(task.id, paper.paperId, bytes, workspace, roundBefore)
        return toJson({ title: paper.title, paperId: detail.paper.paperId, associated: true, file: fileName, path: detail.state?.pdfMaterial?.path })
      }),
    tool('literature_panel',
      '操作当前会话右侧栏。view 查询筛选、页码和勾选；show 切换结果、全文台账、概览、分组、笔记或对比区域，可同时改筛选和翻页；status 查询面板指令或用户确认的实际结果。若下一步要基于修改后的面板范围操作，先确认 status 已完成。',
      ['view', 'show', 'status'], {
        taskId, tab: oneOf(TABS), page: { type: 'integer', minimum: 1 },
        filters: { type: 'object', properties: panelFilters, additionalProperties: false, description: '要应用的筛选全集，空对象清空筛选。' },
        commandId: text('已下发的面板指令 ID。'),
      }, async (args, sessionId) => {
        if (args['action'] === 'status') return toJson(service.panelResult(string(args, 'commandId', true)!, sessionId))
        const task = await modelTask(service, sessionId, string(args, 'taskId'))
        const snapshot = await service.getViewSnapshot(sessionId, task.id)
        if (args['action'] === 'view') return toJson({
          taskId: task.id, title: task.title, round: activeRoundOf(task)?.index, snapshot,
          selected: snapshot?.selectedIds.flatMap((id) => {
            const paper = task.result.papers.find((entry) => entry.paperId === id)
            return paper === undefined ? [] : [{ paperId: id, title: paper.title }]
          }),
        })
        const filters = args['filters'] === undefined ? undefined : checkedFilters(args['filters'])
        const page = integer(args, 'page')
        const tab = choice(args, 'tab', TABS) ?? 'results'
        if (tab !== 'results' && page !== undefined) throw new SearchError('bad_request', '翻页用于结果页，请选择 results')
        if (page !== undefined) {
          const result = await service.results(task.id, { ...toPaperFilter(filters ?? snapshot?.filters ?? {}), limit: 1 })
          const pageCount = Math.max(1, Math.ceil(result.total / RESULT_PAGE_SIZE))
          if (page > pageCount) throw new SearchError('bad_request', `结果只有 ${pageCount} 页`)
        }
        const response = queued(service, sessionId, { action: 'view', taskId: task.id, tab, page, filters, roundId: activeRoundOf(task)?.id })
        service.setCurrentTask(task.id, sessionId)
        return response
      }),
    tool('literature_transfer',
      '查询当前轮次的逐篇 PDF 下载和 Zotero 同步结果。status 可只看下载失败或指定分类内已存题录但缺 PDF 的条目。resumeAttachments 仅为已核验存入指定分类、缺少附件的条目补传 PDF。',
      ['status', 'resumeAttachments'], {
        taskId, paperId, identifier, limit, offset, collection: text('Zotero 分类名称或 ID。补传时必填。'),
        filter: oneOf(['all', 'downloadFailures', 'pendingAttachments'] as const),
        commandId: text('下载或 Zotero 工具返回的指令 ID，可读取这一批的实际结果。'),
      }, async (args, sessionId) => {
        const commandId = string(args, 'commandId')
        if (args['action'] === 'status' && commandId !== undefined) {
          return toJson(service.transfers.details(commandId, sessionId, integer(args, 'offset', 0) ?? 0, integer(args, 'limit', 1, 100) ?? 20))
        }
        const task = await modelTask(service, sessionId, string(args, 'taskId'))
        const filter = choice(args, 'filter', ['all', 'downloadFailures', 'pendingAttachments'] as const)
        const paper = args['paperId'] !== undefined || args['identifier'] !== undefined ? choosePaper(task, args) : undefined
        const collection = string(args, 'collection', args['action'] === 'resumeAttachments')
        const target = collection === undefined ? undefined : await service.zoteroTargets().then((result) => {
          const match = matchZoteroTarget(result.targets, collection)
          if (!result.ok || match.kind !== 'matched') {
            throw new SearchError('bad_request', result.error ?? `请唯一指定 Zotero 分类：${match.kind === 'matched' ? collection : match.candidates.map((entry) => entry.name).join('、')}`)
          }
          return match.target
        })
        const rows = (paper === undefined ? task.result.papers : [paper]).map((entry) => {
          const state = task.states[entry.paperId]
          const zotero = (state?.zoteroTransfers ?? []).filter((transfer) => target === undefined || transfer.targetId === target.id)
          const status = pdfStatusOf(task, entry)
          return {
            paperId: entry.paperId, title: entry.title, status, path: state?.pdfFile, error: state?.pdfError,
            zotero, downloadFailed: state?.pdfError !== undefined && status !== 'downloaded',
            pendingAttachment: zotero.some((transfer) => transfer.parent.status === 'done' && transfer.attachment.status !== 'done'),
          }
        })
        const matched = rows.filter((row) => filter === 'downloadFailures' ? row.downloadFailed : filter === 'pendingAttachments' ? row.pendingAttachment : true)
        const from = integer(args, 'offset', 0) ?? 0
        const size = integer(args, 'limit', 1, 100) ?? 20
        if (args['action'] === 'status') return toJson({ taskId: task.id, total: matched.length, items: matched.slice(from, from + size) })
        if (target === undefined) throw new SearchError('bad_request', '补传必须指定 Zotero 分类')
        const candidates = matched.filter((row) => row.pendingAttachment).slice(from, from + size)
        if (candidates.length === 0) return '该范围暂无已保存题录但缺附件的文献。'
        const result = await service.zoteroSync(
          task.id, candidates.map((entry) => entry.paperId), await resolveSessionWorkspace(sessionId), target, true,
        )
        return toJson(result)
      }),
    settingsTool(service, deps),
  ]
}

async function waitForPage(operation: Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(resolve, 20_000, false) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function checkedFilters(value: unknown): Record<string, string | boolean | number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SearchError('bad_request', 'filters 需要对象')
  }
  const result: Record<string, string | boolean | number> = {}
  for (const [key, entry] of Object.entries(value)) {
    const field = panelFilters[key as keyof typeof panelFilters]
    if (!Object.hasOwn(panelFilters, key) || field === undefined ||
      (field.type === 'integer' ? typeof entry !== 'number' || !Number.isInteger(entry) :
        typeof entry !== field.type) || ('enum' in field && !(field.enum as readonly unknown[]).includes(entry))) {
      throw new SearchError('bad_request', `不支持的面板筛选：${key}`)
    }
    if (typeof entry === 'number' && (entry < 1 || entry > 3000)) throw new SearchError('bad_request', '年份范围为 1 至 3000')
    result[key] = entry as string | boolean | number
  }
  if (typeof result['yearFrom'] === 'number' && typeof result['yearTo'] === 'number' && result['yearFrom'] > result['yearTo']) {
    throw new SearchError('bad_request', '起始年份不能晚于截止年份')
  }
  return result
}

function settingsTool(service: TaskService, deps: ModelOperationDeps): Operation {
  return tool('literature_settings',
    '查看和调整文献检索插件设置。get 读有效配置及密钥是否已配置；update 修改或重置插件字段；probeSource 测试数据源；probeStorage 测试存储；probeZotero、zoteroTargets 检查 Zotero；authorization 查写入授权；requestAuthorization、cleanup、deleteTask 在右侧栏发起用户确认。',
    ['get', 'update', 'probeSource', 'probeStorage', 'probeZotero', 'zoteroTargets', 'authorization', 'requestAuthorization', 'cleanup', 'deleteTask'], {
      taskId, source: oneOf(SOURCE_IDS), scope: oneOf(CLEANUP),
      patch: { type: 'object', description: '只写需要修改的字段，字段名和值类型见 get。API 密钥用设置页输入。' },
      reset: { type: 'array', items: { type: 'string' }, description: '清除字段覆盖，恢复继承值。' },
    }, async (args, sessionId) => {
      const action = args['action']
      const config = getSettings()
      if (action === 'get') {
        const { ncbiApiKey, openalexApiKey, s2ApiKey, serpApiKey, ...visible } = config
        return toJson({ ...visible, keys: {
          ncbiApiKey: ncbiApiKey !== '', openalexApiKey: openalexApiKey !== '',
          s2ApiKey: s2ApiKey !== '', serpApiKey: serpApiKey !== '',
        } })
      }
      if (action === 'probeSource') {
        const source = choice(args, 'source', SOURCE_IDS)
        if (source === undefined) throw new SearchError('bad_request', '请指定来源')
        return toJson(await service.probe(source))
      }
      if (action === 'probeStorage') return toJson(await service.storageProbe(await resolveSessionWorkspace(sessionId)))
      if (action === 'probeZotero') return toJson(await service.zoteroProbe())
      if (action === 'zoteroTargets') return toJson(await service.zoteroTargets())
      if (action === 'authorization') return toJson(await service.zoteroAuthorization())
      if (action === 'requestAuthorization') return queued(service, sessionId, {
        action: 'confirm', message: '允许文献检索插件申请本机 Zotero 写入权限？Zotero 可能会显示授权窗口。',
      }, async () => toJson(await service.zoteroAuthorization(true)))
      if (action === 'cleanup') {
        const scope = choice(args, 'scope', CLEANUP)
        if (scope === undefined) throw new SearchError('bad_request', '请指定清理范围')
        const label = { tasks: '未置顶任务', pdf: '插件 PDF 缓存', all: '未置顶任务和插件 PDF 缓存' }[scope]
        return queued(service, sessionId, { action: 'confirm', message: `确定清理${label}？` },
          async () => toJson(await service.cleanup(scope)))
      }
      if (action === 'deleteTask') {
        const id = string(args, 'taskId', true)!
        const task = await service.get(id)
        return queued(service, sessionId, { action: 'confirm', message: `确定删除任务「${task.title}」（${task.id}）？` },
          async () => { await service.remove(id); return `已删除「${task.title}」` })
      }
      if (deps.updateSettings === undefined) throw new SearchError('bad_request', '宿主未提供持久化设置接口')
      if (args['patch'] !== undefined && (args['patch'] === null || typeof args['patch'] !== 'object' || Array.isArray(args['patch']))) {
        throw new SearchError('bad_request', 'patch 需要对象')
      }
      const patch = asRecord(args['patch'])
      const resetValue = args['reset']
      if (resetValue !== undefined && (!Array.isArray(resetValue) || resetValue.some((entry) => typeof entry !== 'string'))) {
        throw new SearchError('bad_request', 'reset 需要字段名数组')
      }
      const reset = (resetValue ?? []) as string[]
      for (const key of [...Object.keys(patch), ...reset]) {
        if (!Object.hasOwn(config, key)) throw new SearchError('bad_request', `未知配置字段：${key}`)
      }
      for (const [key, value] of Object.entries(patch)) {
        if ((SECRETS as readonly string[]).includes(key)) throw new SearchError('bad_request', 'API 密钥请通过插件设置的密钥输入框填写')
        const current = config[key as keyof typeof config]
        if (Array.isArray(current) ? !Array.isArray(value) || value.some((entry) => !SOURCE_IDS.includes(entry)) :
          typeof value !== typeof current || (typeof value === 'number' && !Number.isFinite(value))) {
          throw new SearchError('bad_request', `配置值类型不正确：${key}`)
        }
      }
      const update = async () => {
        await deps.updateSettings!(patch, reset)
        return `配置已保存：${[...new Set([...Object.keys(patch), ...reset])].join('、')}`
      }
      if (Object.keys(patch).length + reset.length === 0) return '没有要保存的字段。'
      if (reset.some((key) => (SECRETS as readonly string[]).includes(key))) {
        return queued(service, sessionId, { action: 'confirm', message: `确定重置插件配置 ${reset.join('、')}？这会移除对应的密钥覆盖。` }, update)
      }
      return update()
    })
}
