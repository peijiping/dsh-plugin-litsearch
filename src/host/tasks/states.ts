/**
 * 筛读台账：论文级状态（四态筛读 / 分组 / 必读顺序 / 备注 / 标签）与任务分组。
 *
 * 所有写入口（面板注解、模型 `literature_task annotate`、分组编辑）都先经过
 * 这里的校验，确保状态结构稳定；`states` 以稳定的 `paperId` 为键，因此跨任务
 * 继承与重跑都不会错位。
 */

import { SearchError } from '../../search/errors.js'
import type {
  AnnotationInput,
  Paper,
  PaperState,
  PdfStatus,
  Screening,
  SearchTask,
  TaskGroup,
} from '../../search/types.js'

const MAX_ANNOTATIONS = 50
const MAX_GROUPS = 50
const MAX_GROUP_NAME = 60
const MAX_GROUP_DESCRIPTION = 500
const MAX_NOTE = 4000
const MAX_PDF_ERROR = 300
const MAX_PDF_FILE = 1024
const MAX_SHORTLIST_ORDER = 100_000

export const SCREENINGS: readonly Screening[] = ['unread', 'read', 'included', 'excluded']

export const PDF_STATUSES: readonly PdfStatus[] = [
  'unknown',
  'available',
  'downloaded',
  'missing',
  'html-only',
  'paywalled',
  'blocked',
  'failed',
]

export function isScreening(value: unknown): value is Screening {
  return typeof value === 'string' && (SCREENINGS as readonly string[]).includes(value)
}

export function isPdfStatus(value: unknown): value is PdfStatus {
  return typeof value === 'string' && (PDF_STATUSES as readonly string[]).includes(value)
}

export function emptyState(): PaperState {
  return { screening: 'unread' }
}

/** 当前任务里每篇论文的有效状态（缺省为未读）。 */
export function stateOf(task: SearchTask, paperId: string): PaperState {
  return task.states[paperId] ?? emptyState()
}

/** 按当前结果集统计四态数量；被删掉的结果不计入。 */
export function countScreening(
  papers: readonly Paper[],
  states: Readonly<Record<string, PaperState>>,
): Record<Screening, number> {
  const counts: Record<Screening, number> = { unread: 0, read: 0, included: 0, excluded: 0 }
  for (const paper of papers) {
    counts[states[paper.paperId]?.screening ?? 'unread'] += 1
  }
  return counts
}

/** 校验并合并一批注解；返回更新后的 states 与命中条数。 */
export function applyAnnotations(
  task: SearchTask,
  inputs: readonly AnnotationInput[],
): { states: Record<string, PaperState>; updated: number } {
  if (inputs.length === 0) throw new SearchError('bad_request', 'papers 不能为空')
  if (inputs.length > MAX_ANNOTATIONS) {
    throw new SearchError('bad_request', `一次最多注解 ${MAX_ANNOTATIONS} 篇`)
  }

  const known = new Set(task.result.papers.map((paper) => paper.paperId))
  const groupIds = new Set(task.groups.map((group) => group.id))
  const states: Record<string, PaperState> = { ...task.states }
  let updated = 0

  for (const input of inputs) {
    const paperId = input.paperId.trim()
    if (paperId === '') throw new SearchError('bad_request', 'paperId 不能为空')
    if (!known.has(paperId)) {
      throw new SearchError('bad_request', `任务里没有这篇文献：${paperId}`)
    }

    const next: PaperState = { ...(states[paperId] ?? emptyState()) }
    let touched = false

    if (input.screening !== undefined) {
      if (!isScreening(input.screening)) {
        throw new SearchError('bad_request', `screening 只能是 ${SCREENINGS.join(' / ')}`)
      }
      next.screening = input.screening
      touched = true
    }

    if (input.groupId !== undefined) {
      if (input.groupId === null || input.groupId === '') {
        delete next.groupId
      } else {
        if (!groupIds.has(input.groupId)) {
          throw new SearchError('bad_request', `未知分组：${input.groupId}`)
        }
        next.groupId = input.groupId
      }
      touched = true
    }

    if (input.shortlistOrder !== undefined) {
      if (input.shortlistOrder === null) {
        delete next.shortlistOrder
      } else {
        if (
          !Number.isInteger(input.shortlistOrder) ||
          input.shortlistOrder < 0 ||
          input.shortlistOrder > MAX_SHORTLIST_ORDER
        ) {
          throw new SearchError(
            'bad_request',
            `shortlistOrder 必须是 0..${MAX_SHORTLIST_ORDER} 的整数`,
          )
        }
        next.shortlistOrder = input.shortlistOrder
      }
      touched = true
    }

    if (input.note !== undefined) {
      if (typeof input.note !== 'string') throw new SearchError('bad_request', 'note 必须是字符串')
      const note = input.note.trim()
      if (note === '') delete next.note
      else next.note = note.slice(0, MAX_NOTE)
      touched = true
    }

    if (input.pdfStatus !== undefined) {
      if (!isPdfStatus(input.pdfStatus)) {
        throw new SearchError('bad_request', `pdfStatus 只能是 ${PDF_STATUSES.join(' / ')}`)
      }
      next.pdfStatus = input.pdfStatus
      touched = true
    }

    if (input.pdfError !== undefined) {
      if (typeof input.pdfError !== 'string') {
        throw new SearchError('bad_request', 'pdfError 必须是字符串')
      }
      const reason = input.pdfError.trim()
      if (reason === '') delete next.pdfError
      else next.pdfError = reason.slice(0, MAX_PDF_ERROR)
      touched = true
    }

    if (input.pdfFile !== undefined) {
      if (typeof input.pdfFile !== 'string') {
        throw new SearchError('bad_request', 'pdfFile 必须是字符串')
      }
      const file = input.pdfFile.trim()
      if (file === '') delete next.pdfFile
      else next.pdfFile = file.slice(0, MAX_PDF_FILE)
      touched = true
    }

    if (!touched) continue
    states[paperId] = next
    updated += 1
  }

  return { states, updated }
}

/** 校验分组列表：id 唯一、名称非空、顺序重排为连续整数。 */
export function normalizeGroups(values: readonly TaskGroup[] | undefined): TaskGroup[] | undefined {
  if (values === undefined) return undefined
  if (!Array.isArray(values)) throw new SearchError('bad_request', 'groups 必须是数组')
  if (values.length > MAX_GROUPS) {
    throw new SearchError('bad_request', `分组最多 ${MAX_GROUPS} 个`)
  }

  const seen = new Set<string>()
  const groups: TaskGroup[] = []
  for (const raw of values) {
    const id = raw.id.trim()
    if (id === '' || id.length > 40) {
      throw new SearchError('bad_request', '分组 id 必须是 1..40 个字符')
    }
    if (seen.has(id)) throw new SearchError('bad_request', `分组 id 重复：${id}`)
    seen.add(id)
    const name = raw.name.trim()
    if (name === '') throw new SearchError('bad_request', '分组名称不能为空')
    const group: TaskGroup = {
      id,
      name: name.slice(0, MAX_GROUP_NAME),
      order: groups.length,
    }
    const description = raw.description?.trim() ?? ''
    if (description !== '') group.description = description.slice(0, MAX_GROUP_DESCRIPTION)
    groups.push(group)
  }
  return groups
}

/** 分组若仍有论文引用，删除前提醒调用方（调用方决定是否允许）。 */
export function groupUsage(task: SearchTask, groupId: string): number {
  return Object.values(task.states).filter((state) => state.groupId === groupId).length
}

/** 按必读顺序、年份、标题排序某组的论文。 */
export function sortGroupPapers(task: SearchTask, papers: readonly Paper[]): Paper[] {
  return [...papers].sort((a, b) => {
    const left = stateOf(task, a.paperId).shortlistOrder
    const right = stateOf(task, b.paperId).shortlistOrder
    if (left !== undefined || right !== undefined) {
      if (left === undefined) return 1
      if (right === undefined) return -1
      if (left !== right) return left - right
    }
    return (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title)
  })
}
