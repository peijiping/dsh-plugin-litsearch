/**
 * 独立论文 tab：`dsh-resource://litsearch-paper/<taskId>/<paperId>`。
 *
 * 展示完整摘要、标识符、筛读与标注、全文预览和 PubTator 实体；数据来自
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
  paperPdfUrl,
  syncZotero,
} from './api'
import { paperText } from './compose'
import { EntityPanel } from './Entities'
import { insertBuilt, type InputActions } from './inline'
import { tpl, type Translate } from './locales'
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
  'html-only': '#b26a00',
  paywalled: '#b26a00',
  blocked: '#d64545',
  failed: '#d64545',
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function PaperPane({ t, useTabInfo, inputActions }: Props): ReactElement {
  const info = useTabInfo()
  const ref = paperRefFromAddress(info.tab.navigation?.address || info.tab.contentId || '')
  const [detail, setDetail] = useState<PaperDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [toast, setToast] = useState('')
  const [editing, setEditing] = useState(false)
  const [preview, setPreview] = useState<'pdf' | 'html' | null>(null)
  const [note, setNote] = useState('')
  const [tags, setTags] = useState('')
  const [order, setOrder] = useState('')
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

  const state = detail?.state
  const noteKey = state?.note ?? ''
  const tagsKey = (state?.tags ?? []).join(',')
  const orderKey = state?.shortlistOrder ?? ''

  useEffect(() => {
    setNote(noteKey)
    setTags(tagsKey)
    setOrder(orderKey === '' ? '' : String(orderKey))
  }, [noteKey, tagsKey, orderKey])

  useEffect(() => {
    setEditing(false)
    setPreview(null)
    setRisFallback(null)
  }, [ref?.taskId, ref?.paperId])

  useEffect(() => {
    if (toast === '') return undefined
    const timer = setTimeout(() => setToast(''), 2400)
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
      .catch((err: unknown) => setToast(messageOf(err)))
      .finally(() => setBusy(false))
  }

  const saveDetail = (): void => {
    const trimmedOrder = order.trim()
    const parsedOrder = Number(trimmedOrder)
    const tagList = tags
      .split(/[,，;；]/u)
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '')
    annotate({
      paperId: paper.paperId,
      note,
      tags: tagList,
      shortlistOrder:
        trimmedOrder === '' || !Number.isFinite(parsedOrder) ? null : Math.floor(parsedOrder),
    })
    setEditing(false)
  }

  const insert = (): void => {
    void (async () => {
      const outcome = await insertBuilt(inputActions, () => paperText(t, paper))
      if (outcome === 'inserted') setToast(t('result.inserted'))
      else setToast(t(outcome === 'no-editor' ? 'error.noEditor' : 'error.draftChanged'))
    })()
  }

  const download = (): void => {
    setBusy(true)
    void downloadPaperPdf(taskId, paper.paperId)
      .then((result) => {
        if (result.status === 'downloaded') {
          setToast(tpl(t('pdf.downloaded'), { name: result.filename ?? '' }))
        } else if (result.status === 'html-only') {
          setToast(tpl(t('pdf.htmlFallback'), { message: result.error ?? '' }))
        } else {
          setToast(tpl(t('pdf.error'), { message: result.error ?? result.status }))
        }
      })
      .catch((err: unknown) => setToast(tpl(t('pdf.error'), { message: messageOf(err) })))
      .finally(() => {
        setBusy(false)
        setNonce((value) => value + 1)
      })
  }

  const zotero = (): void => {
    setBusy(true)
    void syncZotero(taskId, [paper.paperId])
      .then((result) => {
        const message = result.messages[0] ?? ''
        if (result.failed === 0 && message === '') {
          setToast(tpl(t('pdf.zoteroDone'), { n: result.saved }))
        } else {
          setToast(
            tpl(t('pdf.zoteroPartial'), {
              saved: result.saved,
              failed: result.failed,
              message,
            }),
          )
        }
        if (result.failed > 0) {
          setRisFallback({ ids: [paper.paperId], message: message || t('pdf.zoteroFailed') })
        }
      })
      .catch((err: unknown) => {
        const message = messageOf(err)
        setToast(tpl(t('pdf.zoteroFailed'), { message }))
        setRisFallback({ ids: [paper.paperId], message })
      })
      .finally(() => setBusy(false))
  }

  const pdfStatus: PdfStatus =
    state?.pdfStatus ?? (paper.pdfUrl === '' ? 'unknown' : 'available')
  const canPdf =
    paper.pdfUrl !== '' || paper.ids.pmcid !== '' || paper.ids.arxivId !== '' || paper.doi !== ''
  const canHtml = paper.ids.pmcid !== ''
  const authors =
    paper.authors.length === 0
      ? ''
      : `${paper.authors.slice(0, 6).join(', ')}${paper.authors.length > 6 ? ' et al.' : ''}`
  const meta = [authors, paper.year === null ? '' : String(paper.year), paper.venue]
    .filter((part) => part !== '')
    .join(' · ')
  const groupName = detail.groups.find((group) => group.id === state?.groupId)?.name

  return (
    <div style={panelStyle}>
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
        {state?.shortlistOrder !== undefined && (
          <span style={badgeStyle}>{tpl(t('annotate.shortlistBadge'), { n: state.shortlistOrder })}</span>
        )}
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

      {state?.pdfError !== undefined && (
        <div style={{ ...statusStyle, color: '#b26a00' }}>
          {tpl(t('pdf.error'), { message: state.pdfError })}
        </div>
      )}

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
        <button type="button" style={linkButtonStyle} onClick={() => setEditing((value) => !value)}>
          {editing ? t('annotate.collapse') : t('annotate.expand')}
        </button>
      </div>

      {editing && (
        <div style={EDIT_STYLE}>
          <label style={FIELD_STYLE}>
            <span>{t('annotate.note')}</span>
            <textarea
              style={NOTE_STYLE}
              value={note}
              rows={3}
              placeholder={t('annotate.notePlaceholder')}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <label style={FIELD_STYLE}>
            <span>{t('annotate.tags')}</span>
            <input
              style={INPUT_STYLE}
              value={tags}
              placeholder={t('annotate.tagsPlaceholder')}
              onChange={(event) => setTags(event.target.value)}
            />
          </label>
          <label style={{ ...FIELD_STYLE, maxWidth: 120 }}>
            <span>{t('annotate.shortlistOrder')}</span>
            <input
              style={INPUT_STYLE}
              inputMode="numeric"
              value={order}
              placeholder="—"
              onChange={(event) => setOrder(event.target.value)}
            />
          </label>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="outline" size="sm" type="button" disabled={busy} onClick={saveDetail}>
              {t('annotate.save')}
            </Button>
          </div>
        </div>
      )}

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

      {preview !== null && (
        <div style={PREVIEW_WRAP_STYLE}>
          <div style={PREVIEW_HEAD_STYLE}>
            <span>{preview === 'pdf' ? t('pdf.preview') : t('pdf.fulltext')}</span>
            <button type="button" style={linkButtonStyle} onClick={() => setPreview(null)}>
              {t('pdf.closePreview')}
            </button>
          </div>
          <iframe
            title={preview === 'pdf' ? t('pdf.preview') : t('pdf.fulltext')}
            src={
              preview === 'pdf'
                ? paperPdfUrl(taskId, paper.paperId)
                : paperFullTextUrl(taskId, paper.paperId)
            }
            style={IFRAME_STYLE}
          />
        </div>
      )}

      {toast !== '' && <div style={toastStyle}>{toast}</div>}

      {risFallback !== null && (
        <div style={FALLBACK_STYLE}>
          <span style={{ minWidth: 0 }}>
            {tpl(t('pdf.zoteroFallback'), { message: risFallback.message })}
          </span>
          <a href={exportUrl(taskId, 'ris', {}, risFallback.ids)} download style={linkStyle}>
            {t('pdf.zoteroFallbackLink')}
          </a>
          <button type="button" style={linkButtonStyle} onClick={() => setRisFallback(null)}>
            {t('pdf.zoteroFallbackDismiss')}
          </button>
        </div>
      )}

      <div style={ACTION_STYLE}>
        <Button variant="ghost" size="sm" type="button" onClick={insert}>
          {t('result.insert')}
        </Button>
        {canPdf && (
          <button
            type="button"
            style={linkButtonStyle}
            onClick={() => setPreview((value) => (value === 'pdf' ? null : 'pdf'))}
          >
            {t('pdf.preview')}
          </button>
        )}
        {canPdf && (
          <button type="button" style={linkButtonStyle} disabled={busy} onClick={download}>
            {t('pdf.download')}
          </button>
        )}
        {canHtml && (
          <button
            type="button"
            style={linkButtonStyle}
            onClick={() => setPreview((value) => (value === 'html' ? null : 'html'))}
          >
            {t('pdf.fulltext')}
          </button>
        )}
        <button type="button" style={linkButtonStyle} disabled={busy} onClick={zotero}>
          {t('pdf.zotero')}
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
const EDIT_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '6px 8px',
  borderRadius: 6,
  background: 'rgba(127,127,127,0.07)',
}
const FIELD_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  fontSize: 11,
  opacity: 0.9,
}
const INPUT_STYLE: CSSProperties = {
  fontSize: 12,
  padding: '3px 5px',
  borderRadius: 4,
  border: '1px solid rgba(127,127,127,0.28)',
  background: 'transparent',
  color: 'inherit',
  minWidth: 0,
}
const NOTE_STYLE: CSSProperties = {
  ...INPUT_STYLE,
  resize: 'vertical',
  fontFamily: 'inherit',
  lineHeight: 1.5,
}
const IDS_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  fontSize: 12,
}
const PREVIEW_WRAP_STYLE: CSSProperties = {
  border: '1px solid rgba(127,127,127,0.22)',
  borderRadius: 6,
  overflow: 'hidden',
}
const PREVIEW_HEAD_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '3px 8px',
  fontSize: 11,
  background: 'rgba(127,127,127,0.08)',
}
const IFRAME_STYLE: CSSProperties = {
  width: '100%',
  height: 420,
  border: 'none',
  background: '#fff',
}
const FALLBACK_STYLE: CSSProperties = {
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
const ACTION_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 10,
  marginTop: 2,
}
