/**
 * 检索执行步骤进度面板。
 *
 * 展示当前轮预生成的固定步骤清单：整体进度条 + 按检索式分组的数据源查询
 * + 末尾的数据去重。步骤状态来自 TaskDetail.steps，随任务详情轮询刷新。
 */

import type { CSSProperties, ReactElement } from 'react'

import type { TaskStep, TaskStepStatus } from '../search/types'
import { SpinnerIcon } from './icons'
import { tpl, type Translate } from './locales'
import { ACCENT, ERROR } from './styles'

interface Props {
  t: Translate
  steps: readonly TaskStep[]
}

const GLYPH: Record<TaskStepStatus, string> = {
  pending: '○',
  running: '',
  done: '✓',
  skipped: '–',
  failed: '!',
}

const COLOR: Record<TaskStepStatus, CSSProperties['color']> = {
  pending: '#8a93a6',
  running: ACCENT,
  done: '#2f9e5f',
  skipped: '#8a93a6',
  failed: ERROR,
}

function isFinal(status: TaskStepStatus): boolean {
  return status === 'done' || status === 'skipped' || status === 'failed'
}

export function RunProgressPanel({ t, steps }: Props): ReactElement {
  const total = steps.length
  const finished = steps.filter((step) => isFinal(step.status)).length
  const percent = total === 0 ? 0 : Math.round((finished / total) * 100)

  // 去重是毫秒级同步操作，轮询不一定命中 running 那一瞬；
  // 若其余步骤已全部终态而去重仍 pending，UI 上按「去重中」渲染。
  const dedup = steps.find((step) => step.kind === 'dedup')
  const others = steps.filter((step) => step.kind !== 'dedup')
  const dedupStatus: TaskStepStatus =
    dedup !== undefined && dedup.status === 'pending' && others.length > 0 && others.every((step) => isFinal(step.status))
      ? 'running'
      : (dedup?.status ?? 'pending')
  const dedupShown: TaskStep | undefined = dedup === undefined ? undefined : { ...dedup, status: dedupStatus }

  const groups = steps.filter((step) => step.kind === 'query')

  return (
    <div style={PANEL_STYLE} role="status" aria-live="polite">
      <div style={HEAD_STYLE}>
        <span>{t('task.progress.title')}</span>
        <span>{tpl(t('task.progress.count'), { done: finished, total })}</span>
      </div>
      <div style={BAR_TRACK_STYLE}>
        <div style={{ ...BAR_FILL_STYLE, width: `${percent}%` }} />
      </div>

      {groups.map((group) => (
        <div key={group.id} style={GROUP_STYLE}>
          <div style={GROUP_TITLE_STYLE}>
            <Mark status={group.status} />
            <span style={GROUP_LABEL_STYLE}>{group.label}</span>
          </div>
          {steps
            .filter((step) => step.kind === 'source' && step.queryIndex === group.queryIndex)
            .map((step) => (
              <div key={step.id} style={ROW_STYLE}>
                <Mark status={step.status} />
                <div style={ROW_BODY_STYLE}>
                  <div style={ROW_MAIN_STYLE}>
                    <span style={ROW_LABEL_STYLE}>{t(`source.${step.source ?? ''}`)}</span>
                    <span style={{ ...ROW_VALUE_STYLE, color: COLOR[step.status] }}>
                      {sourceText(t, step)}
                    </span>
                  </div>
                  {step.status === 'skipped' && step.error !== undefined && step.error !== '' && (
                    <div style={SKIP_REASON_STYLE}>{step.error}</div>
                  )}
                </div>
              </div>
            ))}
        </div>
      ))}

      {dedupShown !== undefined && (
        <div style={ROW_STYLE}>
          <Mark status={dedupShown.status} />
          <span style={ROW_LABEL_STYLE}>{t('task.progress.dedup')}</span>
          <span style={{ ...ROW_VALUE_STYLE, color: COLOR[dedupShown.status] }}>
            {dedupText(t, dedupShown)}
          </span>
        </div>
      )}
    </div>
  )
}

function sourceText(t: Translate, step: TaskStep): string {
  switch (step.status) {
    case 'running':
      return t('task.progress.sourceRunning')
    case 'done':
      return tpl(t('task.progress.sourceDone'), { n: step.count ?? 0 })
    case 'skipped':
      return t('task.progress.sourceSkipped')
    case 'failed':
      return tpl(t('task.progress.sourceFailed'), { message: step.error ?? '' })
    default:
      return t('task.step.pending')
  }
}

function dedupText(t: Translate, step: TaskStep): string {
  switch (step.status) {
    case 'running':
      return t('task.progress.dedupRunning')
    case 'done':
      return tpl(t('task.progress.dedupDone'), { n: step.count ?? 0 })
    case 'skipped':
      return t('task.step.skipped')
    case 'failed':
      return tpl(t('task.progress.sourceFailed'), { message: step.error ?? '' })
    default:
      return t('task.step.pending')
  }
}

function Mark({ status }: { status: TaskStepStatus }): ReactElement {
  return (
    <span
      style={{ color: COLOR[status], flexShrink: 0, width: 14, textAlign: 'center', display: 'inline-flex', justifyContent: 'center' }}
      aria-hidden
    >
      {status === 'running' ? <SpinnerIcon /> : GLYPH[status]}
    </span>
  )
}

const PANEL_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignSelf: 'center',
  width: '100%',
  maxWidth: 320,
  marginTop: 0,
  gap: 5,
  padding: '8px 10px',
  borderRadius: 12,
  border: '1px solid var(--ls-accent-line)',
  background: 'var(--ls-accent-soft)',
  fontSize: 12,
  lineHeight: 1.4,
}

const HEAD_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  fontWeight: 500,
  fontSize: 11.5,
  color: 'var(--ls-accent-ink)',
}

const BAR_TRACK_STYLE: CSSProperties = {
  height: 3,
  borderRadius: 999,
  background: 'var(--ls-accent-soft-2)',
  overflow: 'hidden',
}

const BAR_FILL_STYLE: CSSProperties = {
  height: '100%',
  borderRadius: 2,
  background: 'linear-gradient(90deg, var(--ls-accent), var(--ls-accent-2))',
  transition: 'width 0.3s ease',
}

const GROUP_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  paddingLeft: 7,
  borderLeft: '2px solid var(--ls-accent-line)',
}

const GROUP_TITLE_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  fontWeight: 500,
  fontSize: 11.5,
  color: 'inherit',
}

const GROUP_LABEL_STYLE: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 5,
  paddingLeft: 8,
}

const ROW_BODY_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
}

const ROW_MAIN_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  minWidth: 0,
}

const SKIP_REASON_STYLE: CSSProperties = {
  fontSize: 10.5,
  lineHeight: 1.35,
  color: '#8a93a6',
  overflowWrap: 'anywhere',
}

const ROW_LABEL_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  opacity: 0.85,
}

const ROW_VALUE_STYLE: CSSProperties = {
  flexShrink: 0,
  fontSize: 11,
  textAlign: 'right',
}
