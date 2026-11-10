/**
 * 任务「对比」tab：按稳定 paperId 与旧任务比较新增/缺失。
 *
 * 默认选建立任务时继承的 `fromTaskId`；对比由 Host 计算，面板只负责选基准
 * 和展示结果。点「只看新增」把结果页切成 `newOnly` 筛选。
 */

import { useEffect, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'

import type { ComparePaper, CompareResult, TaskSummary } from '../search/types'
import { fetchCompare, listTasks } from './api'
import { tpl, type Translate } from './locales'
import { ERROR, linkButtonStyle, linkStyle, statusStyle } from './styles'

interface Props {
  t: Translate
  taskId: string
  fromTaskId?: string
  rev: number
  busy?: boolean
  onOnlyNew(): void
  onInclude?(paperIds: readonly string[]): void
}

interface State {
  tasks: TaskSummary[] | null
  report: CompareResult | null
  loading: boolean
  error: string | null
}

export function CompareTab({
  t,
  taskId,
  fromTaskId,
  rev,
  busy = false,
  onOnlyNew,
  onInclude,
}: Props): ReactElement {
  const [baseId, setBaseId] = useState(fromTaskId ?? '')
  const [state, setState] = useState<State>({
    tasks: null,
    report: null,
    loading: false,
    error: null,
  })

  useEffect(() => {
    const controller = new AbortController()
    listTasks(controller.signal)
      .then((tasks) => {
        if (controller.signal.aborted) return
        const others = tasks.filter((task) => task.id !== taskId)
        setState((previous) => ({ ...previous, tasks: others }))
        setBaseId((current) => {
          if (current !== '') return current
          if (fromTaskId !== undefined && others.some((task) => task.id === fromTaskId)) {
            return fromTaskId
          }
          return others[0]?.id ?? ''
        })
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState((previous) => ({ ...previous, tasks: [] }))
        }
      })
    return () => {
      controller.abort()
    }
  }, [taskId, fromTaskId])

  useEffect(() => {
    if (baseId === '') return undefined
    const controller = new AbortController()
    setState((previous) => ({ ...previous, loading: true, error: null }))
    fetchCompare(taskId, baseId, controller.signal)
      .then((report) => {
        if (!controller.signal.aborted) {
          setState((previous) => ({ ...previous, report, loading: false, error: null }))
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState((previous) => ({
          ...previous,
          report: null,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }))
      })
    return () => {
      controller.abort()
    }
  }, [taskId, baseId, rev])

  const report = state.report

  return (
    <div style={WRAP_STYLE}>
      <div style={statusStyle}>{t('compare.title')}</div>

      {state.tasks !== null && state.tasks.length === 0 ? (
        <div style={statusStyle}>{t('compare.none')}</div>
      ) : (
        <div style={PICK_ROW_STYLE}>
          <label style={FIELD_STYLE}>
            <span>{t('compare.base')}</span>
            <select
              style={SELECT_STYLE}
              value={baseId}
              onChange={(event) => setBaseId(event.target.value)}
            >
              <option value="">{t('compare.pick')}</option>
              {(state.tasks ?? []).map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </label>
          {fromTaskId !== undefined && (
            <button type="button" style={linkButtonStyle} onClick={onOnlyNew}>
              {t('compare.onlyNew')}
            </button>
          )}
        </div>
      )}

      {state.loading && <div style={statusStyle}>{t('compare.loading')}</div>}
      {state.error !== null && (
        <div style={{ ...statusStyle, color: ERROR }}>
          {tpl(t('compare.failed'), { message: state.error })}
        </div>
      )}

      {report !== null && (
        <>
          <div style={statusStyle}>
            {tpl(t('compare.summary'), {
              total: report.counts.total,
              baseTotal: report.counts.baseTotal,
              added: report.counts.added,
              common: report.counts.common,
              missing: report.counts.missing,
            })}
          </div>

          {report.counts.added === 0 && report.counts.missing === 0 && (
            <div style={statusStyle}>{t('compare.empty')}</div>
          )}

          {report.added.length > 0 && (
            <Section
              title={`${t('compare.added')}（${report.counts.added}）`}
              action={
                onInclude === undefined ? undefined : (
                  <button
                    type="button"
                    style={linkButtonStyle}
                    disabled={busy || state.loading}
                    onClick={() => onInclude(report.added.map((paper) => paper.paperId))}
                  >
                    {tpl(t('compare.includeAdded'), { n: report.added.length })}
                  </button>
                )
              }
            >
              {report.added.slice(0, 50).map((paper) => (
                <PaperRow key={paper.paperId} paper={paper} />
              ))}
            </Section>
          )}

          {report.missing.length > 0 && (
            <Section title={`${t('compare.missing')}（${report.counts.missing}）`}>
              {report.missing.slice(0, 50).map((paper) => (
                <PaperRow key={paper.paperId} paper={paper} />
              ))}
            </Section>
          )}
        </>
      )}
    </div>
  )
}

function Section({
  title,
  action,
  children,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}): ReactElement {
  return (
    <section>
      <div style={HEAD_ROW_STYLE}>
        <h4 style={HEAD_STYLE}>{title}</h4>
        {action}
      </div>
      <div style={LIST_STYLE}>{children}</div>
    </section>
  )
}

function PaperRow({ paper }: { paper: ComparePaper }): ReactElement {
  const meta = [
    paper.authors.slice(0, 3).join(', '),
    paper.year === null ? '' : String(paper.year),
    paper.venue,
  ]
    .filter((part) => part !== '')
    .join(' · ')
  return (
    <div style={ROW_STYLE}>
      <div style={{ fontSize: 12, lineHeight: 1.45 }}>{paper.title}</div>
      {meta !== '' && <div style={ROW_META_STYLE}>{meta}</div>}
      {paper.doi !== '' && (
        <a
          style={linkStyle}
          href={`https://doi.org/${paper.doi}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          DOI
        </a>
      )}
    </div>
  )
}

const WRAP_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 }
const PICK_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  gap: 8,
  flexWrap: 'wrap',
}
const FIELD_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  fontSize: 11,
  flex: '1 1 160px',
  minWidth: 0,
}
const SELECT_STYLE: CSSProperties = {
  fontSize: 12,
  padding: '3px 5px',
  borderRadius: 4,
  border: '1px solid rgba(127,127,127,0.28)',
  background: 'transparent',
  color: 'inherit',
  minWidth: 0,
}
const HEAD_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
}
const HEAD_STYLE: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  opacity: 0.72,
  margin: '6px 0 2px',
}
const LIST_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column' }
const ROW_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  padding: '5px 0',
  borderTop: '1px solid rgba(127,127,127,0.14)',
}
const ROW_META_STYLE: CSSProperties = { fontSize: 11, opacity: 0.7 }
