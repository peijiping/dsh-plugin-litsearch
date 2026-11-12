/**
 * 任务 tab 正文：一个独立 tab 承载一次检索任务。
 *
 * 任务 id 从 tab 的资源地址解析（不依赖 layout 恢复的 params）；正文自己轮询
 * 运行中的任务，完成即停。关闭 tab 时 `tab.signal` 中止请求。
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type {
  AnnotationInput,
  Paper,
  Screening,
  SortMode,
  TaskDetail,
  TaskStatsReport,
} from '../search/types'
import {
  downloadPaperPdf,
  exportUrl,
  fetchStats,
  syncZotero,
  type ResultsQuery,
} from './api'
import { rememberTaskTitle } from './autoOpen'
import { CompareTab } from './CompareTab'
import { ConditionEditor } from './ConditionEditor'
import { paperText, papersText, taskText } from './compose'
import { FullTextTab, type FullTextView } from './FullTextTab'
import { GroupsTab } from './GroupsTab'
import { HistoryIcon, IconButton, TaskListIcon } from './icons'
import { insertBuilt, type InputActions } from './inline'
import { tpl, type Translate } from './locales'
import { NotesTab } from './NotesTab'
import { OverviewTab } from './OverviewTab'
import { PaperCard } from './PaperCard'
import { RoundsDialog } from './RoundsDialog'
import { TaskFilters, activeFilterCount } from './TaskFilters'
import { TaskListDialog } from './TaskListDialog'
import {
  ACCENT,
  ERROR,
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
import { RESULT_PAGE_SIZE, useTask } from './useTask'

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
  /** 从任务列表弹窗切换到另一个任务（宿主按地址去重，重复打开只聚焦）。 */
  onOpenTask?: (id: string, title: string) => void
  /** 当前任务被删除且没有别的任务可切换时，由宿主关闭这个任务 tab。 */
  onCloseTask?: (taskId: string) => void
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

export function TaskPane({
  t,
  useTabInfo,
  inputActions,
  onOpenPaper,
  onOpenTask,
  onCloseTask,
}: Props): ReactElement {
  const info = useTabInfo()
  const taskId = parseTaskId(info)
  const [filters, setFilters] = useState<ResultsQuery>({})
  const [tab, setTab] = useState<TabKey>('results')
  const view = useTask(taskId, info.tab.signal, RESULT_PAGE_SIZE, filters)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [toast, setToast] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [editingConditions, setEditingConditions] = useState(false)
  const [risFallback, setRisFallback] = useState<{
    ids: readonly string[]
    message: string
  } | null>(null)
  const [showRounds, setShowRounds] = useState(false)
  const [showTaskList, setShowTaskList] = useState(false)
  /** 任务级全文统计：结果页覆盖率横幅与全文页台账共用同一份数据。 */
  const [overview, setOverview] = useState<TaskStatsReport | null>(null)

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

  // rev 变化（下载、标注、重跑）后重取覆盖率，保证横幅与全文页一致。
  useEffect(() => {
    if (taskId === null) return undefined
    const controller = new AbortController()
    void fetchStats(taskId, {}, 'task', controller.signal)
      .then((report) => {
        if (!controller.signal.aborted) setOverview(report)
      })
      .catch(() => {
        if (!controller.signal.aborted) setOverview(null)
      })
    return () => controller.abort()
  }, [taskId, detail?.rev])

  // 切任务时先清掉上一个任务的覆盖率，避免横幅短暂显示旧数据。
  useEffect(() => {
    setOverview(null)
  }, [taskId])

  useEffect(() => {
    if (toast === '') return undefined
    const timer = setTimeout(() => setToast(''), 2400)
    return () => clearTimeout(timer)
  }, [toast])

  // 翻页或切换 tab 后回到内容顶部，避免停在上一页的滚动位置。
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
  }, [view.pageIndex, tab])

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

  /** 把任务 id 与当前条件带入会话草稿，新会话也能续接同一任务。 */
  const insertTask = (): void => {
    if (detail === null) return
    void (async () => {
      const outcome = await insertBuilt(inputActions, () => taskText(t, detail))
      if (outcome === 'inserted') setToast(t('task.inserted'))
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

  /** 结果页与全文页共用同一套批量下载 / Zotero 逻辑。 */
  const downloadIds = (paperIds: readonly string[]): void => {
    if (taskId === null || paperIds.length === 0) return
    void (async () => {
      let ok = 0
      let failed = 0
      for (const paperId of paperIds) {
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

  const zoteroIds = (paperIds: readonly string[]): void => {
    if (taskId === null || paperIds.length === 0) return
    void syncZotero(taskId, paperIds)
      .then((result) => {
        setToast(zoteroToast(t, result.saved, result.failed, result.messages))
        if (result.failed > 0) {
          setRisFallback({
            ids: [...paperIds],
            message: result.messages[0] ?? t('pdf.zoteroFailed'),
          })
        }
      })
      .catch((error: unknown) => {
        const message = messageOf(error)
        setToast(tpl(t('pdf.zoteroFailed'), { message }))
        setRisFallback({ ids: [...paperIds], message })
      })
  }

  const downloadMany = (): void => downloadIds(ids)
  const zoteroMany = (): void => zoteroIds(ids)

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
  const roundCount = detail.roundCount ?? 0
  const failed = detail.result.sources.filter((source) => !source.ok && !source.skipped)
  const skipped = detail.result.sources.filter((source) => source.skipped)
  const page = view.page
  /** 当前生效的排序：面板选择优先，未选择时跟随任务条件。 */
  const sortValue: SortMode = filters.sort ?? detail.conditions.sort
  const pageStart = page === null ? 0 : page.offset
  const pageEnd = page === null ? 0 : page.offset + page.papers.length
  // 覆盖率恒为任务级口径（scope=task），不随结果页筛选变化。
  const coverage = overview?.fullText
  const overviewAvailable =
    coverage === undefined ? 0 : coverage.available + coverage.downloaded + coverage.htmlOnly
  const overviewMissing =
    coverage === undefined
      ? 0
      : coverage.unknown + coverage.paywalled + coverage.blocked + coverage.failed
  const overviewRate =
    overview === null || overview.loaded === 0
      ? 0
      : Math.round((overviewAvailable / overview.loaded) * 100)

  // tab 用非 button 容器渲染：宿主的 button 全局样式会给未选中项画出深色底线。
  const tabItems: { key: TabKey; label: string }[] = [
    { key: 'results', label: tpl(t('tab.results'), { n: page?.total ?? detail.result.totalLoaded }) },
    { key: 'overview', label: t('tab.overview') },
    { key: 'fulltext', label: t('tab.fulltext') },
    { key: 'groups', label: t('tab.groups') },
    { key: 'notes', label: t('tab.notes') },
    { key: 'compare', label: t('tab.compare') },
  ]

  return (
    <div style={TASK_PANEL_STYLE}>
      <header>
        <div style={HEADER_TOP_STYLE}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ ...titleStyle, fontSize: 14 }}>{detail.title}</div>
            <div style={metaStyle}>
              {tpl(t('task.meta'), {
                origin: t(`task.origin.${detail.origin}`),
                date: formatDate(detail.createdAt),
              })}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <Button
              variant="outline"
              size="sm"
              type="button"
              title={t('task.insertToChatHint')}
              onClick={insertTask}
            >
              {t('task.insertToChat')}
            </Button>
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
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => view.reload()}
            >
              {t('task.refresh')}
            </Button>
            <IconButton label={t('rounds.open')} onClick={() => setShowRounds(true)}>
              <HistoryIcon />
            </IconButton>
            <IconButton label={t('taskList.open')} onClick={() => setShowTaskList(true)}>
              <TaskListIcon />
            </IconButton>
          </div>
        </div>
        <div style={{ ...metaStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...statusChipStyle, color: statusColor(detail) }}>
            {t(`task.status.${detail.status}`)}
          </span>
          <span>{tpl(t('rounds.badge'), { n: detail.roundCount ?? 0 })}</span>
          <span>{tpl(t('task.sourceCount'), { n: detail.conditions.sources.length })}</span>
          <span>{tpl(t('task.pageSize'), { n: detail.conditions.pageSize })}</span>
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
        <div style={ROUND_BANNER_STYLE} role="status" aria-live="polite">
          {roundCount > 0
            ? detail.progress === undefined
              ? tpl(t('task.roundRunning'), { round: roundCount })
              : tpl(t('task.roundRunningDetail'), {
                  round: roundCount,
                  i: detail.progress.queryIndex,
                  n: detail.progress.queryTotal,
                })
            : detail.progress === undefined
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

      {skipped.length > 0 && (
        <div style={statusStyle}>
          {tpl(t('task.sourceSkipped'), {
            sources: skipped
              .map((source) => t(`source.${source.id}`))
              .join(t('task.sourceListSeparator')),
          })}
        </div>
      )}

      {detail.error !== undefined && (
        <div style={{ ...statusStyle, color: ERROR }}>{detail.error}</div>
      )}

      {active && (
        <div style={{ ...formStyle, gap: 8 }}>
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
        </div>
      )}

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
        {tabItems.map((item) => (
          <div
            key={item.key}
            aria-current={tab === item.key ? 'page' : undefined}
            tabIndex={0}
            style={tab === item.key ? TAB_ACTIVE_STYLE : TAB_STYLE}
            onClick={() => setTab(item.key)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setTab(item.key)
              }
            }}
          >
            {item.label}
          </div>
        ))}
      </div>

      <div ref={bodyRef} style={SCROLL_BODY_STYLE}>
        {tab === 'results' ? (
        <>
          {overview !== null && (
            <div style={COVERAGE_WRAP_STYLE}>
              <div style={COVERAGE_ROW_STYLE}>
                <span>
                  {tpl(t('fulltext.coverageBar'), {
                    available: overviewAvailable,
                    total: overview.loaded,
                    rate: overviewRate,
                    missing: overviewMissing,
                  })}
                </span>
                <button
                  type="button"
                  style={
                    filters.missingFullText === true
                      ? QUICK_FILTER_ACTIVE_STYLE
                      : QUICK_FILTER_STYLE
                  }
                  onClick={() =>
                    setFilters((previous) => ({
                      ...previous,
                      missingFullText: previous.missingFullText === true ? undefined : true,
                    }))
                  }
                >
                  {t('fulltext.quickFilter')}
                </button>
                <button type="button" style={linkButtonStyle} onClick={() => setTab('fulltext')}>
                  {t('fulltext.openTab')}
                </button>
              </div>
              <div style={COVERAGE_HINT_STYLE}>{t('fulltext.barHint')}</div>
            </div>
          )}
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

          {page !== null && page.total > 0 && (
            <div style={PAGE_TOOLBAR_STYLE}>
              <div style={PAGE_TOOLBAR_ROW_STYLE}>
                <label style={PAGE_SORT_LABEL_STYLE}>
                  <span>{t('filter.sort')}</span>
                  <select
                    style={PAGE_SORT_SELECT_STYLE}
                    value={sortValue}
                    onChange={(event) => {
                      const next = event.target.value as SortMode
                      // 与任务默认排序一致时不写进筛选对象，避免多出一条生效条件。
                      setFilters((previous) => ({
                        ...previous,
                        sort: next === detail.conditions.sort ? undefined : next,
                      }))
                    }}
                  >
                    {SORT_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {t(`sort.${mode}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <span style={PAGE_RANGE_STYLE}>
                  {tpl(t('pager.range'), {
                    from: pageStart + 1,
                    to: pageEnd,
                    total: page.total,
                  })}
                </span>
              </div>
              <Pager
                t={t}
                index={view.pageIndex}
                count={view.pageCount}
                onChange={view.goToPage}
              />
            </div>
          )}

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
                      onManageGroups={() => setTab('groups')}
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
              <Pager
                t={t}
                index={view.pageIndex}
                count={view.pageCount}
                onChange={view.goToPage}
              />
            </>
          ) : active ? (
            <div style={ROUND_RESULTS_HINT_STYLE}>
              {roundCount > 0
                ? tpl(t('task.roundRunningResults'), { round: roundCount })
                : t('task.running')}
            </div>
          ) : (
            !view.loading && (
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
          stats={overview}
          onDownload={downloadPaper}
          onZotero={zoteroPaper}
          onBatchDownload={(papers) => downloadIds(papers.map((paper) => paper.paperId))}
          onBatchZotero={(papers) => zoteroIds(papers.map((paper) => paper.paperId))}
          onShowInResults={(viewKey: FullTextView) => {
            // 清空其他筛选，保证按钮上写的篇数就是跳过去能看到的篇数。
            setFilters(
              viewKey === 'missing' ? { missingFullText: true } : { pdfStatus: viewKey },
            )
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

      <RoundsDialog
        t={t}
        open={showRounds}
        onClose={() => setShowRounds(false)}
        taskId={taskId}
        detail={detail}
        busy={active}
        onRerun={() => {
          view.reload()
          setToast(t('rounds.rerunStarted'))
        }}
      />
      <TaskListDialog
        t={t}
        open={showTaskList}
        onClose={() => setShowTaskList(false)}
        currentTaskId={taskId}
        onOpenTask={onOpenTask ?? (() => undefined)}
        onCurrentRemoved={(fallback) => {
          if (fallback !== null) onOpenTask?.(fallback.id, fallback.title)
          else onCloseTask?.(taskId)
        }}
      />
    </div>
  )
}

const HEADER_TOP_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 8,
}

const SCREENINGS: readonly Screening[] = ['unread', 'read', 'included', 'excluded']
const SORT_MODES: readonly SortMode[] = ['relevance', 'citations', 'year']
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
          disabled={busy}
          aria-label={t('bulk.setGroup')}
          title={groups.length === 0 ? t('annotate.groupHint') : t('bulk.setGroup')}
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

/** 结果页翻页条：首页 / 上一页 / 页码 / 下一页 / 末页。单页时不渲染。 */
function Pager({
  t,
  index,
  count,
  onChange,
}: {
  t: Translate
  index: number
  count: number
  onChange(index: number): void
}): ReactElement | null {
  if (count <= 1) return null
  const atStart = index <= 0
  const atEnd = index >= count - 1
  return (
    <div style={PAGER_STYLE}>
      <button
        type="button"
        style={atStart ? PAGER_BUTTON_DISABLED : PAGER_BUTTON}
        disabled={atStart}
        onClick={() => onChange(0)}
      >
        {t('pager.first')}
      </button>
      <button
        type="button"
        style={atStart ? PAGER_BUTTON_DISABLED : PAGER_BUTTON}
        disabled={atStart}
        onClick={() => onChange(index - 1)}
      >
        {t('pager.prev')}
      </button>
      <span style={PAGER_STATUS_STYLE}>
        {tpl(t('pager.status'), { page: index + 1, pages: count })}
      </span>
      <button
        type="button"
        style={atEnd ? PAGER_BUTTON_DISABLED : PAGER_BUTTON}
        disabled={atEnd}
        onClick={() => onChange(index + 1)}
      >
        {t('pager.next')}
      </button>
      <button
        type="button"
        style={atEnd ? PAGER_BUTTON_DISABLED : PAGER_BUTTON}
        disabled={atEnd}
        onClick={() => onChange(count - 1)}
      >
        {t('pager.last')}
      </button>
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

const ROUND_BANNER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid rgba(80,140,255,0.35)',
  background: 'rgba(80,140,255,0.10)',
  color: ACCENT,
  fontSize: 12,
  fontWeight: 600,
}

const ROUND_RESULTS_HINT_STYLE: CSSProperties = {
  padding: '10px 8px',
  fontSize: 12,
  color: ACCENT,
}

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

// 只有选中项画底部横线；tab 用普通 div 渲染，绕开宿主对 button / tab 元素的
// 全局下划线样式（原先的 `transparent` 边会被渲染成深色）。用 padding 补偿 2px 边框高度。
const TAB_ROW_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 2,
}
const TAB_STYLE: CSSProperties = {
  padding: '4px 8px 6px',
  border: 'none',
  borderBottom: 'none',
  boxShadow: 'none',
  outline: 'none',
  textDecoration: 'none',
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
  opacity: 0.66,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  userSelect: 'none',
}
const TAB_ACTIVE_STYLE: CSSProperties = {
  ...TAB_STYLE,
  padding: '4px 8px',
  borderBottom: `2px solid ${ACCENT}`,
  color: ACCENT,
  opacity: 1,
  fontWeight: 600,
}
const SCREENING_BAR_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: 8,
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
  flexWrap: 'nowrap',
  whiteSpace: 'nowrap',
  gap: 8,
  marginLeft: 'auto',
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

const COVERAGE_WRAP_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '5px 8px',
  borderRadius: 6,
  background: 'rgba(80,140,255,0.08)',
  border: '1px solid rgba(80,140,255,0.25)',
  fontSize: 12,
}
const COVERAGE_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
}
const COVERAGE_HINT_STYLE: CSSProperties = { fontSize: 11, opacity: 0.66 }
const QUICK_FILTER_STYLE: CSSProperties = {
  padding: '1px 7px',
  borderRadius: 10,
  border: '1px solid rgba(127,127,127,0.3)',
  background: 'transparent',
  color: 'inherit',
  fontSize: 11,
  cursor: 'pointer',
}
const QUICK_FILTER_ACTIVE_STYLE: CSSProperties = {
  ...QUICK_FILTER_STYLE,
  borderColor: '#508cff',
  color: '#508cff',
  fontWeight: 600,
}

// 任务面板占满 tab 高度，正文区自己滚动：宿主只给固定高度，不负责滚动长列表。
const TASK_PANEL_STYLE: CSSProperties = {
  ...panelStyle,
  height: '100%',
  minHeight: 0,
  boxSizing: 'border-box',
}
const SCROLL_BODY_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
}

const PAGE_TOOLBAR_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '2px 0',
}
const PAGE_TOOLBAR_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
}
const PAGE_SORT_LABEL_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 11,
  opacity: 0.8,
}
const PAGE_SORT_SELECT_STYLE: CSSProperties = {
  fontSize: 11,
  padding: '2px 4px',
  borderRadius: 4,
  border: '1px solid rgba(127,127,127,0.28)',
  background: 'transparent',
  color: 'inherit',
}
const PAGE_RANGE_STYLE: CSSProperties = {
  marginLeft: 'auto',
  fontSize: 11,
  opacity: 0.66,
  whiteSpace: 'nowrap',
}
const PAGER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexWrap: 'wrap',
  gap: 6,
  fontSize: 11,
}
const PAGER_BUTTON: CSSProperties = {
  padding: '1px 7px',
  borderRadius: 10,
  border: '1px solid rgba(127,127,127,0.3)',
  background: 'transparent',
  color: 'inherit',
  fontSize: 11,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}
const PAGER_BUTTON_DISABLED: CSSProperties = {
  ...PAGER_BUTTON,
  opacity: 0.4,
  cursor: 'default',
}
const PAGER_STATUS_STYLE: CSSProperties = { opacity: 0.72, whiteSpace: 'nowrap' }
