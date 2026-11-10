/**
 * 任务 tab 正文：一个独立 tab 承载一次检索任务。
 *
 * 任务 id 从 tab 的资源地址解析（不依赖 layout 恢复的 params）；正文自己轮询
 * 运行中的任务，完成即停。关闭 tab 时 `tab.signal` 中止请求。
 */

import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { AnnotationInput, Paper, Screening, TaskDetail } from '../search/types'
import {
  downloadPaperPdf,
  exportUrl,
  syncZotero,
  updateTask,
  type ResultsQuery,
} from './api'
import { rememberTaskTitle } from './autoOpen'
import { CompareTab } from './CompareTab'
import { ConditionEditor } from './ConditionEditor'
import { paperText, papersText } from './compose'
import { FullTextTab } from './FullTextTab'
import { GroupsTab } from './GroupsTab'
import { insertBuilt, type InputActions } from './inline'
import { tpl, type Translate } from './locales'
import { NotesTab } from './NotesTab'
import { OverviewTab } from './OverviewTab'
import { PaperCard } from './PaperCard'
import { TaskFilters, activeFilterCount } from './TaskFilters'
import {
  ACCENT,
  ERROR,
  actionRowStyle,
  formStyle,
  linkButtonStyle,
  linkStyle,
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

type TabKey = 'results' | 'overview' | 'fulltext' | 'groups' | 'notes' | 'compare'

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
  onOpenPaper?: (taskId: string, paperId: string, title: string) => void
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

export function TaskPane({ t, useTabInfo, inputActions, onOpenPaper }: Props): ReactElement {
  const info = useTabInfo()
  const taskId = parseTaskId(info)
  const [filters, setFilters] = useState<ResultsQuery>({})
  const [tab, setTab] = useState<TabKey>('results')
  const view = useTask(taskId, info.tab.signal, undefined, filters)
  const [toast, setToast] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [editingConditions, setEditingConditions] = useState(false)
  const [risFallback, setRisFallback] = useState<{
    ids: readonly string[]
    message: string
  } | null>(null)

  const detail = view.detail
  const filterActive = useMemo(() => activeFilterCount(filters) > 0, [filters])
  const filterKey = JSON.stringify(filters)

  useEffect(() => {
    setSelected(new Set())
  }, [taskId, filterKey])

  useEffect(() => {
    setEditingConditions(false)
    setRisFallback(null)
  }, [taskId])

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

  const insertMany = (): void => {
    const loaded = view.page
    if (loaded === null) return
    const papers = loaded.papers.filter((paper) => selected.has(paper.paperId))
    if (papers.length === 0) return
    void (async () => {
      const outcome = await insertBuilt(inputActions, () => papersText(t, papers))
      if (outcome === 'inserted') setToast(tpl(t('bulk.inserted'), { n: papers.length }))
      else setToast(t(outcome === 'no-editor' ? 'error.noEditor' : 'error.draftChanged'))
    })()
  }

  const downloadPaper = (paper: Paper): void => {
    if (taskId === null) return
    void (async () => {
      try {
        const result = await downloadPaperPdf(taskId, paper.paperId)
        if (result.status === 'downloaded') {
          setToast(tpl(t('pdf.downloaded'), { name: result.filename ?? '' }))
        } else if (result.status === 'html-only') {
          setToast(tpl(t('pdf.htmlFallback'), { message: result.error ?? '' }))
        } else {
          setToast(tpl(t('pdf.error'), { message: result.error ?? result.status }))
        }
      } catch (error) {
        setToast(tpl(t('pdf.error'), { message: messageOf(error) }))
      } finally {
        view.reload()
      }
    })()
  }

  const zoteroPaper = (paper: Paper): void => {
    if (taskId === null) return
    void syncZotero(taskId, [paper.paperId])
      .then((result) => {
        setToast(zoteroToast(t, result.saved, result.failed, result.messages))
        if (result.failed > 0) {
          setRisFallback({
            ids: [paper.paperId],
            message: result.messages[0] ?? t('pdf.zoteroFailed'),
          })
        }
      })
      .catch((error: unknown) => {
        const message = messageOf(error)
        setToast(tpl(t('pdf.zoteroFailed'), { message }))
        setRisFallback({ ids: [paper.paperId], message })
      })
  }

  const toggleSelect = (paperId: string): void => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(paperId)) next.delete(paperId)
      else next.add(paperId)
      return next
    })
  }

  const ids = [...selected]

  const annotateMany = (patch: Partial<Pick<AnnotationInput, 'screening' | 'groupId'>>): void => {
    if (ids.length === 0) return
    void view.annotate(ids.map((paperId) => ({ paperId, ...patch })))
  }

  /** Host 单次最多注解 50 篇，对比页整批纳入时分段提交。 */
  const includeMany = (paperIds: readonly string[]): void => {
    if (paperIds.length === 0) return
    void (async () => {
      for (let index = 0; index < paperIds.length; index += 50) {
        await view.annotate(
          paperIds.slice(index, index + 50).map((paperId) => ({ paperId, screening: 'included' })),
        )
      }
    })()
  }

  const downloadMany = (): void => {
    if (taskId === null || ids.length === 0) return
    void (async () => {
      let ok = 0
      let failed = 0
      for (const paperId of ids) {
        try {
          const result = await downloadPaperPdf(taskId, paperId)
          if (result.status === 'downloaded' || result.status === 'html-only') ok += 1
          else failed += 1
        } catch {
          failed += 1
        }
      }
      setToast(tpl(t('bulk.downloadDone'), { ok, failed }))
      view.reload()
    })()
  }

  const zoteroMany = (): void => {
    if (taskId === null || ids.length === 0) return
    void syncZotero(taskId, ids)
      .then((result) => {
        setToast(zoteroToast(t, result.saved, result.failed, result.messages))
        if (result.failed > 0) {
          setRisFallback({
            ids,
            message: result.messages[0] ?? t('pdf.zoteroFailed'),
          })
        }
      })
      .catch((error: unknown) => {
        const message = messageOf(error)
        setToast(tpl(t('pdf.zoteroFailed'), { message }))
        setRisFallback({ ids, message })
      })
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
          <button
            type="button"
            style={linkButtonStyle}
            disabled={active}
            title={active ? t('task.running') : t('condition.title')}
            onClick={() => setEditingConditions((previous) => !previous)}
          >
            {t('condition.edit')}
          </button>
          {detail.fromTaskId !== undefined && (
            <span title={detail.fromTaskId}>
              {tpl(t('ledger.fromTask'), { id: detail.fromTaskId })}
            </span>
          )}
        </div>
      </header>

      {editingConditions && (
        <ConditionEditor
          t={t}
          detail={detail}
          onCancel={() => setEditingConditions(false)}
          onSaved={() => {
            setEditingConditions(false)
            setToast(t('condition.saved'))
            view.reload()
          }}
        />
      )}

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

      {risFallback !== null && (
        <div style={RIS_FALLBACK_STYLE}>
          <span style={{ minWidth: 0 }}>
            {tpl(t('pdf.zoteroFallback'), { message: risFallback.message })}
          </span>
          <a
            href={exportUrl(taskId, 'ris', {}, risFallback.ids)}
            download
            style={linkStyle}
          >
            {t('pdf.zoteroFallbackLink')}
          </a>
          <button
            type="button"
            style={linkButtonStyle}
            onClick={() => setRisFallback(null)}
          >
            {t('pdf.zoteroFallbackDismiss')}
          </button>
        </div>
      )}

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
        <button
          type="button"
          style={tab === 'fulltext' ? TAB_ACTIVE_STYLE : TAB_STYLE}
          onClick={() => setTab('fulltext')}
        >
          {t('tab.fulltext')}
        </button>
        <button
          type="button"
          style={tab === 'groups' ? TAB_ACTIVE_STYLE : TAB_STYLE}
          onClick={() => setTab('groups')}
        >
          {t('tab.groups')}
        </button>
        <button
          type="button"
          style={tab === 'notes' ? TAB_ACTIVE_STYLE : TAB_STYLE}
          onClick={() => setTab('notes')}
        >
          {t('tab.notes')}
        </button>
        <button
          type="button"
          style={tab === 'compare' ? TAB_ACTIVE_STYLE : TAB_STYLE}
          onClick={() => setTab('compare')}
        >
          {t('tab.compare')}
        </button>
      </div>

      {tab === 'results' ? (
        <>
          <TaskFilters
            t={t}
            value={filters}
            sources={detail.conditions.sources}
            queries={detail.conditions.queries}
            groups={detail.groups}
            onChange={setFilters}
          />

          <ScreeningBar
            t={t}
            taskId={taskId}
            detail={detail}
            filters={filters}
            onChange={setFilters}
          />

          {selected.size > 0 && (
            <BulkBar
              t={t}
              taskId={taskId}
              count={selected.size}
              ids={ids}
              pageIds={page?.papers.map((paper) => paper.paperId) ?? []}
              groups={detail.groups}
              busy={view.busy}
              filters={filters}
              onClear={() => setSelected(new Set())}
              onSelectPage={(pageIds) => setSelected(new Set(pageIds))}
              onAnnotate={annotateMany}
              onInsert={insertMany}
              onDownload={downloadMany}
              onZotero={zoteroMany}
            />
          )}
          {page !== null && page.papers.length > 0 ? (
            <>
              <ul style={listStyle}>
                {page.papers.map((paper) => (
                  <li key={paper.paperId}>
                    <PaperCard
                      paper={paper}
                      t={t}
                      taskId={taskId}
                      state={detail.states[paper.paperId]}
                      groups={detail.groups}
                      busy={view.busy}
                      selected={selected.has(paper.paperId)}
                      onToggleSelect={toggleSelect}
                      onInsert={insert}
                      onAnnotate={(input) => {
                        void view.annotate([input])
                      }}
                      onDownload={downloadPaper}
                      onZotero={zoteroPaper}
                      {...(onOpenPaper === undefined
                        ? {}
                        : {
                            onOpenPaper: (item: Paper) =>
                              onOpenPaper(taskId, item.paperId, item.title),
                          })}
                    />
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
      ) : tab === 'overview' ? (
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
      ) : tab === 'fulltext' ? (
        <FullTextTab
          t={t}
          taskId={taskId}
          rev={detail.rev}
          states={detail.states}
          onDownload={downloadPaper}
          onZotero={zoteroPaper}
          onShowMissing={() => {
            setFilters((previous) => ({ ...previous, missingFullText: true }))
            setTab('results')
          }}
        />
      ) : tab === 'groups' ? (
        <GroupsTab
          t={t}
          taskId={taskId}
          detail={detail}
          onSaved={view.reload}
          onPickGroup={(groupId) => {
            setFilters((previous) => ({ ...previous, groupId }))
            setTab('results')
          }}
        />
      ) : tab === 'notes' ? (
        <NotesTab t={t} taskId={taskId} detail={detail} onSaved={view.reload} />
      ) : (
        <CompareTab
          t={t}
          taskId={taskId}
          rev={detail.rev}
          busy={view.busy}
          {...(detail.fromTaskId === undefined ? {} : { fromTaskId: detail.fromTaskId })}
          onInclude={includeMany}
          onOnlyNew={() => {
            setFilters((previous) => ({ ...previous, newOnly: true }))
            setTab('results')
          }}
        />
      )}
    </div>
  )
}

const SCREENINGS: readonly Screening[] = ['unread', 'read', 'included', 'excluded']
const EXPORT_FORMATS = ['csv', 'ris', 'bibtex', 'md'] as const

/** 筛读台账条：四态计数（点击筛选）+ 只看新增 + 导出当前筛选。 */
function ScreeningBar({
  t,
  taskId,
  detail,
  filters,
  onChange,
}: {
  t: Translate
  taskId: string
  detail: TaskDetail
  filters: ResultsQuery
  onChange(next: ResultsQuery): void
}): ReactElement {
  const counts = detail.stats.screening
  const toggle = (screening: Screening): void => {
    onChange({
      ...filters,
      screening: filters.screening === screening ? undefined : screening,
    })
  }

  return (
    <div style={SCREENING_BAR_STYLE}>
      <div style={SCREENING_PILLS_STYLE}>
        {SCREENINGS.map((screening) => (
          <button
            key={screening}
            type="button"
            style={filters.screening === screening ? SCREENING_PILL_ACTIVE : SCREENING_PILL}
            onClick={() => toggle(screening)}
          >
            {t(`screening.${screening}`)} {counts[screening]}
          </button>
        ))}
        {detail.fromTaskId !== undefined && (
          <button
            type="button"
            style={filters.newOnly === true ? SCREENING_PILL_ACTIVE : SCREENING_PILL}
            onClick={() => onChange({ ...filters, newOnly: filters.newOnly === true ? undefined : true })}
          >
            {t('ledger.newOnly')}
          </button>
        )}
      </div>
      <div style={EXPORT_ROW_STYLE} title={t('export.hint')}>
        <span style={EXPORT_LABEL_STYLE}>{t('ledger.export')}</span>
        {EXPORT_FORMATS.map((format) => (
          <a
            key={format}
            style={EXPORT_LINK_STYLE}
            href={exportUrl(taskId, format, filters)}
            download
          >
            {t(`export.${format}`)}
          </a>
        ))}
      </div>
    </div>
  )
}

/** 选中多篇后的批量操作条：筛读、分组、下载、Zotero、按选中导出。 */
function BulkBar({
  t,
  taskId,
  count,
  ids,
  pageIds,
  groups,
  busy,
  filters,
  onClear,
  onSelectPage,
  onAnnotate,
  onInsert,
  onDownload,
  onZotero,
}: {
  t: Translate
  taskId: string
  count: number
  ids: readonly string[]
  pageIds: readonly string[]
  groups: readonly { id: string; name: string }[]
  busy: boolean
  filters: ResultsQuery
  onClear(): void
  onSelectPage(pageIds: readonly string[]): void
  onAnnotate(patch: Partial<Pick<AnnotationInput, 'screening' | 'groupId'>>): void
  onInsert(): void
  onDownload(): void
  onZotero(): void
}): ReactElement {
  return (
    <div style={BULK_STYLE}>
      <div style={BULK_ROW_STYLE}>
        <strong style={{ fontSize: 12 }}>{tpl(t('bulk.count'), { n: count })}</strong>
        <button type="button" style={linkButtonStyle} onClick={() => onSelectPage(pageIds)}>
          {t('bulk.selectPage')}
        </button>
        <button type="button" style={linkButtonStyle} onClick={onClear}>
          {t('bulk.clear')}
        </button>
      </div>
      <div style={BULK_ROW_STYLE}>
        <select
          style={BULK_SELECT_STYLE}
          value=""
          disabled={busy}
          aria-label={t('bulk.setScreening')}
          onChange={(event) => {
            const value = event.target.value
            if (value !== '') onAnnotate({ screening: value as Screening })
          }}
        >
          <option value="">{t('bulk.setScreening')}</option>
          {SCREENINGS.map((screening) => (
            <option key={screening} value={screening}>
              {t(`screening.${screening}`)}
            </option>
          ))}
        </select>
        <select
          style={BULK_SELECT_STYLE}
          value=""
          disabled={busy || groups.length === 0}
          aria-label={t('bulk.setGroup')}
          onChange={(event) => {
            const value = event.target.value
            if (value !== '') onAnnotate({ groupId: value === '__none__' ? null : value })
          }}
        >
          <option value="">{t('bulk.setGroup')}</option>
          <option value="__none__">{t('bulk.removeGroup')}</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
        <button type="button" style={linkButtonStyle} onClick={onInsert}>
          {t('bulk.insert')}
        </button>
        <button type="button" style={linkButtonStyle} disabled={busy} onClick={onDownload}>
          {t('bulk.download')}
        </button>
        <button type="button" style={linkButtonStyle} disabled={busy} onClick={onZotero}>
          {t('bulk.zotero')}
        </button>
      </div>
      <div style={BULK_ROW_STYLE}>
        <span style={{ fontSize: 11, opacity: 0.66 }}>{t('bulk.export')}</span>
        {EXPORT_FORMATS.map((format) => (
          <a
            key={format}
            style={EXPORT_LINK_STYLE}
            href={exportUrl(taskId, format, filters, ids)}
            download
          >
            {t(`export.${format}`)}
          </a>
        ))}
      </div>
    </div>
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function zoteroToast(
  t: Translate,
  saved: number,
  failed: number,
  messages: readonly string[],
): string {
  const detail = messages[0] ?? ''
  if (failed === 0 && detail === '') return tpl(t('pdf.zoteroDone'), { n: saved })
  return tpl(t('pdf.zoteroPartial'), { saved, failed, message: detail })
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

const RIS_FALLBACK_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
  padding: '5px 8px',
  borderRadius: 6,
  border: '1px solid rgba(178,106,0,0.4)',
  background: 'rgba(178,106,0,0.08)',
  fontSize: 11,
  lineHeight: 1.5,
}

const TAB_ROW_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 2,
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
const SCREENING_BAR_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '2px 0 4px',
  borderBottom: '1px solid rgba(127,127,127,0.12)',
}
const SCREENING_PILLS_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
}
const SCREENING_PILL: CSSProperties = {
  fontSize: 11,
  padding: '1px 7px',
  borderRadius: 10,
  border: '1px solid rgba(127,127,127,0.3)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}
const SCREENING_PILL_ACTIVE: CSSProperties = {
  ...SCREENING_PILL,
  borderColor: ACCENT,
  color: ACCENT,
  fontWeight: 600,
}
const EXPORT_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
  fontSize: 11,
}
const EXPORT_LABEL_STYLE: CSSProperties = { opacity: 0.66 }
const EXPORT_LINK_STYLE: CSSProperties = {
  color: ACCENT,
  textDecoration: 'none',
  fontSize: 11,
}
const BULK_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '4px 6px',
  borderRadius: 6,
  background: 'rgba(80,140,255,0.08)',
  border: '1px solid rgba(80,140,255,0.25)',
}
const BULK_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
}
const BULK_SELECT_STYLE: CSSProperties = {
  fontSize: 11,
  padding: '2px 4px',
  borderRadius: 4,
  border: '1px solid rgba(127,127,127,0.28)',
  background: 'transparent',
  color: 'inherit',
  maxWidth: 140,
}
