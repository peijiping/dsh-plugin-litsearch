/**
 * 独立论文 tab：`dsh-resource://litsearch-paper/<taskId>/<paperId>`。
 *
 * 展示完整摘要、标识符、筛读与分组、全文预览和 PubTator 实体；数据来自
 * 单篇详情端点，避免为了打开一篇论文拉取整页结果。
 */

import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type {
  AnnotationInput,
  Paper,
  PaperDetail,
  PdfStatus,
  Screening,
} from '../search/types'
import {
  annotateTask,
  downloadPaperPdf,
  exportUrl,
  fetchPaper,
  paperFullTextUrl,
} from './api'
import { paperSummary, paperText } from './compose'
import { DownloadButton } from './DownloadButton'
import { EntityPanel } from './Entities'
import { insertQuote, type InputActions } from './inline'
import { tpl, type Translate } from './locales'
import { PreviewFrame } from './PreviewFrame'
import { ZoteroSyncDialog } from './ZoteroSyncDialog'
import { subscribeTaskSummary } from './taskListStore'
import {
  ERROR,
  abstractStyle,
  badgeRowStyle,
  badgeStyle,
  linkButtonStyle,
  linkStyle,
  metaStyle,
  panelStyle,
  statusStyle,
  titleStyle,
  toastErrorStyle,
  toastStackStyle,
  toastStyle,
} from './styles'

export const PAPER_ADDRESS_PREFIX = 'dsh-resource://litsearch-paper/'

type TabInfoLike = {
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
  /** 已下载时点击：先复核文件仍在，再在右侧面板预览本地 PDF。 */
  onOpenLocal?: (taskId: string, paperId: string, path: string) => void
  /** 已下载时点箭头菜单：在系统文件管理器中定位该 PDF。 */
  onRevealLocal?: (path: string) => void
}

export function paperRefFromAddress(
  address: string,
): { taskId: string; paperId: string } | null {
  if (!address.startsWith(PAPER_ADDRESS_PREFIX)) return null
  const rest = address.slice(PAPER_ADDRESS_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const taskPart = rest.slice(0, slash)
  const paperPart = rest.slice(slash + 1)
  if (paperPart === '' || paperPart.includes('/')) return null
  try {
    return { taskId: decodeURIComponent(taskPart), paperId: decodeURIComponent(paperPart) }
  } catch {
    return null
  }
}

const SCREENINGS: readonly Screening[] = ['unread', 'read', 'included', 'excluded']

const PDF_COLOR: Record<PdfStatus, string> = {
  unknown: 'rgba(127,127,127,0.8)',
  available: '#508cff',
  downloaded: '#2e9e5b',
  missing: '#d64545',
  'html-only': '#b26a00',
  paywalled: '#b26a00',
  blocked: '#d64545',
  failed: '#d64545',
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function PaperPane({
  t,
  useTabInfo,
  inputActions,
  onOpenLocal,
  onRevealLocal,
}: Props): ReactElement {
  const info = useTabInfo()
  const ref = paperRefFromAddress(info.tab.navigation?.address || info.tab.contentId || '')
  const [detail, setDetail] = useState<PaperDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [toast, setToastState] = useState('')
  const [toastTone, setToastTone] = useState<'info' | 'error'>('info')
  const notify = (text: string, tone: 'info' | 'error' = 'info'): void => {
    setToastState(text)
    setToastTone(tone)
  }
  const [showHtml, setShowHtml] = useState(false)
  const [zoteroOpen, setZoteroOpen] = useState(false)
  const [risFallback, setRisFallback] = useState<{ ids: readonly string[]; message: string } | null>(
    null,
  )

  const taskId = ref?.taskId ?? ''
  const paperId = ref?.paperId ?? ''

  useEffect(() => {
    if (ref === null) {
      setLoading(false)
      setError(t('paperTab.notFound'))
      return undefined
    }
    const controller = new AbortController()
    setLoading(true)
    fetchPaper(ref.taskId, ref.paperId, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return
        setDetail(next)
        setError(null)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setDetail(null)
        setError(messageOf(err))
        setLoading(false)
      })
    return () => controller.abort()
  }, [ref?.taskId, ref?.paperId, nonce, t])

  // Host 复核出「文件已删除」等状态时 rev 会变化：重新取一次详情换掉按钮文案。
  useEffect(() => {
    if (ref === null) return undefined
    return subscribeTaskSummary((summary) => {
      if (summary.id === ref.taskId) setNonce((value) => value + 1)
    })
  }, [ref?.taskId])

  const state = detail?.state

  useEffect(() => {
    setShowHtml(false)
    setRisFallback(null)
  }, [ref?.taskId, ref?.paperId])

  useEffect(() => {
    if (toast === '') return undefined
    const timer = setTimeout(() => setToastState(''), 4000)
    return () => clearTimeout(timer)
  }, [toast])

  const paper = detail?.paper
  const sources = useMemo(
    () => (paper === undefined ? [] : [...new Set(paper.hitSources.map((hit) => hit.source))]),
    [paper],
  )

  if (loading) return <div style={panelStyle}>{t('paperTab.loading')}</div>
  if (detail === null || paper === undefined) {
    return (
      <div style={panelStyle}>
        <div style={{ ...statusStyle, color: ERROR }}>{error ?? t('paperTab.notFound')}</div>
        <Button variant="outline" size="sm" type="button" onClick={() => setNonce((n) => n + 1)}>
          {t('paperTab.retry')}
        </Button>
      </div>
    )
  }

  const annotate = (input: AnnotationInput): void => {
    if (busy) return
    setBusy(true)
    void annotateTask(taskId, [input])
      .then(() => setNonce((value) => value + 1))
      .catch((err: unknown) => notify(messageOf(err)))
      .finally(() => setBusy(false))
  }

  const insert = (): void => {
    const outcome = insertQuote(inputActions, paperText(t, paper), paperSummary(t, paper))
    if (outcome === 'inserted') notify(t('result.inserted'))
    else notify(t(outcome === 'no-editor' ? 'error.noEditor' : 'error.draftChanged'))
  }

  const download = (): void => {
    setBusy(true)
    setDownloading(true)
    void downloadPaperPdf(taskId, paper.paperId)
      .then((result) => {
        if (result.status === 'downloaded') {
          notify(tpl(t('pdf.downloaded'), { name: result.filename ?? '' }))
        } else if (result.status === 'html-only') {
          notify(tpl(t('pdf.htmlFallback'), { message: result.error ?? '' }), 'error')
        } else {
          notify(tpl(t('pdf.error'), { message: result.error ?? result.status }), 'error')
        }
      })
      .catch((err: unknown) =>
        notify(tpl(t('pdf.error'), { message: messageOf(err) }), 'error'),
      )
      .finally(() => {
        setBusy(false)
        setDownloading(false)
        setNonce((value) => value + 1)
      })
  }

  const zotero = (): void => {
    setZoteroOpen(true)
  }

  const pdfStatus: PdfStatus =
    state?.pdfStatus ?? (paper.pdfUrl === '' ? 'unknown' : 'available')
  const canPdf =
    paper.pdfUrl !== '' || paper.ids.pmcid !== '' || paper.ids.arxivId !== '' || paper.doi !== ''
  const canHtml = paper.ids.pmcid !== ''
  const downloaded = !downloading && state?.pdfStatus === 'downloaded'
  const downloadedPath = downloaded ? state?.pdfFile : undefined
  const pdfMissing = !downloading && state?.pdfStatus === 'missing'
  const failedMessage =
    !downloading && state?.pdfStatus === 'failed' ? state.pdfError : undefined
  const downloadLabel = downloading
    ? t('pdf.downloading')
    : downloaded
      ? t('pdf.downloadedAction')
      : pdfMissing
        ? t('pdf.missingAction')
        : state?.pdfStatus === 'failed'
          ? t('pdf.retry')
          : t('pdf.download')
  const downloadHint = downloading
    ? t('pdf.downloadingHint')
    : downloaded
      ? tpl(t('pdf.downloadedHint'), {
          path: downloadedPath ?? detail.downloadDir ?? '',
        })
      : pdfMissing
        ? t('pdf.missingHint')
        : failedMessage !== undefined
          ? tpl(t('pdf.retryHint'), { message: failedMessage })
          : tpl(t('pdf.downloadHint'), {
              path: detail.downloadDir ?? t('pdf.downloadDirUnknown'),
            })
  const authors =
    paper.authors.length === 0
      ? ''
      : `${paper.authors.slice(0, 6).join(', ')}${paper.authors.length > 6 ? ' et al.' : ''}`
  const meta = [authors, paper.year === null ? '' : String(paper.year), paper.venue]
    .filter((part) => part !== '')
    .join(' · ')
  const groupName = detail.groups.find((group) => group.id === state?.groupId)?.name

  return (
    <div style={{ ...panelStyle, position: 'relative' }}>
      <div style={{ ...statusStyle, opacity: 0.66 }}>
        {tpl(t('paperTab.fromTask'), { title: detail.taskTitle })}
      </div>

      <div>
        {paper.url === '' ? (
          <span style={PAPER_TITLE_STYLE}>{paper.title}</span>
        ) : (
          <a style={PAPER_TITLE_STYLE} href={paper.url} target="_blank" rel="noreferrer noopener">
            {paper.title}
          </a>
        )}
        {meta !== '' && <div style={metaStyle}>{meta}</div>}
      </div>

      <div style={badgeRowStyle}>
        <span style={{ ...badgeStyle, color: SCREENING_COLOR[state?.screening ?? 'unread'] }}>
          {t(`screening.${state?.screening ?? 'unread'}`)}
        </span>
        {groupName !== undefined && <span style={badgeStyle}>{groupName}</span>}
        {sources.map((source) => (
          <span key={source} style={badgeStyle}>
            {t(`source.${source}`)}
          </span>
        ))}
        {paper.citedBy !== null && (
          <span style={badgeStyle}>{tpl(t('result.citedBy'), { n: paper.citedBy })}</span>
        )}
        {paper.openAccess && <span style={badgeStyle}>{t('result.openAccess')}</span>}
        <span style={{ ...badgeStyle, color: PDF_COLOR[pdfStatus] }}>
          {t(`pdf.status.${pdfStatus}`)}
        </span>
      </div>

      <div style={STATE_ROW_STYLE}>
        <select
          style={SELECT_STYLE}
          value={state?.screening ?? 'unread'}
          disabled={busy}
          aria-label={t('filter.screening')}
          onChange={(event) =>
            annotate({ paperId: paper.paperId, screening: event.target.value as Screening })
          }
        >
          {SCREENINGS.map((value) => (
            <option key={value} value={value}>
              {t(`screening.${value}`)}
            </option>
          ))}
        </select>
        <select
          style={SELECT_STYLE}
          value={state?.groupId ?? ''}
          disabled={busy}
          aria-label={t('annotate.group')}
          title={detail.groups.length === 0 ? t('annotate.groupHint') : t('annotate.group')}
          onChange={(event) =>
            annotate({
              paperId: paper.paperId,
              groupId: event.target.value === '' ? null : event.target.value,
            })
          }
        >
          <option value="">{t('annotate.noGroup')}</option>
          {detail.groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
      </div>

      {paper.abstract !== '' && (
        <section>
          <h4 style={HEAD_STYLE}>{t('paperTab.abstract')}</h4>
          <div style={abstractStyle}>{paper.abstract}</div>
        </section>
      )}

      <section>
        <h4 style={HEAD_STYLE}>{t('paperTab.identifiers')}</h4>
        <div style={IDS_STYLE}>
          {paper.doi !== '' && (
            <a
              style={linkStyle}
              href={`https://doi.org/${paper.doi}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              DOI: {paper.doi}
            </a>
          )}
          {paper.ids.pmid !== '' && (
            <a
              style={linkStyle}
              href={`https://pubmed.ncbi.nlm.nih.gov/${paper.ids.pmid}/`}
              target="_blank"
              rel="noreferrer noopener"
            >
              PMID: {paper.ids.pmid}
            </a>
          )}
          {paper.ids.pmcid !== '' && (
            <a
              style={linkStyle}
              href={`https://www.ncbi.nlm.nih.gov/pmc/articles/${paper.ids.pmcid}/`}
              target="_blank"
              rel="noreferrer noopener"
            >
              PMCID: {paper.ids.pmcid}
            </a>
          )}
          {paper.ids.arxivId !== '' && (
            <a
              style={linkStyle}
              href={`https://arxiv.org/abs/${paper.ids.arxivId}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              arXiv: {paper.ids.arxivId}
            </a>
          )}
          {paper.url !== '' && (
            <a style={linkStyle} href={paper.url} target="_blank" rel="noreferrer noopener">
              {t('paperTab.landing')}
            </a>
          )}
        </div>
      </section>

      <section>
        <h4 style={HEAD_STYLE}>{t('entity.title')}</h4>
        <EntityPanel t={t} taskId={taskId} paperId={paper.paperId} pmid={paper.ids.pmid} />
      </section>

      {showHtml && (
        <PreviewFrame
          t={t}
          src={paperFullTextUrl(taskId, paper.paperId)}
          height={420}
          onClose={() => setShowHtml(false)}
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
            <div style={FALLBACK_STYLE}>
              <span style={{ minWidth: 0 }}>
                {tpl(t('pdf.zoteroFallback'), { message: risFallback.message })}
              </span>
              <a
                href={exportUrl(taskId, 'ris', {}, risFallback.ids)}
                download
                style={FALLBACK_LINK_STYLE}
              >
                {t('pdf.zoteroFallbackLink')}
              </a>
              <button
                type="button"
                style={FALLBACK_BUTTON_STYLE}
                onClick={() => setRisFallback(null)}
              >
                {t('pdf.zoteroFallbackDismiss')}
              </button>
            </div>
          )}
        </div>
      )}

      <ZoteroSyncDialog
        t={t}
        open={zoteroOpen}
        taskId={taskId}
        items={[{ paperId: paper.paperId, title: paper.title }]}
        states={state === undefined ? {} : { [paper.paperId]: state }}
        onClose={() => {
          setZoteroOpen(false)
          setNonce((value) => value + 1)
        }}
        onDone={(failedIds) => {
          setNonce((value) => value + 1)
          if (failedIds.length === 0) return
          setRisFallback({ ids: failedIds, message: t('zotero.dialog.failFallback') })
        }}
      />

      <div style={ACTION_STYLE}>
        <Button variant="ghost" size="sm" type="button" onClick={insert}>
          {t('result.insert')}
        </Button>
        {canPdf && (
          <DownloadButton
            t={t}
            label={downloadLabel}
            hint={downloadHint}
            {...(downloadedPath === undefined ? {} : { downloadedPath })}
            missing={pdfMissing}
            downloading={downloading}
            disabled={busy}
            style={linkButtonStyle}
            onDownload={download}
            {...(onOpenLocal === undefined
              ? {}
              : { onOpen: (path: string) => onOpenLocal(taskId, paper.paperId, path) })}
            {...(onRevealLocal === undefined ? {} : { onReveal: onRevealLocal })}
          />
        )}
        {canHtml && (
          <button
            type="button"
            style={linkButtonStyle}
            onClick={() => setShowHtml((value) => !value)}
          >
            {t('pdf.fulltext')}
          </button>
        )}
        <button
          type="button"
          style={
            state?.zoteroStatus === 'synced'
              ? { ...linkButtonStyle, color: '#2e9e5b' }
              : state?.zoteroStatus === 'failed'
                ? { ...linkButtonStyle, color: ERROR }
                : linkButtonStyle
          }
          title={
            state?.zoteroStatus === 'synced'
              ? state.zoteroCollection
              : state?.zoteroStatus === 'failed'
                ? state.zoteroError
                : undefined
          }
          disabled={busy}
          onClick={zotero}
        >
          {state?.zoteroStatus === 'synced'
            ? t('pdf.zoteroSynced')
            : state?.zoteroStatus === 'failed'
              ? t('pdf.zoteroRetry')
              : t('pdf.zotero')}
        </button>
        {paper.pdfUrl !== '' && (
          <a style={linkStyle} href={paper.pdfUrl} target="_blank" rel="noreferrer noopener">
            {t('result.pdf')}
          </a>
        )}
      </div>
    </div>
  )
}

const SCREENING_COLOR: Record<Screening, string> = {
  unread: 'rgba(127,127,127,0.9)',
  read: '#508cff',
  included: '#2e9e5b',
  excluded: '#d64545',
}

/** 独立论文页是整页主视图，标题比结果卡片再大一级。 */
const PAPER_TITLE_STYLE: CSSProperties = {
  ...titleStyle,
  fontSize: 16,
  fontWeight: 700,
  lineHeight: 1.45,
}

const HEAD_STYLE: CSSProperties = {
  fontSize: 13,
  fontWeight: 650,
  opacity: 0.85,
  margin: '10px 0 4px',
}

const STATE_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 6,
  fontSize: 12,
}
const SELECT_STYLE: CSSProperties = {
  fontSize: 11.5,
  padding: '2px 4px',
  borderRadius: 4,
  border: '1px solid rgba(127,127,127,0.28)',
  background: 'transparent',
  color: 'inherit',
  maxWidth: 150,
}
const IDS_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  fontSize: 12,
}
const FALLBACK_STYLE: CSSProperties = {
  ...toastStyle,
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
  borderLeft: '3px solid #b26a00',
}
const FALLBACK_LINK_STYLE: CSSProperties = {
  color: '#fff',
  fontSize: 12,
  textDecoration: 'underline',
}
const FALLBACK_BUTTON_STYLE: CSSProperties = {
  ...linkButtonStyle,
  color: '#fff',
  textDecoration: 'underline',
}
const ACTION_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 10,
  marginTop: 2,
}
