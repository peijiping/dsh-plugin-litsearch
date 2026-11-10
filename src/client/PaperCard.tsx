/**
 * 任务结果里的单篇文献卡片。
 *
 * 标题可点外链；徽章展示命中来源、被引、开放获取。摘要默认折叠。
 */

import { useState, type ReactElement } from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { Paper } from '../search/types'
import { tpl, type Translate } from './locales'
import {
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

interface Props {
  paper: Paper
  t: Translate
  onInsert: (paper: Paper) => void
}

export function PaperCard({ paper, t, onInsert }: Props): ReactElement {
  const [expanded, setExpanded] = useState(false)

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

  return (
    <article style={cardStyle}>
      {paper.url === '' ? (
        <span style={titleStyle}>{paper.title}</span>
      ) : (
        <a style={titleStyle} href={paper.url} target="_blank" rel="noreferrer noopener">
          {paper.title}
        </a>
      )}

      {meta !== '' && <div style={metaStyle}>{meta}</div>}

      <div style={badgeRowStyle}>
        {sources.map((source) => (
          <span key={source} style={badgeStyle}>
            {t(`source.${source}`)}
          </span>
        ))}
        {paper.citedBy !== null && (
          <span style={badgeStyle}>{tpl(t('result.citedBy'), { n: paper.citedBy })}</span>
        )}
        {paper.openAccess && <span style={badgeStyle}>{t('result.openAccess')}</span>}
      </div>

      {paper.abstract !== '' && (
        <div style={abstractStyle}>
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
      )}

      <div style={actionRowStyle}>
        <Button variant="ghost" size="sm" type="button" onClick={() => onInsert(paper)}>
          {t('result.insert')}
        </Button>
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
    </article>
  )
}
