/**
 * 任务 tab 正文：一个独立 tab 承载一次检索任务。
 *
 * 任务 id 从 tab 的资源地址解析（不依赖 layout 恢复的 params）；正文自己轮询
 * 运行中的任务，完成即停。关闭 tab 时 `tab.signal` 中止请求。
 */

import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { Paper, TaskDetail } from '../search/types'
import { updateTask, type ResultsQuery } from './api'
import { rememberTaskTitle } from './autoOpen'
import { paperText } from './compose'
import { insertBuilt, type InputActions } from './inline'
import { tpl, type Translate } from './locales'
import { OverviewTab } from './OverviewTab'
import { PaperCard } from './PaperCard'
import { TaskFilters, activeFilterCount } from './TaskFilters'
import {
  ACCENT,
  ERROR,
  actionRowStyle,
  formStyle,
  linkButtonStyle,
  listStyle,
  metaStyle,
  panelStyle,
  statusStyle,
  titleStyle,
  toastStyle,
} from './styles'
import { useTask } from './useTask'

/** 任务 tab 的资源地址前缀（与 index.ts 的 openTask 一致）。 */
export const TASK_ADDRESS_PREFIX = 'dsh-resource://litsearch-task/'

/** `useTabInfo` 中本组件用到的部分。 */
interface TabInfoLike {
  tab: {
    contentId?: string
    navigation?: { address?: string; params?: unknown }
    signal: AbortSignal
  }
}

interface Props {
  t: Translate
  useTabInfo(): TabInfoLike
  inputActions?: InputActions
}

export function taskIdFromAddress(address: string): string | null {
  if (!address.startsWith(TASK_ADDRESS_PREFIX)) return null
  const encoded = address.slice(TASK_ADDRESS_PREFIX.length)
  if (encoded === '' || encoded.includes('/')) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

function parseTaskId(info: TabInfoLike): string | null {
  return taskIdFromAddress(info.tab.navigation?.address || info.tab.contentId || '')
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export function TaskPane({ t, useTabInfo, inputActions }: Props): ReactElement {
  const info = useTabInfo()
  const taskId = parseTaskId(info)
  const [filters, setFilters] = useState<ResultsQuery>({})
  const [tab, setTab] = useState<'results' | 'overview'>('results')
  const view = useTask(taskId, info.tab.signal, undefined, filters)
  const [toast, setToast] = useState('')

  const detail = view.detail
  const filterActive = useMemo(() => activeFilterCount(filters) > 0, [filters])

  useEffect(() => {
    if (detail !== null) rememberTaskTitle(detail.id, detail.title)
  }, [detail])

  useEffect(() => {
    if (toast === '') return undefined
    const timer = setTimeout(() => setToast(''), 2400)
    return () => clearTimeout(timer)
  }, [toast])

  const insert = (paper: Paper): void => {
    void (async () => {
      const outcome = await insertBuilt(inputActions, () => paperText(t, paper))
      if (outcome === 'inserted') setToast(t('result.inserted'))
      else setToast(t(outcome === 'no-editor' ? 'error.noEditor' : 'error.draftChanged'))
    })()
  }

  if (taskId === null) return <div style={panelStyle}>{t('task.notFound')}</div>

  if (detail === null) {
    return (
      <div style={panelStyle}>
        {view.loading ? (
          <div style={statusStyle}>{t('task.loading')}</div>
        ) : (
          <>
            <div style={{ ...statusStyle, color: ERROR }}>{view.error ?? t('task.notFound')}</div>
            <Button variant="outline" size="sm" type="button" onClick={() => view.reload()}>
              {t('task.retry')}
            </Button>
          </>
        )}
      </div>
    )
  }

  const active = detail.status === 'running' || detail.status === 'queued'
  const failed = detail.result.sources.filter((source) => !source.ok)
  const page = view.page

  return (
    <div style={panelStyle}>
      <header>
        <div style={{ ...titleStyle, fontSize: 14 }}>{detail.title}</div>
        <div style={metaStyle}>
          {tpl(t('task.meta'), {
            origin: t(`task.origin.${detail.origin}`),
            date: formatDate(detail.createdAt),
          })}
        </div>
        <div style={{ ...metaStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...statusChipStyle, color: statusColor(detail) }}>
            {t(`task.status.${detail.status}`)}
          </span>
          <span>{tpl(t('task.sourceCount'), { n: detail.conditions.sources.length })}</span>
          <span>{tpl(t('task.pageSize'), { n: detail.conditions.pageSize })}</span>
          <button
            type="button"
            style={linkButtonStyle}
            onClick={() => {
              void updatePin(taskId, detail, view.reload)
            }}
          >
            {detail.pinned ? t('task.unpin') : t('task.pin')}
          </button>
        </div>
      </header>

      {active && (
        <div style={{ ...statusStyle, color: ACCENT }}>
          {detail.progress === undefined
            ? t('task.running')
            : tpl(t('task.progress'), {
                i: detail.progress.queryIndex,
                n: detail.progress.queryTotal,
              })}
        </div>
      )}

      <div style={statusStyle}>
        {tpl(t('task.stats'), {
          raw: detail.stats.rawHits,
          deduped: detail.stats.deduped,
          loaded: detail.result.totalLoaded,
        })}
      </div>

      {failed.length > 0 && (
        <div style={{ ...statusStyle, color: ERROR }}>
          {failed
            .map((source) =>
              tpl(t('error.sourceFailed'), {
                source: t(`source.${source.id}`),
                message: source.error ?? '',
              }),
            )
            .join('；')}
        </div>
      )}

      {detail.error !== undefined && (
        <div style={{ ...statusStyle, color: ERROR }}>{detail.error}</div>
      )}

      <div style={{ ...formStyle, gap: 8 }}>
        <Button
          variant="outline"
          size="sm"
          type="button"
          disabled={active || view.busy}
          onClick={() => {
            void view.rerun()
          }}
        >
          {t('task.rerun')}
        </Button>
        {active && (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={view.busy}
            onClick={() => {
              void view.cancel()
            }}
          >
            {t('task.cancel')}
          </Button>
        )}
        <button type="button" style={linkButtonStyle} onClick={() => view.reload()}>
          {t('task.refresh')}
        </button>
      </div>

      {toast !== '' && <div style={toastStyle}>{toast}</div>}

      {view.error !== null && detail.result.totalLoaded > 0 && (
        <div style={{ ...statusStyle, color: ERROR }}>{view.error}</div>
      )}

      <div style={TAB_ROW_STYLE}>
        <button
          type="button"
          style={tab === 'results' ? TAB_ACTIVE_STYLE : TAB_STYLE}
          onClick={() => setTab('results')}
        >
          {tpl(t('tab.results'), { n: page?.total ?? detail.result.totalLoaded })}
        </button>
        <button
          type="button"
          style={tab === 'overview' ? TAB_ACTIVE_STYLE : TAB_STYLE}
          onClick={() => setTab('overview')}
        >
          {t('tab.overview')}
        </button>
      </div>

      {tab === 'results' ? (
        <>
          <TaskFilters
            t={t}
            value={filters}
            sources={detail.conditions.sources}
            queries={detail.conditions.queries}
            onChange={setFilters}
          />

          {page !== null && page.papers.length > 0 ? (
            <>
              <ul style={listStyle}>
                {page.papers.map((paper) => (
                  <li key={paper.paperId}>
                    <PaperCard paper={paper} t={t} onInsert={insert} />
                  </li>
                ))}
              </ul>
              {page.papers.length < page.total && (
                <div style={actionRowStyle}>
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    disabled={view.loadingMore}
                    onClick={() => {
                      void view.loadMore()
                    }}
                  >
                    {tpl(t('task.loadMore'), { shown: page.papers.length, total: page.total })}
                  </Button>
                </div>
              )}
            </>
          ) : (
            !view.loading &&
            !active && (
              <div style={statusStyle}>
                {filterActive ? t('filter.noMatch') : t('task.empty')}
              </div>
            )
          )}
        </>
      ) : (
        <OverviewTab
          t={t}
          taskId={taskId}
          rev={detail.rev}
          filters={filters}
          filterActive={filterActive}
          onPick={(patch) => {
            setFilters((previous) => ({ ...previous, ...patch }))
            setTab('results')
          }}
        />
      )}
    </div>
  )
}

async function updatePin(
  id: string,
  detail: TaskDetail,
  reload: () => void,
): Promise<void> {
  try {
    await updateTask(id, { pinned: !detail.pinned })
    reload()
  } catch {
    // 置顶失败不阻塞正文；刷新一次即可看到真实状态。
    reload()
  }
}

function statusColor(detail: TaskDetail): string {
  if (detail.status === 'error') return ERROR
  if (detail.status === 'partial') return '#b26a00'
  if (detail.status === 'running' || detail.status === 'queued') return ACCENT
  return 'inherit'
}

const statusChipStyle = {
  fontWeight: 600,
  fontSize: 12,
} as const

const TAB_ROW_STYLE: CSSProperties = {
  display: 'flex',
  gap: 4,
  borderBottom: '1px solid rgba(127,127,127,0.18)',
}
const TAB_STYLE: CSSProperties = {
  padding: '4px 8px',
  border: 'none',
  borderBottom: '2px solid transparent',
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
  opacity: 0.66,
  cursor: 'pointer',
}
const TAB_ACTIVE_STYLE: CSSProperties = {
  ...TAB_STYLE,
  opacity: 1,
  fontWeight: 600,
  borderBottomColor: ACCENT,
}
