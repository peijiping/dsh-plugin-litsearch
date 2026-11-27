/**
 * 独立论文 tab：`dsh-resource://litsearch-paper/<taskId>/<paperId>`。
 *
 * 展示完整摘要、标识符、筛读与分组、全文预览和 PubTator 实体；数据来自
 * 单篇详情端点，避免为了打开一篇论文拉取整页结果。
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type {
  AnnotationInput,
  OaLocation,
  Paper,
  PaperDetail,
  PdfStatus,
  Screening,
} from '../search/types'
import {
  annotateTask,
  associatePaperPdf,
  detachPaperPdf,
  downloadPaperPdf,
  exportUrl,
  fetchPaper,
  paperFullTextUrl,
} from './api'
import { paperSummary, paperText } from './compose'
import { DownloadButton } from './DownloadButton'
import { EntityPanel } from './Entities'
import { ChatIcon } from './icons'
import { insertQuote, type InputActions } from './inline'
import { tpl, type Translate } from './locales'
import { abstractPreview, hostOf } from './text'
import { TranslationButton } from './TranslationButton'
import { useTranslation } from './useTranslation'
import {
  canDownloadPdf,
  paperPdfStatus,
  pdfActionUi,
  pdfLinkOptions,
  zoteroActionUi,
} from './pdfActions'
import { PreviewFrame } from './PreviewFrame'
import { RisOriginMetadata } from './RisTools'
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
/** 与结果卡片一致：摘要默认只展示 260 字。 */
const ABSTRACT_PREVIEW = 260

const PDF_COLOR: Record<PdfStatus, string> = {
  unknown: 'var(--ls-ink-3)',
  available: 'var(--ls-accent)',
  downloaded: 'var(--ls-success)',
  missing: 'var(--ls-error)',
  'html-only': 'var(--ls-warn)',
  paywalled: 'var(--ls-warn)',
  blocked: 'var(--ls-error)',
  failed: 'var(--ls-error)',
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
  const [pdfCandidate, setPdfCandidate] = useState<File | null>(null)
  const [changingMaterial, setChangingMaterial] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [failedLinks, setFailedLinks] = useState<OaLocation[]>([])
  const [toast, setToastState] = useState('')
  const [toastTone, setToastTone] = useState<'info' | 'error'>('info')
  const notify = (text: string, tone: 'info' | 'error' = 'info'): void => {
    setToastState(text)
    setToastTone(tone)
  }
  const [showHtml, setShowHtml] = useState(false)
  const [abstractOpen, setAbstractOpen] = useState(false)
  const htmlRef = useRef<HTMLDivElement>(null)
  const [zoteroOpen, setZoteroOpen] = useState(false)
  const [risFallback, setRisFallback] = useState<{ ids: readonly string[]; message: string } | null>(
    null,
  )

  const taskId = ref?.taskId ?? ''
  const paperId = ref?.paperId ?? ''
  useEffect(() => setPdfCandidate(null), [taskId, paperId])

  const updateMaterial = async (file?: File): Promise<void> => {
    setChangingMaterial(true)
    try {
      await (file === undefined ? detachPaperPdf(taskId, paperId) : associatePaperPdf(taskId, paperId, file))
      setPdfCandidate(null)
      setNonce((value) => value + 1)
    } catch (error) {
      notify(messageOf(error), 'error')
    } finally {
      setChangingMaterial(false)
    }
  }

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
    setAbstractOpen(false)
    setRisFallback(null)
  }, [ref?.taskId, ref?.paperId])

  // 打开全文后把预览滚进视野，避免它停在页尾只露一行。
  useEffect(() => {
    if (showHtml) htmlRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [showHtml])

  useEffect(() => {
    if (toast === '') return undefined
    const timer = setTimeout(() => setToastState(''), 4000)
    return () => clearTimeout(timer)
  }, [toast])

  const paper = detail?.paper
  // 详情加载完成前也要调用（hooks 不能条件调用）；空标题时按钮并未渲染。
  const translation = useTranslation(
    {
      paperId: paper?.paperId ?? '',
      title: paper?.title ?? '',
      abstract: paper?.abstract ?? '',
      abstractCompleteness: paper?.abstractCompleteness,
    },
    t,
  )
  // 与结果卡片一致：折叠与否按原文判定（译后按钮不会消失），预览按比例缩放。
  const { text: abstractShown, collapsible: canCollapseAbstract } = abstractPreview({
    shown: translation.abstract,
    source: translation.sourceAbstract,
    previewChars: ABSTRACT_PREVIEW,
    expanded: abstractOpen,
  })
  const sources = useMemo(
    () => (paper === undefined ? [] : [...new Set(paper.hitSources.map((hit) => hit.source))]),
    [paper],
  )

  if (loading) return <div className="ls-root" style={panelStyle}>{t('paperTab.loading')}</div>
  if (detail === null || paper === undefined) {
    return (
      <div className="ls-root" style={panelStyle}>
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
          setFailedLinks([])
          notify(tpl(t('pdf.downloaded'), { name: result.filename ?? '' }))
        } else {
          setFailedLinks(result.links ?? [])
          if (result.status === 'html-only') {
            notify(tpl(t('pdf.htmlFallback'), { message: result.error ?? '' }), 'error')
          } else {
            notify(tpl(t('pdf.error'), { message: result.error ?? result.status }), 'error')
          }
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

  /** 展开全文时顺手收起摘要，把空间让给正文；再点一次则只收起全文。 */
  const toggleHtml = (): void => {
    if (showHtml) {
      setShowHtml(false)
      return
    }
    setAbstractOpen(false)
    setShowHtml(true)
  }

  const pdfStatus: PdfStatus = paperPdfStatus(paper, state)
  const canPdf = canDownloadPdf(paper, pdfStatus)
  const canHtml =
    paper.ids.pmcid !== '' ||
    paper.ids.arxivId !== '' ||
    (paper.openAccess && paper.ids.pmid !== '')
  const directPdfUrl =
    paper.pdfUrl !== ''
      ? paper.pdfUrl
      : (paper.oaLocations ?? []).find(
          (location) => location.kind === 'pdf' && location.textMining !== true,
        )?.url ?? ''
  const pdfLinks = pdfLinkOptions({ paper, failedLinks, directPdfUrl, t })
  const showLinkBar =
    pdfLinks.length > 0 ||
    state?.pdfStatus === 'blocked' ||
    state?.pdfStatus === 'paywalled' ||
    state?.pdfStatus === 'failed'
  const pdfAction = pdfActionUi({
    paper,
    state,
    download: downloading ? { state: 'downloading' } : undefined,
    downloadDir: detail.downloadDir,
    t,
  })
  const zoteroAction = zoteroActionUi(t, state)
  const authors =
    paper.authors.length === 0
      ? ''
      : `${paper.authors.slice(0, 6).join(', ')}${paper.authors.length > 6 ? ' et al.' : ''}`
  const meta = [authors, paper.year === null ? '' : String(paper.year), paper.venue]
    .filter((part) => part !== '')
    .join(' · ')
  const groupName = detail.groups.find((group) => group.id === state?.groupId)?.name
  // 来源与引用量用一行次要文本表达，比一排灰胶囊安静得多。
  const sourceLine = [
    ...sources.map((source) => t(`source.${source}`)),
    ...(paper.citedBy === null ? [] : [tpl(t('result.citedBy'), { n: paper.citedBy })]),
    ...(paper.openAccess ? [t('result.openAccess')] : []),
  ].join(' · ')

  return (
    <div className="ls-root" style={PAPER_PANEL_STYLE}>
      <div style={SCROLL_BODY_STYLE}>
        <div className="ls-sub">{tpl(t('paperTab.fromTask'), { title: detail.taskTitle })}</div>

        <article className="ls-card" style={HERO_STYLE}>
          <div style={STATUS_ROW_STYLE}>
            <span style={{ ...badgeStyle, color: SCREENING_COLOR[state?.screening ?? 'unread'] }}>
              {t(`screening.${state?.screening ?? 'unread'}`)}
            </span>
            {groupName !== undefined && <span style={badgeStyle}>{groupName}</span>}
            <span style={{ ...badgeStyle, color: PDF_COLOR[pdfStatus] }}>
              {t(`pdf.status.${pdfStatus}`)}
            </span>
          </div>

          {paper.url === '' ? (
            <span style={PAPER_TITLE_STYLE}>{translation.title}</span>
          ) : (
            <a style={PAPER_TITLE_STYLE} href={paper.url} target="_blank" rel="noreferrer noopener">
              {translation.title}
            </a>
          )}
          {meta !== '' && <div style={metaStyle}>{meta}</div>}

          {sourceLine !== '' && !detail.searchOrigins?.length && <div style={SOURCE_LINE_STYLE}>{sourceLine}</div>}
          {detail.searchOrigins?.map((origin, index) => (
            <div key={origin.roundId + ':' + index} style={{ ...SOURCE_LINE_STYLE, overflowWrap: 'anywhere' }}>
              {tpl(t('ris.onlineOrigin'), { source: t('source.' + origin.source), round: origin.roundIndex })}
              {origin.query && ' · ' + origin.query}
            </div>
          ))}
          {paper.supplement !== undefined && (
            <div style={metaStyle}>{t('supplement.badge')} · {paper.supplement.id}</div>
          )}
          {detail.risOrigins?.map((batch) => (
            <details key={batch.id + ':' + batch.line} style={{ ...metaStyle, overflowWrap: 'anywhere' }}>
              <summary>{t('source.ris')} · {batch.database} · {batch.fileName}</summary>
              <div>{tpl(t('ris.originLine'), { line: batch.line, rawType: batch.rawType })}</div>
              <RisOriginMetadata t={t} batch={batch} />
            </details>
          ))}
        </article>

        <div style={CONTROL_STYLE}>
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

          <div style={ACTION_STYLE}>
            <TranslationButton
              t={t}
              state={translation}
              className="ls-btn ls-btn-ghost ls-btn-compact"
            />
            <button
              type="button"
              className="ls-btn ls-btn-primary ls-btn-compact"
              onClick={insert}
            >
              <ChatIcon />
              {t('result.insert')}
            </button>
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
                style={GHOST_PILL_STYLE}
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
                className="ls-btn ls-btn-ghost ls-btn-compact"
                onClick={toggleHtml}
              >
                {t('pdf.fulltext')}
              </button>
            )}
            <button
              type="button"
              className="ls-btn ls-btn-ghost ls-btn-compact"
              title={zoteroAction.hint}
              disabled={busy}
              onClick={zotero}
              {...(zoteroAction.color === undefined ? {} : { style: { color: zoteroAction.color } })}
            >
              {zoteroAction.label}
            </button>
            {directPdfUrl !== '' && (
              <a
                className="ls-btn ls-btn-ghost ls-btn-compact"
                href={directPdfUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                {t('result.pdf')}
              </a>
            )}
          </div>
        </div>

        <section style={SECTION_STYLE}>
          <h4 style={HEAD_STYLE}>{t('material.title')}</h4>
          <label style={metaStyle}>
            {t('material.select')}
            {' '}
            <input type="file" accept="application/pdf,.pdf" disabled={changingMaterial}
              onChange={(event) => {
                setPdfCandidate(event.target.files?.[0] ?? null)
                event.target.value = ''
              }}
            />
          </label>
          {pdfCandidate !== null && (
            <div style={metaStyle}>
              {tpl(t('material.confirm'), { name: pdfCandidate.name })}
              {' '}
              <Button type="button" variant="outline" size="sm" disabled={changingMaterial}
                onClick={() => { void updateMaterial(pdfCandidate) }}
              >{t('material.attach')}</Button>
            </div>
          )}
          {state?.pdfMaterial !== undefined && (
            <div style={metaStyle} title={state.pdfMaterial.path}>
              {tpl(t('material.linked'), { date: new Date(state.pdfMaterial.acquiredAt).toLocaleDateString() })}
              {' '}
              <Button type="button" variant="outline" size="sm" disabled={changingMaterial}
                onClick={() => { void updateMaterial() }}
              >{t('material.detach')}</Button>
            </div>
          )}
        </section>

        {showLinkBar && (
          <div style={LINK_BAR_STYLE}>
            {pdfLinks.map((link) => (
              <a
                key={link.url}
                style={linkStyle}
                href={link.url}
                title={link.title}
                target="_blank"
                rel="noreferrer noopener"
              >
                {link.label}
              </a>
            ))}
            {paper.doi !== '' && (
              <a
                style={linkStyle}
                href={`https://doi.org/${paper.doi}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                {t('pdf.openLanding')}
              </a>
            )}
          </div>
        )}

        <section style={SECTION_STYLE}>
          <h4 style={HEAD_STYLE}>{t('paperTab.abstract')}</h4>
          <div style={ABSTRACT_TEXT_STYLE}>
            {paper.abstract === '' ? t('paperTab.abstractUnavailable') : abstractShown}
            {canCollapseAbstract && (
              <>
                {' '}
                <button
                  type="button"
                  style={linkButtonStyle}
                  onClick={() => setAbstractOpen((value) => !value)}
                >
                  {abstractOpen ? t('result.collapseAbstract') : t('result.expandAbstract')}
                </button>
              </>
            )}
          </div>
          {paper.abstractCompleteness === 'unknown' && (
            <p style={metaStyle}>{t('paperTab.abstractCompletenessUnknown')}</p>
          )}
        </section>

        <section style={SECTION_STYLE}>
          <h4 style={HEAD_STYLE}>{t('paperTab.identifiers')}</h4>
          <div className="ls-card-quiet" style={ID_CARD_STYLE}>
            {paper.doi !== '' && (
              <IdRow label="DOI" value={paper.doi} href={`https://doi.org/${paper.doi}`} />
            )}
            {paper.ids.pmid !== '' && (
              <IdRow
                label="PMID"
                value={paper.ids.pmid}
                href={`https://pubmed.ncbi.nlm.nih.gov/${paper.ids.pmid}/`}
              />
            )}
            {paper.ids.pmcid !== '' && (
              <IdRow
                label="PMCID"
                value={paper.ids.pmcid}
                href={`https://www.ncbi.nlm.nih.gov/pmc/articles/${paper.ids.pmcid}/`}
              />
            )}
            {paper.ids.arxivId !== '' && (
              <IdRow
                label="arXiv"
                value={paper.ids.arxivId}
                href={`https://arxiv.org/abs/${paper.arxivVersionId ?? paper.ids.arxivId}`}
              />
            )}
            {paper.url !== '' && (
              <IdRow label={t('paperTab.landing')} value={hostOf(paper.url)} href={paper.url} />
            )}
          </div>
        </section>

        <section style={SECTION_STYLE}>
          <h4 style={HEAD_STYLE}>{t('entity.title')}</h4>
          <EntityPanel t={t} taskId={taskId} paperId={paper.paperId} pmid={paper.ids.pmid} />
        </section>

        {showHtml && (
          <div ref={htmlRef} style={HTML_ANCHOR_STYLE}>
            <PreviewFrame
              t={t}
              src={paperFullTextUrl(taskId, paper.paperId)}
              height={560}
              onClose={() => setShowHtml(false)}
            />
          </div>
        )}
      </div>

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
    </div>
  )
}

/** 标识符一行：左标签、右可点值，长值省略号截断。 */
function IdRow({ label, value, href }: { label: string; value: string; href: string }): ReactElement {
  return (
    <div style={ID_ROW_STYLE}>
      <span style={ID_LABEL_STYLE}>{label}</span>
      <a
        style={ID_VALUE_STYLE}
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        title={value}
      >
        {value}
      </a>
    </div>
  )
}

const SCREENING_COLOR: Record<Screening, string> = {
  unread: 'var(--ls-ink-2)',
  read: 'var(--ls-accent)',
  included: 'var(--ls-success)',
  excluded: 'var(--ls-error)',
}

/** 宿主 tab 只给固定高度：论文页自己撑满并滚动，浮层留在滚动容器外。 */
const PAPER_PANEL_STYLE: CSSProperties = {
  ...panelStyle,
  position: 'relative',
  height: '100%',
  minHeight: 0,
  boxSizing: 'border-box',
}
const SCROLL_BODY_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
}
/** 全文预览的锚点：点开后滚到这里，整块都能看见。 */
const HTML_ANCHOR_STYLE: CSSProperties = { scrollMarginTop: 8 }

/** 独立论文页是整页主视图，标题比结果卡片再大一级。 */
const PAPER_TITLE_STYLE: CSSProperties = {
  ...titleStyle,
  fontSize: 16,
  lineHeight: 1.5,
}

/** 头部卡：状态徽章 → 标题 → 作者/年份/出处 → 来源徽章。 */
const HERO_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '13px 14px',
}

const STATUS_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 6,
}

const SOURCE_LINE_STYLE: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.6,
  color: 'var(--ls-ink-3)',
}

/** 状态与动作：窄面板下动作按钮自然换行，不挤成一排。 */
const CONTROL_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const SECTION_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const HEAD_STYLE: CSSProperties = {
  fontSize: 13.5,
  fontWeight: 500,
  color: 'var(--ls-ink-1)',
  margin: 0,
}

const ABSTRACT_TEXT_STYLE: CSSProperties = {
  fontSize: 12.5,
  lineHeight: 1.75,
  color: 'var(--ls-ink-2)',
}

const ID_CARD_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '10px 12px',
}

const ID_ROW_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '62px minmax(0, 1fr)',
  alignItems: 'baseline',
  gap: 10,
}

const ID_LABEL_STYLE: CSSProperties = {
  fontSize: 11,
  color: 'var(--ls-ink-3)',
}

const ID_VALUE_STYLE: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--ls-accent-ink)',
  textDecoration: 'none',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const LINK_BAR_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 12,
}

/** 次要动作的胶囊外观；下载按钮也复用它。 */
const GHOST_PILL_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '4px 10px',
  borderRadius: 999,
  border: '1px solid var(--ls-line)',
  background: 'var(--ls-surface)',
  color: 'var(--ls-ink-2)',
  fontSize: 11.5,
  lineHeight: 1.4,
  textDecoration: 'none',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const STATE_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 6,
}
const SELECT_STYLE: CSSProperties = {
  fontSize: 11.5,
  padding: '4px 8px',
  borderRadius: 8,
  border: '1px solid var(--ls-line)',
  background: 'var(--ls-surface)',
  color: 'var(--ls-ink-1)',
  maxWidth: 160,
  cursor: 'pointer',
}
const FALLBACK_STYLE: CSSProperties = {
  ...toastStyle,
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
  borderLeft: '3px solid var(--ls-warn)',
}
const FALLBACK_LINK_STYLE: CSSProperties = {
  color: 'var(--ls-accent-ink)',
  fontSize: 12,
  textDecoration: 'underline',
  textUnderlineOffset: 2,
}
const FALLBACK_BUTTON_STYLE: CSSProperties = {
  ...linkButtonStyle,
  textDecoration: 'none',
}
const ACTION_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 6,
}
