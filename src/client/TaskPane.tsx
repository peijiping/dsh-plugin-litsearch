/**
 * 任务 tab 正文：一个独立 tab 承载一次检索任务。
 *
 * 任务 id 从 tab 的资源地址解析（不依赖 layout 恢复的 params）；正文自己轮询
 * 运行中的任务，完成即停。关闭 tab 时 `tab.signal` 中止请求。
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'

import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

import type {
  AnnotationInput,
  Paper,
  Screening,
  SortMode,
  TaskDetail,
  TaskStatsReport,
} from '../search/types'
import { isManualPdfFailure } from '../search/types'
import {
  chooseDownloadDir,
  downloadPaperPdf,
  exportUrl,
  fetchPaper,
  supplementPaper,
  fetchStats,
  postViewSnapshot,
  type ResultsQuery,
  type ViewSnapshotBody,
} from './api'
import { rememberTaskTitle, forgetTask } from './autoOpen'
import { CompareTab } from './CompareTab'
import { ConditionEditor } from './ConditionEditor'
import { ConditionSummary } from './ConditionSummary'
import { paperSummary, paperText, papersSummary, papersText, taskSummary, taskText } from './compose'
import { markConsumed, usePendingDownloadCommands } from './downloadCommandStore'
import { DownloadDialog, type BatchDownloadItem } from './DownloadDialog'
import { NoticeBar } from './NoticeBar'
import { ZoteroSyncDialog, type ZoteroCommandMeta } from './ZoteroSyncDialog'
import { markZoteroConsumed, usePendingZoteroCommands } from './zoteroCommandStore'
import { FullTextTab } from './FullTextTab'
import { GroupsTab } from './GroupsTab'
import {
  AlertIcon,
  ChatIcon,
  ChevronDownIcon,
  ClockIcon,
  HistoryIcon,
  RefreshIcon,
  ResultIcon,
  RoundIcon,
  RunIcon,
  SpinnerIcon,
  SwitchIcon,
  ZoteroIcon,
} from './icons'
import { insertQuote, type InputActions } from './inline'
import { tpl, type Translate } from './locales'
import { NotesTab } from './NotesTab'
import { OverviewTab } from './OverviewTab'
import { Pager } from './Pager'
import { RunProgressPanel } from './RunProgressPanel'
import { PaperCard } from './PaperCard'
import { BulkActionButton, BulkDownloadButton } from './BulkButtons'
import type { PdfDownloadUi } from './pdfActions'
import { RoundsDialog } from './RoundsDialog'
import { TaskFilters, FilterToggleButton, ActiveFilterChips, activeFilterCount } from './TaskFilters'
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
  /** 切换前记录的上一个任务；当前任务失效时可一键切回，避免困在错误页。 */
  getPreviousTask?: () => { id: string; title: string } | null
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

/** 弹窗来源信息：手动批量不带说明，模型发起时展示范围与用户意图。 */
interface BatchMeta {
  origin: 'panel' | 'model'
  scopeLabel?: string
  reason?: string
  /** 模型点名了保存目录时直接开跑；缺省则先停在选目录阶段。 */
  dir?: string
}

/** `ResultsQuery` 的扁平投影：只保留已生效、可序列化的筛选值。 */
function snapshotFilters(filters: ResultsQuery): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(filters)) {
    if (key === 'offset' || key === 'limit') continue
    if (value === undefined || value === null || value === '' || value === false) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    }
  }
  return out
}

export function TaskPane({
  t,
  useTabInfo,
  inputActions,
  onOpenPaper,
  onOpenTask,
  onCloseTask,
  getPreviousTask,
  onOpenLocal,
  onRevealLocal,
}: Props): ReactElement {
  const info = useTabInfo()
  const taskId = parseTaskId(info)
  const [filters, setFilters] = useState<ResultsQuery>({})
  const [tab, setTab] = useState<TabKey>('results')
  const view = useTask(taskId, info.tab.signal, RESULT_PAGE_SIZE, filters)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [toast, setToast] = useState<{
    text: string
    tone: 'info' | 'error'
    ms: number
  } | null>(null)
  const notify = (
    text: string,
    tone: 'info' | 'error' = 'info',
    ms = 4000,
  ): void => {
    setToast({ text, tone, ms })
  }
  /** paperId → 下载状态；刷新任务后仍保留「下载中 / 已下载」的即时反馈。 */
  const [downloads, setDownloads] = useState<Readonly<Record<string, PdfDownloadUi>>>({})
  /** 批量下载弹窗：只集中展示，真实状态仍写在 downloads / 任务详情的 states 里。 */
  const [batchItems, setBatchItems] = useState<readonly BatchDownloadItem[]>([])
  const [batchOpen, setBatchOpen] = useState(false)
  /** 先选目录（setup）还是已开始下载（running）；下载完成仍保持 running。 */
  const [batchPhase, setBatchPhase] = useState<'setup' | 'running'>('setup')
  /** 本次下载的保存目录；空串表示交给 Host 用默认目录。 */
  const [batchDir, setBatchDir] = useState('')
  /** 任务的当前默认目录，用于占位与「默认 …」提示。 */
  const [batchDefaultDir, setBatchDefaultDir] = useState('')
  const [batchPicking, setBatchPicking] = useState(false)
  /** 弹窗被占用（选目录中或下载中），模型指令排队等待，避免互相覆盖。 */
  const [batchBusy, setBatchBusy] = useState(false)
  const batchBusyRef = useRef(false)
  /** Zotero 同步弹窗：单篇与批量共用，先选目标目录再同步，并展示逐篇结果。 */
  const [zoteroItems, setZoteroItems] = useState<readonly BatchDownloadItem[]>([])
  const [zoteroOpen, setZoteroOpen] = useState(false)
  /** 模型发起的同步：范围说明、原话与目标目录；手动操作时为 undefined。 */
  const [zoteroMeta, setZoteroMeta] = useState<ZoteroCommandMeta | undefined>(undefined)
  const [batchRunning, setBatchRunning] = useState(false)
  const batchRunningRef = useRef(false)
  /** 模型发起的下载：弹窗标明来源/范围，并提供独立的「取消下载」。 */
  const [batchMeta, setBatchMeta] = useState<BatchMeta>({ origin: 'panel' })
  const [batchCancelled, setBatchCancelled] = useState(false)
  const batchAbortRef = useRef<AbortController | null>(null)
  /** 待消费的模型指令；tab 未挂载时由模块级 store 暂存，focus 拉起后再消费。 */
  const pendingCommands = usePendingDownloadCommands(taskId)
  const pendingZoteroCommands = usePendingZoteroCommands(taskId)
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
  const [filterOpen, setFilterOpen] = useState(false)

  const detail = view.detail
  const filterCount = useMemo(() => activeFilterCount(filters), [filters])
  const filterActive = filterCount > 0
  // 排序只换顺序、不换结果集合，翻页更不该清空已选；只有换任务或改其它筛选条件才重置。
  const selectionScope = JSON.stringify({ ...filters, sort: undefined })
  // 批量下载循环里用 ref 读取最新下载状态，避免闭包取到旧值。
  const downloadsRef = useRef<Readonly<Record<string, PdfDownloadUi>>>(downloads)
  downloadsRef.current = downloads

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
    setBatchPhase('setup')
    setBatchDir('')
    setBatchPicking(false)
    batchBusyRef.current = false
    setBatchBusy(false)
  }, [taskId])

  useEffect(() => {
    setEditingConditions(false)
    setRisFallback(null)
  }, [taskId])

  useEffect(() => {
    if (detail !== null) rememberTaskTitle(detail.id, detail.title)
  }, [detail])

  // 任务已不存在：清掉本地标题 / 待打开缓存，标签标题回退为默认文案。
  useEffect(() => {
    if (taskId !== null && view.errorCode === 'not_found') forgetTask(taskId)
  }, [taskId, view.errorCode])

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
    if (toast === null) return
    const timer = setTimeout(() => setToast(null), toast.ms)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => setToast(null), [taskId])

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

  /** 单篇下载也走批量弹窗：先确认保存目录，再开始下载。 */
  const downloadPaper = (paper: Paper): void => {
    if (taskId === null) return
    const source = paper.hitSources[0]?.source ?? paper.source
    const meta = [paper.venue, paper.year === null ? '' : String(paper.year)]
      .filter((part) => part !== '')
      .join(' · ')
    stageDownload([
      {
        paperId: paper.paperId,
        title: paper.title,
        source,
        ...(meta === '' ? {} : { meta }),
      },
    ])
  }

  /** 单篇 / 批量 / 模型指令共用一个弹窗：先选 Zotero 目录，再逐篇同步。 */
  const openZotero = (
    nextItems: readonly BatchDownloadItem[],
    meta?: ZoteroCommandMeta,
  ): void => {
    if (taskId === null || nextItems.length === 0) return
    setZoteroItems(nextItems)
    setZoteroMeta(meta)
    setZoteroOpen(true)
  }

  const zoteroPaper = (paper: Paper): void => {
    openZotero([{ paperId: paper.paperId, title: paper.title }])
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
   * 打开下载框并先停在「选目录」阶段。
   *
   * 单篇、批量、模型未指定目录的指令都走这里；模型指定了目录则由
   * runBatchDownload 直接开跑。真正执行仍是最多 5 篇并发，结果实时写入
   * downloads，弹窗只做集中展示。
   */
  const stageDownload = (
    entries: readonly BatchDownloadItem[],
    meta: BatchMeta = { origin: 'panel' },
  ): void => {
    if (taskId === null || entries.length === 0) return
    if (batchRunningRef.current) {
      // 上一轮还没跑完：只把弹窗叫回来，不替换清单、也不重复下载。
      setBatchOpen(true)
      return
    }
    const defaultDir = detail?.downloadDir ?? ''
    setBatchItems(entries.map((entry) => ({ ...entry })))
    setBatchMeta(meta)
    setBatchDefaultDir(defaultDir)
    setBatchDir(meta.dir ?? defaultDir)
    setBatchCancelled(false)
    setBatchPhase('setup')
    // 选目录阶段也占用弹窗，模型指令先排队，避免被下一单悄悄顶掉。
    batchBusyRef.current = true
    setBatchBusy(true)
    setBatchOpen(true)
    if (meta.dir !== undefined) runBatchDownload(entries, meta, meta.dir)
  }

  /** 用户确认目录后开始下载；此后弹窗直接显示进度。 */
  const confirmDownload = (): void => {
    if (batchPhase !== 'setup' || taskId === null || batchRunningRef.current) return
    const dir = batchDir.trim()
    if (dir !== '' && !looksLikeAbsoluteDir(dir)) {
      notify(t('batch.dirInvalid'), 'error', 6000)
      return
    }
    runBatchDownload(batchItems, batchMeta, dir === '' ? undefined : dir)
  }

  /** 真正的下载循环：按最多 5 篇并发；已在目标目录的由 Host 跳过。 */
  const runBatchDownload = (
    entries: readonly BatchDownloadItem[],
    meta: BatchMeta,
    dir: string | undefined,
  ): void => {
    if (taskId === null || entries.length === 0) return
    if (batchRunningRef.current) {
      setBatchOpen(true)
      return
    }
    const controller = new AbortController()
    batchAbortRef.current = controller
    setBatchCancelled(false)
    setBatchMeta(meta)
    setBatchItems(entries.map((entry) => ({ ...entry })))
    setBatchDefaultDir(detail?.downloadDir ?? '')
    setBatchDir(dir ?? (detail?.downloadDir ?? ''))
    setBatchPhase('running')
    setBatchOpen(true)
    batchBusyRef.current = true
    setBatchBusy(true)
    batchRunningRef.current = true
    setBatchRunning(true)
    void (async () => {
      let ok = 0
      let manualCount = 0
      let failedCount = 0
      let changed = false
      /** 单篇：交给 Host 判断目标目录里是否已有；结果实时写回 downloads。 */
      const runOne = async (paperId: string): Promise<void> => {
        const runtime = downloadsRef.current[paperId]
        // 同一轮里重复取到才是真的跳过；换目录重下由 Host 按路径判断。
        if (runtime?.state === 'downloading') return
        changed = true
        setDownloads((previous) => ({ ...previous, [paperId]: { state: 'downloading' } }))
        try {
          const result = await downloadPaperPdf(taskId, paperId, dir, controller.signal)
          if (result.status === 'downloaded') {
            ok += 1
            setDownloads((previous) => ({
              ...previous,
              [paperId]: {
                state: 'downloaded',
                ...(result.path === undefined ? {} : { path: result.path }),
                ...(result.skipped === true ? { skipped: true } : {}),
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
          if (controller.signal.aborted) {
            // 被取消的篇不算失败，回到待下载状态，弹窗里仍能看到它。
            setDownloads((previous) => {
              const next = { ...previous }
              delete next[paperId]
              return next
            })
            return
          }
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
          if (controller.signal.aborted) return
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
        batchAbortRef.current = null
        batchBusyRef.current = false
        // 置回 false 会触发模型指令消费 effect，自动接着跑队列里的下一条。
        setBatchBusy(false)
        setBatchRunning(false)
      }
      // 被取消时不报「下载完成」：弹窗里已有「已取消」说明。
      if (changed && !controller.signal.aborted) {
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
    stageDownload(ids.map((paperId) => ({ paperId, title: known.get(paperId) ?? '' })))
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

  /** 只有显式的「取消下载」才中止；关闭弹窗仍只隐藏，后台继续跑完。 */
  const cancelBatch = (): void => {
    batchAbortRef.current?.abort()
    setBatchCancelled(true)
  }

  /** 关闭弹窗：选目录阶段直接释放占用，下载中只隐藏、后台继续跑完。 */
  const closeBatch = (): void => {
    setBatchOpen(false)
    if (!batchRunningRef.current) {
      batchBusyRef.current = false
      setBatchBusy(false)
    }
  }

  /** 调宿主原生选目录框；结果回填到输入框，用户仍可手动编辑。 */
  const pickBatchDir = (): void => {
    if (batchPicking) return
    setBatchPicking(true)
    void chooseDownloadDir(batchDir.trim() === '' ? batchDefaultDir : batchDir)
      .then((result) => {
        if (result.cancelled) return
        if (result.path !== undefined && result.path !== '') setBatchDir(result.path)
      })
      .catch((error: unknown) => {
        notify(tpl(t('batch.pickFailed'), { message: messageOf(error) }), 'error', 8000)
      })
      .finally(() => setBatchPicking(false))
  }

  // 上报当前视图快照：Host 侧的模型工具靠它算准「当前页 / 当前筛选全部」。
  // 变化时节流 400ms，切任务或卸载时清理；后台标签页不上报。
  useEffect(() => {
    if (taskId === null || view.detail === null || view.page === null) return undefined
    const body: ViewSnapshotBody = {
      taskId,
      pageIndex: view.pageIndex,
      pageSize: view.pageSize,
      // 让 Host 能直接答出「共 N 页」，不必自己重算一遍筛选。
      total: view.page.total,
      ...(filters.sort === undefined ? {} : { sort: filters.sort }),
      filters: snapshotFilters(filters),
      pagePaperIds: view.page.papers.map((paper) => paper.paperId),
      selectedIds: [...selected],
      rev: view.page.rev,
    }
    const timer = setTimeout(() => {
      if (document.hidden) return
      void postViewSnapshot(body).catch(() => undefined)
    }, 400)
    return () => clearTimeout(timer)
  }, [taskId, view.detail, view.page, view.pageIndex, view.pageSize, filters, selected])

  // 消费模型下载指令：始终串行。上一轮没跑完（含停在选目录）就留在 store
  // 队列里，空闲后自动接着处理下一条，不丢也不重复。
  useEffect(() => {
    if (taskId === null || batchBusyRef.current || batchBusy || batchRunning) return
    const command = pendingCommands[0]
    if (command === undefined) return
    if (command.paperIds.length === 0) {
      markConsumed(command.commandId)
      notify(t('batch.empty'))
      return
    }
    const byId = new Map(command.items.map((item) => [item.paperId, item]))
    const items: BatchDownloadItem[] = command.paperIds.map((paperId) => {
      const item = byId.get(paperId)
      return {
        paperId,
        title: item?.title ?? papersByIdRef.current.get(paperId)?.title ?? '',
        ...(item?.source === undefined ? {} : { source: item.source }),
        ...(item?.meta === undefined ? {} : { meta: item.meta }),
      }
    })
    markConsumed(command.commandId)
    stageDownload(items, {
      origin: 'model',
      scopeLabel: command.scopeLabel,
      reason: command.reason,
      ...(command.dir === undefined ? {} : { dir: command.dir }),
    })
    // stageDownload 每次渲染都是新函数，故意不进依赖：占用状态靠
    // batchBusyRef 同步拦截，空闲后靠 batchBusy 变化重新消费队列。
  }, [taskId, pendingCommands, batchBusy, batchRunning])

  // 消费模型 Zotero 指令：同步弹窗同时只能跑一批，弹窗开着时指令留在队列里，
  // 关闭后自动接着消费下一条（与下载队列互不干扰）。tab 未挂载时由 store 暂存。
  useEffect(() => {
    if (taskId === null || zoteroOpen) return
    const command = pendingZoteroCommands[0]
    if (command === undefined) return
    if (command.paperIds.length === 0) {
      markZoteroConsumed(command.commandId)
      notify(t('zotero.dialog.modelEmpty'))
      return
    }
    const byId = new Map(command.items.map((item) => [item.paperId, item]))
    const items: BatchDownloadItem[] = command.paperIds.map((paperId) => {
      const item = byId.get(paperId)
      return {
        paperId,
        title: item?.title ?? papersByIdRef.current.get(paperId)?.title ?? '',
        ...(item?.source === undefined ? {} : { source: item.source }),
        ...(item?.meta === undefined ? {} : { meta: item.meta }),
      }
    })
    markZoteroConsumed(command.commandId)
    openZotero(items, {
      origin: 'model',
      scopeLabel: command.scopeLabel,
      reason: command.reason,
      ...(command.target === undefined ? {} : { initialTarget: command.target }),
      autoStart: command.autoStart,
    })
    // openZotero 每次渲染都是新函数，故意不进依赖：zoteroOpen 变化即代表
    // 弹窗已关闭，可以消费下一条；运行中的弹窗靠 zoteroOpen 拦截。
  }, [taskId, pendingZoteroCommands, zoteroOpen])

  const zoteroIds = (paperIds: readonly string[]): void => {
    if (taskId === null || paperIds.length === 0) return
    // 标题优先取当前页与已加载过的文献；跨页未加载的先留空，由弹窗显示「无标题」。
    const known = new Map<string, string>()
    for (const paper of view.page?.papers ?? []) known.set(paper.paperId, paper.title)
    for (const paper of papersByIdRef.current.values()) {
      if (!known.has(paper.paperId)) known.set(paper.paperId, paper.title)
    }
    openZotero(paperIds.map((paperId) => ({ paperId, title: known.get(paperId) ?? '' })))
  }

  const zoteroMany = (): void => zoteroIds(ids)

  const taskListDialog = (
    <TaskListDialog
      t={t}
      open={showTaskList}
      onClose={() => setShowTaskList(false)}
      currentTaskId={taskId}
      onOpenTask={onOpenTask ?? (() => undefined)}
      onCurrentRemoved={(fallback) => {
        if (fallback !== null) onOpenTask?.(fallback.id, fallback.title)
        else if (taskId !== null) onCloseTask?.(taskId)
      }}
    />
  )

  // 切换前预检没拦住（例如在别处被删）或布局恢复指向了已清理的任务：
  // 不展示裸报错，改为「任务不存在」卡片 + 明确的恢复入口。
  const missing = taskId === null || view.errorCode === 'not_found'
  const back = getPreviousTask?.() ?? null

  if (detail === null || taskId === null) {
    return (
      <div className="ls-root" style={MISSING_PANEL_STYLE}>
        <NoticeBar t={t} />
        {view.loading && !missing ? (
          <div style={statusStyle}>{t('task.loading')}</div>
        ) : missing ? (
          <>
            <div style={MISSING_CARD_STYLE}>
              <div style={MISSING_TITLE_STYLE}>{t('task.notFound')}</div>
              {taskId !== null && (
                <div style={statusStyle}>{tpl(t('task.missingId'), { id: taskId })}</div>
              )}
              <div style={statusStyle}>{t('task.missingHint')}</div>
              <div style={MISSING_ACTIONS_STYLE}>
                {back !== null && back.id !== taskId && (
                  <Button
                    variant="primary"
                    size="sm"
                    type="button"
                    onClick={() => onOpenTask?.(back.id, back.title)}
                  >
                    {t('task.backToPrevious')}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => setShowTaskList(true)}
                >
                  {t('task.openList')}
                </Button>
                {taskId !== null && (
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={() => onCloseTask?.(taskId)}
                  >
                    {t('task.closeTab')}
                  </Button>
                )}
              </div>
            </div>
            {taskListDialog}
          </>
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
  /** 执行查询按钮的忙碌态：任务在跑，或本轮重跑请求尚未返回。 */
  const running = active || view.busy
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
  const overviewRate =
    overview === null || overview.loaded === 0
      ? 0
      : Math.round((overviewAvailable / overview.loaded) * 100)

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
    <div className="ls-root" style={TASK_PANEL_STYLE}>
      <NoticeBar t={t} />
      <header style={HEADER_STYLE}>
        <div style={HEADER_TOP_STYLE}>
          <div style={HEADER_LEAD_STYLE}>
            <div className="ls-page-title" style={HEADER_TITLE_STYLE}>
              {detail.title}
            </div>
            <Button
              variant="outline"
              size="sm"
              type="button"
              className="ls-btn ls-btn-ghost ls-btn-compact"
              style={HEADER_BTN_STYLE}
              title={t('taskList.open')}
              onClick={() => setShowTaskList(true)}
            >
              <SwitchIcon />
              {t('taskList.switch')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              type="button"
              className="ls-btn ls-btn-ghost ls-btn-compact"
              style={HEADER_BTN_STYLE}
              title={running ? t('task.running') : t('task.runQueryHint')}
              disabled={running}
              onClick={() => {
                void view.rerun()
              }}
            >
              <span style={RUN_ICON_STYLE} aria-hidden>
                {running ? <SpinnerIcon /> : <RunIcon />}
              </span>
              {t('task.runQuery')}
            </Button>
          </div>
          <div style={HEADER_ACTIONS_STYLE}>
            <Button
              variant="outline"
              size="sm"
              type="button"
              className="ls-btn ls-btn-ghost ls-btn-compact"
              style={HEADER_BTN_STYLE}
              title={t('task.insertToChatHint')}
              onClick={insertTask}
            >
              <ChatIcon />
              {t('task.insertToChat')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              type="button"
              className="ls-btn ls-btn-ghost ls-btn-compact"
              style={HEADER_BTN_STYLE}
              onClick={() => view.reload()}
            >
              <RefreshIcon />
              {t('task.refresh')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              type="button"
              className="ls-btn ls-btn-ghost ls-btn-compact"
              style={HEADER_BTN_STYLE}
              title={t('rounds.open')}
              onClick={() => setShowRounds(true)}
            >
              <HistoryIcon />
              {currentRoundNo > 0
                ? tpl(t('task.roundsButton'), { round: currentRoundNo })
                : t('rounds.open')}
            </Button>
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
            <ConditionSummary
              t={t}
              conditions={detail.conditions}
              {...(detail.fromTaskId === undefined ? {} : { fromTaskId: detail.fromTaskId })}
            />
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

      {(toast !== null || risFallback !== null) && (
        <div style={toastStackStyle}>
          {toast !== null && (
            <div
              role={toast.tone === 'error' ? 'alert' : 'status'}
              style={{
                ...toastStyle,
                ...(toast.tone === 'error' ? toastErrorStyle : null),
              }}
            >
              {toast.text}
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

      <div className="ls-seg" style={TAB_ROW_STYLE}>
        {tabItems.map((item) => (
          <div
            key={item.key}
            className="ls-seg-item"
            role="tab"
            aria-selected={tab === item.key}
            aria-current={tab === item.key ? 'page' : undefined}
            tabIndex={0}
            style={tab === item.key ? TAB_ACTIVE_STYLE : TAB_STYLE}
            onClick={() => setTab(item.key)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setTab(item.key)
                return
              }
              // 隐藏了滚动条，方向键是窄面板里唯一可靠的切换方式。
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault()
                const sibling =
                  event.key === 'ArrowRight'
                    ? event.currentTarget.nextElementSibling
                    : event.currentTarget.previousElementSibling
                if (sibling instanceof HTMLElement) {
                  sibling.focus()
                  sibling.click()
                }
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
          <SupplementBox
            key={taskId}
            t={t}
            taskId={taskId}
            disabled={active}
            onAdded={() => {
              view.goToPage(0)
              view.reload()
            }}
            onViewSupplements={() => setFilters({ supplementedOnly: true })}
          />
          {!active && detail.steps?.some((step) => step.received !== undefined) && (
            <details>
              <summary>{t('task.progress.fetchDetails')}</summary>
              <RunProgressPanel t={t} steps={detail.steps} />
            </details>
          )}
          <div style={COVERAGE_WRAP_STYLE}>
            <div style={COVERAGE_ROW_STYLE}>
              {(detail.stats.supplemented ?? 0) > 0 && (
                <span>{tpl(t('supplement.count'), { n: detail.stats.supplemented ?? 0 })}</span>
              )}
              {overview !== null && (
                <span>
                  {tpl(t('fulltext.coverageBar'), {
                    available: overviewAvailable,
                    total: overview.loaded,
                    rate: overviewRate,
                  })}
                </span>
              )}
              {detail.fromTaskId !== undefined && (
                <NewOnlyPill t={t} filters={filters} onChange={setFilters} />
              )}
              <FilterToggleButton
                t={t}
                count={filterCount}
                onClick={() => setFilterOpen(true)}
              />
              <ActiveFilterChips
                t={t}
                value={filters}
                queries={detail.conditions.queries}
                groups={detail.groups}
                onChange={setFilters}
              />
              <ExportMenu t={t} taskId={taskId} filters={filters} />
            </div>
          </div>
          <TaskFilters
            t={t}
            value={filters}
            sources={detail.conditions.sources}
            queries={detail.conditions.queries}
            groups={detail.groups}
            stats={overview}
            screeningCounts={detail.stats.screening}
            open={filterOpen}
            onOpenChange={setFilterOpen}
            onChange={setFilters}
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
          {active ? (
            detail.steps !== undefined && detail.steps.length > 0 ? (
              <RunProgressPanel t={t} steps={detail.steps} />
            ) : (
              // 旧任务兜底：没有步骤数据时保留原单行提示。
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
            )
          ) : page !== null && page.papers.length > 0 ? (
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
          groups={detail.groups}
          screeningCounts={detail.stats.screening}
          downloads={downloads}
          busy={view.busy}
          batchRunning={batchRunning}
          onDownload={downloadPaper}
          {...(detail.downloadDir === undefined ? {} : { downloadDir: detail.downloadDir })}
          {...(onOpenLocal === undefined ? {} : { onOpenLocal })}
          {...(onRevealLocal === undefined ? {} : { onRevealLocal })}
          onRevealDir={onRevealLocal}
          onZotero={zoteroPaper}
          onBatchDownload={(papers) =>
            stageDownload(
              papers.map((paper) => ({ paperId: paper.paperId, title: paper.title })),
            )
          }
          onBatchZotero={(papers) => zoteroIds(papers.map((paper) => paper.paperId))}
          onShowInResults={(viewKey, ledgerFilter) => {
            // 清空其他筛选，保证按钮上写的篇数就是跳过去能看到的篇数；
            // 台账自己的筛读 / 分组条件一并带过去。
            setFilters({
              ...(viewKey === 'missing'
                ? { missingFullText: true }
                : viewKey === 'reachable'
                  ? { hasFullText: true }
                  : { pdfStatus: viewKey }),
              ...(ledgerFilter.screening === undefined ? {} : { screening: ledgerFilter.screening }),
              ...(ledgerFilter.groupId === undefined ? {} : { groupId: ledgerFilter.groupId }),
            })
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
          {...(filters.groupId === undefined ? {} : { activeGroupId: filters.groupId })}
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
        origin={batchMeta.origin}
        scopeLabel={batchMeta.scopeLabel}
        reason={batchMeta.reason}
        cancelled={batchCancelled}
        started={batchPhase === 'running'}
        dir={batchDir}
        defaultDir={batchDefaultDir}
        picking={batchPicking}
        onDirChange={setBatchDir}
        onPickDir={pickBatchDir}
        onConfirm={confirmDownload}
        onCancel={batchMeta.origin === 'model' ? cancelBatch : undefined}
        onClose={closeBatch}
      />
      <ZoteroSyncDialog
        t={t}
        open={zoteroOpen}
        taskId={taskId}
        items={zoteroItems}
        states={detail.states}
        meta={zoteroMeta}
        onClose={() => {
          setZoteroOpen(false)
        }}
        onDone={(failedIds) => {
          // 同步结果已写回 Host 并广播新 rev，卡片状态会随详情更新。
          if (failedIds.length === 0) return
          setRisFallback({
            ids: failedIds,
            message: t('zotero.dialog.failFallback'),
          })
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
      {taskListDialog}
    </div>
  )
}

const HEADER_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
}

const HEADER_TOP_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: 8,
}

/** 标题与「切换任务 / 执行查询」同行；空间不足时按钮换行到标题下方。 */
const HEADER_LEAD_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 6,
  flex: '1 1 auto',
  minWidth: 0,
}

/** 标题允许收缩换行，始终先保留按钮的完整尺寸。 */
const HEADER_TITLE_STYLE: CSSProperties = {
  minWidth: 0,
}

/** 头部胶囊按钮不参与压缩，避免文字被挤成多行。 */
const HEADER_BTN_STYLE: CSSProperties = {
  flexShrink: 0,
}

/** 头部操作区：窄面板下允许换行，避免按钮被裁掉。 */
const HEADER_ACTIONS_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  flexWrap: 'wrap',
  gap: 6,
  flex: '0 1 auto',
  minWidth: 0,
  marginLeft: 'auto',
}

/** 执行查询按钮的图标：常态绿色播放键，执行中换成绿色转圈。 */
const RUN_ICON_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--ls-success)',
}

/** 标题下方左右两栏：左=查询条件，右=本轮结果与提醒。窄面板下自动上下堆叠。 */
const HEADER_SPLIT_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 8,
}

/** 两栏卡片统一的最高高度（含内边距与描边）：超出部分在卡片内部滚动。 */
const HEADER_BOX_MAX_HEIGHT = 142

const CONDITION_BOX_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  minWidth: 0,
  maxHeight: HEADER_BOX_MAX_HEIGHT,
  boxSizing: 'border-box',
  padding: '10px 12px',
  borderRadius: 12,
  border: '1px solid var(--ls-line)',
  background: 'var(--ls-surface-2)',
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
  fontWeight: 500,
}

const ROUND_BOX_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  minWidth: 0,
  maxHeight: HEADER_BOX_MAX_HEIGHT,
  boxSizing: 'border-box',
  overflowY: 'auto',
  padding: '10px 12px',
  borderRadius: 12,
  border: '1px solid var(--ls-accent-line)',
  background: 'var(--ls-accent-soft)',
}

/** 检索进行中：整框加深蓝色底与描边，让「还在跑」一眼可见。 */
const ROUND_BOX_ACTIVE_STYLE: CSSProperties = {
  ...ROUND_BOX_STYLE,
  border: '1px solid var(--ls-accent-line-strong)',
  background: 'var(--ls-accent-soft-2)',
  boxShadow: '0 0 0 3px var(--ls-accent-soft)',
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
  color: 'var(--ls-ink-3)',
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
  borderRadius: 8,
  border: '1px solid var(--ls-accent-line-strong)',
  background: 'var(--ls-accent-soft-2)',
  fontSize: 12.5,
}

const ROUND_RUNNING_ICON_STYLE: CSSProperties = {
  ...ROUND_ICON_STYLE,
  opacity: 1,
  marginTop: 0,
}

const ROUND_RUNNING_TEXT_STYLE: CSSProperties = {
  ...ROUND_TEXT_STYLE,
  color: 'var(--ls-accent-ink)',
  fontWeight: 500,
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

/** 在结果页按标识补录，提交后等待用户确认结果。 */
function SupplementBox({ t, taskId, disabled, onAdded, onViewSupplements }: {
  t: Translate
  taskId: string
  disabled: boolean
  onAdded(): void
  onViewSupplements(): void
}): ReactElement {
  const [identifier, setIdentifier] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{
    status: 'added' | 'existing' | 'failed'
    message: string
  } | null>(null)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])

  async function submit(): Promise<void> {
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    try {
      const result = await supplementPaper(taskId, identifier, controller.signal)
      if (controller.signal.aborted) return
      if ('paper' in result) {
        setIdentifier('')
        setFeedback({
          status: result.status,
          message: tpl(t(`supplement.${result.status}`), { title: result.paper.title }),
        })
        if (result.status === 'added') onAdded()
      } else {
        setFeedback({ status: 'failed', message: t(`supplement.${result.status}`) })
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setFeedback({ status: 'failed', message: messageOf(error) })
      }
    } finally {
      pending.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  const feedbackTitle = feedback === null ? '' : t(`supplement.${feedback.status}Title`)

  return (
    <>
      <form
        style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: '6px 8px' }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!disabled && feedback === null && pending.current === null && identifier.trim() !== '') void submit()
        }}
      >
        <input
          aria-label={t('supplement.identifier')}
          placeholder="DOI / PMID / arXiv ID"
          maxLength={512}
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          disabled={disabled || busy}
        />
        <Button type="submit" variant="outline" size="sm" disabled={disabled || busy || identifier.trim() === ''}>
          {t(busy ? 'supplement.working' : 'supplement.add')}
        </Button>
      </form>
      {feedback !== null && (
        <Modal
          open
          headless
          title={feedbackTitle}
          onClose={() => { /* 点击遮罩或按 Escape 时保留结果。 */ }}
        >
          <div style={{ padding: '20px 20px 0' }}>
            <h2 style={{ margin: 0, fontSize: 17 }}>{feedbackTitle}</h2>
            <p style={{ margin: '10px 0 20px', maxHeight: '50dvh', overflowY: 'auto', overflowWrap: 'anywhere' }}>
              {feedback.message}
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }}>
              {feedback.status === 'added' && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setFeedback(null)
                    onViewSupplements()
                  }}
                >
                  {t('supplement.viewAll')}
                </Button>
              )}
              <Button type="button" variant="primary" data-modal-autofocus onClick={() => setFeedback(null)}>
                {t('supplement.confirm')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

/** 「仅看新增」快捷按钮。 */
function NewOnlyPill({
  t,
  filters,
  onChange,
}: {
  t: Translate
  filters: ResultsQuery
  onChange(next: ResultsQuery): void
}): ReactElement {
  return (
    <div style={SCREENING_PILLS_STYLE}>
      <button
        type="button"
        style={filters.newOnly === true ? SCREENING_PILL_ACTIVE : SCREENING_PILL}
        onClick={() => onChange({ ...filters, newOnly: filters.newOnly === true ? undefined : true })}
      >
        {t('ledger.newOnly')}
      </button>
    </div>
  )
}

/** 「导出 ▾」下拉：点开后才展开各格式链接，给筛选条件让出横向空间。 */
function ExportMenu({
  t,
  taskId,
  filters,
}: {
  t: Translate
  taskId: string
  filters: ResultsQuery
}): ReactElement {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const closeOnOutside = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false)
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

  return (
    <div ref={ref} style={EXPORT_ROW_STYLE} title={t('export.hint')}>
      <span style={EXPORT_DIVIDER_STYLE} aria-hidden>
        |
      </span>
      <button
        type="button"
        style={EXPORT_TOGGLE_STYLE}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {t('ledger.export')}
        <ChevronDownIcon />
      </button>
      {open && (
        <div role="menu" style={EXPORT_MENU_STYLE}>
          {EXPORT_FORMATS.map((format) => (
            <a
              key={format}
              role="menuitem"
              style={EXPORT_MENU_ITEM_STYLE}
              href={exportUrl(taskId, format, filters)}
              download
              onClick={() => setOpen(false)}
            >
              {t(`export.${format}`)}
            </a>
          ))}
        </div>
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
        <span style={{ fontSize: 11, color: 'var(--ls-ink-3)' }}>{t('bulk.export')}</span>
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

/** 下载目录只接受绝对路径或 `~/`；相对路径由 Host 拒绝，这里先在前端拦下。 */
function looksLikeAbsoluteDir(value: string): boolean {
  return (
    value === '~' ||
    value.startsWith('~/') ||
    value.startsWith('/') ||
    value.startsWith('\\\\') ||
    /^[A-Za-z]:[\\/]/u.test(value)
  )
}

/** 结果页「检索还在进行」的提示条：蓝色高亮块 + 旋转图标。 */
const ROUND_RESULTS_HINT_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  marginTop: 2,
  padding: '9px 11px',
  borderRadius: 8,
  border: '1px solid var(--ls-accent-line-strong)',
  background: 'var(--ls-accent-soft-2)',
  fontSize: 12.5,
  fontWeight: 500,
  lineHeight: 1.45,
  color: 'var(--ls-accent-ink)',
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
  borderLeft: '3px solid var(--ls-warn)',
}
const RIS_FALLBACK_LINK_STYLE: CSSProperties = {
  color: 'var(--ls-accent-ink)',
  fontSize: 12,
  textDecoration: 'underline',
  textUnderlineOffset: 2,
}
const RIS_FALLBACK_BUTTON_STYLE: CSSProperties = {
  ...linkButtonStyle,
  textDecoration: 'none',
}

// 只有选中项画底部横线；tab 用普通 div 渲染，绕开宿主对 button / tab 元素的
// 全局下划线样式（原先的 `transparent` 边会被渲染成深色）。用 padding 补偿 2px 边框高度。
const TAB_ROW_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'nowrap',
  gap: 3,
  padding: 3,
  borderRadius: 10,
  background: 'var(--ls-surface-2)',
  overflowX: 'auto',
  overflowY: 'hidden',
}
const TAB_STYLE: CSSProperties = {
  padding: '5px 9px',
  borderRadius: 9,
  border: '1px solid var(--ls-line)',
  boxShadow: 'none',
  outline: 'none',
  textDecoration: 'none',
  background: 'var(--ls-surface)',
  color: 'var(--ls-ink-2)',
  fontSize: 11,
  fontWeight: 500,
  lineHeight: 1.4,
  flex: '0 0 auto',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  userSelect: 'none',
}
/** 激活项在深色主题下由 theme.ts 的 !important 规则改写为浅靛蓝底。 */
const TAB_ACTIVE_STYLE: CSSProperties = {
  ...TAB_STYLE,
  border: '1px solid #111318',
  background: '#111318',
  color: '#fff',
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
  border: '1px solid var(--ls-line-strong)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}
const SCREENING_PILL_ACTIVE: CSSProperties = {
  ...SCREENING_PILL,
  borderColor: ACCENT,
  color: 'var(--ls-accent-ink)',
  fontWeight: 500,
}
const EXPORT_ROW_STYLE: CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'nowrap',
  whiteSpace: 'nowrap',
  gap: 8,
  marginLeft: 'auto',
  fontSize: 11,
}
/** 「导出」入口：保留文案，右侧下三角提示可展开。 */
const EXPORT_TOGGLE_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'var(--ls-accent-ink)',
  fontSize: 11.5,
  lineHeight: 1.4,
  cursor: 'pointer',
}
const EXPORT_MENU_STYLE: CSSProperties = {
  position: 'absolute',
  top: '100%',
  right: 0,
  marginTop: 3,
  zIndex: 40,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 120,
  padding: 2,
  borderRadius: 10,
  border: '1px solid var(--ls-line)',
  background: 'var(--ls-surface)',
  boxShadow: 'var(--ls-shadow-2)',
}
const EXPORT_MENU_ITEM_STYLE: CSSProperties = {
  padding: '5px 8px',
  borderRadius: 4,
  color: 'var(--ls-ink-1)',
  fontSize: 12,
  lineHeight: 1.4,
  textDecoration: 'none',
  whiteSpace: 'nowrap',
}
/** 导出区与前文之间的竖线分隔。 */
const EXPORT_DIVIDER_STYLE: CSSProperties = {
  opacity: 0.3,
  marginRight: -2,
}
const EXPORT_LINK_STYLE: CSSProperties = {
  color: 'var(--ls-accent-ink)',
  textDecoration: 'none',
  fontSize: 11.5,
}
const BULK_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '4px 6px',
  borderRadius: 6,
  background: 'var(--ls-accent-soft)',
  border: '1px solid var(--ls-accent-line)',
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
  border: '1px solid var(--ls-line-strong)',
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
  background: 'var(--ls-accent-soft)',
  border: '1px solid var(--ls-accent-line)',
  fontSize: 12,
}
const COVERAGE_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
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

/** 任务缺失时的整页容器：保留滚动与最小高度，不把宿主 tab 撑坏。 */
const MISSING_PANEL_STYLE: CSSProperties = {
  ...TASK_PANEL_STYLE,
  overflowY: 'auto',
}
const MISSING_CARD_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '14px 14px',
  borderRadius: 12,
  border: '1px solid var(--ls-line)',
  background: 'var(--ls-surface-2)',
}
const MISSING_TITLE_STYLE: CSSProperties = {
  fontSize: 13.5,
  fontWeight: 600,
  lineHeight: 1.45,
  color: ERROR,
}
const MISSING_ACTIONS_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
  marginTop: 2,
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
  color: 'var(--ls-ink-3)',
  whiteSpace: 'nowrap',
}
const PAGE_SORT_LABEL_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 11.5,
  color: 'var(--ls-ink-2)',
}
const PAGE_SORT_SELECT_STYLE: CSSProperties = {
  fontSize: 11.5,
  padding: '2px 4px',
  borderRadius: 4,
  border: '1px solid var(--ls-line-strong)',
  background: 'transparent',
  color: 'inherit',
}
