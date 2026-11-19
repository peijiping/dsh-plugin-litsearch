/**
 * 「全文」台账：全任务口径的覆盖率 + 可按状态切换的补抓队列。
 *
 * 统计由父组件一次取回（与结果页的覆盖率横幅共用同一份数据），本页只按视图
 * 拉列表；切换视图时重置分页，同一视图内的 rev 变化（下载 / 同步完成）只静默
 * 更新列表与状态，保留滚动位置与已选项。下载 / Zotero 走父组件的同一套操作。
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'

import type {
  Paper,
  PaperState,
  PdfStatus,
  TaskStatsReport,
} from '../search/types'
import { fetchResults, type ResultsQuery } from './api'
import { BulkActionButton, BulkDownloadButton } from './BulkButtons'
import { DownloadButton } from './DownloadButton'
import { ZoteroIcon } from './icons'
import { tpl, type Translate } from './locales'
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
const PAGE_SIZE = 100

/** `reachable` 为可获取全文合集，`missing` 为缺全文合集，其余为按有效状态精确过滤。 */
export type FullTextView = 'reachable' | 'missing' | PdfStatus

interface Props {
  t: Translate
  taskId: string
  rev: number
  states: Record<string, PaperState>
  /** 任务级统计（scope=task），与结果页覆盖率横幅共用。 */
  stats: TaskStatsReport | null
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
  /** 清空其他筛选，把当前视图带进结果页。 */
  onShowInResults: (view: FullTextView) => void
}

interface ListState {
  papers: Paper[]
  total: number
  loading: boolean
  loadingMore: boolean
  error: string | null
}

const EMPTY_LIST: ListState = {
  papers: [],
  total: 0,
  loading: true,
  loadingMore: false,
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
  const [list, setList] = useState<ListState>(EMPTY_LIST)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const seqRef = useRef(0)
  const listRef = useRef(list)
  listRef.current = list
  /** 上一次取数的任务 + 视图；相同则说明只是 rev 刷新，保留现有列表。 */
  const scopeRef = useRef('')

  useEffect(() => {
    const scope = `${taskId}\u0000${view}`
    const sameScope = scopeRef.current === scope
    scopeRef.current = scope
    const seq = ++seqRef.current
    const controller = new AbortController()
    const loaded = listRef.current.papers.length
    if (!sameScope) {
      setList(EMPTY_LIST)
      setSelected(new Set())
    }

    // 按 PAGE_SIZE 分块补齐已加载的条目：rev 刷新不缩水列表，也不清空滚动内容。
    const refresh = async (): Promise<void> => {
      const target = sameScope ? Math.max(PAGE_SIZE, loaded) : PAGE_SIZE
      const papers: Paper[] = []
      let total = 0
      try {
        for (let offset = 0; offset < target; ) {
          const page = await fetchResults(
            taskId,
            { ...viewQuery(view), offset, limit: PAGE_SIZE },
            controller.signal,
          )
          if (seqRef.current !== seq || controller.signal.aborted) return
          papers.push(...page.papers)
          total = page.total
          offset += PAGE_SIZE
          if (page.papers.length < PAGE_SIZE || papers.length >= total) break
        }
        setList({ papers, total, loading: false, loadingMore: false, error: null })
      } catch (error) {
        if (seqRef.current !== seq || controller.signal.aborted) return
        const message = error instanceof Error ? error.message : String(error)
        setList((previous) =>
          sameScope && previous.papers.length > 0
            ? { ...previous, loading: false, loadingMore: false, error: message }
            : { ...EMPTY_LIST, loading: false, error: message },
        )
      }
    }

    // 下载 / 同步会连续触发多次 rev：同一视图内去抖，避免每篇都重取整页。
    const timer = sameScope ? setTimeout(() => void refresh(), 250) : undefined
    if (timer === undefined) void refresh()
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [taskId, rev, view])

  const loadMore = (): void => {
    if (list.loading || list.loadingMore || list.papers.length >= list.total) return
    const seq = seqRef.current
    const offset = list.papers.length
    setList((previous) => ({ ...previous, loadingMore: true }))
    void fetchResults(taskId, { ...viewQuery(view), offset, limit: PAGE_SIZE })
      .then((page) => {
        if (seqRef.current !== seq) return
        setList((previous) => ({
          ...previous,
          papers: [...previous.papers, ...page.papers],
          total: page.total,
          loadingMore: false,
        }))
      })
      .catch((error: unknown) => {
        if (seqRef.current !== seq) return
        setList((previous) => ({
          ...previous,
          loadingMore: false,
          error: error instanceof Error ? error.message : String(error),
        }))
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

  if (list.loading && list.papers.length === 0) {
    return <div style={TEXT_STYLE}>{t('fulltext.loading')}</div>
  }

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
  const selectedPapers = list.papers.filter((paper) => selected.has(paper.paperId))
  const viewLabel =
    view === 'missing'
      ? t('fulltext.missing')
      : view === 'reachable'
        ? t('fulltext.reachable')
        : t(`pdf.status.${view}`)

  return (
    <div style={WRAP_STYLE}>
      <div style={HINT_STYLE}>
        {coverage === undefined
          ? t('fulltext.hintFallback')
          : tpl(t('fulltext.hint'), { total: stats?.loaded ?? 0 })}
      </div>

      {coverage !== undefined && (
        <>
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
          <div style={TEXT_STYLE}>
            {tpl(t('fulltext.coverage'), {
              available: availableCount,
              total: stats?.loaded ?? 0,
            })}
          </div>
        </>
      )}

      <div style={ROW_HEAD_STYLE}>
        <span>
          {viewLabel}（{list.total}）
        </span>
        <button type="button" style={LINK_STYLE} onClick={() => onShowInResults(view)}>
          {tpl(t('fulltext.showInResults'), { n: list.total })}
        </button>
      </div>

      {selected.size > 0 && (
        <BulkBar
          t={t}
          count={selected.size}
          busy={busy}
          batchRunning={batchRunning}
          onSelectPage={() => setSelected(new Set(list.papers.map((paper) => paper.paperId)))}
          onClear={() => setSelected(new Set())}
          onDownload={() => onBatchDownload(selectedPapers)}
          onZotero={() => onBatchZotero(selectedPapers)}
          {...(downloadDir === undefined || onRevealDir === undefined
            ? {}
            : { downloadDir, onRevealDir })}
        />
      )}

      {list.error !== null && <div style={{ ...TEXT_STYLE, color: 'var(--ls-error)' }}>{list.error}</div>}

      {list.papers.length === 0 ? (
        <div style={TEXT_STYLE}>{t('fulltext.none')}</div>
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
      {list.papers.length < list.total && (
        <button type="button" style={MORE_STYLE} disabled={list.loadingMore} onClick={loadMore}>
          {tpl(t('fulltext.loadMore'), { shown: list.papers.length, total: list.total })}
        </button>
      )}
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
  onSelectPage,
  onClear,
  onDownload,
  onZotero,
}: {
  t: Translate
  count: number
  busy: boolean
  batchRunning: boolean
  downloadDir?: string
  onRevealDir?: (path: string) => void
  onSelectPage(): void
  onClear(): void
  onDownload(): void
  onZotero(): void
}): ReactElement {
  return (
    <div style={BULK_STYLE}>
      <div style={BULK_ROW_STYLE}>
        <strong style={{ fontSize: 12 }}>{tpl(t('bulk.count'), { n: count })}</strong>
        <button type="button" style={LINK_STYLE} onClick={onSelectPage}>
          {t('bulk.selectPage')}
        </button>
        <button type="button" style={LINK_STYLE} onClick={onClear}>
          {t('bulk.clear')}
        </button>
      </div>
      <div style={BULK_ROW_STYLE}>
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
  gap: 8,
  marginTop: 4,
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--ls-ink-1)',
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
const MORE_STYLE: CSSProperties = {
  alignSelf: 'flex-start',
  marginTop: 4,
  padding: '3px 10px',
  borderRadius: 999,
  border: '1px solid var(--ls-line)',
  background: 'var(--ls-surface)',
  color: 'var(--ls-ink-2)',
  fontSize: 11,
  cursor: 'pointer',
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
