/**
 * 任务结果里的单篇文献卡片。
 *
 * 标题可点外链；徽章展示命中来源、被引、开放获取。筛读状态与分组就地修改。
 */

import { useState, type CSSProperties, type ReactElement } from 'react'

import type {
  AnnotationInput,
  Paper,
  PaperState,
  PdfStatus,
  Screening,
  TaskGroup,
} from '../search/types'
import { paperFullTextUrl } from './api'
import { DownloadButton } from './DownloadButton'
import { EntityPanel } from './Entities'
import {
  AbstractIcon,
  AuthorsIcon,
  ChatIcon,
  DownloadIcon,
  TitleIcon,
  ZoteroIcon,
} from './icons'
import { tpl, type Translate } from './locales'
import {
  canDownloadPdf,
  paperPdfStatus,
  pdfActionUi,
  pdfLinkOptions,
  zoteroActionUi,
  type PdfDownloadUi,
} from './pdfActions'
import { PreviewFrame } from './PreviewFrame'
import { TranslationButton } from './TranslationButton'
import { useTranslation } from './useTranslation'
import { abstractPreview } from './text'
import {
  abstractStyle,
  actionButtonStyle,
  actionRowStyle,
  badgeRowStyle,
  badgeStyle,
  cardStyle,
  CARD_CLASS,
  linkButtonStyle,
  linkStyle,
  metaStyle,
  titleStyle,
} from './styles'

const ABSTRACT_PREVIEW = 260

/** 分组下拉里「去新建分组」的哨兵值，不会与真实 group id 冲突。 */
const CREATE_GROUP_VALUE = '__create_group__'

const SCREENINGS: readonly Screening[] = ['unread', 'read', 'included', 'excluded']

const SCREENING_COLOR: Record<Screening, string> = {
  unread: 'var(--ls-ink-2)',
  read: 'var(--ls-accent)',
  included: 'var(--ls-success)',
  excluded: 'var(--ls-error)',
}

interface Props {
  paper: Paper
  t: Translate
  taskId: string
  state?: PaperState
  groups: readonly TaskGroup[]
  busy: boolean
  /** PDF 保存目录，用于下载按钮的悬停提示。 */
  downloadDir?: string
  /** 当前这篇的下载状态；未点击过时不传。 */
  download?: PdfDownloadUi
  /** 已下载时点击：先复核文件仍在，再在右侧面板预览本地 PDF。 */
  onOpenLocal?: (taskId: string, paperId: string, path: string) => void
  /** 已下载时点箭头菜单：在系统文件管理器中定位该 PDF。 */
  onRevealLocal?: (path: string) => void
  selected?: boolean
  onToggleSelect?: (paperId: string) => void
  onInsert: (paper: Paper) => void
  onAnnotate: (input: AnnotationInput) => void
  onDownload: (paper: Paper) => void
  onZotero: (paper: Paper) => void
  onOpenPaper?: (paper: Paper) => void
  /** 无分组时把用户送到任务的「分组」页新建；独立论文页不传。 */
  onManageGroups?: () => void
}

export function PaperCard({
  paper,
  t,
  taskId,
  state,
  groups,
  busy,
  downloadDir,
  download,
  onOpenLocal,
  onRevealLocal,
  selected = false,
  onToggleSelect,
  onInsert,
  onAnnotate,
  onDownload,
  onZotero,
  onOpenPaper,
  onManageGroups,
}: Props): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [entities, setEntities] = useState(false)
  const [showHtml, setShowHtml] = useState(false)

  const authors =
    paper.authors.length === 0
      ? ''
      : `${paper.authors.slice(0, 3).join(', ')}${paper.authors.length > 3 ? ' et al.' : ''}`
  const meta = [authors, paper.year === null ? '' : String(paper.year), paper.venue]
    .filter((part) => part !== '')
    .join(' · ')

  const sources = [...new Set(paper.hitSources.map((hit) => hit.source))]
  // 折叠与否按原文判定（译后按钮不会消失）；预览长度按译文/原文比例缩放。
  const translation = useTranslation(paper, t)
  const { text: abstract, collapsible: canCollapse } = abstractPreview({
    shown: translation.abstract,
    source: translation.sourceAbstract,
    previewChars: ABSTRACT_PREVIEW,
    expanded,
  })

  const screening = state?.screening ?? 'unread'
  const groupName = groups.find((group) => group.id === state?.groupId)?.name
  const pdfStatus: PdfStatus = paperPdfStatus(paper, state)
  const canPdf = canDownloadPdf(paper, pdfStatus)
  // PMC 通道可用 PMID 反查 PMCID；只对标注开放的记录展示，减少无谓请求。
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
  // 下载失败（或已知被墙/需订阅）时给出可点击的替代路径，而不是只弹 toast。
  const showLinkBar =
    download?.state === 'failed' ||
    pdfStatus === 'failed' ||
    pdfStatus === 'blocked' ||
    pdfStatus === 'paywalled'
  const pdfLinks = pdfLinkOptions({
    paper,
    failedLinks: download?.links ?? [],
    directPdfUrl,
    t,
  })

  const pdfAction = pdfActionUi({ paper, state, download, downloadDir, t })
  const zoteroAction = zoteroActionUi(t, state)

  return (
    <article className={`${CARD_CLASS} ls-card-hover`} style={cardStyle}>
      {/* 顶部工具行：勾选、筛读、分组集中在一处，正文从标题开始。 */}
      <div style={STATE_ROW_STYLE}>
        {onToggleSelect !== undefined && (
          <input
            type="checkbox"
            checked={selected}
            aria-label={t('bulk.select')}
            onChange={() => onToggleSelect(paper.paperId)}
          />
        )}
        <select
          style={SELECT_STYLE}
          value={screening}
          disabled={busy}
          aria-label={t('filter.screening')}
          onChange={(event) =>
            onAnnotate({ paperId: paper.paperId, screening: event.target.value as Screening })
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
          title={groups.length === 0 ? t('annotate.groupHint') : t('annotate.group')}
          onChange={(event) => {
            const value = event.target.value
            if (value === CREATE_GROUP_VALUE) {
              // 哨兵项不写入数据，立刻把受控 select 显示回退到真实值。
              event.target.value = state?.groupId ?? ''
              onManageGroups?.()
              return
            }
            onAnnotate({ paperId: paper.paperId, groupId: value === '' ? null : value })
          }}
        >
          <option value="">{t('annotate.noGroup')}</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
          {groups.length === 0 && onManageGroups !== undefined && (
            <option value={CREATE_GROUP_VALUE}>{t('annotate.createGroup')}</option>
          )}
        </select>
        {/* 主操作靠右：翻译 + 加入对话都常驻右上角，「快捷操作」行只留次要入口。 */}
        <TranslationButton t={t} state={translation} style={TRANSLATE_BUTTON_STYLE} />
        <button
          type="button"
          style={INSERT_BUTTON_STYLE}
          title={t('result.insert')}
          onClick={() => onInsert(paper)}
        >
          <ChatIcon />
          {t('result.insert')}
        </button>
      </div>

      <div style={FIELD_ROW_STYLE}>
        <span style={FIELD_ICON_STYLE}>
          <TitleIcon />
        </span>
        {paper.url === '' ? (
          <span style={{ ...titleStyle, ...FIELD_BODY_STYLE }}>{translation.title}</span>
        ) : (
          <a
            style={{ ...titleStyle, ...FIELD_BODY_STYLE }}
            href={paper.url}
            target="_blank"
            rel="noreferrer noopener"
          >
            {translation.title}
          </a>
        )}
      </div>

      {meta !== '' && (
        <div style={{ ...FIELD_ROW_STYLE, marginTop: 4 }}>
          <span style={{ ...FIELD_ICON_STYLE, marginTop: 1 }}>
            <AuthorsIcon />
          </span>
          <div style={{ ...metaStyle, ...FIELD_BODY_STYLE, marginTop: 0 }}>{meta}</div>
        </div>
      )}

      {translation.sourceAbstract !== '' && (
        <div style={{ ...FIELD_ROW_STYLE, marginTop: 6 }}>
          <span style={FIELD_ICON_STYLE}>
            <AbstractIcon />
          </span>
          <div style={{ ...abstractStyle, ...FIELD_BODY_STYLE, marginTop: 0 }}>
            {abstract}
            {canCollapse && (
              <>
                {' '}
                <button
                  type="button"
                  style={linkButtonStyle}
                  onClick={() => setExpanded((value) => !value)}
                >
                  {expanded ? t('result.collapseAbstract') : t('result.expandAbstract')}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* 底部三行共用两列网格：标签列宽度随文案自适应，内容列因此紧贴标签左移。 */}
      <div style={CARD_ROWS_STYLE}>
        <span style={INFO_LABEL_STYLE} title={t('result.infoHint')}>
          {t('result.infoLabel')}
        </span>
        <div style={{ ...badgeRowStyle, ...FIELD_BODY_STYLE, marginTop: 0 }}>
          {paper.supplement !== undefined && (
            <span style={SUPPLEMENT_BADGE_STYLE}>{t('supplement.badge')}</span>
          )}
          {Boolean(paper.risBatchIds?.length) && (
            <span style={INFO_BADGE_STYLE}>{t('source.ris')}</span>
          )}
          <span style={{ ...INFO_BADGE_STYLE, color: SCREENING_COLOR[screening] }}>
            {t(`screening.${screening}`)}
          </span>
          {groupName !== undefined && <span style={INFO_BADGE_STYLE}>{groupName}</span>}
          {sources.map((source) => (
            <span key={source} style={INFO_BADGE_STYLE}>
              {t(`source.${source}`)}
            </span>
          ))}
          {paper.citedBy !== null && (
            <span style={INFO_BADGE_STYLE}>{tpl(t('result.citedBy'), { n: paper.citedBy })}</span>
          )}
          {paper.openAccess && <span style={INFO_BADGE_STYLE}>{t('result.openAccess')}</span>}
          <span
            style={{ ...INFO_BADGE_STYLE, color: PDF_COLOR[pdfStatus] }}
            title={state?.pdfError}
          >
            {t(`pdf.status.${pdfStatus}`)}
          </span>
        </div>

        <span style={ACTION_LABEL_STYLE} title={t('result.actionHint')}>
          {t('result.actionLabel')}
        </span>
        <div
          style={{
            ...actionRowStyle,
            ...FIELD_BODY_STYLE,
            marginTop: 0,
            flexWrap: 'wrap',
            rowGap: 2,
          }}
        >
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
              style={actionButtonStyle}
              icon={<DownloadIcon />}
              onDownload={() => onDownload(paper)}
              {...(onOpenLocal === undefined
                ? {}
                : { onOpen: (path: string) => onOpenLocal(taskId, paper.paperId, path) })}
              {...(onRevealLocal === undefined ? {} : { onReveal: onRevealLocal })}
            />
          )}
          <button
            type="button"
            style={
              zoteroAction.color === undefined
                ? actionButtonStyle
                : { ...actionButtonStyle, color: zoteroAction.color }
            }
            disabled={busy}
            title={zoteroAction.hint}
            onClick={() => onZotero(paper)}
          >
            <ZoteroIcon />
            {zoteroAction.label}
          </button>
          {onOpenPaper !== undefined && (
            <button type="button" style={linkButtonStyle} onClick={() => onOpenPaper(paper)}>
              {t('paper.open')}
            </button>
          )}
          {paper.ids.pmid !== '' && (
            <button
              type="button"
              style={linkButtonStyle}
              onClick={() => setEntities((value) => !value)}
            >
              {t('entity.title')}
            </button>
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
          {directPdfUrl !== '' && (
            <a style={linkStyle} href={directPdfUrl} target="_blank" rel="noreferrer noopener">
              {t('result.pdf')}
            </a>
          )}
          {paper.doi !== '' && (
            <a
              style={linkStyle}
              href={`https://doi.org/${paper.doi}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              DOI
            </a>
          )}
        </div>

        {showLinkBar && (pdfLinks.length > 0 || paper.doi !== '' || canHtml) && (
          <>
            <span style={ACTION_LABEL_STYLE}>{t('pdf.linksLabel')}</span>
            <div
              style={{
                ...FIELD_BODY_STYLE,
                marginTop: 0,
                display: 'flex',
                flexWrap: 'wrap',
                columnGap: 12,
                rowGap: 4,
                alignItems: 'center',
              }}
            >
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
              {canHtml && (
                <button type="button" style={linkButtonStyle} onClick={() => setShowHtml(true)}>
                  {t('pdf.webFullText')}
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {entities && (
        <EntityPanel t={t} taskId={taskId} paperId={paper.paperId} pmid={paper.ids.pmid} />
      )}

      {showHtml && (
        <PreviewFrame
          t={t}
          src={paperFullTextUrl(taskId, paper.paperId)}
          height={360}
          onClose={() => setShowHtml(false)}
        />
      )}
    </article>
  )
}

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

/** 卡片顶部工具行：勾选 / 筛读 / 分组。 */
const STATE_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
  marginBottom: 8,
  fontSize: 12,
}

/** 右上角常驻的「加入对话」：与工具行控件同高。 */
const INSERT_BUTTON_STYLE: CSSProperties = {
  ...actionButtonStyle,
  flexShrink: 0,
}

/** 「原 / 译」：靠右吸附，单字宽，避免把筛读与分组挤走。 */
const TRANSLATE_BUTTON_STYLE: CSSProperties = {
  ...actionButtonStyle,
  marginLeft: 'auto',
  flexShrink: 0,
  justifyContent: 'center',
  minWidth: 28,
  fontWeight: 500,
}

/** 标题 / 作者 / 摘要统一为「图标 + 正文」两列，长文本只在正文列换行。 */
const FIELD_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 6,
}
const FIELD_ICON_STYLE: CSSProperties = {
  display: 'inline-flex',
  flexShrink: 0,
  width: 14,
  marginTop: 2,
  color: 'var(--ls-accent-ink)',
  opacity: 0.75,
}
const FIELD_BODY_STYLE: CSSProperties = { flex: 1, minWidth: 0 }

/**
 * 卡片底部三行共用一个两列网格：标签列取 `max-content`（中文标签只有 5 个字，
 * 不必再白占 92px 固定宽度），内容列 `minmax(0, 1fr)` 保证长串徽章能正常换行。
 * 「状态与来源」用青绿、「快捷操作」用主题蓝，避免两行都是蓝字难以分辨。
 */
const INFO_COLOR = 'var(--ls-info)'
const CARD_ROWS_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'max-content minmax(0, 1fr)',
  columnGap: 6,
  rowGap: 2,
  marginTop: 2,
}
const ROW_LABEL_STYLE: CSSProperties = {
  paddingTop: 1,
  fontSize: 11.5,
  lineHeight: '16px',
  fontWeight: 500,
  whiteSpace: 'nowrap',
}
const INFO_LABEL_STYLE: CSSProperties = { ...ROW_LABEL_STYLE, color: INFO_COLOR }
const ACTION_LABEL_STYLE: CSSProperties = { ...ROW_LABEL_STYLE, color: 'var(--ls-accent-ink)' }
const INFO_BADGE_STYLE: CSSProperties = {
  ...badgeStyle,
  padding: '1px 5px',
  fontSize: 10.5,
  lineHeight: 1.3,
  color: INFO_COLOR,
  border: '1px solid rgba(18,131,108,0.45)',
}
const SUPPLEMENT_BADGE_STYLE: CSSProperties = {
  ...INFO_BADGE_STYLE,
  color: '#733c08',
  background: '#ffe6af',
  borderColor: '#d19437',
  fontWeight: 600,
}
const SELECT_STYLE: CSSProperties = {
  fontSize: 11,
  padding: '2px 4px',
  borderRadius: 4,
  border: '1px solid var(--ls-line-strong)',
  background: 'transparent',
  color: 'inherit',
  maxWidth: 130,
}
