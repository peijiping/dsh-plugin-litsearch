/**
 * 任务结果里的单篇文献卡片。
 *
 * 标题可点外链；徽章展示命中来源、被引、开放获取。筛读状态与分组就地修改，
 * 备注 / 标签 / 必读顺序收在「标注」里，避免窄栏里堆满输入框。
 */

import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type {
  AnnotationInput,
  Paper,
  PaperState,
  PdfStatus,
  Screening,
  TaskGroup,
} from '../search/types'
import { paperFullTextUrl, paperPdfUrl } from './api'
import { EntityPanel } from './Entities'
import { AbstractIcon, AuthorsIcon, TitleIcon } from './icons'
import { tpl, type Translate } from './locales'
import {
  ACCENT,
  abstractStyle,
  actionRowStyle,
  badgeRowStyle,
  badgeStyle,
  cardStyle,
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
  unread: 'rgba(127,127,127,0.9)',
  read: '#508cff',
  included: '#2e9e5b',
  excluded: '#d64545',
}

interface Props {
  paper: Paper
  t: Translate
  taskId: string
  state?: PaperState
  groups: readonly TaskGroup[]
  busy: boolean
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
  const [editing, setEditing] = useState(false)
  const [entities, setEntities] = useState(false)
  const [preview, setPreview] = useState<'pdf' | 'html' | null>(null)
  const [note, setNote] = useState(state?.note ?? '')
  const [tags, setTags] = useState((state?.tags ?? []).join(', '))
  const [order, setOrder] = useState(
    state?.shortlistOrder === undefined ? '' : String(state.shortlistOrder),
  )

  const noteKey = state?.note ?? ''
  const tagsKey = (state?.tags ?? []).join(',')
  const orderKey = state?.shortlistOrder ?? ''
  useEffect(() => {
    setNote(noteKey)
    setTags(tagsKey)
    setOrder(orderKey === '' ? '' : String(orderKey))
  }, [noteKey, tagsKey, orderKey])

  const authors =
    paper.authors.length === 0
      ? ''
      : `${paper.authors.slice(0, 3).join(', ')}${paper.authors.length > 3 ? ' et al.' : ''}`
  const meta = [authors, paper.year === null ? '' : String(paper.year), paper.venue]
    .filter((part) => part !== '')
    .join(' · ')

  const sources = [...new Set(paper.hitSources.map((hit) => hit.source))]
  const canCollapse = paper.abstract.length > ABSTRACT_PREVIEW
  const abstract =
    expanded || !canCollapse ? paper.abstract : `${paper.abstract.slice(0, ABSTRACT_PREVIEW)}…`

  const screening = state?.screening ?? 'unread'
  const groupName = groups.find((group) => group.id === state?.groupId)?.name
  const hasNote = (state?.note ?? '') !== '' || (state?.tags ?? []).length > 0
  const pdfStatus: PdfStatus = state?.pdfStatus ?? (paper.pdfUrl === '' ? 'unknown' : 'available')
  const canPdf =
    paper.pdfUrl !== '' || paper.ids.pmcid !== '' || paper.ids.arxivId !== '' || paper.doi !== ''
  const canHtml = paper.ids.pmcid !== ''

  const saveDetail = (): void => {
    const trimmedOrder = order.trim()
    const parsedOrder = Number(trimmedOrder)
    const tagList = tags
      .split(/[,，;；]/u)
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '')
    onAnnotate({
      paperId: paper.paperId,
      note,
      tags: tagList,
      shortlistOrder:
        trimmedOrder === '' || !Number.isFinite(parsedOrder) ? null : Math.floor(parsedOrder),
    })
    setEditing(false)
  }

  return (
    <article style={cardStyle}>
      {/* 顶部工具行：勾选、筛读、分组、标注集中在一处，正文从标题开始。 */}
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
        <button type="button" style={linkButtonStyle} onClick={() => setEditing((value) => !value)}>
          {editing ? t('annotate.collapse') : t('annotate.expand')}
          {hasNote ? ' •' : ''}
        </button>
      </div>

      {editing && (
        <div style={EDIT_STYLE}>
          <label style={EDIT_FIELD_STYLE}>
            <span>{t('annotate.note')}</span>
            <textarea
              style={NOTE_STYLE}
              value={note}
              rows={2}
              placeholder={t('annotate.notePlaceholder')}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <label style={EDIT_FIELD_STYLE}>
            <span>{t('annotate.tags')}</span>
            <input
              style={INPUT_STYLE}
              value={tags}
              placeholder={t('annotate.tagsPlaceholder')}
              onChange={(event) => setTags(event.target.value)}
            />
          </label>
          <label style={{ ...EDIT_FIELD_STYLE, maxWidth: 120 }}>
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

      <div style={FIELD_ROW_STYLE}>
        <span style={FIELD_ICON_STYLE}>
          <TitleIcon />
        </span>
        {paper.url === '' ? (
          <span style={{ ...titleStyle, ...FIELD_BODY_STYLE }}>{paper.title}</span>
        ) : (
          <a
            style={{ ...titleStyle, ...FIELD_BODY_STYLE }}
            href={paper.url}
            target="_blank"
            rel="noreferrer noopener"
          >
            {paper.title}
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

      {paper.abstract !== '' && (
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

      {state?.pdfError !== undefined && (
        <div style={PDF_ERROR_STYLE}>{tpl(t('pdf.error'), { message: state.pdfError })}</div>
      )}

      <div style={CARD_ROW_STYLE} title={t('result.infoHint')}>
        <span style={INFO_LABEL_STYLE}>{t('result.infoLabel')}</span>
        <div style={{ ...badgeRowStyle, ...FIELD_BODY_STYLE, marginTop: 0 }}>
          <span style={{ ...INFO_BADGE_STYLE, color: SCREENING_COLOR[screening] }}>
            {t(`screening.${screening}`)}
          </span>
          {groupName !== undefined && <span style={INFO_BADGE_STYLE}>{groupName}</span>}
          {state?.shortlistOrder !== undefined && (
            <span style={INFO_BADGE_STYLE}>
              {tpl(t('annotate.shortlistBadge'), { n: state.shortlistOrder })}
            </span>
          )}
          {sources.map((source) => (
            <span key={source} style={INFO_BADGE_STYLE}>
              {t(`source.${source}`)}
            </span>
          ))}
          {paper.citedBy !== null && (
            <span style={INFO_BADGE_STYLE}>{tpl(t('result.citedBy'), { n: paper.citedBy })}</span>
          )}
          {paper.openAccess && <span style={INFO_BADGE_STYLE}>{t('result.openAccess')}</span>}
          <span style={{ ...INFO_BADGE_STYLE, color: PDF_COLOR[pdfStatus] }}>
            {t(`pdf.status.${pdfStatus}`)}
          </span>
        </div>
      </div>

      <div style={CARD_ROW_STYLE} title={t('result.actionHint')}>
        <span style={ACTION_LABEL_STYLE}>{t('result.actionLabel')}</span>
        <div
          style={{
            ...actionRowStyle,
            ...FIELD_BODY_STYLE,
            marginTop: 0,
            flexWrap: 'wrap',
            rowGap: 2,
          }}
        >
          <Button
            variant="ghost"
            size="sm"
            type="button"
            style={{ color: ACCENT }}
            onClick={() => onInsert(paper)}
          >
            {t('result.insert')}
          </Button>
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
            <button
              type="button"
              style={linkButtonStyle}
              disabled={busy}
              onClick={() => onDownload(paper)}
            >
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
          <button
            type="button"
            style={linkButtonStyle}
            disabled={busy}
            onClick={() => onZotero(paper)}
          >
            {t('pdf.zotero')}
          </button>
          {paper.pdfUrl !== '' && (
            <a style={linkStyle} href={paper.pdfUrl} target="_blank" rel="noreferrer noopener">
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
      </div>

      {entities && (
        <EntityPanel t={t} taskId={taskId} paperId={paper.paperId} pmid={paper.ids.pmid} />
      )}

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
    </article>
  )
}

const PDF_COLOR: Record<PdfStatus, string> = {
  unknown: 'rgba(127,127,127,0.8)',
  available: '#508cff',
  downloaded: '#2e9e5b',
  'html-only': '#b26a00',
  paywalled: '#b26a00',
  blocked: '#d64545',
  failed: '#d64545',
}

const PDF_ERROR_STYLE: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.5,
  color: '#b26a00',
  marginTop: 2,
}
const PREVIEW_WRAP_STYLE: CSSProperties = {
  marginTop: 6,
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
  height: 360,
  border: 'none',
  background: '#fff',
}

/** 卡片顶部工具行：勾选 / 筛读 / 分组 / 标注。 */
const STATE_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
  marginBottom: 8,
  fontSize: 12,
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
  color: ACCENT,
  opacity: 0.75,
}
const FIELD_BODY_STYLE: CSSProperties = { flex: 1, minWidth: 0 }

/**
 * 卡片底部两行：左边固定宽度的行标签，右边是内容。
 * 「状态与来源」用青绿、「快捷操作」用主题蓝，避免两行都是蓝字难以分辨。
 */
const INFO_COLOR = '#12836c'
const CARD_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  marginTop: 3,
}
const ROW_LABEL_STYLE: CSSProperties = {
  flexShrink: 0,
  width: 92,
  paddingTop: 1,
  fontSize: 11.5,
  lineHeight: '16px',
  fontWeight: 650,
  whiteSpace: 'nowrap',
}
const INFO_LABEL_STYLE: CSSProperties = { ...ROW_LABEL_STYLE, color: INFO_COLOR }
const ACTION_LABEL_STYLE: CSSProperties = { ...ROW_LABEL_STYLE, color: ACCENT }
const INFO_BADGE_STYLE: CSSProperties = {
  ...badgeStyle,
  padding: '1px 6px',
  lineHeight: 1.3,
  color: INFO_COLOR,
  border: '1px solid rgba(18,131,108,0.45)',
}
const SELECT_STYLE: CSSProperties = {
  fontSize: 11,
  padding: '2px 4px',
  borderRadius: 4,
  border: '1px solid rgba(127,127,127,0.28)',
  background: 'transparent',
  color: 'inherit',
  maxWidth: 130,
}
const EDIT_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  marginBottom: 8,
  padding: '6px 8px',
  borderRadius: 6,
  background: 'rgba(127,127,127,0.07)',
}
const EDIT_FIELD_STYLE: CSSProperties = {
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
