/**
 * 「全文」台账：全任务口径的覆盖率 + 可按状态切换的补抓队列。
 *
 * 统计由父组件一次取回（与结果页的覆盖率横幅共用同一份数据），本页只按视图
 * 拉列表；切换视图或任务 rev 变化时重置分页。下载 / Zotero 走父组件的同一套
 * 操作，完成后 rev 变化会触发本页重取。
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'

import type {
  Paper,
  PaperState,
  PdfStatus,
  TaskStatsReport,
} from '../search/types'
import { fetchResults, type ResultsQuery } from './api'
import { tpl, type Translate } from './locales'

const STATUSES: readonly PdfStatus[] = [
  'unknown',
  'available',
  'downloaded',
  'html-only',
  'paywalled',
  'blocked',
  'failed',
]
const PAGE_SIZE = 100

/** `missing` 为缺全文合集，其余为按有效全文状态精确过滤。 */
export type FullTextView = 'missing' | PdfStatus

interface Props {
  t: Translate
  taskId: string
  rev: number
  states: Record<string, PaperState>
  /** 任务级统计（scope=task），与结果页覆盖率横幅共用。 */
  stats: TaskStatsReport | null
  onDownload: (paper: Paper) => void
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
  return view === 'missing' ? { missingFullText: true } : { pdfStatus: view }
}

export function FullTextTab({
  t,
  taskId,
  rev,
  states,
  stats,
  onDownload,
  onZotero,
  onBatchDownload,
  onBatchZotero,
  onShowInResults,
}: Props): ReactElement {
  const [view, setView] = useState<FullTextView>('missing')
  const [list, setList] = useState<ListState>(EMPTY_LIST)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const seqRef = useRef(0)

  useEffect(() => {
    const seq = ++seqRef.current
    const controller = new AbortController()
    setList(EMPTY_LIST)
    setSelected(new Set())
    void fetchResults(taskId, { ...viewQuery(view), limit: PAGE_SIZE }, controller.signal)
      .then((page) => {
        if (seqRef.current !== seq || controller.signal.aborted) return
        setList({
          papers: page.papers,
          total: page.total,
          loading: false,
          loadingMore: false,
          error: null,
        })
      })
      .catch((error: unknown) => {
        if (seqRef.current !== seq || controller.signal.aborted) return
        setList({
          ...EMPTY_LIST,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    return () => controller.abort()
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
    coverage === undefined ? 0 : coverage.unknown + coverage.paywalled + coverage.blocked + coverage.failed
  const selectedPapers = list.papers.filter((paper) => selected.has(paper.paperId))
  const viewLabel = view === 'missing' ? t('fulltext.missing') : t(`pdf.status.${view}`)

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
              style={view === 'missing' ? CHIP_ACTIVE_STYLE : CHIP_BUTTON_STYLE}
              onClick={() => setView('missing')}
            >
              {t('fulltext.missing')} {missingCount}
            </button>
            {STATUSES.map((status) => (
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
          onSelectPage={() => setSelected(new Set(list.papers.map((paper) => paper.paperId)))}
          onClear={() => setSelected(new Set())}
          onDownload={() => onBatchDownload(selectedPapers)}
          onZotero={() => onBatchZotero(selectedPapers)}
        />
      )}

      {list.error !== null && <div style={{ ...TEXT_STYLE, color: '#d64545' }}>{list.error}</div>}

      {list.papers.length === 0 ? (
        <div style={TEXT_STYLE}>{t('fulltext.none')}</div>
      ) : (
        <ul style={LIST_STYLE}>
          {list.papers.map((paper) => (
            <FullTextRow
              key={paper.paperId}
              t={t}
              paper={paper}
              selected={selected.has(paper.paperId)}
              status={paperStatus(states, paper)}
              error={states[paper.paperId]?.pdfError}
              onToggleSelect={toggleSelect}
              onDownload={onDownload}
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
  onSelectPage,
  onClear,
  onDownload,
  onZotero,
}: {
  t: Translate
  count: number
  onSelectPage(): void
  onClear(): void
  onDownload(): void
  onZotero(): void
}): ReactElement {
  return (
    <div style={BULK_STYLE}>
      <strong style={{ fontSize: 12 }}>{tpl(t('bulk.count'), { n: count })}</strong>
      <button type="button" style={LINK_STYLE} onClick={onSelectPage}>
        {t('bulk.selectPage')}
      </button>
      <button type="button" style={LINK_STYLE} onClick={onClear}>
        {t('bulk.clear')}
      </button>
      <button type="button" style={LINK_STYLE} onClick={onDownload}>
        {t('bulk.download')}
      </button>
      <button type="button" style={LINK_STYLE} onClick={onZotero}>
        {t('bulk.zotero')}
      </button>
    </div>
  )
}

function FullTextRow({
  t,
  paper,
  selected,
  status,
  error,
  onToggleSelect,
  onDownload,
  onZotero,
}: {
  t: Translate
  paper: Paper
  selected: boolean
  status: PdfStatus
  error: string | undefined
  onToggleSelect(paperId: string): void
  onDownload(paper: Paper): void
  onZotero(paper: Paper): void
}): ReactElement {
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
        {error !== undefined && <span style={ROW_ERROR_STYLE}>{error}</span>}
      </div>
      <div style={ROW_ACTIONS_STYLE}>
        <button type="button" style={LINK_STYLE} onClick={() => onDownload(paper)}>
          {t('pdf.download')}
        </button>
        <button type="button" style={LINK_STYLE} onClick={() => onZotero(paper)}>
          {t('pdf.zotero')}
        </button>
      </div>
    </li>
  )
}

function paperStatus(states: Record<string, PaperState>, paper: Paper): PdfStatus {
  return states[paper.paperId]?.pdfStatus ?? (paper.pdfUrl === '' ? 'unknown' : 'available')
}

function statusKey(status: PdfStatus): keyof NonNullable<TaskStatsReport['fullText']> {
  return status === 'html-only' ? 'htmlOnly' : status
}

const WRAP_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 6 }
const TEXT_STYLE: CSSProperties = { fontSize: 12.5, lineHeight: 1.6 }
const HINT_STYLE: CSSProperties = { fontSize: 11, opacity: 0.7, lineHeight: 1.6 }
const CHIP_ROW_STYLE: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4 }
const CHIP_BUTTON_STYLE: CSSProperties = {
  fontSize: 11,
  padding: '1px 6px',
  borderRadius: 4,
  border: '1px solid rgba(127,127,127,0.28)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
}
const CHIP_ACTIVE_STYLE: CSSProperties = {
  ...CHIP_BUTTON_STYLE,
  borderColor: '#508cff',
  color: '#508cff',
  fontWeight: 600,
}
const ROW_HEAD_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  marginTop: 4,
  fontSize: 12.5,
  fontWeight: 650,
}
const LINK_STYLE: CSSProperties = {
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: '#508cff',
  fontSize: 11,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}
const BULK_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
  padding: '4px 6px',
  borderRadius: 6,
  background: 'rgba(80,140,255,0.08)',
  border: '1px solid rgba(80,140,255,0.25)',
}
const MORE_STYLE: CSSProperties = {
  alignSelf: 'flex-start',
  marginTop: 4,
  padding: '3px 8px',
  borderRadius: 4,
  border: '1px solid rgba(127,127,127,0.28)',
  background: 'transparent',
  color: 'inherit',
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
  borderBottom: '1px solid rgba(127,127,127,0.1)',
}
const ROW_MAIN_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  minWidth: 0,
}
const ROW_TITLE_STYLE: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 650,
  lineHeight: 1.45,
  color: 'inherit',
  textDecoration: 'none',
}
const ROW_META_STYLE: CSSProperties = { fontSize: 11, opacity: 0.66 }
const ROW_ERROR_STYLE: CSSProperties = { fontSize: 11, color: '#b26a00' }
const ROW_ACTIONS_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 2,
  flex: '0 0 auto',
}
