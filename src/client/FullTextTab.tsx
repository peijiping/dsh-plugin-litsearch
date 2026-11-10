/**
 * 「全文」台账：与概览覆盖同口径列出缺全文的文献及失败原因。
 *
 * 列表只取缺全文的一页，避免把整个任务拉进组件；下载 / Zotero 仍走父组件的
 * 同一套操作，完成后任务 rev 变化会触发本页重取。
 */

import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'

import type {
  Paper,
  PaperState,
  PdfStatus,
  ResultsPage,
  TaskStatsReport,
} from '../search/types'
import { fetchResults, fetchStats } from './api'
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

interface Props {
  t: Translate
  taskId: string
  rev: number
  states: Record<string, PaperState>
  onDownload: (paper: Paper) => void
  onZotero: (paper: Paper) => void
  onShowMissing: () => void
}

interface State {
  stats: TaskStatsReport | null
  page: ResultsPage | null
  loading: boolean
  error: string | null
}

export function FullTextTab({
  t,
  taskId,
  rev,
  states,
  onDownload,
  onZotero,
  onShowMissing,
}: Props): ReactElement {
  const [state, setState] = useState<State>({
    stats: null,
    page: null,
    loading: true,
    error: null,
  })

  useEffect(() => {
    const controller = new AbortController()
    setState((previous) => ({ ...previous, loading: true, error: null }))
    void Promise.all([
      fetchStats(taskId, {}, 'task', controller.signal),
      fetchResults(taskId, { missingFullText: true, limit: 100 }, controller.signal),
    ])
      .then(([stats, page]) => {
        if (!controller.signal.aborted) setState({ stats, page, loading: false, error: null })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState({
          stats: null,
          page: null,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    return () => {
      controller.abort()
    }
  }, [taskId, rev])

  if (state.loading && state.stats === null) {
    return <div style={TEXT_STYLE}>{t('fulltext.loading')}</div>
  }
  if (state.error !== null) {
    return <div style={{ ...TEXT_STYLE, color: '#d64545' }}>{state.error}</div>
  }

  const stats = state.stats
  const page = state.page
  const coverage = stats?.fullText

  return (
    <div style={WRAP_STYLE}>
      <div style={HINT_STYLE}>{t('fulltext.hint')}</div>

      {coverage !== undefined && (
        <div style={CHIP_ROW_STYLE}>
          {STATUSES.map((status) => (
            <span key={status} style={CHIP_STYLE}>
              {t(`pdf.status.${status}`)} {coverage[statusKey(status)]}
            </span>
          ))}
        </div>
      )}
      {coverage !== undefined && (
        <div style={TEXT_STYLE}>
          {tpl(t('fulltext.coverage'), {
            available: coverage.available + coverage.downloaded,
            total: stats?.loaded ?? 0,
          })}
        </div>
      )}

      <div style={ROW_HEAD_STYLE}>
        <span>{t('fulltext.missing')}</span>
        <button type="button" style={LINK_STYLE} onClick={onShowMissing}>
          {t('fulltext.showInResults')}
        </button>
      </div>

      {page === null || page.papers.length === 0 ? (
        <div style={TEXT_STYLE}>{t('fulltext.none')}</div>
      ) : (
        <ul style={LIST_STYLE}>
          {page.papers.map((paper) => (
            <FullTextRow
              key={paper.paperId}
              t={t}
              paper={paper}
              status={paperStatus(states, paper)}
              error={states[paper.paperId]?.pdfError}
              onDownload={onDownload}
              onZotero={onZotero}
            />
          ))}
        </ul>
      )}
      {page !== null && page.total > page.papers.length && (
        <div style={TEXT_STYLE}>
          {tpl(t('fulltext.more'), { shown: page.papers.length, total: page.total })}
        </div>
      )}
    </div>
  )
}

function FullTextRow({
  t,
  paper,
  status,
  error,
  onDownload,
  onZotero,
}: {
  t: Translate
  paper: Paper
  status: PdfStatus
  error: string | undefined
  onDownload(paper: Paper): void
  onZotero(paper: Paper): void
}): ReactElement {
  return (
    <li style={ROW_STYLE}>
      <div style={ROW_MAIN_STYLE}>
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
const TEXT_STYLE: CSSProperties = { fontSize: 12, lineHeight: 1.6 }
const HINT_STYLE: CSSProperties = { fontSize: 11, opacity: 0.7, lineHeight: 1.6 }
const CHIP_ROW_STYLE: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4 }
const CHIP_STYLE: CSSProperties = {
  fontSize: 11,
  padding: '1px 6px',
  borderRadius: 4,
  border: '1px solid rgba(127,127,127,0.28)',
}
const ROW_HEAD_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  marginTop: 4,
  fontSize: 12,
  fontWeight: 600,
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
const LIST_STYLE: CSSProperties = { margin: 0, padding: 0, listStyle: 'none' }
const ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 8,
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
  fontSize: 12,
  fontWeight: 600,
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
