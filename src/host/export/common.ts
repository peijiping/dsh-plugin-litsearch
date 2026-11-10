/**
 * 导出共用上下文：把任务、待导出论文与可选的对比基准打包给各格式渲染器。
 */

import type { Paper, SearchTask } from '../../search/types.js'
import { stateOf } from '../tasks/states.js'

export interface ExportContext {
  task: SearchTask
  papers: Paper[]
  /** `markdown` 导出用于生成「与对比任务差异」区块。 */
  base?: SearchTask
  generatedAt: Date
}

export function queryName(task: SearchTask, queryId: string): string {
  return task.conditions.queries.find((query) => query.id === queryId)?.name ?? queryId
}

export function groupName(task: SearchTask, groupId: string | undefined): string {
  if (groupId === undefined) return ''
  return task.groups.find((group) => group.id === groupId)?.name ?? ''
}

export function paperNote(task: SearchTask, paper: Paper): string {
  return stateOf(task, paper.paperId).note ?? ''
}

export function paperTags(task: SearchTask, paper: Paper): string[] {
  return stateOf(task, paper.paperId).tags ?? []
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** 文件名用的安全任务 id（导出统一按 id 命名，避免标题里的路径字符）。 */
export function exportStem(task: SearchTask, date: Date): string {
  return `litsearch-${task.id}-${isoDate(date)}`
}
