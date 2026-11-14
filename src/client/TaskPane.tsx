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
  PaperState,
  Screening,
  SortMode,
  TaskDetail,
  TaskStatsReport,
} from '../search/types'
import { isManualPdfFailure } from '../search/types'
import {
  downloadPaperPdf,
  exportUrl,
  fetchPaper,
  fetchStats,
  syncZotero,
  type ResultsQuery,
} from './api'
import { rememberTaskTitle } from './autoOpen'
import { CompareTab } from './CompareTab'
import { ConditionEditor } from './ConditionEditor'
import { paperSummary, paperText, papersSummary, papersText, taskSummary, taskText } from './compose'
import { DownloadDialog, type BatchDownloadItem } from './DownloadDialog'
import { FullTextTab, type FullTextView } from './FullTextTab'
import { GroupsTab } from './GroupsTab'
import {
  AlertIcon,
  ChatIcon,
  ClockIcon,
  DownloadIcon,
  HistoryIcon,
  IconButton,
  ResultIcon,
  RoundIcon,
  SpinnerIcon,
  TaskListIcon,
  ZoteroIcon,
} from './icons'
import { insertQuote, type InputActions } from './inline'
import { tpl, type Translate } from './locales'
import { NotesTab } from './NotesTab'
import { OverviewTab } from './OverviewTab'
import { PaperCard, type PdfDownloadUi } from './PaperCard'
import { RoundsDialog } from './RoundsDialog'
import { TaskFilters, activeFilterCount } from './TaskFilters'
import { TaskListDialog } from './TaskListDialog'
import {
  ACCENT,
  ERROR,
  linkButtonStyle,
  linkStyle,
  listStyle,
  panelStyle,
  statusStyle,
  titleStyle,
  toastErrorStyle,
  toastStackStyle,
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
  /** 已下载文献：先复核文件仍在，再在右侧面板预览本地 PDF。 */
  onOpenLocal?: (taskId: string, paperId: string, path: string) => void
  /** 已下载文献：在系统文件管理器中定位 PDF。 */
  onRevealLocal?: (path: string) => void
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
  onOpenLocal,
  onRevealLocal,
}: Props): ReactElement {
  const info = useTabInfo()
  const taskId = parseTaskId(info)
  const [filters, setFilters] = useState<ResultsQuery>({})
  const [tab, setTab] = useState<TabKey>('results')
  const view = useTask(taskId, info.tab.signal, RESULT_PAGE_SIZE, filters)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [toast, setToastState] = useState('')
  const [toastTone, setToastTone] = useState<'info' | 'error'>('info')
  const [toastMs, setToastMs] = useState(4000)
  /** 统一的底部浮层提示：tone 区分普通结果与下载失败。 */
  const notify = (text: string, tone: 'info' | 'error' = 'info', ms = 4000): void => {
    setToastState(text)
    setToastTone(tone)
    setToastMs(ms)
  }
  /** paperId → 下载状态；刷新任务后仍保留「下载中 / 已下载」的即时反馈。 */
  const [downloads, setDownloads] = useState<Readonly<Record<string, PdfDownloadUi>>>({})
  /** 批量下载弹窗：只集中展示，真实状态仍写在 downloads / 任务详情的 states 里。 */
  const [batchItems, setBatchItems] = useState<readonly BatchDownloadItem[]>([])
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchRunning, setBatchRunning] = useState(false)
  const batchRunningRef = useRef(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  /** 结果页里见过的文献：跨页选中的条目做「加入对话」时要能拿到论文详情。 */
  const papersByIdRef = useRef<Map<string, Paper>>(new Map())
  const ids = [...selected]
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
  // 排序只换顺序、不换结果集合，翻页更不该清空已选；只有换任务或改其它筛选条件才重置。
  const selectionScope = JSON.stringify({ ...filters, sort: undefined })
  // 批量下载循环里要判断「当前是否已下载」，用 ref 读取最新状态避免闭包取到旧值。
  const downloadsRef = useRef<Readonly<Record<string, PdfDownloadUi>>>(downloads)
  downloadsRef.current = downloads
  const statesRef = useRef<Record<string, PaperState>>({})
  statesRef.current = detail?.states ?? {}

  useEffect(() => {
    setSelected(new Set())
  }, [taskId, selectionScope])

  useEffect(() => {
    papersByIdRef.current.clear()
  }, [taskId])

  // 每翻到一页就把文献并入缓存，跨页选中的条目在别的页上也能取到详情。
  useEffect(() => {
    for (const paper of view.page?.papers ?? []) papersByIdRef.current.set(paper.paperId, paper)
  }, [view.page])

  useEffect(() => {
    setDownloads({})
    setBatchItems([])
    setBatchOpen(false)
  }, [taskId])

  useEffect(() => {
    setEditingConditions(false)
    setRisFallback(null)
  }, [taskId])

  useEffect(() => {
    if (detail !== null) rememberTaskTitle(detail.id, detail.title)
  }, [detail])

  // rev 变化（下载、筛读、重跑）后重取覆盖率，保证横幅与全文页一致。
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
    const timer = setTimeout(() => notify(''), toastMs)
    return () => clearTimeout(timer)
  }, [toast, toastMs])

  // 翻页或切换 tab 后回到内容顶部，避免停在上一页的滚动位置。
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 })
  }, [view.pageIndex, tab])

  const insert = (paper: Paper): void => {
    const outcome = insertQuote(inputActions, paperText(t, paper), paperSummary(t, paper))
    if (outcome === 'inserted') notify(t('result.inserted'))
    else notify(t(outcome === 'no-editor' ? 'error.noEditor' : 'error.draftChanged'))
  }

  /** 跨页选中也要整批插入：优先用翻页时缓存的论文，缺的再按 id 补详情。 */
  const insertMany = (): void => {
    if (taskId === null || ids.length === 0) return
    const known = papersByIdRef.current
    const finish = (): void => {
      const papers = ids
        .map((paperId) => known.get(paperId))
        .filter((paper): paper is Paper => paper !== undefined)
      if (papers.length === 0) return
      const outcome = insertQuote(inputActions, papersText(t, papers), papersSummary(t, papers))
      if (outcome === 'inserted') notify(tpl(t('bulk.inserted'), { n: papers.length }))
      else notify(t(outcome === 'no-editor' ? 'error.noEditor' : 'error.draftChanged'))
    }
    const missing = ids.filter((paperId) => !known.has(paperId))
    if (missing.length === 0) {
      finish()
      return
    }
    void Promise.all(
      missing.map((paperId) =>
        fetchPaper(taskId, paperId)
          .then((loaded) => {
            known.set(paperId, loaded.paper)
          })
          .catch(() => undefined),
      ),
    ).then(finish)
  }

  /** 把任务 id 与当前条件带入会话草稿，新会话也能续接同一任务。 */
  const insertTask = (): void => {
    if (detail === null) return
    const outcome = insertQuote(inputActions, taskText(t, detail), taskSummary(t, detail))
    if (outcome === 'inserted') notify(t('task.inserted'))
    else notify(t(outcome === 'no-editor' ? 'error.noEditor' : 'error.draftChanged'))
  }

  const downloadPaper = (paper: Paper): void => {
    if (taskId === null) return
    const paperId = paper.paperId
    setDownloads((previous) => ({ ...previous, [paperId]: { state: 'downloading' } }))
    void (async () => {
      try {
        const result = await downloadPaperPdf(taskId, paperId)
        if (result.status === 'downloaded') {
          setDownloads((previous) => ({
            ...previous,
            [paperId]: { state: 'downloaded', ...(result.path === undefined ? {} : { path: result.path }) },
          }))
          notify(tpl(t('pdf.downloaded'), { name: result.filename ?? '' }), 'info', 6000)
        } else {
          setDownloads((previous) => ({
            ...previous,
            [paperId]: {
              state: 'failed',
              error: result.error ?? result.status,
              ...(result.reason === undefined ? {} : { reason: result.reason }),
            },
          }))
          notify(
            result.status === 'html-only'
              ? tpl(t('pdf.htmlFallback'), { message: result.error ?? '' })
              : tpl(t('pdf.error'), { message: result.error ?? result.status }),
            'error',
            8000,
          )
        }
      } catch (error) {
        setDownloads((previous) => ({
          ...previous,
          [paperId]: { state: 'failed', error: messageOf(error) },
        }))
        notify(tpl(t('pdf.error'), { message: messageOf(error) }), 'error', 8000)
      } finally {
        view.reload()
      }
    })()
  }

  const zoteroPaper = (paper: Paper): void => {
    if (taskId === null) return
    void syncZotero(taskId, [paper.paperId])
      .then((result) => {
        notify(zoteroToast(t, result.saved, result.failed, result.messages))
        if (result.failed > 0) {
          setRisFallback({
            ids: [paper.paperId],
            message: result.messages[0] ?? t('pdf.zoteroFailed'),
          })
        }
      })
      .catch((error: unknown) => {
        const message = messageOf(error)
        notify(tpl(t('pdf.zoteroFailed'), { message }))
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

  /** 本页全选用并集：翻页可累加，不会把其它页已选的文献冲掉。 */
  const selectPage = (pageIds: readonly string[]): void => {
    if (pageIds.length === 0) return
    setSelected((previous) => {
      const next = new Set(previous)
      for (const paperId of pageIds) next.add(paperId)
      return next
    })
  }

  /** 取消全选：清空所有已选（含其它页）。 */
  const clearSelection = (): void => setSelected(new Set())

  const annotateMany = (patch: Partial<Pick<AnnotationInput, 'screening' | 'groupId'>>): void => {
    if (ids.length === 0) return
    // 改完筛选状态就清空选中：命中的文献可能被当前筛选移出列表，
    // 残留的选中会让批量条一直挂在那里。
    void view.annotate(ids.map((paperId) => ({ paperId, ...patch }))).then(() => {
      setSelected(new Set())
    })
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

  /**
   * 批量下载：打开进度弹窗后按最多 5 篇并发下载。
   *
   * 已下载（含文件已删除以外的正常已下载）的文献直接略过，不再重复请求；
   * 每篇的结果实时写入 downloads，弹窗只做集中展示。批量未结束时再次触发
   * 只重新打开弹窗，避免两轮循环重复下载同一批文献。
   */
  const startBatchDownload = (entries: readonly BatchDownloadItem[]): void => {
    if (taskId === null || entries.length === 0) return
    if (batchRunningRef.current) {
      // 上一轮还没跑完：只把弹窗叫回来，不替换清单、也不重复下载。
      setBatchOpen(true)
      return
    }
    setBatchItems(entries.map((entry) => ({ ...entry })))
    setBatchOpen(true)
    batchRunningRef.current = true
    setBatchRunning(true)
    void (async () => {
      let ok = 0
      let manualCount = 0
      let failedCount = 0
      let changed = false
      /** 单篇：跳过已下载的，下载结果实时写回 downloads。 */
      const runOne = async (paperId: string): Promise<void> => {
        const runtime = downloadsRef.current[paperId]
        if (runtime?.state === 'downloading') return
        if (
          runtime?.state === 'downloaded' ||
          statesRef.current[paperId]?.pdfStatus === 'downloaded'
        ) {
          // 已经是已下载状态：直接略过，不重新下载。
          return
        }
        changed = true
        setDownloads((previous) => ({ ...previous, [paperId]: { state: 'downloading' } }))
        try {
          const result = await downloadPaperPdf(taskId, paperId)
          if (result.status === 'downloaded') {
            ok += 1
            setDownloads((previous) => ({
              ...previous,
              [paperId]: {
                state: 'downloaded',
                ...(result.path === undefined ? {} : { path: result.path }),
              },
            }))
          } else {
            if (isManualPdfFailure(result.reason)) manualCount += 1
            else failedCount += 1
            setDownloads((previous) => ({
              ...previous,
              [paperId]: {
                state: 'failed',
                error: result.error ?? result.status,
                ...(result.reason === undefined ? {} : { reason: result.reason }),
              },
            }))
          }
        } catch (error: unknown) {
          failedCount += 1
          setDownloads((previous) => ({
            ...previous,
            [paperId]: { state: 'failed', error: messageOf(error) },
          }))
        }
      }
      // 固定数量的 worker 从同一个游标取任务：并发数不超过 5，也不会重复取到同一篇。
      let cursor = 0
      const worker = async (): Promise<void> => {
        while (cursor < entries.length) {
          const entry = entries[cursor]
          cursor += 1
          if (entry !== undefined) await runOne(entry.paperId)
        }
      }
      try {
        await Promise.all(
          Array.from({ length: Math.min(BATCH_CONCURRENCY, entries.length) }, () => worker()),
        )
      } finally {
        batchRunningRef.current = false
        setBatchRunning(false)
        if (changed) view.reload()
      }
      if (changed) {
        notify(
          tpl(t('bulk.downloadDone'), { ok, manual: manualCount, failed: failedCount }),
          failedCount > 0 ? 'error' : 'info',
          8000,
        )
      }
    })()
  }

  /** 结果页选中项：标题优先取当前页，跨页选中的文献再异步补详情。 */
  const downloadMany = (): void => {
    if (taskId === null || ids.length === 0) return
    const known = new Map<string, string>()
    for (const paper of view.page?.papers ?? []) known.set(paper.paperId, paper.title)
    startBatchDownload(ids.map((paperId) => ({ paperId, title: known.get(paperId) ?? '' })))
    const missing = ids.filter((paperId) => !known.has(paperId))
    if (missing.length === 0) return
    void Promise.all(
      missing.map((paperId) =>
        fetchPaper(taskId, paperId)
          .then((loaded) => {
            setBatchItems((previous) =>
              previous.map((item) =>
                item.paperId === paperId ? { ...item, title: loaded.paper.title } : item,
              ),
            )
          })
          .catch(() => undefined),
      ),
    )
  }

  const zoteroIds = (paperIds: readonly string[]): void => {
    if (taskId === null || paperIds.length === 0) return
    void syncZotero(taskId, paperIds)
      .then((result) => {
        notify(zoteroToast(t, result.saved, result.failed, result.messages))
        if (result.failed > 0) {
          setRisFallback({
            ids: [...paperIds],
            message: result.messages[0] ?? t('pdf.zoteroFailed'),
          })
        }
      })
      .catch((error: unknown) => {
        const message = messageOf(error)
        notify(tpl(t('pdf.zoteroFailed'), { message }))
        setRisFallback({ ids: [...paperIds], message })
      })
  }

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
  const pageIds = page?.papers.map((paper) => paper.paperId) ?? []
  /** 当前生效的排序：面板选择优先，未选择时跟随任务条件。 */
  const sortValue: SortMode = filters.sort ?? detail.conditions.sort
  // 覆盖率恒为任务级口径（scope=task），不随结果页筛选变化。
  const coverage = overview?.fullText
  const overviewAvailable =
    coverage === undefined ? 0 : coverage.available + coverage.downloaded + coverage.htmlOnly
  const overviewMissing =
    coverage === undefined
      ? 0
      : coverage.unknown +
        coverage.missing +
        coverage.paywalled +
        coverage.blocked +
        coverage.failed
  const overviewRate =
    overview === null || overview.loaded === 0
      ? 0
      : Math.round((overviewAvailable / overview.loaded) * 100)

  // 左栏：任务当前生效的检索条件（纯文本回显，改条件走弹窗）。
  const conditionMeta: string[] = [tpl(t('task.pageSize'), { n: detail.conditions.pageSize })]
  if (detail.conditions.yearFrom !== undefined || detail.conditions.yearTo !== undefined) {
    conditionMeta.push(
      tpl(t('task.conditionYear'), {
        value: `${detail.conditions.yearFrom ?? ''}–${detail.conditions.yearTo ?? ''}`,
      }),
    )
  }
  if (detail.conditions.language !== 'any') {
    conditionMeta.push(
      tpl(t('filter.languageChip'), { value: t(`lang.${detail.conditions.language}`) }),
    )
  }
  if (detail.conditions.openAccessOnly) conditionMeta.push(t('condition.openAccess'))
  if ((detail.conditions.types ?? []).length > 0) {
    conditionMeta.push(
      tpl(t('filter.typeChip'), { value: (detail.conditions.types ?? []).join(', ') }),
    )
  }
  conditionMeta.push(tpl(t('filter.sortChip'), { value: t(`sort.${detail.conditions.sort}`) }))

  // 右栏：当前轮次的进度 / 结果与提醒。
  const rounds = detail.rounds ?? []
  const currentRound = rounds.length === 0 ? undefined : rounds[rounds.length - 1]
  const currentRoundNo = currentRound?.index ?? roundCount
  const currentStats = currentRound?.stats ?? detail.stats
  const roundLine = active
    ? currentRoundNo > 0
      ? detail.progress === undefined
        ? tpl(t('task.roundRunning'), { round: currentRoundNo })
        : tpl(t('task.roundRunningDetail'), {
            round: currentRoundNo,
            i: detail.progress.queryIndex,
            n: detail.progress.queryTotal,
          })
      : detail.progress === undefined
        ? t('task.running')
        : tpl(t('task.progress'), {
            i: detail.progress.queryIndex,
            n: detail.progress.queryTotal,
          })
    : currentRoundNo > 0
      ? tpl(t('task.roundLine'), {
          round: currentRoundNo,
          status: t(`task.status.${currentRound?.status ?? detail.status}`),
          date: formatDate(currentRound?.createdAt ?? detail.createdAt),
        })
      : tpl(t('task.roundStatusLine'), {
          status: t(`task.status.${detail.status}`),
          date: formatDate(detail.createdAt),
        })
  const statsLine = tpl(t('task.stats'), {
    raw: currentStats.rawHits,
    deduped: currentStats.deduped,
    loaded: currentRound?.stats?.loaded ?? detail.result.totalLoaded,
  })
  const failedLine = failed
    .map((source) =>
      tpl(t('error.sourceFailed'), {
        source: t(`source.${source.id}`),
        message: source.error ?? '',
      }),
    )
    .join('；')
  const skippedLine = tpl(t('task.sourceSkipped'), {
    sources: skipped.map((source) => t(`source.${source.id}`)).join(t('task.sourceListSeparator')),
  })

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
      <header style={HEADER_STYLE}>
        <div style={HEADER_TOP_STYLE}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ ...titleStyle, fontSize: 16, fontWeight: 700, lineHeight: 1.4 }}>
              {detail.title}
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
        <div style={HEADER_SPLIT_STYLE}>
          <section style={CONDITION_BOX_STYLE}>
            <div style={BOX_HEAD_STYLE}>
              <button
                type="button"
                style={BOX_HEAD_TITLE_STYLE}
                disabled={active}
                title={active ? t('task.running') : t('condition.title')}
                onClick={() => setEditingConditions(true)}
              >
                {t('condition.edit')}
              </button>
            </div>
            <div style={CONDITION_BODY_STYLE}>
              {detail.conditions.queries
                .filter((query) => query.enabled)
                .map((query) => (
                  <div key={query.id} style={CONDITION_QUERY_STYLE} title={query.text}>
                    {query.name !== '' && (
                      <span style={CONDITION_QUERY_NAME_STYLE}>{query.name}</span>
                    )}
                    <span>{query.text}</span>
                  </div>
                ))}
              <div style={CONDITION_META_STYLE}>
                {tpl(t('task.conditionSources'), {
                  sources: detail.conditions.sources.map((id) => t(`source.${id}`)).join(' / '),
                })}
              </div>
              <div style={CONDITION_META_STYLE}>{conditionMeta.join(' · ')}</div>
              {detail.fromTaskId !== undefined && (
                <div style={CONDITION_META_STYLE} title={detail.fromTaskId}>
                  {tpl(t('ledger.fromTask'), { id: detail.fromTaskId })}
                </div>
              )}
            </div>
          </section>

          <section style={active ? ROUND_BOX_ACTIVE_STYLE : ROUND_BOX_STYLE}>
            <div style={ROUND_LINE_STYLE}>
              <span style={ROUND_ICON_STYLE} aria-hidden>
                <ClockIcon />
              </span>
              <span style={ROUND_TEXT_STYLE}>
                {tpl(t('task.meta'), {
                  origin: t(`task.origin.${detail.origin}`),
                  date: formatDate(detail.createdAt),
                })}
              </span>
            </div>
            <div
              style={active ? ROUND_RUNNING_ROW_STYLE : ROUND_LINE_STYLE}
              role={active ? 'status' : undefined}
              aria-live={active ? 'polite' : undefined}
            >
              <span style={active ? ROUND_RUNNING_ICON_STYLE : ROUND_ICON_STYLE} aria-hidden>
                {active ? <SpinnerIcon /> : <RoundIcon />}
              </span>
              <span style={active ? ROUND_RUNNING_TEXT_STYLE : ROUND_TEXT_STYLE}>{roundLine}</span>
            </div>
            <div style={ROUND_LINE_STYLE}>
              <span style={ROUND_ICON_STYLE} aria-hidden>
                <ResultIcon />
              </span>
              <span style={ROUND_TEXT_STYLE}>{statsLine}</span>
            </div>
            {failed.length > 0 && (
              <div style={{ ...ROUND_LINE_STYLE, color: ERROR }}>
                <span style={ROUND_ICON_STYLE} aria-hidden>
                  <AlertIcon />
                </span>
                <span style={ROUND_TEXT_STYLE}>{failedLine}</span>
              </div>
            )}
            {skipped.length > 0 && (
              <div style={ROUND_LINE_STYLE}>
                <span style={ROUND_ICON_STYLE} aria-hidden>
                  <AlertIcon />
                </span>
                <span style={ROUND_TEXT_STYLE}>{skippedLine}</span>
              </div>
            )}
            {detail.error !== undefined && (
              <div style={{ ...ROUND_LINE_STYLE, color: ERROR }}>
                <span style={ROUND_ICON_STYLE} aria-hidden>
                  <AlertIcon />
                </span>
                <span style={ROUND_TEXT_STYLE}>{detail.error}</span>
              </div>
            )}
            {active && (
              <div style={ROUND_ACTION_STYLE}>
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
          </section>
        </div>
      </header>

      {editingConditions && (
        <ConditionEditor
          t={t}
          detail={detail}
          onCancel={() => setEditingConditions(false)}
          onSaved={() => {
            setEditingConditions(false)
            notify(t('condition.saved'))
            view.reload()
          }}
        />
      )}

      {(toast !== '' || risFallback !== null) && (
        <div style={toastStackStyle}>
          {toast !== '' && (
            <div
              role="status"
              style={{ ...toastStyle, ...(toastTone === 'error' ? toastErrorStyle : null) }}
            >
              {toast}
            </div>
          )}

          {risFallback !== null && (
            <div style={RIS_FALLBACK_STYLE}>
              <span style={{ minWidth: 0 }}>
                {tpl(t('pdf.zoteroFallback'), { message: risFallback.message })}
              </span>
              <a
                href={exportUrl(taskId, 'ris', {}, risFallback.ids)}
                download
                style={RIS_FALLBACK_LINK_STYLE}
              >
                {t('pdf.zoteroFallbackLink')}
              </a>
              <button
                type="button"
                style={RIS_FALLBACK_BUTTON_STYLE}
                onClick={() => setRisFallback(null)}
              >
                {t('pdf.zoteroFallbackDismiss')}
              </button>
            </div>
          )}
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
                <div style={EXPORT_ROW_STYLE} title={t('export.hint')}>
                  <span style={EXPORT_DIVIDER_STYLE} aria-hidden>
                    |
                  </span>
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
            </div>
          )}
          <TaskFilters
            t={t}
            value={filters}
            sources={detail.conditions.sources}
            queries={detail.conditions.queries}
            groups={detail.groups}
            stats={overview}
            onChange={setFilters}
            leading={
              <ScreeningPills t={t} detail={detail} filters={filters} onChange={setFilters} />
            }
          />

          {page !== null && page.total > 0 && (
            <div style={PAGE_TOOLBAR_ROW_STYLE}>
              <div style={PAGE_TOOLBAR_LEFT_STYLE}>
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
                <button
                  type="button"
                  style={PAGE_TOOLBAR_ACTION_STYLE}
                  title={t('bulk.selectPageHint')}
                  onClick={() => selectPage(pageIds)}
                >
                  {t('bulk.selectPage')}
                </button>
                <button
                  type="button"
                  style={
                    selected.size === 0
                      ? PAGE_TOOLBAR_ACTION_DISABLED_STYLE
                      : PAGE_TOOLBAR_ACTION_STYLE
                  }
                  disabled={selected.size === 0}
                  title={t('bulk.unselectAllHint')}
                  onClick={clearSelection}
                >
                  {t('bulk.unselectAll')}
                </button>
                {selected.size > 0 && (
                  <span style={PAGE_TOOLBAR_COUNT_STYLE} title={t('bulk.keepHint')}>
                    {tpl(t('bulk.count'), { n: selected.size })}
                  </span>
                )}
              </div>
              <Pager
                t={t}
                index={view.pageIndex}
                count={view.pageCount}
                total={page.total}
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
              pageIds={pageIds}
              groups={detail.groups}
              busy={view.busy}
              filters={filters}
              onClear={clearSelection}
              onSelectPage={selectPage}
              onAnnotate={annotateMany}
              onInsert={insertMany}
              onDownload={downloadMany}
              onZotero={zoteroMany}
              batchRunning={batchRunning}
              {...(detail.downloadDir === undefined || onRevealLocal === undefined
                ? {}
                : { downloadDir: detail.downloadDir, onRevealDir: onRevealLocal })}
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
                      {...(detail.downloadDir === undefined
                        ? {}
                        : { downloadDir: detail.downloadDir })}
                      {...(downloads[paper.paperId] === undefined
                        ? {}
                        : { download: downloads[paper.paperId] })}
                      {...(onOpenLocal === undefined ? {} : { onOpenLocal })}
                      {...(onRevealLocal === undefined ? {} : { onRevealLocal })}
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
                total={page.total}
                onChange={view.goToPage}
              />
            </>
          ) : active ? (
            <div style={ROUND_RESULTS_HINT_STYLE} role="status" aria-live="polite">
              <span style={ROUND_RESULTS_ICON_STYLE} aria-hidden>
                <SpinnerIcon />
              </span>
              <span>
                {roundCount > 0
                  ? tpl(t('task.roundRunningResults'), { round: roundCount })
                  : t('task.running')}
              </span>
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
          {...(onOpenLocal === undefined ? {} : { onOpenLocal })}
          {...(onRevealLocal === undefined ? {} : { onRevealLocal })}
          onZotero={zoteroPaper}
          onBatchDownload={(papers) =>
            startBatchDownload(
              papers.map((paper) => ({ paperId: paper.paperId, title: paper.title })),
            )
          }
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
          onNotify={notify}
          onPickGroup={(groupId) => {
            setFilters((previous) => ({ ...previous, groupId }))
            setTab('results')
          }}
        />
      ) : tab === 'notes' ? (
        <NotesTab t={t} taskId={taskId} detail={detail} onSaved={view.reload} onNotify={notify} />
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

      <DownloadDialog
        t={t}
        open={batchOpen}
        items={batchItems}
        states={detail.states}
        downloads={downloads}
        onClose={() => {
          setBatchOpen(false)
          // 关闭即刷新列表：下载可能仍在后台继续，让文献状态跟上 Host 的真实结果。
          view.reload()
        }}
      />
      <RoundsDialog
        t={t}
        open={showRounds}
        onClose={() => setShowRounds(false)}
        taskId={taskId}
        detail={detail}
        busy={active}
        onRerun={() => {
          view.reload()
          notify(t('rounds.rerunStarted'))
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

const HEADER_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const HEADER_TOP_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 8,
}

/** 标题下方左右两栏：左=查询条件，右=本轮结果与提醒。窄面板下自动上下堆叠。 */
const HEADER_SPLIT_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 8,
}

const CONDITION_BOX_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  minWidth: 0,
  padding: '7px 9px',
  borderRadius: 8,
  border: '1px solid rgba(127,127,127,0.2)',
  background: 'rgba(127,127,127,0.05)',
}

const BOX_HEAD_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
}

/** 条件框标题「修改查询条件」：既要点得动，也要像小节标题。 */
const BOX_HEAD_TITLE_STYLE: CSSProperties = {
  ...linkButtonStyle,
  fontSize: 12.5,
  fontWeight: 650,
}

const CONDITION_BODY_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  minWidth: 0,
  maxHeight: 132,
  overflowY: 'auto',
}

const CONDITION_QUERY_STYLE: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  wordBreak: 'break-word',
}

const CONDITION_QUERY_NAME_STYLE: CSSProperties = {
  marginRight: 4,
  fontSize: 11.5,
  fontWeight: 600,
  opacity: 0.55,
}

const CONDITION_META_STYLE: CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.5,
  opacity: 0.7,
  wordBreak: 'break-word',
}

const ROUND_BOX_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  minWidth: 0,
  padding: '7px 9px',
  borderRadius: 8,
  border: '1px solid rgba(80,140,255,0.22)',
  background: 'rgba(80,140,255,0.05)',
}

/** 检索进行中：整框加深蓝色底与描边，让「还在跑」一眼可见。 */
const ROUND_BOX_ACTIVE_STYLE: CSSProperties = {
  ...ROUND_BOX_STYLE,
  border: '1px solid rgba(80,140,255,0.65)',
  background: 'rgba(80,140,255,0.12)',
  boxShadow: '0 0 0 1px rgba(80,140,255,0.18)',
}

const ROUND_LINE_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 6,
  minWidth: 0,
  fontSize: 12,
  lineHeight: 1.5,
}

const ROUND_ICON_STYLE: CSSProperties = {
  display: 'inline-flex',
  flexShrink: 0,
  marginTop: 1,
  color: ACCENT,
  opacity: 0.8,
}

const ROUND_TEXT_STYLE: CSSProperties = {
  minWidth: 0,
  wordBreak: 'break-word',
}

/** 运行中的那一行：独立高亮带，配旋转图标。 */
const ROUND_RUNNING_ROW_STYLE: CSSProperties = {
  ...ROUND_LINE_STYLE,
  alignItems: 'center',
  margin: '0 -3px',
  padding: '4px 6px',
  borderRadius: 6,
  border: '1px solid rgba(80,140,255,0.5)',
  background: 'rgba(80,140,255,0.18)',
  fontSize: 12.5,
}

const ROUND_RUNNING_ICON_STYLE: CSSProperties = {
  ...ROUND_ICON_STYLE,
  opacity: 1,
  marginTop: 0,
}

const ROUND_RUNNING_TEXT_STYLE: CSSProperties = {
  ...ROUND_TEXT_STYLE,
  color: ACCENT,
  fontWeight: 650,
}

const ROUND_ACTION_STYLE: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
}

const SCREENINGS: readonly Screening[] = ['unread', 'read', 'included', 'excluded']
const SORT_MODES: readonly SortMode[] = ['relevance', 'citations', 'year']
const EXPORT_FORMATS = ['csv', 'ris', 'bibtex', 'md'] as const
/** 批量下载的并发上限：同时下载 5 篇。 */
const BATCH_CONCURRENCY = 5

/** 筛读计数（点击筛选）：与「筛选」按钮同排，接在筛选条最前面。 */
function ScreeningPills({
  t,
  detail,
  filters,
  onChange,
}: {
  t: Translate
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
  batchRunning,
  downloadDir,
  onRevealDir,
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
  /** 批量下载进行中：按钮禁用，避免再起一轮重复下载。 */
  batchRunning: boolean
  /** 下载目录；给了才在批量下载按钮右侧画下三角。 */
  downloadDir?: string
  onRevealDir?: (path: string) => void
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
        <BulkActionButton icon={<ChatIcon />} label={t('bulk.insert')} onClick={onInsert} />
        <BulkDownloadButton
          t={t}
          label={t('bulk.download')}
          onClick={onDownload}
          disabled={busy || batchRunning}
          {...(downloadDir === undefined || onRevealDir === undefined
            ? {}
            : { downloadDir, onReveal: onRevealDir })}
        />
        <BulkActionButton
          icon={<ZoteroIcon />}
          label={t('bulk.zotero')}
          onClick={onZotero}
          disabled={busy}
        />
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

/** 批量条里的图标按钮：与下拉框同处一行，悬停时加深底色。 */
function BulkActionButton({
  icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: ReactElement
  label: string
  onClick(): void
  disabled?: boolean
}): ReactElement {
  const [hover, setHover] = useState(false)
  const highlighted = hover && !disabled
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...BULK_BUTTON_STYLE,
        ...(highlighted
          ? { borderColor: 'rgba(80,140,255,0.75)', background: 'rgba(80,140,255,0.16)' }
          : null),
        ...(disabled ? { opacity: 0.45, cursor: 'default' } : null),
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

/**
 * 批量下载按钮 + 下三角：点主体打开下载进度弹窗；点箭头展开菜单，
 * 在系统文件管理器中打开下载目录（与条目上「查看已下载 ▾」的菜单一致）。
 */
function BulkDownloadButton({
  t,
  label,
  onClick,
  disabled,
  downloadDir,
  onReveal,
}: {
  t: Translate
  label: string
  onClick(): void
  disabled: boolean
  /** 下载目录；没有目录或没有打开能力时不画下三角。 */
  downloadDir?: string
  onReveal?: (path: string) => void
}): ReactElement {
  const [open, setOpen] = useState(false)
  const groupRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const closeOnOutside = (event: MouseEvent): void => {
      if (groupRef.current !== null && !groupRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const revealable = downloadDir !== undefined && onReveal !== undefined

  return (
    <span ref={groupRef} style={BULK_DOWNLOAD_GROUP_STYLE}>
      <BulkActionButton
        icon={<DownloadIcon />}
        label={label}
        onClick={onClick}
        disabled={disabled}
      />
      {revealable && (
        <button
          type="button"
          style={{
            ...BULK_ARROW_STYLE,
            ...(disabled ? { opacity: 0.45, cursor: 'default' } : null),
          }}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t('bulk.revealDir')}
          title={t('bulk.revealDir')}
          disabled={disabled}
          onClick={() => setOpen((value) => !value)}
        >
          ▾
        </button>
      )}
      {open && revealable && (
        <span role="menu" style={BULK_MENU_STYLE}>
          <button
            type="button"
            role="menuitem"
            style={BULK_MENU_ITEM_STYLE}
            onClick={() => {
              setOpen(false)
              if (downloadDir !== undefined) onReveal?.(downloadDir)
            }}
          >
            {t('bulk.revealDir')}
          </button>
        </span>
      )}
    </span>
  )
}

/** 结果页翻页条：首页 / 上一页 / 页码 / 下一页 / 末页。单页时不渲染。 */
function Pager({
  t,
  index,
  count,
  total,
  onChange,
}: {
  t: Translate
  index: number
  count: number
  /** 总篇数；给了就并进页码文案，省掉单独一行统计。 */
  total?: number
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
        {total === undefined
          ? tpl(t('pager.status'), { page: index + 1, pages: count })
          : tpl(t('pager.statusTotal'), { page: index + 1, pages: count, total })}
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

/** 结果页「检索还在进行」的提示条：蓝色高亮块 + 旋转图标。 */
const ROUND_RESULTS_HINT_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  marginTop: 2,
  padding: '9px 11px',
  borderRadius: 8,
  border: '1px solid rgba(80,140,255,0.5)',
  background: 'rgba(80,140,255,0.12)',
  fontSize: 12.5,
  fontWeight: 600,
  lineHeight: 1.45,
  color: ACCENT,
}

const ROUND_RESULTS_ICON_STYLE: CSSProperties = {
  display: 'inline-flex',
  flexShrink: 0,
}

const RIS_FALLBACK_STYLE: CSSProperties = {
  ...toastStyle,
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
  borderLeft: '3px solid #b26a00',
}
const RIS_FALLBACK_LINK_STYLE: CSSProperties = {
  color: '#fff',
  fontSize: 12,
  textDecoration: 'underline',
}
const RIS_FALLBACK_BUTTON_STYLE: CSSProperties = {
  ...linkButtonStyle,
  color: '#fff',
  textDecoration: 'underline',
}

// 只有选中项画底部横线；tab 用普通 div 渲染，绕开宿主对 button / tab 元素的
// 全局下划线样式（原先的 `transparent` 边会被渲染成深色）。用 padding 补偿 2px 边框高度。
const TAB_ROW_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
}
const TAB_STYLE: CSSProperties = {
  padding: '4px 9px 7px',
  border: 'none',
  borderBottom: 'none',
  boxShadow: 'none',
  outline: 'none',
  textDecoration: 'none',
  background: 'transparent',
  color: 'inherit',
  fontSize: 13,
  fontWeight: 500,
  opacity: 0.75,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  userSelect: 'none',
}
const TAB_ACTIVE_STYLE: CSSProperties = {
  ...TAB_STYLE,
  padding: '4px 9px',
  borderBottom: `2px solid ${ACCENT}`,
  color: ACCENT,
  opacity: 1,
  fontWeight: 700,
}
const SCREENING_PILLS_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
}
const SCREENING_PILL: CSSProperties = {
  fontSize: 11.5,
  padding: '2px 8px',
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
/** 导出区与前文之间的竖线分隔。 */
const EXPORT_DIVIDER_STYLE: CSSProperties = {
  opacity: 0.3,
  marginRight: -2,
}
const EXPORT_LINK_STYLE: CSSProperties = {
  color: ACCENT,
  textDecoration: 'none',
  fontSize: 11.5,
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
const BULK_BUTTON_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 8px',
  borderRadius: 5,
  border: '1px solid rgba(80,140,255,0.4)',
  background: 'transparent',
  color: ACCENT,
  fontSize: 11.5,
  lineHeight: 1.4,
  cursor: 'pointer',
}

/** 批量下载 + 下三角的组合：箭头紧贴按钮右侧，菜单相对整体定位。 */
const BULK_DOWNLOAD_GROUP_STYLE: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
}
const BULK_ARROW_STYLE: CSSProperties = {
  padding: '2px 3px',
  borderRadius: 5,
  border: '1px solid rgba(80,140,255,0.4)',
  background: 'transparent',
  color: ACCENT,
  fontSize: 12,
  lineHeight: 1.4,
  cursor: 'pointer',
}
const BULK_MENU_STYLE: CSSProperties = {
  position: 'absolute',
  top: '100%',
  left: 0,
  marginTop: 3,
  zIndex: 40,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 132,
  padding: 2,
  borderRadius: 6,
  border: '1px solid rgba(127,127,127,0.3)',
  background: '#fff',
  boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
}
const BULK_MENU_ITEM_STYLE: CSSProperties = {
  padding: '5px 8px',
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  color: '#1f2328',
  fontSize: 12,
  lineHeight: 1.4,
  textAlign: 'left',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
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
const QUICK_FILTER_STYLE: CSSProperties = {
  padding: '2px 8px',
  borderRadius: 10,
  border: '1px solid rgba(127,127,127,0.3)',
  background: 'transparent',
  color: 'inherit',
  fontSize: 11.5,
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
  position: 'relative',
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

/** 排序（含本页全选 / 取消全选）与翻页同一行：操作靠左，翻页（含总篇数）靠右。 */
const PAGE_TOOLBAR_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: 8,
  padding: '2px 0',
}
const PAGE_TOOLBAR_LEFT_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
}
const PAGE_TOOLBAR_ACTION_STYLE: CSSProperties = {
  ...linkButtonStyle,
  fontSize: 11.5,
  whiteSpace: 'nowrap',
}
const PAGE_TOOLBAR_ACTION_DISABLED_STYLE: CSSProperties = {
  ...PAGE_TOOLBAR_ACTION_STYLE,
  opacity: 0.4,
  cursor: 'default',
}
const PAGE_TOOLBAR_COUNT_STYLE: CSSProperties = {
  fontSize: 11.5,
  opacity: 0.66,
  whiteSpace: 'nowrap',
}
const PAGE_SORT_LABEL_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 11.5,
  opacity: 0.8,
}
const PAGE_SORT_SELECT_STYLE: CSSProperties = {
  fontSize: 11.5,
  padding: '2px 4px',
  borderRadius: 4,
  border: '1px solid rgba(127,127,127,0.28)',
  background: 'transparent',
  color: 'inherit',
}
const PAGER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexWrap: 'wrap',
  gap: 6,
  fontSize: 11.5,
}
const PAGER_BUTTON: CSSProperties = {
  padding: '2px 8px',
  borderRadius: 10,
  border: '1px solid rgba(127,127,127,0.3)',
  background: 'transparent',
  color: 'inherit',
  fontSize: 11.5,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}
const PAGER_BUTTON_DISABLED: CSSProperties = {
  ...PAGER_BUTTON,
  opacity: 0.4,
  cursor: 'default',
}
const PAGER_STATUS_STYLE: CSSProperties = { opacity: 0.72, whiteSpace: 'nowrap' }
