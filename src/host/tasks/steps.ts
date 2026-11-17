/**
 * 检索执行步骤的纯逻辑：预生成清单与异常收尾。
 *
 * 步骤清单在轮首按固定数量生成，执行中只按 id 原地改状态，不追加、不删除，
 * 因此并发的源回调不会互相覆盖，UI 也能得到稳定的分母来算整体进度。
 */

import type { SourceId, TaskStatus, TaskStep } from '../../search/types.js'

/**
 * 预生成一轮的步骤清单：每条检索式一个分组步骤 + 其下每个源一个查询步骤，
 * 末尾一个去重步骤。总数 = N × (1 + S) + 1。
 */
export function buildSteps(
  queries: readonly { name: string; text: string }[],
  sources: readonly SourceId[],
): TaskStep[] {
  const steps: TaskStep[] = []
  queries.forEach((query, index) => {
    const queryNo = index + 1
    const label = query.name.trim() !== '' ? query.name : query.text
    steps.push({
      id: `q${queryNo}`,
      kind: 'query',
      label,
      queryIndex: queryNo,
      status: 'pending',
    })
    for (const source of sources) {
      steps.push({
        id: `q${queryNo}:${source}`,
        kind: 'source',
        label: source,
        queryIndex: queryNo,
        source,
        status: 'pending',
      })
    }
  })
  steps.push({ id: 'dedup', kind: 'dedup', label: 'dedup', status: 'pending' })
  return steps
}

/** 轮次结束时把未完步骤收尾，避免面板出现「永远进行中」。 */
export function finalizeSteps(
  steps: readonly TaskStep[],
  status: TaskStatus,
  reason?: string,
): void {
  for (const step of steps) {
    if (step.status !== 'running' && step.status !== 'pending') continue
    if (status === 'canceled') {
      step.status = 'skipped'
      step.error = reason ?? '检索已取消'
    } else if (status === 'error') {
      step.status = step.status === 'running' ? 'failed' : 'skipped'
      step.error = reason ?? '检索失败'
    } else {
      step.status = 'skipped'
      step.error = '本轮已结束'
    }
  }
}
