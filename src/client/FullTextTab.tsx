/**
 * 「全文」台账：全任务口径的覆盖率 + 可按状态切换的补抓队列。
 *
 * 统计由父组件一次取回（与结果页的覆盖率横幅共用同一份数据），本页只按视图
 * 拉列表；切换视图时重置分页，同一视图内的 rev 变化（下载 / 同步完成）只静默
 * 更新列表与状态，保留滚动位置与已选项。下载 / Zotero 走父组件的同一套操作。
 *
 * 本页另有一层自己的轻量筛选（筛读 + 分组），只收窄下方清单，覆盖统计仍恒为
 * 任务级口径；它与结果页的筛选互不相通。
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'

import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'

import type {
  Paper,
  PaperState,
  PdfStatus,
  Screening,
  TaskGroup,
  TaskStatsReport,
} from '../search/types'
import { RESULT_PAGE_SIZE } from '../search/types'
import { fetchResults, type ResultsQuery } from './api'
import { BulkActionButton, BulkDownloadButton } from './BulkButtons'
import { DownloadButton } from './DownloadButton'
import { ZoteroIcon } from './icons'
import { tpl, type Translate } from './locales'
import { Pager } from './Pager'
import {
  canDownloadPdf,
  paperPdfStatus,
  pdfActionUi,
  zoteroActionUi,
  type PdfDownloadUi,
} from './pdfActions'

/** 可获取全文的状态，chip 排在最前。 */
const REACHABLE_STATUSES: readonly PdfStatus[] = ['available', 'downloaded', 'html-only']
/** 缺全文的状态，chip 排在「缺全文」合集之后。 */
const MISSING_STATUSES: readonly PdfStatus[] = ['unknown', 'paywalled', 'blocked', 'failed']
const SCREENINGS: readonly Screening[] = ['unread', 'read', 'included', 'excluded']

/** `reachable` 为可获取全文合集，`missing` 为缺全文合集，其余为按有效状态精确过滤。 */
export type FullTextView = 'reachable' | 'missing' | PdfStatus

/** 台账本地筛选：只收窄清单，不参与上方覆盖统计。 */
interface LedgerFilter {
  screening?: Screening
  groupId?: string
}

interface Props {
  t: Translate
  taskId: string
  rev: number
  states: Record<string, PaperState>
  /** 任务级统计（scope=task），与结果页覆盖率横幅共用。 */
  stats: TaskStatsReport | null
  /** 台账筛选用的分组清单。 */
  groups: readonly TaskGroup[]
  /** 筛读各状态的篇数；传入后在筛选弹窗里显示为带计数的胶囊按钮。 */
  screeningCounts?: Readonly<Record<Screening, number>>
  /** 即时下载状态；与结果页共用同一份，点击后立刻进入「下载中…」。 */
  downloads: Readonly<Record<string, PdfDownloadUi>>
  /** PDF 保存目录，用于下载按钮的悬停提示。 */
  downloadDir?: string
  /** 任务操作进行中（与结果页的 busy 一致），用于禁用批量按钮。 */
  busy: boolean
  /** 批量下载进行中：禁用按钮，避免再起一轮重复下载。 */
  batchRunning: boolean
  onDownload: (paper: Paper) => void
  /** 已下载文献：先复核文件仍在，再在右侧面板预览本地 PDF。 */
  onOpenLocal?: (taskId: string, paperId: string, path: string) => void
  /** 已下载文献：在系统文件管理器中定位 PDF。 */
  onRevealLocal?: (path: string) => void
  /** 批量下载按钮的下三角：在文件管理器中打开下载目录。 */
  onRevealDir?: (path: string) => void
  onZotero: (paper: Paper) => void
  onBatchDownload: (papers: readonly Paper[]) => void
  onBatchZotero: (papers: readonly Paper[]) => void
  /** 清空其他筛选，把当前视图（含台账筛选）带进结果页。 */
  onShowInResults: (view: FullTextView, filter: LedgerFilter) => void
}

interface ListState {
  papers: Paper[]
  total: number
  loading: boolean
  error: string | null
}

const EMPTY_LIST: ListState = {
  papers: [],
  total: 0,
  loading: true,
  error: null,
}

function viewQuery(view: FullTextView): ResultsQuery {
  if (view === 'missing') return { missingFullText: true }
  if (view === 'reachable') return { hasFullText: true }
  return { pdfStatus: view }
}

export function FullTextTab({
  t,
  taskId,
  rev,
  states,
  stats,
  groups,
  screeningCounts,
  downloads,
  downloadDir,
  busy,
  batchRunning,
  onDownload,
  onOpenLocal,
  onRevealLocal,
  onRevealDir,
  onZotero,
  onBatchDownload,
  onBatchZotero,
  onShowInResults,
}: Props): ReactElement {
  const [view, setView] = useState<FullTextView>('reachable')
  const [ledgerFilter, setLedgerFilter] = useState<LedgerFilter>({})
  const [filterOpen, setFilterOpen] = useState(false)
  const [pageIndex, setPageIndex] = useState(0)
  const [list, setList] = useState<ListState>(EMPTY_LIST)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const seqRef = useRef(0)
  /** 当前清单里见过的文献：跨页选中的条目做批量下载 / Zotero 时要能拿到详情。 */
  const papersByIdRef = useRef<Map<string, Paper>>(new Map())
  /** 上一次取数的任务 + 视图 + 台账筛选 + 页码；相同则说明只是 rev 刷新，保留现有列表。 */
  const scopeRef = useRef('')
  const ledgerFilters: ResultsQuery = {
    ...(ledgerFilter.screening === undefined ? {} : { screening: ledgerFilter.screening }),
    ...(ledgerFilter.groupId === undefined ? {} : { groupId: ledgerFilter.groupId }),
  }
  const ledgerFilterCount =
    (ledgerFilter.screening === undefined ? 0 : 1) + (ledgerFilter.groupId === undefined ? 0 : 1)

  // 换任务 / 视图 / 台账筛选时回到第一页并清空选中：旧页的选中留下会误导批量操作。
  const scopeKey = `${taskId}\u0000${view}\u0000${JSON.stringify(ledgerFilter)}`
  const [prevScope, setPrevScope] = useState(scopeKey)
  if (prevScope !== scopeKey) {
    setPrevScope(scopeKey)
    setPageIndex(0)
    setSelected(new Set())
    papersByIdRef.current.clear()
  }

  useEffect(() => {
    const scope = `${scopeKey}\u0000${pageIndex}`
    const sameScope = scopeRef.current === scope
    scopeRef.current = scope
    const seq = ++seqRef.current
    const controller = new AbortController()
    if (!sameScope) setList(EMPTY_LIST)

    // 同一页内的 rev 刷新只静默重取，不缩水列表，也不清空已选项。
    const refresh = async (): Promise<void> => {
      try {
        const page = await fetchResults(
          taskId,
          {
            ...viewQuery(view),
            ...ledgerFilters,
            offset: pageIndex * RESULT_PAGE_SIZE,
            limit: RESULT_PAGE_SIZE,
          },
          controller.signal,
        )
        if (seqRef.current !== seq || controller.signal.aborted) return
        setList({ papers: page.papers, total: page.total, loading: false, error: null })
      } catch (error) {
        if (seqRef.current !== seq || controller.signal.aborted) return
        const message = error instanceof Error ? error.message : String(error)
        setList((previous) =>
          sameScope && previous.papers.length > 0
            ? { ...previous, loading: false, error: message }
            : { ...EMPTY_LIST, loading: false, error: message },
        )
      }
    }

    // 下载 / 同步会连续触发多次 rev：同一页内去抖，避免每篇都重取一次。
    const timer = sameScope ? setTimeout(() => void refresh(), 250) : undefined
    if (timer === undefined) void refresh()
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
    // ledgerFilter 只在用户操作时换新对象，引用可直接作为依赖。
  }, [taskId, rev, view, ledgerFilter, pageIndex])

  // 结果变少（例如批量改状态后当前页空了）时页码可能越界，收回最后一页。
  useEffect(() => {
    if (list.loading || list.total === 0) return
    const last = Math.max(0, Math.ceil(list.total / RESULT_PAGE_SIZE) - 1)
    if (pageIndex > last) setPageIndex(last)
  }, [list.loading, list.total, pageIndex])

  // 每翻到一页就把文献并入缓存，跨页选中的条目在别的页上也能取到详情。
  useEffect(() => {
    for (const paper of list.papers) papersByIdRef.current.set(paper.paperId, paper)
  }, [list.papers])

  const toggleSelect = (paperId: string): void => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(paperId)) next.delete(paperId)
      else next.add(paperId)
      return next
    })
  }

  /** 本页全选用并集：翻页可累加，不会把其它页已选的文献冲掉。 */
  const selectPage = (): void => {
    const pageIds = list.papers.map((paper) => paper.paperId)
    if (pageIds.length === 0) return
    setSelected((previous) => {
      const next = new Set(previous)
      for (const paperId of pageIds) next.add(paperId)
      return next
    })
  }

  /** 取消全选：清空所有已选（含其它页）。 */
  const clearSelection = (): void => setSelected(new Set())

  const filterDialog = (
    <Modal
      open={filterOpen}
      onClose={() => setFilterOpen(false)}
      title={t('fulltext.filterTitle')}
      description={t('fulltext.filterHint')}
      contentClassName="ls-root"
      footer={
        <div className="ls-root" style={DIALOG_FOOTER_STYLE}>
          <button
            type="button"
            className="ls-btn ls-btn-ghost ls-btn-compact"
            disabled={ledgerFilterCount === 0}
            onClick={() => setLedgerFilter({})}
          >
            {t('filter.reset')}
          </button>
          <button
            type="button"
            className="ls-btn ls-btn-primary"
            onClick={() => setFilterOpen(false)}
          >
            {t('filter.done')}
          </button>
        </div>
      }
    >
      <div style={DIALOG_STACK_STYLE}>
        <div style={DIALOG_FIELD_STYLE}>
          <span style={DIALOG_LABEL_STYLE}>{t('filter.screening')}</span>
          <div style={DIALOG_PILL_ROW_STYLE}>
            {SCREENINGS.map((state) => {
              const active = ledgerFilter.screening === state
              const count = screeningCounts?.[state]
              return (
                <button
                  key={state}
                  type="button"
                  aria-pressed={active}
                  style={active ? PILL_ACTIVE_STYLE : PILL_STYLE}
                  onClick={() =>
                    setLedgerFilter((previous) => ({
                      ...previous,
                      screening: active ? undefined : state,
                    }))
                  }
                >
                  {t(`screening.${state}`)}
                  {count === undefined ? null : (
                    <span style={active ? PILL_COUNT_ON_STYLE : PILL_COUNT_STYLE}>{count}</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        <label style={DIALOG_FIELD_STYLE}>
          <span style={DIALOG_LABEL_STYLE}>{t('filter.group')}</span>
          <select
            style={DIALOG_SELECT_STYLE}
            value={ledgerFilter.groupId ?? ''}
            onChange={(event) =>
              setLedgerFilter((previous) => ({
                ...previous,
                groupId: event.target.value === '' ? undefined : event.target.value,
              }))
            }
          >
            <option value="">{t('filter.any')}</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Modal>
  )

  const coverage = stats?.fullText
  const availableCount =
    coverage === undefined ? 0 : coverage.available + coverage.downloaded + coverage.htmlOnly
  const missingCount =
    coverage === undefined
      ? 0
      : coverage.unknown +
        coverage.missing +
        coverage.paywalled +
        coverage.blocked +
        coverage.failed
  const selectedPapers = [...selected]
    .map((paperId) => papersByIdRef.current.get(paperId))
    .filter((paper): paper is Paper => paper !== undefined)
  const pageCount = Math.max(1, Math.ceil(list.total / RESULT_PAGE_SIZE))
  const viewLabel =
    view === 'missing'
      ? t('fulltext.missing')
      : view === 'reachable'
        ? t('fulltext.reachable')
        : t(`pdf.status.${view}`)

  return (
    <div style={WRAP_STYLE}>
      <div style={TOP_ROW_STYLE}>
        <span style={HINT_STYLE}>
          {coverage === undefined
            ? t('fulltext.hintFallback')
            : tpl(t('fulltext.hint'), {
                total: stats?.loaded ?? 0,
                available: availableCount,
              })}
        </span>
        <button
          type="button"
          style={{ ...LINK_STYLE, flexShrink: 0 }}
          onClick={() => onShowInResults(view, ledgerFilter)}
        >
          {tpl(t('fulltext.showInResults'), { n: list.total })}
        </button>
      </div>

      {coverage !== undefined && (
        <div style={CHIP_ROW_STYLE}>
          <button
            type="button"
            style={view === 'reachable' ? CHIP_ACTIVE_STYLE : CHIP_BUTTON_STYLE}
            onClick={() => setView('reachable')}
          >
            {t('fulltext.reachable')} {availableCount}
          </button>
          {REACHABLE_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              style={view === status ? CHIP_ACTIVE_STYLE : CHIP_BUTTON_STYLE}
              onClick={() => setView(status)}
            >
              {t(`pdf.status.${status}`)} {coverage[statusKey(status)]}
            </button>
          ))}
          <button
            type="button"
            style={view === 'missing' ? CHIP_ACTIVE_STYLE : CHIP_BUTTON_STYLE}
            onClick={() => setView('missing')}
          >
            {t('fulltext.missing')} {missingCount}
          </button>
          {MISSING_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              style={view === status ? CHIP_ACTIVE_STYLE : CHIP_BUTTON_STYLE}
              onClick={() => setView(status)}
            >
              {t(`pdf.status.${status}`)} {coverage[statusKey(status)]}
            </button>
          ))}
        </div>
      )}

      <div style={ROW_HEAD_STYLE}>
        <div style={ROW_HEAD_LEFT_STYLE}>
          <span>
            {viewLabel}（{list.total}）
          </span>
          <div style={ROW_HEAD_ACTIONS_STYLE}>
            <button
              type="button"
              style={list.papers.length === 0 ? LINK_DISABLED_STYLE : LINK_STYLE}
              disabled={list.papers.length === 0}
              title={t('bulk.selectPageHint')}
              onClick={selectPage}
            >
              {t('bulk.selectPage')}
            </button>
            <button
              type="button"
              style={selected.size === 0 ? LINK_DISABLED_STYLE : LINK_STYLE}
              disabled={selected.size === 0}
              title={t('bulk.unselectAllHint')}
              onClick={clearSelection}
            >
              {t('bulk.unselectAll')}
            </button>
          </div>
        </div>
        <div style={PAGER_WRAP_STYLE}>
          <Pager
            t={t}
            index={pageIndex}
            count={pageCount}
            total={list.total}
            onChange={setPageIndex}
          />
        </div>
      </div>

      {ledgerFilterCount > 0 && (
        <div style={SCOPED_STYLE}>
          <span>{t('fulltext.scoped')}</span>
          <button type="button" style={LINK_STYLE} onClick={() => setLedgerFilter({})}>
            {t('filter.reset')}
          </button>
        </div>
      )}

      {selected.size > 0 && (
        <BulkBar
          t={t}
          count={selected.size}
          busy={busy}
          batchRunning={batchRunning}
          onDownload={() => onBatchDownload(selectedPapers)}
          onZotero={() => onBatchZotero(selectedPapers)}
          {...(downloadDir === undefined || onRevealDir === undefined
            ? {}
            : { downloadDir, onRevealDir })}
        />
      )}

      {list.error !== null && <div style={{ ...TEXT_STYLE, color: 'var(--ls-error)' }}>{list.error}</div>}

      {list.papers.length === 0 ? (
        <div style={TEXT_STYLE}>{list.loading ? t('fulltext.listLoading') : t('fulltext.none')}</div>
      ) : (
        <ul style={LIST_STYLE}>
          {list.papers.map((paper) => (
            <FullTextRow
              key={paper.paperId}
              t={t}
              paper={paper}
              state={states[paper.paperId]}
              {...(downloads[paper.paperId] === undefined
                ? {}
                : { download: downloads[paper.paperId] })}
              {...(downloadDir === undefined ? {} : { downloadDir })}
              busy={busy}
              selected={selected.has(paper.paperId)}
              onToggleSelect={toggleSelect}
              onDownload={onDownload}
              {...(onOpenLocal === undefined
                ? {}
                : {
                    onOpenLocal: (path: string) =>
                      onOpenLocal(taskId, paper.paperId, path),
                  })}
              {...(onRevealLocal === undefined ? {} : { onRevealLocal })}
              onZotero={onZotero}
            />
          ))}
        </ul>
      )}
      <Pager t={t} index={pageIndex} count={pageCount} total={list.total} onChange={setPageIndex} />
      {filterDialog}
    </div>
  )
}

function BulkBar({
  t,
  count,
  busy,
  batchRunning,
  downloadDir,
  onRevealDir,
  onDownload,
  onZotero,
}: {
  t: Translate
  count: number
  busy: boolean
  batchRunning: boolean
  downloadDir?: string
  onRevealDir?: (path: string) => void
  onDownload(): void
  onZotero(): void
}): ReactElement {
  return (
    <div style={BULK_STYLE}>
      <div style={BULK_ROW_STYLE}>
        <strong style={{ fontSize: 12 }}>{tpl(t('bulk.count'), { n: count })}</strong>
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
    </div>
  )
}

function FullTextRow({
  t,
  paper,
  state,
  download,
  downloadDir,
  busy,
  selected,
  onToggleSelect,
  onDownload,
  onOpenLocal,
  onRevealLocal,
  onZotero,
}: {
  t: Translate
  paper: Paper
  state: PaperState | undefined
  download?: PdfDownloadUi
  downloadDir?: string
  busy: boolean
  selected: boolean
  onToggleSelect(paperId: string): void
  onDownload(paper: Paper): void
  onOpenLocal?: (path: string) => void
  onRevealLocal?: (path: string) => void
  onZotero(paper: Paper): void
}): ReactElement {
  const status = paperPdfStatus(paper, state)
  const pdfAction = pdfActionUi({ paper, state, download, downloadDir, t })
  const zoteroAction = zoteroActionUi(t, state)
  const canPdf = canDownloadPdf(paper, status)
  return (
    <li style={ROW_STYLE}>
      <input
        type="checkbox"
        style={CHECK_STYLE}
        checked={selected}
        aria-label={t('bulk.select')}
        onChange={() => onToggleSelect(paper.paperId)}
      />
      <div style={{ ...ROW_MAIN_STYLE, flex: 1 }}>
        {paper.url === '' ? (
          <span style={ROW_TITLE_STYLE}>{paper.title}</span>
        ) : (
          <a style={ROW_TITLE_STYLE} href={paper.url} target="_blank" rel="noreferrer noopener">
            {paper.title}
          </a>
        )}
        <span style={ROW_META_STYLE}>
          {[paper.year === null ? '' : String(paper.year), paper.venue]
            .filter((part) => part !== '')
            .join(' · ')}{' '}
          · {t(`pdf.status.${status}`)}
        </span>
        <div style={ROW_ACTIONS_STYLE}>
          {canPdf && (
            <DownloadButton
              t={t}
              label={pdfAction.label}
              hint={pdfAction.hint}
              {...(pdfAction.downloadedPath === undefined
                ? {}
                : { downloadedPath: pdfAction.downloadedPath })}
              missing={pdfAction.pdfMissing}
              downloading={pdfAction.downloading}
              disabled={busy}
              style={LINK_STYLE}
              onDownload={() => onDownload(paper)}
              {...(onOpenLocal === undefined ? {} : { onOpen: onOpenLocal })}
              {...(onRevealLocal === undefined ? {} : { onReveal: onRevealLocal })}
            />
          )}
          <button
            type="button"
            style={
              zoteroAction.color === undefined
                ? LINK_STYLE
                : { ...LINK_STYLE, color: zoteroAction.color }
            }
            title={zoteroAction.hint}
            disabled={busy}
            onClick={() => onZotero(paper)}
          >
            {zoteroAction.label}
          </button>
          {(paper.pdfUrl !== '' || paper.doi !== '') && (
            <a
              style={LINK_STYLE}
              href={paper.pdfUrl !== '' ? paper.pdfUrl : `https://doi.org/${paper.doi}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              {t('pdf.openInBrowser')}
            </a>
          )}
        </div>
        {state?.pdfError !== undefined && state.pdfError !== '' && (
          <span style={ROW_ERROR_STYLE}>{state.pdfError}</span>
        )}
      </div>
    </li>
  )
}

function statusKey(status: PdfStatus): keyof NonNullable<TaskStatsReport['fullText']> {
  return status === 'html-only' ? 'htmlOnly' : status
}

const WRAP_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 6 }
const TEXT_STYLE: CSSProperties = { fontSize: 12.5, lineHeight: 1.6 }
const HINT_STYLE: CSSProperties = { fontSize: 11, color: 'var(--ls-ink-3)', lineHeight: 1.6 }
const TOP_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 8,
}
const CHIP_ROW_STYLE: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4 }
const CHIP_BUTTON_STYLE: CSSProperties = {
  fontSize: 11,
  letterSpacing: 0,
  padding: '2px 9px',
  borderRadius: 999,
  border: '1px solid var(--ls-line)',
  background: 'var(--ls-surface)',
  color: 'var(--ls-ink-2)',
  cursor: 'pointer',
  transition: 'border-color .15s ease, background .15s ease, color .15s ease',
}
const CHIP_ACTIVE_STYLE: CSSProperties = {
  ...CHIP_BUTTON_STYLE,
  borderColor: 'var(--ls-accent-line)',
  background: 'var(--ls-accent-soft)',
  color: 'var(--ls-accent-ink)',
  fontWeight: 500,
}
const ROW_HEAD_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: 8,
  marginTop: 4,
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--ls-ink-1)',
}
const ROW_HEAD_LEFT_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
  minWidth: 0,
}
const PAGER_WRAP_STYLE: CSSProperties = {
  fontSize: 11.5,
  fontWeight: 400,
}
const ROW_HEAD_ACTIONS_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  flexWrap: 'wrap',
  gap: 8,
  minWidth: 0,
}
/** 台账筛选生效时的提示：清单收窄，但覆盖率统计仍是任务级。 */
const SCOPED_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 8px',
  borderRadius: 6,
  background: 'var(--ls-accent-soft)',
  color: 'var(--ls-accent-ink)',
  fontSize: 11,
}
const LINK_STYLE: CSSProperties = {
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'var(--ls-accent-ink)',
  fontSize: 11,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}
const LINK_DISABLED_STYLE: CSSProperties = {
  ...LINK_STYLE,
  color: 'var(--ls-ink-3)',
  cursor: 'default',
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
const DIALOG_FOOTER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  width: '100%',
}
const DIALOG_STACK_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
}
const DIALOG_FIELD_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  minWidth: 0,
}
const DIALOG_LABEL_STYLE: CSSProperties = {
  fontSize: 11.5,
  fontWeight: 400,
  lineHeight: 1.5,
  color: 'var(--ls-ink-2)',
}
const DIALOG_PILL_ROW_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
}
const DIALOG_SELECT_STYLE: CSSProperties = {
  fontSize: 12,
  padding: '6px 9px',
  borderRadius: 8,
  border: '1px solid transparent',
  background: 'var(--ls-surface-2)',
  color: 'var(--ls-ink-1)',
  minWidth: 0,
}
const PILL_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11.5,
  lineHeight: 1.4,
  padding: '4px 10px',
  borderRadius: 999,
  border: '1px solid var(--ls-line)',
  background: 'var(--ls-surface-2)',
  color: 'var(--ls-ink-2)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}
const PILL_ACTIVE_STYLE: CSSProperties = {
  ...PILL_STYLE,
  border: '1px solid var(--ls-accent-line)',
  background: 'var(--ls-accent-soft)',
  color: 'var(--ls-accent-ink)',
  fontWeight: 500,
}
const PILL_COUNT_STYLE: CSSProperties = {
  fontSize: 10.5,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--ls-ink-3)',
}
const PILL_COUNT_ON_STYLE: CSSProperties = {
  ...PILL_COUNT_STYLE,
  color: 'var(--ls-accent-ink)',
}
const LIST_STYLE: CSSProperties = { margin: 0, padding: 0, listStyle: 'none' }
const CHECK_STYLE: CSSProperties = { marginTop: 4, flex: '0 0 auto' }
const ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 6,
  padding: '5px 0',
  borderBottom: '1px solid var(--ls-line)',
}
const ROW_MAIN_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  minWidth: 0,
}
const ROW_TITLE_STYLE: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 500,
  lineHeight: 1.5,
  color: 'var(--ls-ink-1)',
  textDecoration: 'none',
}
const ROW_META_STYLE: CSSProperties = { fontSize: 11, color: 'var(--ls-ink-3)' }
const ROW_ERROR_STYLE: CSSProperties = { fontSize: 11, color: 'var(--ls-warn)' }
/** 三个操作横铺在副标题下一行，长条目自动换行。 */
const ROW_ACTIONS_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 10,
  rowGap: 2,
  marginTop: 2,
}
